import type { ReviewQueuesSnapshot } from "./types";

export async function fetchQueues(): Promise<ReviewQueuesSnapshot> {
  const res = await fetch("/api/queues");
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || res.statusText);
  }
  return res.json() as Promise<ReviewQueuesSnapshot>;
}

export async function postRefresh(): Promise<ReviewQueuesSnapshot> {
  const res = await fetch("/api/refresh", { method: "POST" });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || res.statusText);
  }
  return res.json() as Promise<ReviewQueuesSnapshot>;
}
