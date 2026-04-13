import { Octokit } from "@octokit/rest";
import pino from "pino";
import { loadPrMetaForRead } from "../prMetaStore.js";
import { enrichAllOpenPr, enrichPendingItem } from "../waitTier.js";
import {
  PendingReviewKind,
  type AllOpenPrItemBase,
  type PendingReviewItem,
  type PendingReviewItemBase,
  type SmartGitSnapshot,
  type UserQueue,
} from "../types.js";

const log = pino({ name: "smartgit-fetch" });

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
    log.info({ count: repos.length }, "discovered repositories for SmartGit");
    return repos;
  }
  return parseRepos(reposEnv);
}

export async function listTeamMemberLogins(
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

type ReviewRow = {
  id?: number;
  state?: string | null;
  submitted_at?: string | null;
  user?: { login?: string | null } | null;
};

/** Latest review state per GitHub login (by submitted_at, then id). */
export function latestReviewStateByLogin(reviews: ReviewRow[]): Map<string, string> {
  const sorted = [...reviews].sort((a, b) => {
    const ta = new Date(a.submitted_at ?? 0).getTime();
    const tb = new Date(b.submitted_at ?? 0).getTime();
    if (ta !== tb) return ta - tb;
    return (a.id ?? 0) - (b.id ?? 0);
  });
  const byLogin = new Map<string, string>();
  for (const r of sorted) {
    const login = r.user?.login;
    if (!login || !r.state) continue;
    byLogin.set(login, r.state);
  }
  return byLogin;
}

export async function fetchSmartGitSnapshot(
  octokit: InstanceType<typeof Octokit>,
  reposEnv: string
): Promise<SmartGitSnapshot> {
  const prMetaMap = await loadPrMetaForRead();
  const repos = await resolveReposFromEnv(octokit, reposEnv);
  const byUser = new Map<string, PendingReviewItem[]>();
  const creatorsByUser = new Map<string, PendingReviewItem[]>();
  const userMeta = new Map<string, { avatarUrl: string }>();
  const creatorMeta = new Map<string, { avatarUrl: string }>();
  const errors: { repo: string; message: string }[] = [];
  const seenKeys = new Set<string>();
  const seenCreatorKeys = new Set<string>();
  const allOpenMap = new Map<string, AllOpenPrItemBase>();

  const addItem = (login: string, item: PendingReviewItemBase, avatarUrl: string) => {
    const enriched = enrichPendingItem(item, prMetaMap, login);
    const list = byUser.get(login) ?? [];
    const key = `${item.repoFullName}#${item.pullNumber}:${login}`;
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    list.push(enriched);
    byUser.set(login, list);
    if (!userMeta.has(login)) userMeta.set(login, { avatarUrl });
  };

  const addCreatorItem = (login: string, item: PendingReviewItemBase, avatarUrl: string) => {
    const enriched = enrichPendingItem(item, prMetaMap, undefined);
    const list = creatorsByUser.get(login) ?? [];
    const key = `${item.repoFullName}#${item.pullNumber}:author`;
    if (seenCreatorKeys.has(key)) return;
    seenCreatorKeys.add(key);
    list.push(enriched);
    creatorsByUser.set(login, list);
    if (!creatorMeta.has(login)) creatorMeta.set(login, { avatarUrl });
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

        const mergeableState =
          (pr as { mergeable_state?: string | null }).mergeable_state ?? null;

        const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
          owner,
          repo,
          pull_number: pr.number,
          per_page: 100,
        });
        const latestByLogin = latestReviewStateByLogin(reviews);
        const changesRequestedBy = [...latestByLogin.entries()]
          .filter(([, state]) => state === "CHANGES_REQUESTED")
          .map(([login]) => login)
          .sort((a, b) => a.localeCompare(b));

        const authorLogin = pr.user?.login;
        if (changesRequestedBy.length > 0 && authorLogin) {
          const creatorItem: PendingReviewItemBase = {
            repoFullName: fullName,
            pullNumber: pr.number,
            title: pr.title,
            htmlUrl: pr.html_url,
            authorLogin,
            createdAt: pr.created_at,
            updatedAt: pr.updated_at,
            draft: pr.draft ?? false,
            kind: PendingReviewKind.ChangesRequested,
            mergeableState,
            changesRequestedBy,
          };
          addCreatorItem(
            authorLogin,
            creatorItem,
            pr.user?.avatar_url ?? `https://github.com/${authorLogin}.png?size=64`
          );
        }

        const reviewers = await octokit.rest.pulls.listRequestedReviewers({
          owner,
          repo,
          pull_number: pr.number,
        });

        const baseItem: Omit<PendingReviewItemBase, "teamSlug"> = {
          repoFullName: fullName,
          pullNumber: pr.number,
          title: pr.title,
          htmlUrl: pr.html_url,
          authorLogin: pr.user?.login ?? "unknown",
          createdAt: pr.created_at,
          updatedAt: pr.updated_at,
          draft: pr.draft ?? false,
          kind: PendingReviewKind.AwaitingReview,
          mergeableState,
        };

        for (const u of reviewers.data.users) {
          if (!u.login) continue;
          addItem(u.login, { ...baseItem }, u.avatar_url);
        }

        for (const team of reviewers.data.teams) {
          if (!team.slug) continue;
          const item: PendingReviewItemBase = { ...baseItem, teamSlug: team.slug };
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

        const userReq = reviewers.data.users.map((u) => u.login).filter(Boolean) as string[];
        const teamSlugs = reviewers.data.teams.map((t) => t.slug).filter(Boolean) as string[];
        allOpenMap.set(`${fullName}#${pr.number}`, {
          repoFullName: fullName,
          pullNumber: pr.number,
          title: pr.title ?? "",
          htmlUrl: pr.html_url,
          authorLogin: pr.user?.login ?? "unknown",
          createdAt: pr.created_at,
          updatedAt: pr.updated_at,
          mergeableState,
          hasReviewRequests: userReq.length > 0 || teamSlugs.length > 0,
          requestedUserLogins: userReq,
          requestedTeamSlugs: teamSlugs,
          changesRequestedBy,
        });
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

  const creators: UserQueue[] = [...creatorsByUser.entries()]
    .map(([login, items]) => ({
      login,
      avatarUrl: creatorMeta.get(login)?.avatarUrl ?? `https://github.com/${login}.png?size=64`,
      items: items.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()),
    }))
    .sort((a, b) => a.login.localeCompare(b.login));

  const allOpen = [...allOpenMap.values()]
    .map((row) => enrichAllOpenPr(row, prMetaMap))
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  return {
    fetchedAt: new Date().toISOString(),
    allOpen,
    users,
    creators,
    errors,
  };
}
