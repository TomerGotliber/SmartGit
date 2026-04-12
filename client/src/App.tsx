import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchQueues, postRefresh } from "./api";
import { filterQueues } from "./filterQueues";
import type { ReviewQueuesSnapshot } from "./types";
import { UserColumn } from "./UserColumn";

const POLL_MS = 60_000;

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

export function App() {
  const [data, setData] = useState<ReviewQueuesSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wallMode, setWallMode] = useState(false);
  const [filterText, setFilterText] = useState("");
  const [focusLogins, setFocusLogins] = useState<Set<string>>(() => new Set());
  const [fullscreen, setFullscreen] = useState(false);

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
  const usersWithWork = useMemo(() => users.filter((u) => u.items.length > 0), [users]);

  const visibleUsers = useMemo(
    () => filterQueues(users, focusLogins, filterText),
    [users, focusLogins, filterText]
  );

  const totalPending = usersWithWork.reduce((n, u) => n + u.items.length, 0);
  const visiblePending = visibleUsers.reduce((n, u) => n + u.items.length, 0);

  const toggleFocusLogin = useCallback((login: string) => {
    setFocusLogins((prev) => {
      const next = new Set(prev);
      if (next.has(login)) next.delete(login);
      else next.add(login);
      return next;
    });
  }, []);

  const clearFocus = useCallback(() => setFocusLogins(new Set()), []);

  if (loading && !data) {
    return (
      <div className="app-shell">
        <div className="state-center">
          <div className="spinner" aria-hidden />
          <p>Loading review queues…</p>
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
          <h1 className="app-title">Review Queues</h1>
          <p className={`app-sub ${wallMode ? "app-sub--compact" : ""}`}>
            {wallMode
              ? "Tap a reviewer to focus columns. Use search to narrow PRs. Press F for fullscreen."
              : "Open pull requests where someone is still listed as a requested reviewer on GitHub. Use Wall screen for TVs and shared monitors."}
          </p>
        </div>
        <div className="header-actions">
          {data?.fetchedAt ? (
            <span className="meta-pill" title="Last successful sync with GitHub">
              Synced {formatFetchedAt(data.fetchedAt)}
            </span>
          ) : null}
          <span className="meta-pill" title="After filters">
            {visiblePending} / {totalPending} pending
          </span>
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
        <label className="filter-label" htmlFor="queue-filter">
          Search
        </label>
        <input
          id="queue-filter"
          className="filter-input"
          type="search"
          placeholder="Repo, title, author, reviewer, PR #…"
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
          autoComplete="off"
        />
        <div className="reviewer-chips" role="group" aria-label="Focus reviewers">
          <button
            type="button"
            className={`chip ${focusLogins.size === 0 ? "chip--active" : ""}`}
            onClick={clearFocus}
          >
            All reviewers
          </button>
          {usersWithWork.map((u) => (
            <button
              key={u.login}
              type="button"
              className={`chip ${focusLogins.has(u.login) ? "chip--active" : ""}`}
              onClick={() => toggleFocusLogin(u.login)}
              title={`Show only @${u.login}`}
            >
              <img src={u.avatarUrl} alt="" className="chip-avatar" width={22} height={22} />
              @{u.login}
              <span className="chip-count">{u.items.length}</span>
            </button>
          ))}
        </div>
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
                <code>{e.repo}</code>: {e.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {usersWithWork.length === 0 ? (
        <div className="state-center">
          <p>No pending requested reviews across configured repos.</p>
        </div>
      ) : visibleUsers.length === 0 ? (
        <div className="state-center">
          <p>No PRs match your search or reviewer focus.</p>
          <p style={{ marginTop: "1rem" }}>
            <button type="button" className="btn" onClick={() => { setFilterText(""); clearFocus(); }}>
              Clear filters
            </button>
          </p>
        </div>
      ) : (
        <div className="board">
          {visibleUsers.map((u) => (
            <UserColumn key={u.login} user={u} />
          ))}
        </div>
      )}

      {users.some((u) => u.items.length === 0) && usersWithWork.length > 0 ? (
        <details className="empty-teammates">
          <summary>Teammates with empty queues</summary>
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
