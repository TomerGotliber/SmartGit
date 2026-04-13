import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchQueues, postRefresh } from "./api";
import { filterQueues } from "./filterQueues";
import { formatRepoDisplayLabel } from "./repoDisplay";
import type { SmartGitSnapshot, UserQueue } from "./types";
import { UserColumn } from "./UserColumn";

const POLL_MS = 60_000;
const ACTOR_LOGIN_STORAGE_KEY = "smartgit-github-login";

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
  const [focusLogins, setFocusLogins] = useState<Set<string>>(() => new Set());
  const [myViewOnly, setMyViewOnly] = useState(false);
  const [focusRepos, setFocusRepos] = useState<Set<string>>(() => new Set());
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

  const visibleUsers = useMemo(
    () => filterQueues(users, focusLogins, onlyMe, focusRepos),
    [users, focusLogins, onlyMe, focusRepos]
  );

  const visibleCreators = useMemo(
    () => filterQueues(creators, focusLogins, onlyMe, focusRepos),
    [creators, focusLogins, onlyMe, focusRepos]
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
            <p className="chip-board-label">Repositories</p>
            <div className="reviewer-chips" role="group" aria-label="Filter by repository">
              <button
                type="button"
                className={`chip chip--repo ${focusRepos.size === 0 ? "chip--active" : ""}`}
                onClick={clearRepoFocus}
              >
                All repos
              </button>
              {repoNames.map((repo) => (
                <button
                  key={repo}
                  type="button"
                  className={`chip chip--repo ${focusRepos.has(repo) ? "chip--active" : ""}`}
                  onClick={() => toggleFocusRepo(repo)}
                  title={repo}
                >
                  <span className="chip-repo-name">{formatRepoDisplayLabel(repo)}</span>
                  <span className="chip-count">{repoCounts.get(repo) ?? 0}</span>
                </button>
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
    </div>
  );
}
