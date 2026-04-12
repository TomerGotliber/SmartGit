/** How this row should be shown in the UI (reviewer vs author queue). */
export const PendingReviewKind = {
  AwaitingReview: "awaiting_review",
  ChangesRequested: "changes_requested",
} as const;
export type PendingReviewKind = (typeof PendingReviewKind)[keyof typeof PendingReviewKind];

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
}

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
