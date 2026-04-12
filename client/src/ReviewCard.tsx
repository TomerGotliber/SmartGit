import { useId, useState } from "react";
import { PendingReviewKind, type PendingReviewItem } from "./types";

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

export function ReviewCard({ item }: { item: PendingReviewItem }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const isCreator = item.kind === PendingReviewKind.ChangesRequested;
  const mergeState = item.mergeableState?.trim() || null;

  return (
    <article
      className={`review-card ${isCreator ? "review-card--creator-action" : "review-card--awaiting-review"}`}
    >
      <div className="review-card-status-row" aria-label="Pull request status">
        {isCreator ? (
          <span className="status-pill status-pill--danger">Changes requested</span>
        ) : (
          <span className="status-pill status-pill--review">Needs your review</span>
        )}
        {mergeState ? (
          <span
            className={`status-pill status-pill--merge status-pill--merge-${mergeState.replace(/\W/g, "")}`}
            title="GitHub merge status for the PR head vs base"
          >
            {formatMergeable(mergeState)}
          </span>
        ) : null}
      </div>

      <div className="review-card-repo">{item.repoFullName}</div>
      <h3 className="review-card-title">
        <a href={item.htmlUrl} target="_blank" rel="noreferrer">
          #{item.pullNumber} · {item.title}
        </a>
      </h3>

      {isCreator && item.changesRequestedBy && item.changesRequestedBy.length > 0 ? (
        <div className="review-card-changes-from">
          <span className="review-card-changes-label">From</span>
          <div className="review-card-mentions">
            {item.changesRequestedBy.map((login) => (
              <span key={login} className="mention-pill">
                @{login}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      <div className="review-card-meta">
        <span>by @{item.authorLogin}</span>
        <span>updated {formatRelative(item.updatedAt)}</span>
        {item.teamSlug ? <span className="team-badge">via team {item.teamSlug}</span> : null}
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
            <span>{formatAbsolute(item.createdAt)}</span>
          </p>
          <p className="review-card-panel-row">
            <span className="review-card-panel-label">Updated</span>
            <span>{formatAbsolute(item.updatedAt)}</span>
          </p>
          {mergeState ? (
            <p className="review-card-panel-row">
              <span className="review-card-panel-label">Merge</span>
              <span>{formatMergeable(mergeState)}</span>
            </p>
          ) : null}
          <p className="review-card-panel-row review-card-panel-link">
            <a href={item.htmlUrl} target="_blank" rel="noreferrer">
              Open pull request on GitHub →
            </a>
          </p>
        </div>
      ) : null}
    </article>
  );
}
