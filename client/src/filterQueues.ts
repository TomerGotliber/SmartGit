import type { UserQueue } from "./types";

export function filterQueues(
  users: UserQueue[],
  focusLogins: Set<string>,
  onlyLogin: string | null,
  focusRepos: Set<string>,
  focusProjects?: Set<string>
): UserQueue[] {
  return users
    .filter((u) => u.items.length > 0)
    .filter((u) => {
      if (onlyLogin) return u.login.toLowerCase() === onlyLogin.toLowerCase();
      return focusLogins.size === 0 || focusLogins.has(u.login);
    })
    .map((u) => {
      let items = u.items;
      if (focusRepos.size > 0) items = items.filter((item) => focusRepos.has(item.repoFullName));
      if (focusProjects && focusProjects.size > 0) {
        items = items.filter((item) => (item.projects ?? []).some((p) => focusProjects.has(p)));
      }
      return { ...u, items };
    })
    .filter((u) => u.items.length > 0);
}
