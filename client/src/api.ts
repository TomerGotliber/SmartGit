import type { ReviewQueuesSnapshot, UserQueue } from "./types";

export async function fetchQueues(): Promise<ReviewQueuesSnapshot> {
  const res = await fetch("/api/queues");
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || res.statusText);
  }
  const raw = (await res.json()) as ReviewQueuesSnapshot & { creators?: UserQueue[] };
  return { ...raw, creators: raw.creators ?? [] };
}

export async function postRefresh(): Promise<ReviewQueuesSnapshot> {
  const res = await fetch("/api/refresh", { method: "POST" });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || res.statusText);
  }
  const raw = (await res.json()) as ReviewQueuesSnapshot & { creators?: UserQueue[] };
  return { ...raw, creators: raw.creators ?? [] };
}
