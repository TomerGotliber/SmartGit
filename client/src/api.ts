import type {
  AllOpenPrItem,
  PendingReviewItem,
  SmartGitSnapshot,
  ReviewSeverityValue,
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
    allOpen: (raw.allOpen ?? []).map(normalizeAllOpenItem),
    users: raw.users.map(normalizeQueue),
    creators: (raw.creators ?? []).map(normalizeQueue),
  };
}

export async function fetchQueues(): Promise<SmartGitSnapshot> {
  const res = await fetch("/api/queues");
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || res.statusText);
  }
  const raw = (await res.json()) as SmartGitSnapshot & { creators?: UserQueue[]; allOpen?: AllOpenPrItem[] };
  return normalizeSnapshot(raw);
}

export async function postRefresh(): Promise<SmartGitSnapshot> {
  const res = await fetch("/api/refresh", { method: "POST" });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || res.statusText);
  }
  const raw = (await res.json()) as SmartGitSnapshot & { creators?: UserQueue[]; allOpen?: AllOpenPrItem[] };
  return normalizeSnapshot(raw);
}

export async function patchPrSeverity(
  owner: string,
  repo: string,
  pullNumber: number,
  severity: ReviewSeverityValue,
  actorLogin?: string
): Promise<SmartGitSnapshot> {
  const res = await fetch(`/api/pr/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${pullNumber}/severity`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ severity, actorLogin: actorLogin?.trim() || undefined }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(text || res.statusText);
  }
  const raw = JSON.parse(text) as SmartGitSnapshot & { creators?: UserQueue[]; allOpen?: AllOpenPrItem[] };
  return normalizeSnapshot(raw);
}

export async function postPrPoke(
  owner: string,
  repo: string,
  pullNumber: number,
  reviewerLogin: string,
  note?: string
): Promise<SmartGitSnapshot> {
  const res = await fetch(`/api/pr/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${pullNumber}/poke`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reviewerLogin, note: note?.trim() || undefined }),
  });
  const text = await res.text();
  if (res.status === 429) {
    let nextPokeAt: string | undefined;
    try {
      const j = JSON.parse(text) as { nextPokeAt?: string };
      nextPokeAt = j.nextPokeAt;
    } catch {
      /* ignore */
    }
    throw new PokeCooldownError(nextPokeAt ?? null, text);
  }
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

export class PokeCooldownError extends Error {
  constructor(
    public readonly nextPokeAt: string | null,
    message: string
  ) {
    super(message);
    this.name = "PokeCooldownError";
  }
}
