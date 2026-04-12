import { Octokit } from "@octokit/rest";
import pino from "pino";
import type { PendingReviewItem, ReviewQueuesSnapshot, UserQueue } from "../types.js";

const log = pino({ name: "fetchQueues" });

function parseRepos(raw: string): { owner: string; repo: string; fullName: string }[] {
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((fullName) => {
      const parts = fullName.split("/");
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        throw new Error(`Invalid repo "${fullName}". Use owner/repo format.`);
      }
      return { owner: parts[0], repo: parts[1], fullName };
    });
}

function isDiscoverAllRepos(raw: string): boolean {
  const t = raw.trim();
  return t === "*" || /^ALL$/i.test(t);
}

/** Repos the token can use with pull access (via /user/repos). Skips archived. */
export async function resolveReposFromEnv(
  octokit: InstanceType<typeof Octokit>,
  reposEnv: string
): Promise<{ owner: string; repo: string; fullName: string }[]> {
  if (isDiscoverAllRepos(reposEnv)) {
    log.info("REPOS is '*' or ALL: listing repositories accessible to this token");
    const listed = await octokit.paginate(octokit.rest.repos.listForAuthenticatedUser, {
      affiliation: "owner,collaborator,organization_member",
      per_page: 100,
      sort: "updated",
    });
    const repos: { owner: string; repo: string; fullName: string }[] = [];
    for (const r of listed) {
      if (r.archived) continue;
      const fullName = r.full_name;
      if (!fullName) continue;
      const slash = fullName.indexOf("/");
      if (slash <= 0 || slash >= fullName.length - 1) continue;
      repos.push({
        owner: fullName.slice(0, slash),
        repo: fullName.slice(slash + 1),
        fullName,
      });
    }
    log.info({ count: repos.length }, "discovered repositories for review queue");
    return repos;
  }
  return parseRepos(reposEnv);
}

async function listTeamMemberLogins(
  octokit: InstanceType<typeof Octokit>,
  org: string,
  teamSlug: string
): Promise<string[]> {
  const logins: string[] = [];
  for await (const res of octokit.paginate.iterator(octokit.rest.teams.listMembersInOrg, {
    org,
    team_slug: teamSlug,
    per_page: 100,
  })) {
    for (const m of res.data) {
      if (m.login) logins.push(m.login);
    }
  }
  return logins;
}

export async function fetchReviewQueues(
  octokit: InstanceType<typeof Octokit>,
  reposEnv: string
): Promise<ReviewQueuesSnapshot> {
  const repos = await resolveReposFromEnv(octokit, reposEnv);
  const byUser = new Map<string, PendingReviewItem[]>();
  const userMeta = new Map<string, { avatarUrl: string }>();
  const errors: { repo: string; message: string }[] = [];
  const seenKeys = new Set<string>();

  const addItem = (login: string, item: PendingReviewItem, avatarUrl: string) => {
    const list = byUser.get(login) ?? [];
    const key = `${item.repoFullName}#${item.pullNumber}:${login}`;
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    list.push(item);
    byUser.set(login, list);
    if (!userMeta.has(login)) userMeta.set(login, { avatarUrl });
  };

  for (const { owner, repo, fullName } of repos) {
    try {
      const pulls = await octokit.paginate(octokit.rest.pulls.list, {
        owner,
        repo,
        state: "open",
        per_page: 100,
      });

      for (const pr of pulls) {
        if (pr.draft) continue;

        const reviewers = await octokit.rest.pulls.listRequestedReviewers({
          owner,
          repo,
          pull_number: pr.number,
        });

        const baseItem: Omit<PendingReviewItem, "teamSlug"> = {
          repoFullName: fullName,
          pullNumber: pr.number,
          title: pr.title,
          htmlUrl: pr.html_url,
          authorLogin: pr.user?.login ?? "unknown",
          createdAt: pr.created_at,
          updatedAt: pr.updated_at,
          draft: pr.draft ?? false,
        };

        for (const u of reviewers.data.users) {
          if (!u.login) continue;
          addItem(u.login, { ...baseItem }, u.avatar_url);
        }

        for (const team of reviewers.data.teams) {
          if (!team.slug) continue;
          const item: PendingReviewItem = { ...baseItem, teamSlug: team.slug };
          try {
            const members = await listTeamMemberLogins(octokit, owner, team.slug);
            if (members.length === 0) {
              log.warn({ repo: fullName, pr: pr.number, team: team.slug }, "team has no listed members");
              continue;
            }
            for (const login of members) {
              addItem(login, { ...item }, `https://github.com/${login}.png?size=64`);
            }
          } catch (e) {
            log.warn(
              { err: e, repo: fullName, team: team.slug },
              "could not expand team members; skipping team request"
            );
          }
        }
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      log.error({ repo: fullName, err: message }, "failed to fetch repo pulls");
      errors.push({ repo: fullName, message });
    }
  }

  const users: UserQueue[] = [...byUser.entries()]
    .map(([login, items]) => ({
      login,
      avatarUrl: userMeta.get(login)?.avatarUrl ?? `https://github.com/${login}.png?size=64`,
      items: items.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()),
    }))
    .sort((a, b) => a.login.localeCompare(b.login));

  return {
    fetchedAt: new Date().toISOString(),
    users,
    errors,
  };
}
