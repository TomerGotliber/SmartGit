import type {
  AllOpenPrItem,
  PendingReviewItem,
  SmartGitSnapshot,
  UserQueue,
  WaitTier,
} from "./types";

function normalizeItem(item: PendingReviewItem): PendingReviewItem {
  return {
    ...item,
    hoursWaiting: item.hoursWaiting ?? 0,
    waitTier: (item.waitTier ?? 0) as WaitTier,
    severity: item.severity ?? null,
  };
}

function normalizeQueue(u: UserQueue): UserQueue {
  return { ...u, items: u.items.map(normalizeItem) };
}

function normalizeAllOpenItem(item: AllOpenPrItem): AllOpenPrItem {
  return {
    ...item,
    hoursWaiting: item.hoursWaiting ?? 0,
    waitTier: (item.waitTier ?? 0) as WaitTier,
    severity: item.severity ?? null,
    requestedUserLogins: item.requestedUserLogins ?? [],
    requestedTeamSlugs: item.requestedTeamSlugs ?? [],
    changesRequestedBy: item.changesRequestedBy ?? [],
  };
}

function normalizeSnapshot(
  raw: SmartGitSnapshot & { creators?: UserQueue[]; allOpen?: AllOpenPrItem[] }
): SmartGitSnapshot {
  return {
    ...raw,
    actorLogin: raw.actorLogin ?? null,
    allOpen: (raw.allOpen ?? []).map(normalizeAllOpenItem),
    users: raw.users.map(normalizeQueue),
    creators: (raw.creators ?? []).map(normalizeQueue),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** First server sync can take minutes when REPOS=* covers many repos; retry 503 until cache is ready. */
export async function fetchQueues(): Promise<SmartGitSnapshot> {
  const maxAttempts = 90;
  const delayMs = 2000;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch("/api/queues");
    if (res.status === 503) {
      await sleep(delayMs);
      continue;
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || res.statusText);
    }
    const raw = (await res.json()) as SmartGitSnapshot & { creators?: UserQueue[]; allOpen?: AllOpenPrItem[] };
    return normalizeSnapshot(raw);
  }
  throw new Error("Server queue cache is still not ready after waiting. Try Refresh or check server logs.");
}

export async function postRefresh(): Promise<SmartGitSnapshot> {
  const res = await fetch("/api/refresh", { method: "POST" });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(text || res.statusText);
  }
  const raw = (await res.json()) as SmartGitSnapshot & { creators?: UserQueue[]; allOpen?: AllOpenPrItem[] };
  return normalizeSnapshot(raw);
}

export interface BranchInfo {
  name: string;
  protected: boolean;
  ahead: number;
  behind: number;
  base: string | null;
  compared?: boolean;
  prs?: { number: number; title: string; htmlUrl: string; draft: boolean }[];
}

export interface RepoBranchesResponse {
  owner: string;
  repo: string;
  defaultBranch: string;
  totalBranches: number;
  truncated: boolean;
  branches: BranchInfo[];
}

export async function fetchRepoBranches(owner: string, repo: string): Promise<RepoBranchesResponse> {
  const res = await fetch(`/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches`);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || res.statusText);
  }
  return (await res.json()) as RepoBranchesResponse;
}

export async function postPrPoke(
  owner: string,
  repo: string,
  pullNumber: number,
  targetLogin: string,
  options?: { note?: string; customMessage?: string }
): Promise<SmartGitSnapshot> {
  const trimmedNote = options?.note?.trim();
  const trimmedCustom = options?.customMessage?.trim().slice(0, 3200);
  const res = await fetch(`/api/pr/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${pullNumber}/poke`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      targetLogin,
      ...(trimmedCustom ? { customMessage: trimmedCustom } : trimmedNote ? { note: trimmedNote } : {}),
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(text || res.statusText);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return postRefresh();
  }
  const snap = raw as SmartGitSnapshot & { creators?: UserQueue[]; allOpen?: AllOpenPrItem[]; users?: unknown };
  if (snap && Array.isArray(snap.users)) {
    return normalizeSnapshot(snap);
  }
  return postRefresh();
}
