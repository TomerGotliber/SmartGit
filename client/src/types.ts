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
  mergeableState?: string | null;
  changesRequestedBy?: string[];
  teamSlug?: string;
}

export interface UserQueue {
  login: string;
  avatarUrl: string;
  items: PendingReviewItem[];
}

export interface ReviewQueuesSnapshot {
  fetchedAt: string;
  users: UserQueue[];
  creators: UserQueue[];
  errors: { repo: string; message: string }[];
}
