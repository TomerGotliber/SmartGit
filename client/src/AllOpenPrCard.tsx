import { useId, useState } from "react";
import { PokeCooldownError, patchPrSeverity, postPrPoke } from "./api";
import type { AllOpenPrItem, ReviewSeverityValue, SmartGitSnapshot } from "./types";
import { ReviewSeverity } from "./types";

const ACTOR_STORAGE_KEY = "smartgit-github-login";

function formatRelative(iso: string): string {
  const d = new Date(iso);
  const now = Date.now();
  const diff = now - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function formatAbsolute(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });
  } catch {
    return iso;
  }
}

function formatMergeable(state: string): string {
  const labels: Record<string, string> = {
    clean: "Mergeable",
    blocked: "Blocked",
    behind: "Behind base branch",
    dirty: "Merge conflict",
    unknown: "Merge status pending",
    unstable: "Checks pending",
  };
  return labels[state] ?? state.replace(/_/g, " ");
}

function splitRepo(fullName: string): [string, string] {
  const i = fullName.indexOf("/");
  if (i <= 0 || i >= fullName.length - 1) return ["", ""];
  return [fullName.slice(0, i), fullName.slice(i + 1)];
}

function waitTierLabel(tier: number): string {
  if (tier <= 0) return "Fresh";
  if (tier === 1) return "Aging";
  if (tier === 2) return "Stale";
  return "Critical wait";
}

function severityLabel(s: NonNullable<AllOpenPrItem["severity"]>): string {
  if (s === "low") return "Low";
  if (s === "medium") return "Medium";
  return "High";
}

export function AllOpenPrCard({
  pr,
  onSnapshot,
}: {
  pr: AllOpenPrItem;
  onSnapshot: (snap: SmartGitSnapshot) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [actorLogin, setActorLogin] = useState(() => {
    try {
      return localStorage.getItem(ACTOR_STORAGE_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const panelId = useId();
  const mergeState = pr.mergeableState?.trim() || null;
  const [owner, repo] = splitRepo(pr.repoFullName);
  const tier = pr.waitTier ?? 0;
  const hours = pr.hoursWaiting ?? 0;

  const persistActor = (v: string) => {
    setActorLogin(v);
    try {
      if (v.trim()) localStorage.setItem(ACTOR_STORAGE_KEY, v.trim());
      else localStorage.removeItem(ACTOR_STORAGE_KEY);
    } catch {
      /* ignore */
    }
  };

  const onSeverityChange = async (v: ReviewSeverityValue) => {
    if (!owner || !repo) return;
    setBusy(true);
    setMsg(null);
    try {
      const snap = await patchPrSeverity(owner, repo, pr.pullNumber, v, actorLogin.trim() || undefined);
      onSnapshot(snap);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const doPoke = async (reviewerLogin: string) => {
    if (!owner || !repo) return;
    setBusy(true);
    setMsg(null);
    try {
      const snap = await postPrPoke(owner, repo, pr.pullNumber, reviewerLogin);
      onSnapshot(snap);
    } catch (e) {
      if (e instanceof PokeCooldownError && e.nextPokeAt) {
        setMsg(`Cooldown until ${formatAbsolute(e.nextPokeAt)}`);
      } else {
        setMsg(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className={`review-card review-card--open-overview review-card--wait-${tier}`}>
      <div className="review-card-wait-bar" aria-hidden title={`~${hours}h since last PR update`} />

      <div className="review-card-status-row" aria-label="Pull request status">
        <span className={`status-pill status-pill--wait-tier status-pill--wait-${tier}`}>
          {waitTierLabel(tier)} · {hours}h
        </span>
        <span className="status-pill status-pill--open">Open</span>
        {pr.hasReviewRequests ? (
          <span className="status-pill status-pill--review">Review requested</span>
        ) : (
          <span className="status-pill status-pill--merge">No pending reviewer</span>
        )}
        {pr.changesRequestedBy.length > 0 ? (
          <span className="status-pill status-pill--danger">Changes requested</span>
        ) : null}
        {pr.severity ? (
          <span className={`status-pill status-pill--sev status-pill--sev-${pr.severity}`}>
            Priority: {severityLabel(pr.severity)}
          </span>
        ) : null}
        {mergeState ? (
          <span
            className={`status-pill status-pill--merge status-pill--merge-${mergeState.replace(/\W/g, "")}`}
            title="GitHub merge status"
          >
            {formatMergeable(mergeState)}
          </span>
        ) : null}
      </div>

      <div className="review-card-repo">{pr.repoFullName}</div>
      <h3 className="review-card-title">
        <a href={pr.htmlUrl} target="_blank" rel="noreferrer">
          #{pr.pullNumber} · {pr.title}
        </a>
      </h3>

      {(pr.requestedUserLogins.length > 0 || pr.requestedTeamSlugs.length > 0) && (
        <div className="all-open-requests">
          {pr.requestedUserLogins.length > 0 ? (
            <div className="all-open-requests-row">
              <span className="review-card-changes-label">Reviewers</span>
              <div className="review-card-mentions">
                {pr.requestedUserLogins.map((login) => (
                  <span key={login} className="mention-pill">
                    @{login}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
          {pr.requestedTeamSlugs.length > 0 ? (
            <div className="all-open-requests-row">
              <span className="review-card-changes-label">Teams</span>
              <div className="review-card-mentions">
                {pr.requestedTeamSlugs.map((slug) => (
                  <span key={slug} className="team-badge">
                    {slug}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      )}

      {pr.changesRequestedBy.length > 0 ? (
        <div className="review-card-changes-from">
          <span className="review-card-changes-label">Changes from</span>
          <div className="review-card-mentions review-card-mentions--block">
            {pr.changesRequestedBy.map((login) => {
              const st = pr.pokeStatusByReviewer?.[login];
              const canPoke = st?.canPoke !== false;
              return (
                <div key={login} className="review-card-mention-row">
                  <span className="mention-pill">@{login}</span>
                  <button
                    type="button"
                    className="btn-poke"
                    disabled={busy || !canPoke}
                    title={
                      canPoke
                        ? "Post a poke comment on the PR"
                        : st?.nextPokeAt
                          ? `Next poke after ${formatAbsolute(st.nextPokeAt)}`
                          : "Poke unavailable"
                    }
                    onClick={() => void doPoke(login)}
                  >
                    Poke
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      <div className="review-card-severity">
        <label className="review-card-severity-label" htmlFor={`sev-open-${pr.repoFullName}-${pr.pullNumber}`}>
          Severity
        </label>
        <select
          id={`sev-open-${pr.repoFullName}-${pr.pullNumber}`}
          className="review-card-select"
          disabled={busy}
          value={pr.severity ?? ReviewSeverity.None}
          onChange={(ev) => void onSeverityChange(ev.target.value as ReviewSeverityValue)}
        >
          <option value={ReviewSeverity.None}>Not set</option>
          <option value={ReviewSeverity.Low}>Low</option>
          <option value={ReviewSeverity.Medium}>Medium</option>
          <option value={ReviewSeverity.High}>High</option>
        </select>
        <input
          className="review-card-actor"
          type="text"
          placeholder="Your GitHub login (if server enforces author)"
          value={actorLogin}
          onChange={(e) => persistActor(e.target.value)}
        />
      </div>

      {msg ? (
        <p className="review-card-inline-msg" role="status">
          {msg}
        </p>
      ) : null}

      <div className="review-card-meta">
        <span>by @{pr.authorLogin}</span>
        <span>updated {formatRelative(pr.updatedAt)}</span>
      </div>
      <button
        type="button"
        className="review-card-toggle"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? "Hide details" : "Show details"}
      </button>
      {open ? (
        <div id={panelId} className="review-card-panel">
          <p className="review-card-panel-row">
            <span className="review-card-panel-label">Opened</span>
            <span>{formatAbsolute(pr.createdAt)}</span>
          </p>
          <p className="review-card-panel-row">
            <span className="review-card-panel-label">Updated</span>
            <span>{formatAbsolute(pr.updatedAt)}</span>
          </p>
          {mergeState ? (
            <p className="review-card-panel-row">
              <span className="review-card-panel-label">Merge</span>
              <span>{formatMergeable(mergeState)}</span>
            </p>
          ) : null}
          <p className="review-card-panel-row review-card-panel-link">
            <a href={pr.htmlUrl} target="_blank" rel="noreferrer">
              Open pull request on GitHub →
            </a>
          </p>
        </div>
      ) : null}
    </article>
  );
}
