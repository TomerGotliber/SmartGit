/** UI label: `owner/repo` → `repo` (full name stays in `title` where set). */
export function formatRepoDisplayLabel(repoFullName: string): string {
  const i = repoFullName.indexOf("/");
  if (i <= 0 || i >= repoFullName.length - 1) return repoFullName;
  return repoFullName.slice(i + 1);
}
