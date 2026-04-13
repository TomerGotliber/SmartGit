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
  mergeableState?: string | null;
  changesRequestedBy?: string[];
  teamSlug?: string;
  hoursWaiting: number;
  waitTier: WaitTier;
  severity: "low" | "medium" | "high" | null;
  rowReviewerLogin?: string;
  canPokeReviewer?: boolean;
  nextPokeAt?: string;
  pokeStatusByReviewer?: Record<string, { canPoke: boolean; nextPokeAt?: string }>;
}

export interface UserQueue {
  login: string;
  avatarUrl: string;
  items: PendingReviewItem[];
}

export interface AllOpenPrItem {
  repoFullName: string;
  pullNumber: number;
  title: string;
  htmlUrl: string;
  authorLogin: string;
  createdAt: string;
  updatedAt: string;
  mergeableState?: string | null;
  hasReviewRequests: boolean;
  requestedUserLogins: string[];
  requestedTeamSlugs: string[];
  changesRequestedBy: string[];
  hoursWaiting: number;
  waitTier: WaitTier;
  severity: "low" | "medium" | "high" | null;
  pokeStatusByReviewer?: Record<string, { canPoke: boolean; nextPokeAt?: string }>;
}

export interface SmartGitSnapshot {
  fetchedAt: string;
  allOpen: AllOpenPrItem[];
  users: UserQueue[];
  creators: UserQueue[];
  errors: { repo: string; message: string }[];
}
