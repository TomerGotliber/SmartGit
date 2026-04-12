import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import type { ReviewSeverityValue } from "./types.js";

const log = pino({ name: "prMetaStore" });

const __rootDir = path.dirname(fileURLToPath(import.meta.url));

export interface PrMetaEntry {
  severity?: ReviewSeverityValue;
  /** reviewer login -> ISO time of last poke comment */
  pokes?: Record<string, string>;
}

export function prKey(repoFullName: string, pullNumber: number): string {
  return `${repoFullName}#${pullNumber}`;
}

function defaultStorePath(): string {
  const fromEnv = process.env.PR_META_PATH?.trim();
  if (fromEnv) return path.isAbsolute(fromEnv) ? fromEnv : path.resolve(process.cwd(), fromEnv);
  return path.resolve(__rootDir, "../data/pr-meta.json");
}

let writeChain: Promise<void> = Promise.resolve();

async function readRaw(): Promise<Record<string, PrMetaEntry>> {
  const p = defaultStorePath();
  try {
    const raw = await fs.readFile(p, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, PrMetaEntry>;
    }
    return {};
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    log.error({ err: e, path: p }, "failed to read pr-meta store");
    throw e;
  }
}

async function writeRaw(data: Record<string, PrMetaEntry>): Promise<void> {
  const p = defaultStorePath();
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(tmp, p);
}

/** Wait for pending writes, then read (consistent snapshot). */
export async function loadPrMetaForRead(): Promise<Record<string, PrMetaEntry>> {
  await writeChain;
  return readRaw();
}

export function enqueuePrMetaUpdate(mutator: (draft: Record<string, PrMetaEntry>) => void): Promise<void> {
  const op = writeChain.then(async () => {
    const data = await readRaw();
    mutator(data);
    await writeRaw(data);
  });
  writeChain = op.catch((err) => {
    log.error({ err }, "pr-meta update failed");
  });
  return op;
}

export function pokeCooldownMs(): number {
  const h = Number(process.env.POKE_COOLDOWN_HOURS ?? 24);
  if (!Number.isFinite(h) || h < 1) return 24 * 3600 * 1000;
  return h * 3600 * 1000;
}

export function canPokeAgain(lastPokeIso: string | undefined, now: number): { ok: boolean; nextAt?: string } {
  if (!lastPokeIso) return { ok: true };
  const last = new Date(lastPokeIso).getTime();
  if (Number.isNaN(last)) return { ok: true };
  const cooldown = pokeCooldownMs();
  if (now - last >= cooldown) return { ok: true };
  return { ok: false, nextAt: new Date(last + cooldown).toISOString() };
}
