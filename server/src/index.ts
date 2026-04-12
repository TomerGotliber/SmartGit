import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import { Octokit } from "@octokit/rest";
import pino from "pino";
import { pinoHttp } from "pino-http";
import { fetchReviewQueues } from "./github/fetchQueues.js";
import {
  canPokeAgain,
  enqueuePrMetaUpdate,
  loadPrMetaForRead,
  prKey,
} from "./prMetaStore.js";
import { verifyReviewerMayBePoked } from "./pokeReview.js";
import { ReviewSeverity, type ReviewSeverityValue } from "./types.js";

const __rootDir = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__rootDir, "../../.env") });
dotenv.config({ path: path.resolve(__rootDir, "../.env") });

const log = pino({ level: process.env.LOG_LEVEL ?? "info" });

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPOS = process.env.REPOS ?? "";

const PORT = Number(process.env.PORT ?? 4001);
const POLL_MS = Math.max(10_000, Number(process.env.POLL_INTERVAL_MS ?? 60_000));

if (!GITHUB_TOKEN) {
  log.error("GITHUB_TOKEN is required");
  process.exit(1);
}
if (!REPOS.trim()) {
  log.error('REPOS is required: use owner/repo list, or "*" / ALL for every repo this token can access');
  process.exit(1);
}

const octokit = new Octokit({ auth: GITHUB_TOKEN });

let cache: Awaited<ReturnType<typeof fetchReviewQueues>> | null = null;
let refreshPromise: Promise<void> | null = null;

async function refreshCache(): Promise<void> {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    try {
      log.info("refreshing review queues from GitHub");
      cache = await fetchReviewQueues(octokit, REPOS);
      log.info(
        { reviewers: cache.users.length, creators: cache.creators.length, errors: cache.errors.length },
        "refresh complete"
      );
    } catch (e) {
      log.error({ err: e }, "refresh failed");
    } finally {
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

void refreshCache();
setInterval(() => {
  void refreshCache();
}, POLL_MS);

const app = express();
app.use(pinoHttp({ logger: log }));
app.use(cors({ origin: true }));
app.use(express.json());

const severityValues = new Set<string>(Object.values(ReviewSeverity));

app.patch("/api/pr/:owner/:repo/:pullNumber/severity", async (req, res) => {
  const owner = req.params.owner;
  const repo = req.params.repo;
  const pullNumber = Number(req.params.pullNumber);
  if (!owner || !repo || !Number.isFinite(pullNumber)) {
    res.status(400).json({ error: "Invalid path" });
    return;
  }
  const sev = req.body?.severity as ReviewSeverityValue;
  if (!severityValues.has(sev)) {
    res.status(400).json({ error: "severity must be none, low, medium, or high" });
    return;
  }
  const actor =
    typeof req.body?.actorLogin === "string" ? req.body.actorLogin.trim().toLowerCase() : "";
  if (process.env.REQUIRE_PR_AUTHOR_FOR_SEVERITY === "true") {
    if (!actor) {
      res.status(400).json({ error: "actorLogin required when REQUIRE_PR_AUTHOR_FOR_SEVERITY=true" });
      return;
    }
    try {
      const pr = await octokit.pulls.get({ owner, repo, pull_number: pullNumber });
      const author = pr.data.user?.login?.toLowerCase() ?? "";
      if (author !== actor) {
        res.status(403).json({ error: "Only the PR author can set severity" });
        return;
      }
    } catch (e) {
      log.warn({ err: e, owner, repo, pullNumber }, "severity: could not load PR");
      res.status(404).json({ error: "Pull request not found or inaccessible" });
      return;
    }
  }
  try {
    await enqueuePrMetaUpdate((draft) => {
      const key = prKey(`${owner}/${repo}`, pullNumber);
      const cur = { ...(draft[key] ?? {}) };
      if (sev === ReviewSeverity.None) {
        delete cur.severity;
        if (!cur.pokes || Object.keys(cur.pokes).length === 0) delete draft[key];
        else draft[key] = cur;
      } else {
        draft[key] = { ...cur, severity: sev };
      }
    });
    await refreshCache();
    if (!cache) {
      res.status(503).json({ error: "Refresh failed" });
      return;
    }
    res.json(cache);
  } catch (e) {
    log.error({ err: e }, "severity update failed");
    res.status(500).json({ error: "Failed to save severity" });
  }
});

app.post("/api/pr/:owner/:repo/:pullNumber/poke", async (req, res) => {
  const owner = req.params.owner;
  const repo = req.params.repo;
  const pullNumber = Number(req.params.pullNumber);
  if (!owner || !repo || !Number.isFinite(pullNumber)) {
    res.status(400).json({ error: "Invalid path" });
    return;
  }
  const reviewerLogin =
    typeof req.body?.reviewerLogin === "string" ? req.body.reviewerLogin.trim() : "";
  if (!reviewerLogin) {
    res.status(400).json({ error: "reviewerLogin is required" });
    return;
  }
  const note =
    typeof req.body?.note === "string" ? req.body.note.trim().slice(0, 500) : "";

  const key = prKey(`${owner}/${repo}`, pullNumber);
  let meta: Awaited<ReturnType<typeof loadPrMetaForRead>>;
  try {
    meta = await loadPrMetaForRead();
  } catch (e) {
    log.error({ err: e }, "poke: could not read meta");
    res.status(500).json({ error: "Meta store unavailable" });
    return;
  }
  const last = meta[key]?.pokes?.[reviewerLogin];
  const cooldown = canPokeAgain(last, Date.now());
  if (!cooldown.ok) {
    res.status(429).json({
      error: "Poke is on cooldown for this reviewer",
      nextPokeAt: cooldown.nextAt,
    });
    return;
  }

  let allowed: boolean;
  try {
    allowed = await verifyReviewerMayBePoked(octokit, owner, repo, pullNumber, reviewerLogin);
  } catch (e) {
    log.warn({ err: e, owner, repo, pullNumber, reviewerLogin }, "poke: verify failed");
    res.status(502).json({ error: "Could not verify reviewer with GitHub" });
    return;
  }
  if (!allowed) {
    res.status(403).json({
      error: "That user is not a pending requested reviewer (or team member) nor the latest changes-requested reviewer",
    });
    return;
  }

  const lines = [
    `@${reviewerLogin} friendly reminder to take a look at this PR when you have a moment. _(Review Queues poke)_`,
  ];
  if (note) lines.push(`_Note:_ ${note}`);
  const body = lines.join("\n\n");

  try {
    await octokit.issues.createComment({
      owner,
      repo,
      issue_number: pullNumber,
      body,
    });
  } catch (e) {
    log.error({ err: e, owner, repo, pullNumber }, "poke: GitHub comment failed");
    res.status(502).json({
      error: "Could not post comment (check token has issues:write / pull request comment access)",
    });
    return;
  }

  try {
    await enqueuePrMetaUpdate((draft) => {
      const cur = { ...(draft[key] ?? {}) };
      cur.pokes = { ...cur.pokes, [reviewerLogin]: new Date().toISOString() };
      draft[key] = cur;
    });
    await refreshCache();
  } catch (e) {
    log.error({ err: e }, "poke: meta or refresh failed after comment");
  }

  if (!cache) {
    res.status(200).json({ ok: true, warning: "Poke posted but cache refresh failed" });
    return;
  }
  res.json(cache);
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/queues", (_req, res) => {
  if (!cache) {
    res.status(503).json({ error: "Initial sync in progress" });
    return;
  }
  res.json(cache);
});

app.post("/api/refresh", async (_req, res) => {
  await refreshCache();
  if (!cache) {
    res.status(503).json({ error: "Refresh failed" });
    return;
  }
  res.json(cache);
});

const staticDir = path.resolve(__rootDir, "../../client/dist");
if (fs.existsSync(staticDir)) {
  log.info({ staticDir }, "serving built client");
  app.use(express.static(staticDir));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api")) {
      next();
      return;
    }
    res.sendFile(path.join(staticDir, "index.html"));
  });
}

const server = app.listen(PORT, () => {
  log.info({ port: PORT, pollMs: POLL_MS }, "review-queues server listening");
});
server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    log.error(
      { port: PORT, err: err.message },
      "port already in use — stop the other server (e.g. old `npm run dev`) or set PORT in .env"
    );
  } else {
    log.error({ err, port: PORT }, "server listen failed");
  }
  process.exit(1);
});
