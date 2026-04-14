import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchQueues, postRefresh } from "./api";
import { BranchTreeModal } from "./BranchTreeModal";
import { filterQueues } from "./filterQueues";
import { formatRepoDisplayLabel } from "./repoDisplay";
import type { SmartGitSnapshot, UserQueue } from "./types";
import { UserColumn } from "./UserColumn";

const POLL_MS = 60_000;
const ACTOR_LOGIN_STORAGE_KEY = "smartgit-github-login";

const TEAMS: { name: string; repos: string[] }[] = [
  {
    name: "CORE",
    repos: [
      "CameraDevOps",
      "SmartCameras",
      "CameraK8S",
      "CorDBSync",
      "SmartCamerasKPI",
      "SCToolShed",
      "CorsightCICD",
      "CameraEngine",
      "FortifyWeb",
    ],
  },
  { name: "Research", repos: ["CorsightTraining", "CameraEngine", "CameraResearch", "SmartCamerasKPI"] },
];

const FILTERS_STORAGE_KEY = "smartgit-filters-v1";

type PersistedFilters = {
  focusRepos?: string[];
  focusLogins?: string[];
  onlyMe?: string | null;
  myViewOnly?: boolean;
  activeTeam?: string | null;
};

function loadPersistedFilters(): PersistedFilters {
  try {
    const raw = localStorage.getItem(FILTERS_STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as PersistedFilters;
  } catch {
    return {};
  }
}

function formatFetchedAt(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });
  } catch {
    return iso;
  }
}

type QueueChipVariant = "reviewer" | "creator" | "both";

function QueueUserChip({
  u,
  meNormalized,
  variant,
  onlyMe,
  columnFocused,
  onToggleColumnFocus,
  onMeAvatar,
  displayItemCount,
}: {
  u: UserQueue;
  meNormalized: string;
  variant: QueueChipVariant;
  onlyMe: string | null;
  columnFocused: boolean;
  onToggleColumnFocus: (login: string) => void;
  onMeAvatar: () => void;
  /** Total items when merging author + reviewer queues for one chip. */
  displayItemCount?: number;
}) {
  const isMe = Boolean(meNormalized && u.login.toLowerCase() === meNormalized);
  const active = isMe ? Boolean(onlyMe) || columnFocused : Boolean(!onlyMe && columnFocused);
  const count = displayItemCount ?? u.items.length;
  const base =
    variant === "creator" ? "chip chip--creator" : variant === "both" ? "chip chip--both-boards" : "chip";
  const focusTitle =
    variant === "both"
      ? `Show only @${u.login} on author and reviewer boards`
      : `Show only @${u.login}`;

  if (isMe) {
    return (
      <div
        className={`${base} chip--split chip--me ${active ? "chip--active" : ""}`}
        role="group"
        aria-label={`@${u.login}`}
      >
        <button
          type="button"
          className="chip-avatar-btn"
          onClick={onMeAvatar}
          disabled={!meNormalized}
          title={
            meNormalized
              ? "My dashboard: show only your author and reviewer columns"
              : "Token login unavailable"
          }
          aria-pressed={Boolean(onlyMe)}
        >
          <img src={u.avatarUrl} alt="" className="chip-avatar" width={22} height={22} />
        </button>
        <button
          type="button"
          className="chip-body-btn"
          onClick={() => onToggleColumnFocus(u.login)}
          title={`Focus @${u.login} column (without my dashboard)`}
        >
          @{u.login}
          <span className="chip-count">{count}</span>
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      className={`${base} ${active ? "chip--active" : ""}`}
      onClick={() => onToggleColumnFocus(u.login)}
      title={focusTitle}
    >
      <img src={u.avatarUrl} alt="" className="chip-avatar" width={22} height={22} />
      @{u.login}
      <span className="chip-count">{count}</span>
    </button>
  );
}

export function App() {
  const [data, setData] = useState<SmartGitSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wallMode, setWallMode] = useState(false);
  const persisted = useMemo(() => loadPersistedFilters(), []);
  const [focusLogins, setFocusLogins] = useState<Set<string>>(() => new Set(persisted.focusLogins ?? []));
  const [myViewOnly, setMyViewOnly] = useState(() => Boolean(persisted.myViewOnly));
  const [focusRepos, setFocusRepos] = useState<Set<string>>(() => new Set(persisted.focusRepos ?? []));
  const [activeTeam, setActiveTeam] = useState<string | null>(() => persisted.activeTeam ?? null);
  const [branchRepo, setBranchRepo] = useState<string | null>(null);

  useEffect(() => {
    try {
      const payload: PersistedFilters = {
        focusRepos: Array.from(focusRepos),
        focusLogins: Array.from(focusLogins),
        myViewOnly,
        activeTeam,
      };
      localStorage.setItem(FILTERS_STORAGE_KEY, JSON.stringify(payload));
    } catch {
      /* ignore */
    }
  }, [focusRepos, focusLogins, myViewOnly, activeTeam]);
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    const a = data?.actorLogin?.trim();
    if (!a) return;
    try {
      localStorage.setItem(ACTOR_LOGIN_STORAGE_KEY, a);
    } catch {
      /* ignore */
    }
  }, [data?.actorLogin]);

  const load = useCallback(async () => {
    try {
      setError(null);
      const snap = await fetchQueues();
      setData(snap);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      const snap = await postRefresh();
      setData(snap);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const id = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(id);
  }, [load]);

  useEffect(() => {
    document.documentElement.classList.toggle("wall-screen", wallMode);
    return () => document.documentElement.classList.remove("wall-screen");
  }, [wallMode]);

  useEffect(() => {
    const onFs = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) {
      void document.documentElement.requestFullscreen();
    } else {
      void document.exitFullscreen();
    }
  }, []);

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const tag = (ev.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || (ev.target as HTMLElement)?.isContentEditable) return;
      if (ev.key === "f" || ev.key === "F") {
        ev.preventDefault();
        toggleFullscreen();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleFullscreen]);

  const users = data?.users ?? [];
  const creators = data?.creators ?? [];
  const usersWithWork = useMemo(() => users.filter((u) => u.items.length > 0), [users]);
  const creatorsWithWork = useMemo(() => creators.filter((u) => u.items.length > 0), [creators]);

  const { repoNames, repoCounts } = useMemo(() => {
    const seenPr = new Set<string>();
    const counts = new Map<string, number>();
    const bump = (repo: string, pullNumber: number) => {
      const k = `${repo}#${pullNumber}`;
      if (seenPr.has(k)) return;
      seenPr.add(k);
      counts.set(repo, (counts.get(repo) ?? 0) + 1);
    };
    for (const u of users) for (const i of u.items) bump(i.repoFullName, i.pullNumber);
    for (const u of creators) for (const i of u.items) bump(i.repoFullName, i.pullNumber);
    const names = Array.from(counts.keys()).sort((a, b) => a.localeCompare(b));
    return { repoNames: names, repoCounts: counts };
  }, [users, creators]);

  const visibleRepoNames = useMemo(() => {
    if (!activeTeam) return repoNames;
    const team = TEAMS.find((t) => t.name === activeTeam);
    if (!team) return repoNames;
    const wanted = new Set(team.repos.map((n) => n.toLowerCase()));
    return repoNames.filter((full) => {
      const short = full.includes("/") ? full.split("/")[1]! : full;
      return wanted.has(short.toLowerCase());
    });
  }, [repoNames, activeTeam]);

  useEffect(() => {
    const valid = new Set(repoNames);
    setFocusRepos((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set<string>();
      for (const r of prev) if (valid.has(r)) next.add(r);
      return next.size === prev.size ? prev : next;
    });
  }, [repoNames]);

  const meNormalized = (data?.actorLogin ?? "").trim().toLowerCase();
  const onlyMe = myViewOnly && meNormalized ? meNormalized : null;

  const effectiveFocusRepos = useMemo(() => {
    if (!activeTeam) return focusRepos;
    const teamSet = new Set(visibleRepoNames);
    if (focusRepos.size === 0) return teamSet;
    const intersected = new Set<string>();
    for (const r of focusRepos) if (teamSet.has(r)) intersected.add(r);
    return intersected.size > 0 ? intersected : teamSet;
  }, [activeTeam, focusRepos, visibleRepoNames]);

  const visibleUsers = useMemo(
    () => filterQueues(users, focusLogins, onlyMe, effectiveFocusRepos),
    [users, focusLogins, onlyMe, effectiveFocusRepos]
  );

  const visibleCreators = useMemo(
    () => filterQueues(creators, focusLogins, onlyMe, effectiveFocusRepos),
    [creators, focusLogins, onlyMe, effectiveFocusRepos]
  );

  const peopleForChips = useMemo(() => {
    const byLogin = new Map<string, { avatarUrl: string; authorCount: number; reviewerCount: number }>();
    for (const u of creatorsWithWork) {
      byLogin.set(u.login, { avatarUrl: u.avatarUrl, authorCount: u.items.length, reviewerCount: 0 });
    }
    for (const u of usersWithWork) {
      const cur = byLogin.get(u.login);
      if (cur) {
        cur.reviewerCount = u.items.length;
      } else {
        byLogin.set(u.login, { avatarUrl: u.avatarUrl, authorCount: 0, reviewerCount: u.items.length });
      }
    }
    return [...byLogin.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([login, v]) => {
        const variant: QueueChipVariant =
          v.authorCount > 0 && v.reviewerCount > 0 ? "both" : v.authorCount > 0 ? "creator" : "reviewer";
        return {
          login,
          avatarUrl: v.avatarUrl,
          variant,
          displayCount: v.authorCount + v.reviewerCount,
        };
      });
  }, [creatorsWithWork, usersWithWork]);

  const totalReviewerPending = usersWithWork.reduce((n, u) => n + u.items.length, 0);
  const visibleReviewerPending = visibleUsers.reduce((n, u) => n + u.items.length, 0);
  const totalCreatorPending = creatorsWithWork.reduce((n, u) => n + u.items.length, 0);
  const visibleCreatorPending = visibleCreators.reduce((n, u) => n + u.items.length, 0);

  const hasAnything = totalReviewerPending > 0 || totalCreatorPending > 0;
  const hasVisibleSomething = visibleReviewerPending > 0 || visibleCreatorPending > 0;
  const filterActive = focusLogins.size > 0 || focusRepos.size > 0 || Boolean(onlyMe);
  const filterHidesEverything = hasAnything && !hasVisibleSomething && filterActive;

  const toggleMeDashboardAvatar = useCallback(() => {
    if (!meNormalized) return;
    setMyViewOnly((wasOn) => {
      if (!wasOn) setFocusLogins(new Set());
      return !wasOn;
    });
  }, [meNormalized]);

  const toggleFocusLogin = useCallback((login: string) => {
    setMyViewOnly(false);
    setFocusLogins((prev) => {
      const next = new Set(prev);
      if (next.has(login)) next.delete(login);
      else next.add(login);
      return next;
    });
  }, []);

  const clearFocus = useCallback(() => {
    setMyViewOnly(false);
    setFocusLogins(new Set());
  }, []);

  const clearAllFilters = useCallback(() => {
    setFocusLogins(new Set());
    setFocusRepos(new Set());
    setMyViewOnly(false);
  }, []);

  const clearRepoFocus = useCallback(() => setFocusRepos(new Set()), []);

  const toggleTeam = useCallback((teamName: string) => {
    setActiveTeam((prev) => (prev === teamName ? null : teamName));
    setFocusRepos(new Set());
  }, []);

  const toggleFocusRepo = useCallback((repo: string) => {
    setFocusRepos((prev) => {
      const next = new Set(prev);
      if (next.has(repo)) next.delete(repo);
      else next.add(repo);
      return next;
    });
  }, []);

  if (loading && !data) {
    return (
      <div className="app-shell">
        <div className="state-center">
          <div className="spinner" aria-hidden />
          <p>Loading SmartGit…</p>
        </div>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="app-shell">
        <div className="state-center error">
          <p>{error}</p>
          <p style={{ marginTop: "1rem" }}>
            <button type="button" className="btn btn-primary" onClick={() => void load()}>
              Retry
            </button>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <h1 className="app-title">SmartGit</h1>
          <p className={`app-sub ${wallMode ? "app-sub--compact" : ""}`}>
            {wallMode
              ? "Click your avatar on your chip for my dashboard. Press F for fullscreen."
              : data?.actorLogin
                ? "People chips filter author and reviewer boards together. Click your avatar (not @name) on your chip for my dashboard."
                : "People chips filter both boards. My dashboard needs the server to resolve the token’s GitHub login."}
          </p>
        </div>
        <div className="header-actions">
          {data?.fetchedAt ? (
            <span className="meta-pill" title="Last successful sync with GitHub">
              Synced {formatFetchedAt(data.fetchedAt)}
            </span>
          ) : null}
          <span className="meta-pill meta-pill--creators" title="After filters · authors">
            {visibleCreatorPending} / {totalCreatorPending} author
          </span>
          <span className="meta-pill" title="After filters · reviewers">
            {visibleReviewerPending} / {totalReviewerPending} reviewer
          </span>
          {onlyMe ? (
            <span className="meta-pill meta-pill--me" title="Only your author and reviewer columns">
              My view
            </span>
          ) : null}
          {focusRepos.size > 0 ? (
            <span
              className="meta-pill meta-pill--repo"
              title={Array.from(focusRepos)
                .sort((a, b) => a.localeCompare(b))
                .join("\n")}
            >
              {focusRepos.size} repo{focusRepos.size === 1 ? "" : "s"}
            </span>
          ) : null}
          <button
            type="button"
            className={`btn ${wallMode ? "btn-primary" : ""}`}
            onClick={() => setWallMode((v) => !v)}
            title="Larger type and controls for distance viewing"
          >
            {wallMode ? "Wall screen on" : "Wall screen"}
          </button>
          <button type="button" className="btn" onClick={() => void toggleFullscreen()} title="Keyboard: F">
            {fullscreen ? "Exit fullscreen" : "Fullscreen"}
          </button>
          <button type="button" className="btn btn-primary" disabled={refreshing} onClick={() => void onRefresh()}>
            {refreshing ? "Refreshing…" : "Refresh now"}
          </button>
        </div>
      </header>

      <div className="interactive-toolbar">
        {repoNames.length > 0 ? (
          <div className="chip-board">
            <p className="chip-board-label">Teams</p>
            <div className="reviewer-chips" role="group" aria-label="Filter by team">
              <button
                type="button"
                className={`chip chip--repo ${activeTeam === null ? "chip--active" : ""}`}
                onClick={() => {
                  setActiveTeam(null);
                  setFocusRepos(new Set());
                }}
              >
                All teams
              </button>
              {TEAMS.map((t) => {
                const teamFullNames = repoNames.filter((full) => {
                  const short = full.includes("/") ? full.split("/")[1]! : full;
                  return t.repos.map((r) => r.toLowerCase()).includes(short.toLowerCase());
                });
                return (
                  <button
                    key={t.name}
                    type="button"
                    className={`chip chip--repo ${activeTeam === t.name ? "chip--active" : ""}`}
                    onClick={() => toggleTeam(t.name)}
                    title={`Filter to ${t.name}: ${t.repos.join(", ")}`}
                  >
                    <span className="chip-repo-name">{t.name}</span>
                    <span className="chip-count">{teamFullNames.length}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}
        {repoNames.length > 0 ? (
          <div className="chip-board">
            <p className="chip-board-label">Repositories</p>
            <div className="reviewer-chips" role="group" aria-label="Filter by repository">
              <button
                type="button"
                className={`chip chip--repo ${focusRepos.size === 0 ? "chip--active" : ""}`}
                onClick={clearRepoFocus}
              >
                All repos
              </button>
              {visibleRepoNames.map((repo) => (
                <span key={repo} className="chip-repo-wrap">
                  <button
                    type="button"
                    className={`chip chip--repo ${focusRepos.has(repo) ? "chip--active" : ""}`}
                    onClick={() => toggleFocusRepo(repo)}
                    title={repo}
                  >
                    <span className="chip-repo-name">{formatRepoDisplayLabel(repo)}</span>
                    <span className="chip-count">{repoCounts.get(repo) ?? 0}</span>
                  </button>
                  <button
                    type="button"
                    className="chip-tree-btn"
                    onClick={() => setBranchRepo(repo)}
                    title="Open branches tree"
                    aria-label={`Show branch tree for ${repo}`}
                  >
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <circle cx="4" cy="3" r="1.5" />
                      <circle cx="4" cy="13" r="1.5" />
                      <circle cx="12" cy="8" r="1.5" />
                      <path d="M4 4.5v7" />
                      <path d="M4 8c4 0 6-1.5 6.5-3" />
                    </svg>
                  </button>
                </span>
              ))}
            </div>
          </div>
        ) : null}
        {peopleForChips.length > 0 ? (
          <div className="chip-board">
            <p className="chip-board-label">People</p>
            <p className="chip-board-sublabel">Same filter for author and reviewer columns</p>
            <div className="reviewer-chips" role="group" aria-label="Focus people on author and reviewer boards">
              <button
                type="button"
                className={`chip ${!onlyMe && focusLogins.size === 0 ? "chip--active" : ""}`}
                onClick={clearFocus}
              >
                All
              </button>
              {peopleForChips.map(({ login, avatarUrl, variant, displayCount }) => (
                <QueueUserChip
                  key={login}
                  u={{ login, avatarUrl, items: [] }}
                  meNormalized={meNormalized}
                  variant={variant}
                  onlyMe={onlyMe}
                  columnFocused={focusLogins.has(login)}
                  onToggleColumnFocus={toggleFocusLogin}
                  onMeAvatar={toggleMeDashboardAvatar}
                  displayItemCount={displayCount}
                />
              ))}
            </div>
          </div>
        ) : null}
      </div>

      {error ? (
        <div className="banner-error" role="alert">
          <strong>Partial error</strong>
          {error}
        </div>
      ) : null}

      {data?.errors?.length ? (
        <div className="banner-error" role="status">
          <strong>Some repositories could not be loaded</strong>
          <ul style={{ margin: "0.5rem 0 0", paddingLeft: "1.25rem" }}>
            {data.errors.map((e) => (
              <li key={e.repo}>
                <code title={e.repo}>{formatRepoDisplayLabel(e.repo)}</code>: {e.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {!hasAnything ? (
        <div className="state-center">
          <p>No open pull requests in configured repos.</p>
        </div>
      ) : filterHidesEverything ? (
        <div className="state-center">
          <p>No PRs match your repository filter, people filter, or my-dashboard filter.</p>
          <p style={{ marginTop: "1rem" }}>
            <button type="button" className="btn" onClick={clearAllFilters}>
              Clear filters
            </button>
          </p>
        </div>
      ) : (
        <div className="board-split">
          <div className="board-split__pane board-split__authors">
            {visibleCreators.length > 0 ? (
              <section className="board-section board-section--split" aria-labelledby="board-authors-heading">
                <h2 id="board-authors-heading" className="board-section-title">
                  Authors · changes requested
                </h2>
                <div className="board board--split-pane board--split-pane--start">
                  {visibleCreators.map((u) => (
                    <UserColumn
                      key={`c-${u.login}`}
                      user={u}
                      variant="creator"
                      onSnapshot={setData}
                    />
                  ))}
                </div>
              </section>
            ) : null}
          </div>
          <div className="board-split__pane board-split__reviewers">
            {visibleUsers.length > 0 ? (
              <section className="board-section board-section--split" aria-labelledby="board-reviewers-heading">
                <h2 id="board-reviewers-heading" className="board-section-title">
                  Reviewers · waiting for review
                </h2>
                <div className="board board--split-pane board--split-pane--end">
                  {visibleUsers.map((u) => (
                    <UserColumn
                      key={`r-${u.login}`}
                      user={u}
                      variant="reviewer"
                      onSnapshot={setData}
                    />
                  ))}
                </div>
              </section>
            ) : null}
          </div>
        </div>
      )}

      {users.some((u) => u.items.length === 0) && usersWithWork.length > 0 ? (
        <details className="empty-teammates">
          <summary>Teammates with empty reviewer queues</summary>
          <p>
            {users
              .filter((u) => u.items.length === 0)
              .map((u) => u.login)
              .join(", ")}
          </p>
        </details>
      ) : null}
      {branchRepo ? (
        <BranchTreeModal repoFullName={branchRepo} onClose={() => setBranchRepo(null)} />
      ) : null}
    </div>
  );
}
