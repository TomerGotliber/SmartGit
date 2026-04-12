import type { UserQueue } from "./types";

export function filterQueues(users: UserQueue[], focusLogins: Set<string>, filterText: string): UserQueue[] {
  const q = filterText.trim().toLowerCase();
  return users
    .filter((u) => u.items.length > 0)
    .filter((u) => focusLogins.size === 0 || focusLogins.has(u.login))
    .map((u) => {
      if (!q) return u;
      const items = u.items.filter(
        (item) =>
          item.title.toLowerCase().includes(q) ||
          item.repoFullName.toLowerCase().includes(q) ||
          item.authorLogin.toLowerCase().includes(q) ||
          String(item.pullNumber).includes(q) ||
          u.login.toLowerCase().includes(q)
      );
      return { ...u, items };
    })
    .filter((u) => u.items.length > 0);
}
