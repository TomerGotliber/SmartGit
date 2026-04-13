import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import pino from "pino";
import { pinoHttp } from "pino-http";
import { createGitHubOctokit } from "./github/createOctokit.js";
import { fetchSmartGitSnapshot, type SnapshotEnvOptions } from "./github/fetchQueues.js";
import { verifyAuthorMayBePoked, verifyReviewerMayBePoked } from "./pokeReview.js";

const __rootDir = path.dirname(fileURLToPath(import.meta.url));
const rootEnvPath = path.resolve(__rootDir, "../../.env");
const serverEnvPath = path.resolve(__rootDir, "../.env");
dotenv.config({ path: rootEnvPath });
dotenv.config({ path: serverEnvPath });

/** Prefer `REPOS_EXCLUDE` from `.env` files on each refresh without `dotenv` override (which could clobber GITHUB_TOKEN). */
function loadSnapshotEnvFromDotenvFiles(): Required<SnapshotEnvOptions> {
  let reposExcludeRaw: string | undefined;
  for (const envPath of [rootEnvPath, serverEnvPath]) {
    try {
      const parsed = dotenv.parse(fs.readFileSync(envPath, "utf8"));
      if (Object.prototype.hasOwnProperty.call(parsed, "REPOS_EXCLUDE")) {
        reposExcludeRaw = parsed.REPOS_EXCLUDE ?? "";
      }
    } catch {
      /* ENOENT or unreadable */
    }
  }
  return {
    reposExcludeRaw: reposExcludeRaw ?? process.env.REPOS_EXCLUDE ?? "",
  };
}

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

const startupSnapshotEnv = loadSnapshotEnvFromDotenvFiles();
const reposExcludePreview = startupSnapshotEnv.reposExcludeRaw.trim();
if (reposExcludePreview) {
  log.info(
    { REPOS_EXCLUDE: reposExcludePreview },
    "REPOS_EXCLUDE active (from .env when present; reapplied on each poll refresh)"
  );
} else {
  log.info("REPOS_EXCLUDE unset — every repo from REPOS / discovery is scanned");
}

const octokit = createGitHubOctokit(GITHUB_TOKEN);

let cache: Awaited<ReturnType<typeof fetchSmartGitSnapshot>> | null = null;
let refreshPromise: Promise<void> | null = null;

async function refreshCache(): Promise<void> {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    try {
      dotenv.config({ path: rootEnvPath });
      dotenv.config({ path: serverEnvPath });
      const snapshotEnv = loadSnapshotEnvFromDotenvFiles();
      log.info("refreshing SmartGit snapshot from GitHub");
      cache = await fetchSmartGitSnapshot(octokit, REPOS, snapshotEnv);
      log.info(
        {
          allOpen: cache.allOpen.length,
          reviewers: cache.users.length,
          creators: cache.creators.length,
          errors: cache.errors.length,
        },
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

app.post("/api/pr/:owner/:repo/:pullNumber/poke", async (req, res) => {
  const owner = req.params.owner;
  const repo = req.params.repo;
  const pullNumber = Number(req.params.pullNumber);
  if (!owner || !repo || !Number.isFinite(pullNumber)) {
    res.status(400).json({ error: "Invalid path" });
    return;
  }
  const targetLoginRaw =
    (typeof req.body?.targetLogin === "string" ? req.body.targetLogin.trim() : "") ||
    (typeof req.body?.reviewerLogin === "string" ? req.body.reviewerLogin.trim() : "");
  if (!targetLoginRaw) {
    res.status(400).json({ error: "targetLogin is required" });
    return;
  }
  const targetLogin = targetLoginRaw;
  const note =
    typeof req.body?.note === "string" ? req.body.note.trim().slice(0, 500) : "";
  const customMessageRaw =
    typeof req.body?.customMessage === "string" ? req.body.customMessage.trim().slice(0, 3200) : "";

  let pokeKind: "reviewer" | "author";
  try {
    const asReviewer = await verifyReviewerMayBePoked(octokit, owner, repo, pullNumber, targetLogin);
    if (asReviewer) {
      pokeKind = "reviewer";
    } else if (await verifyAuthorMayBePoked(octokit, owner, repo, pullNumber, targetLogin)) {
      pokeKind = "author";
    } else {
      res.status(403).json({
        error:
          "That user is not this PR’s author, nor a pending requested reviewer (or team member), nor a reviewer whose latest review is changes requested",
      });
      return;
    }
  } catch (e) {
    log.warn({ err: e, owner, repo, pullNumber, targetLogin }, "poke: verify failed");
    res.status(502).json({ error: "Could not verify user with GitHub" });
    return;
  }

  let body: string;
  if (customMessageRaw) {
    const esc = targetLogin.replace(/[\\^$*+?.()|[\]{}]/g, "\\$&");
    const lead = new RegExp(`^@${esc}\\s*`, "i");
    const userPart = customMessageRaw.replace(lead, "").trim();
    const main = userPart ? `@${targetLogin} ${userPart}` : `@${targetLogin}`;
    body = `${main}\n\n_(SmartGit poke)_`;
  } else {
    const lines =
      pokeKind === "reviewer"
        ? [
            `@${targetLogin} friendly reminder to take a look at this PR when you have a moment. _(SmartGit poke)_`,
          ]
        : [
            `@${targetLogin} heads-up — the next step on this pull request is with you. Please take a look when you can. _(SmartGit poke)_`,
          ];
    if (note) lines.push(`_Note:_ ${note}`);
    body = lines.join("\n\n");
  }

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
    await refreshCache();
  } catch (e) {
    log.error({ err: e }, "poke: cache refresh failed after comment");
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
    res.status(503).json({
      error: "Initial sync in progress",
      hint: 'With REPOS=* and many repositories, the first GitHub fetch can take several minutes. Wait for server log "refresh complete".',
    });
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
  log.info({ port: PORT, pollMs: POLL_MS }, "SmartGit server listening");
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
