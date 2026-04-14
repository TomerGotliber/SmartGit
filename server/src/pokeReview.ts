import type { Octokit } from "@octokit/rest";
import { latestReviewStateByLogin, listTeamMemberLogins } from "./github/fetchQueues.js";

/** True if `targetLogin` is the PR author (case-insensitive). */
export async function verifyAuthorMayBePoked(
  octokit: InstanceType<typeof Octokit>,
  owner: string,
  repo: string,
  pullNumber: number,
  targetLogin: string
): Promise<boolean> {
  const { data: pr } = await octokit.pulls.get({ owner, repo, pull_number: pullNumber });
  const author = pr.user?.login;
  if (!author) return false;
  return author.toLowerCase() === targetLogin.toLowerCase();
}

export async function verifyReviewerMayBePoked(
  octokit: InstanceType<typeof Octokit>,
  owner: string,
  repo: string,
  pullNumber: number,
  reviewerLogin: string
): Promise<boolean> {
  const target = reviewerLogin.toLowerCase();
  const { data } = await octokit.pulls.listRequestedReviewers({
    owner,
    repo,
    pull_number: pullNumber,
  });
  for (const u of data.users) {
    if (u.login?.toLowerCase() === target) return true;
  }
  for (const team of data.teams) {
    if (!team.slug) continue;
    const members = await listTeamMemberLogins(octokit, owner, team.slug);
    if (members.some((m) => m.toLowerCase() === target)) return true;
  }
  const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
    owner,
    repo,
    pull_number: pullNumber,
    per_page: 100,
  });
  const latest = latestReviewStateByLogin(reviews);
  for (const [login, state] of latest.entries()) {
    if (login.toLowerCase() === target && state === "CHANGES_REQUESTED") return true;
  }
  return false;
}
