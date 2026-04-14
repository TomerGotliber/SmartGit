import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { postPrPoke } from "./api";
import { formatRepoDisplayLabel } from "./repoDisplay";
import { repoTheme } from "./repoTheme";
import { PendingReviewKind, type PendingReviewItem, type SmartGitSnapshot } from "./types";

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

type PokeTargetOption = { login: string; role: string };

function buildPokeTargetOptions(item: PendingReviewItem, isCreator: boolean): PokeTargetOption[] {
  const seen = new Set<string>();
  const out: PokeTargetOption[] = [];
  const add = (login: string | undefined, role: string) => {
    if (!login) return;
    const key = login.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ login, role });
  };
  if (isCreator) {
    add(item.authorLogin, "Author");
    for (const r of item.changesRequestedBy ?? []) add(r, "Reviewer");
  } else {
    add(item.rowReviewerLogin, "Reviewer");
    add(item.authorLogin, "Author");
  }
  return out;
}

function defaultPokeTargetLogin(item: PendingReviewItem, isCreator: boolean): string {
  if (isCreator) return item.authorLogin;
  return item.rowReviewerLogin ?? item.authorLogin;
}

function sortPokeOptionsWithDefaultFirst(options: PokeTargetOption[], defaultLogin: string): PokeTargetOption[] {
  return [...options].sort((a, b) => {
    if (a.login === defaultLogin) return -1;
    if (b.login === defaultLogin) return 1;
    return a.login.localeCompare(b.login);
  });
}

function PokeCustomCompose({
  targetLogin,
  value,
  onChange,
  disabled,
  onCancel,
  onSubmit,
}: {
  targetLogin: string;
  value: string;
  onChange: (next: string) => void;
  disabled: boolean;
  onCancel: () => void;
  onSubmit: () => void | Promise<void>;
}) {
  const areaRef = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    areaRef.current?.focus();
  }, [targetLogin]);

  return (
    <div className="poke-custom-inline" role="group" aria-label={`Custom poke for @${targetLogin}`}>
      <div className="poke-custom-inline-head">
        <span className="poke-custom-inline-title">Custom poke</span>
      </div>
      <div className="poke-custom-compose">
        <div className="poke-custom-compose-inner">
          <span className="poke-custom-mention-prefix" aria-hidden="true">
            @{targetLogin}
          </span>
          <textarea
            ref={areaRef}
            className="poke-custom-textarea"
            rows={4}
            maxLength={3200}
            value={value}
            placeholder="Your message…"
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
            aria-label={`Message after @${targetLogin}`}
          />
        </div>
        <div className="poke-custom-meta">
          <span className="poke-custom-count">
            {value.length} / 3200
          </span>
        </div>
      </div>
      <div className="poke-custom-actions">
        <button type="button" className="btn-poke btn-poke--secondary" disabled={disabled} onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="btn-poke"
          disabled={disabled || !value.trim()}
          onClick={() => void onSubmit()}
        >
          Post comment
        </button>
      </div>
    </div>
  );
}

export function ReviewCard({
  item,
  onSnapshot,
}: {
  item: PendingReviewItem;
  onSnapshot: (snap: SmartGitSnapshot) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pokeMsg, setPokeMsg] = useState<string | null>(null);
  const [pokeDialogLogin, setPokeDialogLogin] = useState<string | null>(null);
  const [customPokeText, setCustomPokeText] = useState("");
  const panelId = useId();
  const pokeTargetFieldId = useId();
  const rTheme = useMemo(() => repoTheme(item.repoFullName), [item.repoFullName]);
  const isCreator = item.kind === PendingReviewKind.ChangesRequested;
  const mergeState = item.mergeableState?.trim() || null;
  const [owner, repo] = splitRepo(item.repoFullName);
  const tier = item.waitTier ?? 0;
  const hours = item.hoursWaiting ?? 0;

  const showPokeRow =
    (isCreator && (item.changesRequestedBy?.length ?? 0) > 0) || (!isCreator && Boolean(item.authorLogin));

  const changesRequestedKey = (item.changesRequestedBy ?? []).join("\0");

  const pokeOptions = useMemo(() => {
    if (!showPokeRow) return [] as PokeTargetOption[];
    const preferred = defaultPokeTargetLogin(item, isCreator);
    const built = buildPokeTargetOptions(item, isCreator);
    return sortPokeOptionsWithDefaultFirst(built, preferred);
  }, [showPokeRow, isCreator, item.authorLogin, item.rowReviewerLogin, changesRequestedKey]);

  const preferredPokeLogin = pokeOptions[0]?.login ?? "";

  const [pokeTargetLogin, setPokeTargetLogin] = useState(preferredPokeLogin);

  useEffect(() => {
    setPokeTargetLogin(preferredPokeLogin);
  }, [preferredPokeLogin]);

  const doPoke = async (targetLogin: string) => {
    if (!owner || !repo) return;
    setBusy(true);
    setPokeMsg(null);
    try {
      const snap = await postPrPoke(owner, repo, item.pullNumber, targetLogin);
      onSnapshot(snap);
    } catch (e) {
      setPokeMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const closePokeDialog = () => {
    setPokeDialogLogin(null);
    setCustomPokeText("");
  };

  const submitCustomPoke = async () => {
    const login = pokeDialogLogin;
    const text = customPokeText.trim();
    if (!login || !owner || !repo || !text) return;
    setBusy(true);
    setPokeMsg(null);
    try {
      const snap = await postPrPoke(owner, repo, item.pullNumber, login, {
        customMessage: text,
      });
      onSnapshot(snap);
      closePokeDialog();
    } catch (e) {
      setPokeMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!pokeDialogLogin) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") closePokeDialog();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pokeDialogLogin]);

  return (
    <article
      className={`review-card review-card--wait-${tier} ${isCreator ? "review-card--creator-action" : "review-card--awaiting-review"}`}
    >
      <div className="review-card-top-accent" style={{ background: rTheme.stripe }} aria-hidden />
      <div className="review-card-wait-bar" aria-hidden title={`~${hours}h since last PR update`} />

      <div className="review-card-status-row" aria-label="Pull request status">
        <span className={`status-pill status-pill--wait-tier status-pill--wait-${tier}`} title="Based on time since PR last updated">
          {waitTierLabel(tier)} · {hours}h
        </span>
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

      <div
        className="review-card-repo review-card-repo--themed"
        style={{
          color: rTheme.labelColor,
          backgroundColor: rTheme.labelBackground,
          borderColor: rTheme.labelBorder,
        }}
      >
        <span title={item.repoFullName}>{formatRepoDisplayLabel(item.repoFullName)}</span>
      </div>
      {item.projects && item.projects.length > 0 ? (
        <div className="review-card-projects" title={`GitHub Projects: ${item.projects.join(", ")}`}>
          {item.projects.map((p) => (
            <span key={p} className="review-card-project">
              {p}
            </span>
          ))}
        </div>
      ) : null}
      <h3 className="review-card-title">
        <a href={item.htmlUrl} target="_blank" rel="noreferrer">
          #{item.pullNumber} · {item.title}
        </a>
      </h3>
      {item.baseRef ? (
        <p className="review-card-base-branch" title="Branch this pull request merges into">
          <span className="review-card-base-branch-label">Into</span>
          <span className="review-card-base-branch-ref">{item.baseRef}</span>
        </p>
      ) : null}

      {pokeOptions.length > 0 ? (
        <div className="review-card-poke">
          <div className="review-card-poke-stack">
            <div className="review-card-poke-toolbar">
              <div className="poke-target-field">
                <label className="poke-target-label" htmlFor={pokeTargetFieldId}>
                  Recipient
                </label>
                <div className="poke-target-select-wrap">
                  <select
                    id={pokeTargetFieldId}
                    className="poke-target-select"
                    value={pokeTargetLogin}
                    disabled={busy}
                    onChange={(e) => {
                      setPokeTargetLogin(e.target.value);
                      closePokeDialog();
                    }}
                  >
                    {pokeOptions.map((o) => (
                      <option key={o.login} value={o.login}>
                        @{o.login} — {o.role}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="review-card-poke-actions review-card-poke-actions--segmented" role="group" aria-label="Poke actions">
                <button
                  type="button"
                  className="btn-poke btn-poke--segment btn-poke--segment-primary"
                  disabled={busy || !pokeTargetLogin}
                  title="Post a poke comment with the server token (target is the selected person)"
                  onClick={() => void doPoke(pokeTargetLogin)}
                >
                  Poke
                </button>
                <button
                  type="button"
                  className="btn-poke btn-poke--segment btn-poke--segment-ghost"
                  disabled={busy || !pokeTargetLogin}
                  title="Write your own poke wording for the selected person"
                  onClick={() => {
                    setCustomPokeText("");
                    setPokeDialogLogin(pokeTargetLogin);
                  }}
                >
                  Custom
                </button>
              </div>
            </div>
            {pokeDialogLogin ? (
              <PokeCustomCompose
                targetLogin={pokeDialogLogin}
                value={customPokeText}
                onChange={setCustomPokeText}
                disabled={busy}
                onCancel={closePokeDialog}
                onSubmit={submitCustomPoke}
              />
            ) : null}
          </div>
        </div>
      ) : null}

      {pokeMsg ? (
        <p className="review-card-inline-msg" role="status">
          {pokeMsg}
        </p>
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
