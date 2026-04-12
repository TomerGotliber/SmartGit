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

const __rootDir = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__rootDir, "../../.env") });
dotenv.config({ path: path.resolve(__rootDir, "../.env") });

const log = pino({ level: process.env.LOG_LEVEL ?? "info" });

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPOS = process.env.REPOS ?? "";
const PORT = Number(process.env.PORT ?? 4000);
const POLL_MS = Math.max(10_000, Number(process.env.POLL_INTERVAL_MS ?? 60_000));

if (!GITHUB_TOKEN) {
  log.error("GITHUB_TOKEN is required");
  process.exit(1);
}
if (!REPOS.trim()) {
  log.error("REPOS is required (comma-separated owner/repo values)");
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
      log.info({ users: cache.users.length, errors: cache.errors.length }, "refresh complete");
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

app.listen(PORT, () => {
  log.info({ port: PORT, pollMs: POLL_MS }, "review-queues server listening");
});
