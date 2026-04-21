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
const SMARTGIT_POKE_TOKEN = process.env.SMARTGIT_POKE_TOKEN?.trim() || "";
const REPOS = process.env.REPOS ?? "";

const PORT = Number(process.env.PORT ?? 4001);
const POLL_MS = Math.max(10_000, Number(process.env.POLL_INTERVAL_MS ?? 300_000));

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
const pokeOctokit = SMARTGIT_POKE_TOKEN ? createGitHubOctokit(SMARTGIT_POKE_TOKEN) : octokit;
if (SMARTGIT_POKE_TOKEN) {
  log.info("SMARTGIT_POKE_TOKEN set — pokes will be posted from the SmartGit account, not GITHUB_TOKEN");
} else {
  log.info("SMARTGIT_POKE_TOKEN unset — pokes fall back to GITHUB_TOKEN");
}

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
  const senderTag =
    typeof req.body?.senderTag === "string"
      ? req.body.senderTag.replace(/[\r\n]+/g, " ").trim().slice(0, 80)
      : "";
  const footer = senderTag ? `_(SmartGit poke from ${senderTag})_` : "_(SmartGit poke)_";

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
    body = `${main}\n\n${footer}`;
  } else {
    const lead =
      pokeKind === "reviewer"
        ? `@${targetLogin} friendly reminder to take a look at this PR when you have a moment.`
        : `@${targetLogin} heads-up — the next step on this pull request is with you. Please take a look when you can.`;
    const lines = [`${lead} ${footer}`];
    if (note) lines.push(`_Note:_ ${note}`);
    body = lines.join("\n\n");
  }

  try {
    await pokeOctokit.issues.createComment({
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

app.get("/api/repos/:owner/:repo/branches", async (req, res) => {
  const { owner, repo } = req.params;
  if (!owner || !repo) {
    res.status(400).json({ error: "Invalid path" });
    return;
  }
  try {
    const repoInfo = await octokit.repos.get({ owner, repo });
    const defaultBranch = repoInfo.data.default_branch;

    const pulls = await octokit.paginate(octokit.pulls.list, {
      owner,
      repo,
      state: "open",
      per_page: 100,
    });

    const prsByHead = new Map<string, { number: number; title: string; htmlUrl: string; draft: boolean }[]>();
    for (const p of pulls) {
      const head = p.head?.ref;
      if (!head) continue;
      const list = prsByHead.get(head) ?? [];
      list.push({ number: p.number, title: p.title, htmlUrl: p.html_url, draft: Boolean(p.draft) });
      prsByHead.set(head, list);
    }

    const ROOT_CANDIDATES = ["master", "main", "staging", "stage", "dev", "develop", "development", "release", "production", "prod"];
    const wantedNames = new Set<string>([defaultBranch, ...ROOT_CANDIDATES, ...prsByHead.keys()]);

    type BranchResult = {
      name: string;
      protected: boolean;
      ahead: number;
      behind: number;
      base: string | null;
      compared: boolean;
      prs: { number: number; title: string; htmlUrl: string; draft: boolean }[];
    };

    const names = Array.from(wantedNames);
    const CONCURRENCY = 12;
    const results: (BranchResult | null)[] = new Array(names.length).fill(null);

    let next = 0;
    async function worker() {
      while (true) {
        const i = next++;
        if (i >= names.length) return;
        const name = names[i]!;
        const prs = prsByHead.get(name) ?? [];
        if (name === defaultBranch) {
          results[i] = { name, protected: false, ahead: 0, behind: 0, base: null, compared: true, prs };
          continue;
        }
        try {
          const cmp = await octokit.repos.compareCommitsWithBasehead({
            owner,
            repo,
            basehead: `${defaultBranch}...${name}`,
          });
          results[i] = {
            name,
            protected: false,
            ahead: cmp.data.ahead_by,
            behind: cmp.data.behind_by,
            base: defaultBranch,
            compared: true,
            prs,
          };
        } catch {
          // 404 = root candidate doesn't exist in this repo; drop it silently
          results[i] = null;
        }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

    const branches = results.filter((b): b is BranchResult => b !== null);

    res.json({
      owner,
      repo,
      defaultBranch,
      totalBranches: branches.length,
      truncated: false,
      branches,
    });
  } catch (e) {
    log.warn({ err: e, owner, repo }, "branches: GitHub fetch failed");
    const status = (e as { status?: number })?.status === 404 ? 404 : 502;
    res.status(status).json({ error: "Could not fetch branches from GitHub" });
  }
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
