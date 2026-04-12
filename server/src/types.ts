/** How this row should be shown in the UI (reviewer vs author queue). */
export const PendingReviewKind = {
  AwaitingReview: "awaiting_review",
  ChangesRequested: "changes_requested",
} as const;
export type PendingReviewKind = (typeof PendingReviewKind)[keyof typeof PendingReviewKind];

export const ReviewSeverity = {
  None: "none",
  Low: "low",
  Medium: "medium",
  High: "high",
} as const;
export type ReviewSeverityValue = (typeof ReviewSeverity)[keyof typeof ReviewSeverity];

/** Staleness by hours since PR `updated_at` (&lt;24h fresh, &lt;72h aging, &lt;1w stale, else critical). */
export const WaitTier = {
  Fresh: 0,
  Aging: 1,
  Stale: 2,
  Critical: 3,
} as const;
export type WaitTier = (typeof WaitTier)[keyof typeof WaitTier];

export interface PendingReviewItem {
  repoFullName: string;
  pullNumber: number;
  title: string;
  htmlUrl: string;
  authorLogin: string;
  createdAt: string;
  updatedAt: string;
  draft: boolean;
  kind: PendingReviewKind;
  /** GitHub mergeable_state when the API returned it (clean, blocked, behind, dirty, unknown, …). */
  mergeableState?: string | null;
  /** When kind is changes_requested: reviewers whose latest submitted review is CHANGES_REQUESTED. */
  changesRequestedBy?: string[];
  /** When set, this item is pending for every member of the team */
  teamSlug?: string;
  /** Whole hours since PR last update (visual wait color). */
  hoursWaiting: number;
  waitTier: WaitTier;
  /** Set by PR author via dashboard (stored in pr-meta.json). */
  severity: Exclude<ReviewSeverityValue, "none"> | null;
  /** Reviewer this row is for (awaiting_review); used for poke + display. */
  rowReviewerLogin?: string;
  /** Whether a poke comment can be posted for rowReviewerLogin (cooldown). */
  canPokeReviewer?: boolean;
  /** ISO time when poke is allowed again. */
  nextPokeAt?: string;
  /** Creator rows: poke cooldown per reviewer who requested changes. */
  pokeStatusByReviewer?: Record<string, { canPoke: boolean; nextPokeAt?: string }>;
}

/** Built from GitHub before local meta (wait tier, severity, poke) is applied. */
export type PendingReviewItemBase = Omit<
  PendingReviewItem,
  | "hoursWaiting"
  | "waitTier"
  | "severity"
  | "canPokeReviewer"
  | "nextPokeAt"
  | "pokeStatusByReviewer"
>;

export interface UserQueue {
  login: string;
  avatarUrl: string;
  items: PendingReviewItem[];
}

export interface ReviewQueuesSnapshot {
  fetchedAt: string;
  /** Requested reviewers still waiting to review. */
  users: UserQueue[];
  /** PR authors with at least one blocking “changes requested” review (latest review per reviewer). */
  creators: UserQueue[];
  errors: { repo: string; message: string }[];
}
