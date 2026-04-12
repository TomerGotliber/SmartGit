import type { UserQueue } from "./types";
import { ReviewCard } from "./ReviewCard";

export function UserColumn({ user }: { user: UserQueue }) {
  return (
    <section className="user-column">
      <header className="user-column-header">
        <img src={user.avatarUrl} alt="" width={40} height={40} loading="lazy" />
        <h2>@{user.login}</h2>
        <span className="user-count">{user.items.length}</span>
      </header>
      <div className="user-column-list">
        {user.items.length === 0 ? (
          <p className="empty-user">Nothing waiting</p>
        ) : (
          user.items.map((item) => <ReviewCard key={`${item.repoFullName}-${item.pullNumber}`} item={item} />)
        )}
      </div>
    </section>
  );
}
