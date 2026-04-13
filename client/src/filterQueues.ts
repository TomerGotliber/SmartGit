import type { AllOpenPrItem, UserQueue } from "./types";

export function filterAllOpen(items: AllOpenPrItem[], filterText: string): AllOpenPrItem[] {
  const q = filterText.trim().toLowerCase();
  if (!q) return items;
  return items.filter((item) => {
    const sev = item.severity?.toLowerCase() ?? "";
    const reqUsers = item.requestedUserLogins.some((l) => l.toLowerCase().includes(q));
    const reqTeams = item.requestedTeamSlugs.some((t) => t.toLowerCase().includes(q));
    const chg = item.changesRequestedBy.some((l) => l.toLowerCase().includes(q));
    return (
      item.title.toLowerCase().includes(q) ||
      item.repoFullName.toLowerCase().includes(q) ||
      item.authorLogin.toLowerCase().includes(q) ||
      String(item.pullNumber).includes(q) ||
      (sev && sev.includes(q)) ||
      reqUsers ||
      reqTeams ||
      chg ||
      (q.includes("review") && item.hasReviewRequests) ||
      (q.includes("change") && item.changesRequestedBy.length > 0)
    );
  });
}

export function filterQueues(users: UserQueue[], focusLogins: Set<string>, filterText: string): UserQueue[] {
  const q = filterText.trim().toLowerCase();
  return users
    .filter((u) => u.items.length > 0)
    .filter((u) => focusLogins.size === 0 || focusLogins.has(u.login))
    .map((u) => {
      if (!q) return u;
      const items = u.items.filter((item) => {
        const byReviewer =
          item.changesRequestedBy?.some((login) => login.toLowerCase().includes(q)) ?? false;
        const sev = item.severity?.toLowerCase() ?? "";
        return (
          item.title.toLowerCase().includes(q) ||
          item.repoFullName.toLowerCase().includes(q) ||
          item.authorLogin.toLowerCase().includes(q) ||
          item.kind.toLowerCase().includes(q) ||
          String(item.pullNumber).includes(q) ||
          u.login.toLowerCase().includes(q) ||
          (sev && sev.includes(q)) ||
          byReviewer
        );
      });
      return { ...u, items };
    })
    .filter((u) => u.items.length > 0);
}
