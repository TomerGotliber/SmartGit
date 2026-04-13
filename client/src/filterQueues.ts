import type { UserQueue } from "./types";

export function filterQueues(
  users: UserQueue[],
  focusLogins: Set<string>,
  onlyLogin: string | null,
  focusRepos: Set<string>
): UserQueue[] {
  return users
    .filter((u) => u.items.length > 0)
    .filter((u) => {
      if (onlyLogin) return u.login.toLowerCase() === onlyLogin.toLowerCase();
      return focusLogins.size === 0 || focusLogins.has(u.login);
    })
    .map((u) => {
      const items =
        focusRepos.size > 0 ? u.items.filter((item) => focusRepos.has(item.repoFullName)) : u.items;
      return { ...u, items };
    })
    .filter((u) => u.items.length > 0);
}
