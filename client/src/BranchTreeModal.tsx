import { useEffect, useMemo, useState } from "react";
import { fetchRepoBranches, type BranchInfo, type RepoBranchesResponse } from "./api";

const NODE_H = 30;
const NODE_GAP = 6;
const LEFT_X = 180;
const RIGHT_X = 340;
const LABEL_W = 420;
const TOP_PAD = 20;

const ROOT_BRANCH_NAMES = ["master", "main", "staging", "stage", "dev", "develop", "development", "release", "production", "prod"];

export function BranchTreeModal({
  repoFullName,
  onClose,
}: {
  repoFullName: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<RepoBranchesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");

  useEffect(() => {
    const [owner, repo] = repoFullName.split("/");
    if (!owner || !repo) {
      setError("Invalid repo name");
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchRepoBranches(owner, repo)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [repoFullName]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const layout = useMemo(() => {
    if (!data) return null;
    const defaultBranch = data.defaultBranch;
    const rootNames = new Set<string>([defaultBranch]);
    const byName = new Map<string, BranchInfo>();
    for (const b of data.branches) byName.set(b.name, b);
    for (const name of ROOT_BRANCH_NAMES) {
      if (byName.has(name)) rootNames.add(name);
    }

    const roots: BranchInfo[] = Array.from(rootNames)
      .map((n) => byName.get(n)!)
      .sort((a, b) => {
        if (a.name === defaultBranch) return -1;
        if (b.name === defaultBranch) return 1;
        return a.name.localeCompare(b.name);
      });

    const others: BranchInfo[] = data.branches
      .filter((b) => !rootNames.has(b.name))
      .sort((a, b) => (b.prs?.length ?? 0) - (a.prs?.length ?? 0) || b.ahead + b.behind - (a.ahead + a.behind) || a.name.localeCompare(b.name));

    const q = query.trim().toLowerCase();
    const visibleOthers = q ? others.filter((b) => b.name.toLowerCase().includes(q)) : others;
    const matchedRoots = q ? roots.filter((r) => r.name.toLowerCase().includes(q)) : [];

    const total = visibleOthers.length + matchedRoots.length;
    const height = Math.max(160, total * (NODE_H + NODE_GAP) + 40);

    const rootSpacing = height / (roots.length + 1);
    const rootPositions = new Map<string, number>();
    roots.forEach((r, i) => rootPositions.set(r.name, rootSpacing * (i + 1)));

    return { roots, rootPositions, others: visibleOthers, matchedRoots, height, q };
  }, [data, query]);

  function rootFor(b: BranchInfo, defaultBranch: string, rootNames: Set<string>): string {
    if (b.base && rootNames.has(b.base)) return b.base;
    return defaultBranch;
  }

  const rootNamesSet = useMemo(() => {
    if (!layout) return new Set<string>();
    return new Set(layout.roots.map((r) => r.name));
  }, [layout]);

  return (
    <div className="branch-modal-overlay" onClick={onClose}>
      <div
        className="branch-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={`Branches of ${repoFullName}`}
      >
        <div className="branch-modal-header">
          <h3>
            Branch tree · <span className="branch-modal-repo">{repoFullName}</span>
          </h3>
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </div>

        {loading ? <p className="branch-modal-status">Loading branches…</p> : null}
        {error ? <p className="branch-modal-status branch-modal-error">{error}</p> : null}

        {data && layout ? (
          <>
            <div className="branch-modal-controls">
              <input
                type="search"
                className="branch-search"
                placeholder="Search branches…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                autoFocus
              />
              <span className="branch-modal-sub">
                {data.totalBranches} total · roots: {layout.roots.map((r) => r.name).join(", ")}
                {query ? ` · ${layout.others.length + layout.matchedRoots.length} match` : ""}
              </span>
            </div>
            <div className="branch-tree-svg-wrap">
              <svg
                width={RIGHT_X + LABEL_W + 40}
                height={layout.height}
                className="branch-tree-svg"
                role="img"
                aria-label="branch tree"
              >
                {/* edges from each non-root branch to its root */}
                {layout.others.map((b, i) => {
                  const y = TOP_PAD + i * (NODE_H + NODE_GAP) + NODE_H / 2;
                  const rootName = rootFor(b, data.defaultBranch, rootNamesSet);
                  const y1 = layout.rootPositions.get(rootName) ?? layout.height / 2;
                  const x1 = LEFT_X + 12;
                  const x2 = RIGHT_X - 6;
                  const midX = (x1 + x2) / 2;
                  const d = `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y}, ${x2} ${y}`;
                  return <path key={`e-${b.name}`} d={d} className="branch-edge" fill="none" />;
                })}

                {/* root nodes */}
                {layout.roots.map((r) => {
                  const y = layout.rootPositions.get(r.name) ?? 0;
                  const isDefault = r.name === data.defaultBranch;
                  const highlighted = layout.q && r.name.toLowerCase().includes(layout.q);
                  return (
                    <g key={`root-${r.name}`} transform={`translate(${LEFT_X}, ${y})`}>
                      <a
                        href={`https://github.com/${data.owner}/${data.repo}/tree/${encodeURIComponent(r.name)}`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <circle r={isDefault ? 10 : 8} className={`branch-node ${isDefault ? "branch-node--root" : "branch-node--subroot"} ${highlighted ? "branch-node--match" : ""}`} />
                        <text
                          x={-14}
                          y={4}
                          textAnchor="end"
                          className={`branch-node-label branch-node-link ${isDefault ? "branch-node-label--root" : "branch-node-label--subroot"}`}
                        >
                          {r.name}
                          {isDefault ? " (default)" : ""}
                        </text>
                      </a>
                    </g>
                  );
                })}

                {/* leaves */}
                {layout.others.map((b, i) => {
                  const y = TOP_PAD + i * (NODE_H + NODE_GAP) + NODE_H / 2;
                  const matched = layout.q && b.name.toLowerCase().includes(layout.q);
                  const branchUrl = `https://github.com/${data.owner}/${data.repo}/tree/${encodeURIComponent(b.name)}`;
                  const primaryUrl = b.prs && b.prs[0] ? b.prs[0].htmlUrl : branchUrl;
                  return (
                    <g key={b.name} transform={`translate(${RIGHT_X}, ${y})`}>
                      <a href={branchUrl} target="_blank" rel="noopener noreferrer">
                        <circle
                          r={6}
                          className={`branch-node ${b.protected ? "branch-node--protected" : ""} ${matched ? "branch-node--match" : ""}`}
                        />
                      </a>
                      <a href={primaryUrl} target="_blank" rel="noopener noreferrer">
                        <text x={12} y={4} className="branch-node-label branch-node-link">
                          {b.name}
                          {b.prs && b.prs.length > 0 ? (
                            <tspan dx={8} className="branch-pr-tag">
                              {b.prs.map((p) => `#${p.number}`).join(" ")}
                            </tspan>
                          ) : null}
                        </text>
                      </a>
                      <text x={12} y={18} className="branch-node-metrics">
                        {b.compared === false ? (
                          <tspan className="branch-metric-tag">not compared</tspan>
                        ) : (
                          <>
                            <tspan className="branch-metric-ahead">↑{b.ahead}</tspan>
                            <tspan dx={8} className="branch-metric-behind">↓{b.behind}</tspan>
                          </>
                        )}
                        {b.prs && b.prs[0] ? (
                          <tspan dx={10} className="branch-pr-title">
                            {b.prs[0].title.length > 50 ? `${b.prs[0].title.slice(0, 50)}…` : b.prs[0].title}
                            {b.prs[0].draft ? " (draft)" : ""}
                          </tspan>
                        ) : null}
                        {b.protected ? <tspan dx={8} className="branch-metric-tag">protected</tspan> : null}
                      </text>
                    </g>
                  );
                })}

                {layout.others.length === 0 && !query ? (
                  <text x={RIGHT_X} y={layout.height / 2} className="branch-node-label">
                    (no non-root branches)
                  </text>
                ) : null}
                {query && layout.others.length === 0 && layout.matchedRoots.length === 0 ? (
                  <text x={RIGHT_X} y={layout.height / 2} className="branch-node-label">
                    No branches match “{query}”
                  </text>
                ) : null}
              </svg>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
