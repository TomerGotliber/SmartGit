import type { Octokit } from "@octokit/rest";
import { latestReviewStateByLogin, listTeamMemberLogins } from "./github/fetchQueues.js";

export async function verifyReviewerMayBePoked(
  octokit: InstanceType<typeof Octokit>,
  owner: string,
  repo: string,
  pullNumber: number,
  reviewerLogin: string
): Promise<boolean> {
  const { data } = await octokit.pulls.listRequestedReviewers({
    owner,
    repo,
    pull_number: pullNumber,
  });
  for (const u of data.users) {
    if (u.login === reviewerLogin) return true;
  }
  for (const team of data.teams) {
    if (!team.slug) continue;
    const members = await listTeamMemberLogins(octokit, owner, team.slug);
    if (members.includes(reviewerLogin)) return true;
  }
  const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
    owner,
    repo,
    pull_number: pullNumber,
    per_page: 100,
  });
  const latest = latestReviewStateByLogin(reviews);
  return latest.get(reviewerLogin) === "CHANGES_REQUESTED";
}
