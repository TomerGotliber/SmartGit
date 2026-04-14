import { Octokit } from "@octokit/rest";
import pino from "pino";
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

const VERSION_LABEL_RE = /^\d+\.\d+(?:\.\d+)?(?:[-+][\w.-]+)?$/;

function extractLabelsFromPr(pr: { labels?: ({ name?: string | null } | string)[] | null }): string[] {
  const labels = pr.labels ?? [];
  const out: string[] = [];
  for (const l of labels) {
    const name = typeof l === "string" ? l : l.name;
    if (name && VERSION_LABEL_RE.test(name)) out.push(name);
  }
  return out;
}

/** Resolved once per process; token user for client “my dashboard”. */
let cachedTokenLogin: string | null | undefined;

async function resolveTokenActorLogin(octokit: InstanceType<typeof Octokit>): Promise<string | null> {
  if (cachedTokenLogin !== undefined) return cachedTokenLogin;
  try {
    const { data } = await octokit.rest.users.getAuthenticated();
    cachedTokenLogin = data.login ?? null;
  } catch (e) {
    log.warn({ err: e }, "could not resolve GitHub token login (getAuthenticated)");
    cachedTokenLogin = null;
  }
  return cachedTokenLogin;
}

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

/** Strip BOM, outer quotes (common in .env), trim. */
function normalizeReposExcludeRaw(raw: string): string {
  let s = raw.replace(/^\uFEFF/, "").trim();
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

function stripTokenQuotes(token: string): string {
  const t = token.trim();
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    return t.slice(1, -1).trim();
  }
  return t;
}

/** Entries: `owner/repo` (full match) or a single segment (match repo name for any owner). Case-insensitive. */
function parseReposExclude(raw: string): {
  isExcluded: (fullName: string, repo: string) => boolean;
} {
  const fullNames = new Set<string>();
  const repoSlugs = new Set<string>();
  const normalized = normalizeReposExcludeRaw(raw);
  for (const part of normalized
    .split(/[\s,;]+/)
    .map((s) => stripTokenQuotes(s).toLowerCase())
    .filter(Boolean)) {
    if (part.includes("/")) {
      const [o, ...rest] = part.split("/");
      const r = rest.join("/");
      if (o && r) fullNames.add(`${o}/${r}`);
    } else {
      repoSlugs.add(part);
    }
  }
  return {
    isExcluded: (fullName: string, repo: string) => {
      if (fullNames.has(fullName.toLowerCase())) return true;
      if (repoSlugs.has(repo.toLowerCase())) return true;
      return false;
    },
  };
}

/** Repo slug excluded everywhere so this dashboard does not list the SmartGit app repo under any owner (e.g. user/SmartGit). */
const BUILTIN_EXCLUDED_REPO_SLUGS = new Set(["smartgit"]);

function withBuiltinRepoExcludes(parsed: ReturnType<typeof parseReposExclude>): {
  isExcluded: (fullName: string, repo: string) => boolean;
} {
  return {
    isExcluded: (fullName: string, repo: string) => {
      if (BUILTIN_EXCLUDED_REPO_SLUGS.has(repo.toLowerCase())) return true;
      return parsed.isExcluded(fullName, repo);
    },
  };
}

function isDiscoverAllRepos(raw: string): boolean {
  const t = raw.trim();
  return t === "*" || /^ALL$/i.test(t);
}

export type SnapshotEnvOptions = {
  /** When set (including ""), used instead of `process.env.REPOS_EXCLUDE` for this snapshot. */
  reposExcludeRaw?: string;
};

/** Repos the token can use with pull access (via /user/repos). Skips archived. */
export async function resolveReposFromEnv(
  octokit: InstanceType<typeof Octokit>,
  reposEnv: string,
  reposExcludeRawOverride?: string
): Promise<{ owner: string; repo: string; fullName: string }[]> {
  const excludeRaw = normalizeReposExcludeRaw(
    reposExcludeRawOverride !== undefined ? reposExcludeRawOverride : (process.env.REPOS_EXCLUDE ?? "")
  );
  const { isExcluded } = withBuiltinRepoExcludes(parseReposExclude(excludeRaw));

  if (isDiscoverAllRepos(reposEnv)) {
    log.info("REPOS is '*' or ALL: listing repositories accessible to this token");
    const listed = await octokit.paginate(octokit.rest.repos.listForAuthenticatedUser, {
      affiliation: "owner,collaborator,organization_member",
      per_page: 100,
      sort: "updated",
    });
    const repos: { owner: string; repo: string; fullName: string }[] = [];
    let skippedExclude = 0;
    for (const r of listed) {
      if (r.archived) continue;
      const fullName = r.full_name;
      if (!fullName) continue;
      const slash = fullName.indexOf("/");
      if (slash <= 0 || slash >= fullName.length - 1) continue;
      const owner = fullName.slice(0, slash);
      const repo = fullName.slice(slash + 1);
      if (isExcluded(fullName, repo)) {
        skippedExclude += 1;
        continue;
      }
      repos.push({ owner, repo, fullName });
    }
    if (excludeRaw.trim()) {
      log.info({ count: repos.length, skippedExclude }, "discovered repositories for SmartGit (after REPOS_EXCLUDE)");
    } else {
      log.info({ count: repos.length }, "discovered repositories for SmartGit");
    }
    return repos;
  }
  const explicit = parseRepos(reposEnv);
  return explicit.filter((e) => {
    if (isExcluded(e.fullName, e.repo)) {
      log.info({ fullName: e.fullName }, "skipping repo (REPOS_EXCLUDE)");
      return false;
    }
    return true;
  });
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

/** Review states that supersede one another for merge / author-queue purposes (GitHub REST). */
const SUBSTANTIVE_REVIEW_STATES = new Set(["APPROVED", "CHANGES_REQUESTED", "DISMISSED"]);

/**
 * Newest substantive review per GitHub login (approve / request changes / dismiss).
 * Ignores `COMMENTED` and `PENDING` so a follow-up “comment only” review does not erase an
 * earlier “request changes” — matching how GitHub still blocks merge until addressed.
 */
export function latestReviewStateByLogin(reviews: ReviewRow[]): Map<string, string> {
  const sorted = [...reviews].sort((a, b) => {
    const ta = new Date(a.submitted_at ?? 0).getTime();
    const tb = new Date(b.submitted_at ?? 0).getTime();
    if (tb !== ta) return tb - ta;
    return (b.id ?? 0) - (a.id ?? 0);
  });
  const byLogin = new Map<string, string>();
  for (const r of sorted) {
    const login = r.user?.login;
    const state = r.state;
    if (!login || !state) continue;
    if (!SUBSTANTIVE_REVIEW_STATES.has(state)) continue;
    if (byLogin.has(login)) continue;
    byLogin.set(login, state);
  }
  return byLogin;
}

export async function fetchSmartGitSnapshot(
  octokit: InstanceType<typeof Octokit>,
  reposEnv: string,
  envOptions?: SnapshotEnvOptions
): Promise<SmartGitSnapshot> {
  const reposExcludeRaw =
    envOptions?.reposExcludeRaw !== undefined
      ? envOptions.reposExcludeRaw
      : (process.env.REPOS_EXCLUDE ?? "");
  const repos = await resolveReposFromEnv(octokit, reposEnv, reposExcludeRaw);
  const byUser = new Map<string, PendingReviewItem[]>();
  const creatorsByUser = new Map<string, PendingReviewItem[]>();
  const userMeta = new Map<string, { avatarUrl: string }>();
  const creatorMeta = new Map<string, { avatarUrl: string }>();
  const errors: { repo: string; message: string }[] = [];
  const seenKeys = new Set<string>();
  const seenCreatorKeys = new Set<string>();
  const allOpenMap = new Map<string, AllOpenPrItemBase>();

  const addItem = (login: string, item: PendingReviewItemBase, avatarUrl: string) => {
    const enriched = enrichPendingItem(item, login);
    const list = byUser.get(login) ?? [];
    const key = `${item.repoFullName}#${item.pullNumber}:${login}`;
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    list.push(enriched);
    byUser.set(login, list);
    if (!userMeta.has(login)) userMeta.set(login, { avatarUrl });
  };

  const addCreatorItem = (login: string, item: PendingReviewItemBase, avatarUrl: string) => {
    const enriched = enrichPendingItem(item, undefined);
    const list = creatorsByUser.get(login) ?? [];
    const key = `${item.repoFullName}#${item.pullNumber}:author`;
    if (seenCreatorKeys.has(key)) return;
    seenCreatorKeys.add(key);
    list.push(enriched);
    creatorsByUser.set(login, list);
    if (!creatorMeta.has(login)) creatorMeta.set(login, { avatarUrl });
  };

  const REPO_CONCURRENCY = 6;
  const PR_CONCURRENCY = 8;

  async function processPr(
    pr: Awaited<ReturnType<typeof octokit.rest.pulls.list>>["data"][number],
    owner: string,
    repo: string,
    fullName: string
  ) {
    const mergeableState =
      (pr as { mergeable_state?: string | null }).mergeable_state ?? null;
    const baseRef = pr.base?.ref?.trim() || null;
    const projects = extractLabelsFromPr(pr);

    if (pr.draft) {
      allOpenMap.set(`${fullName}#${pr.number}`, {
        repoFullName: fullName,
        pullNumber: pr.number,
        title: pr.title ?? "",
        htmlUrl: pr.html_url,
        authorLogin: pr.user?.login ?? "unknown",
        createdAt: pr.created_at,
        updatedAt: pr.updated_at,
        mergeableState,
        baseRef,
        hasReviewRequests: false,
        requestedUserLogins: [],
        requestedTeamSlugs: [],
        changesRequestedBy: [],
        projects,
      });
      return;
    }

    const [reviews, reviewers] = await Promise.all([
      octokit.paginate(octokit.rest.pulls.listReviews, {
        owner,
        repo,
        pull_number: pr.number,
        per_page: 100,
      }),
      octokit.rest.pulls.listRequestedReviewers({ owner, repo, pull_number: pr.number }),
    ]);

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
        baseRef,
        changesRequestedBy,
        projects,
      };
      addCreatorItem(
        authorLogin,
        creatorItem,
        pr.user?.avatar_url ?? `https://github.com/${authorLogin}.png?size=64`
      );
    }

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
      baseRef,
      projects,
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
      baseRef,
      hasReviewRequests: userReq.length > 0 || teamSlugs.length > 0,
      requestedUserLogins: userReq,
      requestedTeamSlugs: teamSlugs,
      changesRequestedBy,
      projects,
    });
  }

  async function processRepo(owner: string, repo: string, fullName: string) {
    try {
      const pulls = await octokit.paginate(octokit.rest.pulls.list, {
        owner,
        repo,
        state: "open",
        per_page: 100,
      });
      log.info({ repo: fullName, prs: pulls.length }, "processing repo pulls");
      let prIdx = 0;
      async function prWorker() {
        while (true) {
          const j = prIdx++;
          if (j >= pulls.length) return;
          await processPr(pulls[j]!, owner, repo, fullName);
        }
      }
      await Promise.all(Array.from({ length: PR_CONCURRENCY }, () => prWorker()));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      log.error({ repo: fullName, err: message }, "failed to fetch repo pulls");
      errors.push({ repo: fullName, message });
    }
  }

  let repoIdx = 0;
  async function repoWorker() {
    while (true) {
      const i = repoIdx++;
      if (i >= repos.length) return;
      const { owner, repo, fullName } = repos[i]!;
      await processRepo(owner, repo, fullName);
    }
  }
  await Promise.all(Array.from({ length: REPO_CONCURRENCY }, () => repoWorker()));

  const users: UserQueue[] = [...byUser.entries()]
    .map(([login, items]) => ({
      login,
      avatarUrl: userMeta.get(login)?.avatarUrl ?? `https://github.com/${login}.png?size=64`,
      items: items
        .map((i) => ({ ...i, rowReviewerLogin: login }))
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()),
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
    .map((row) => enrichAllOpenPr(row))
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  const actorLogin = await resolveTokenActorLogin(octokit);
  log.info(
    {
      repoCount: repos.length,
      reposExcludeActive: Boolean(normalizeReposExcludeRaw(reposExcludeRaw).trim()),
    },
    "snapshot repo list (this refresh)"
  );

  return {
    fetchedAt: new Date().toISOString(),
    actorLogin,
    allOpen,
    users,
    creators,
    errors,
  };
}
