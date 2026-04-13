import type { SmartGitSnapshot, UserQueue } from "./types";
import { ReviewCard } from "./ReviewCard";

export function UserColumn({
  user,
  variant,
  onSnapshot,
}: {
  user: UserQueue;
  variant: "reviewer" | "creator";
  onSnapshot: (snap: SmartGitSnapshot) => void;
}) {
  const subtitle = variant === "creator" ? "Address feedback" : "Awaiting review";

  return (
    <section className={`user-column user-column--${variant}`}>
      <header className="user-column-header">
        <img src={user.avatarUrl} alt="" width={40} height={40} loading="lazy" />
        <div className="user-column-titles">
          <h2>@{user.login}</h2>
          <p className="user-column-sub">{subtitle}</p>
        </div>
        <span className="user-count">{user.items.length}</span>
      </header>
      <div className="user-column-list">
        {user.items.length === 0 ? (
          <p className="empty-user">Nothing here</p>
        ) : (
          user.items.map((item) => (
            <ReviewCard
              key={`${item.repoFullName}-${item.pullNumber}-${item.kind}-${item.teamSlug ?? ""}`}
              item={item}
              onSnapshot={onSnapshot}
            />
          ))
        )}
      </div>
    </section>
  );
}
