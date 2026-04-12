export interface PendingReviewItem {
  repoFullName: string;
  pullNumber: number;
  title: string;
  htmlUrl: string;
  authorLogin: string;
  createdAt: string;
  updatedAt: string;
  draft: boolean;
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
  users: UserQueue[];
  errors: { repo: string; message: string }[];
}
