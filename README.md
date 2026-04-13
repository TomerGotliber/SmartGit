# SmartGit

Small R&D dashboard that **polls GitHub** for open pull requests and lists **pending reviews per person** (anyone still shown as a **requested reviewer**). Optional **team** requests are expanded to individual members when the token can read org team membership.

## Prerequisites

- Node.js 20+
- A GitHub personal access token (classic or fine-grained) with access to the repositories you list

### Token permissions

- **Classic PAT:** `repo` (private repos) or `public_repo` (public only), plus **`read:org`** if you use requested **teams** and want them expanded to users. **Poke** needs permission to **comment** on pull requests (included in `repo`).
- **Fine-grained:** read access to the chosen repos; for team expansion, include organization **Members** read where applicable. For **Poke**, grant **Issues** and **Pull requests** write on those repos (comments use the Issues API).

## Configuration

Copy `.env.example` to `.env` in the project root (or set variables in your environment):

| Variable | Required | Description |
|----------|----------|-------------|
| `GITHUB_TOKEN` | Yes | PAT for API access |
| `REPOS` | Yes | Comma- or space-separated `owner/repo`, or `*` / `ALL` to use every **non-archived** repo the token can access ([list repos for the authenticated user](https://docs.github.com/en/rest/repos/repos#list-repositories-for-the-authenticated-user)) |
| `PORT` | No | API (and production UI) port, default `4001`. The Vite dev proxy reads this from the root `.env`. |
| `POLL_INTERVAL_MS` | No | Server refresh interval, default `60000` (minimum `10000`) |
| `LOG_LEVEL` | No | e.g. `info`, `debug` |
| `PR_META_PATH` | No | File path for per-PR **severity** and **poke** cooldown timestamps (default `server/data/pr-meta.json`, gitignored) |
| `POKE_COOLDOWN_HOURS` | No | Minimum hours between pokes of the same reviewer on the same PR (default `24`) |
| `REQUIRE_PR_AUTHOR_FOR_SEVERITY` | No | If `true`, setting severity requires `actorLogin` in the request to match the PR author on GitHub |

Example:

```bash
export GITHUB_TOKEN=ghp_...
export REPOS="acme/engine,acme/api,acme/web"
# or scan all accessible repos:
export REPOS="*"
```

## Development

Run API and Vite dev server together (API on port 4001 by default, UI on 5173 with `/api` proxied):

```bash
npm install
npm run dev
```

Open `http://localhost:5173`.

## Production

Build the UI and run the Node server; it serves `client/dist` when present on the same port as the API.

```bash
npm install
npm run build --prefix client
npm run build --prefix server
node server/dist/index.js
```

Open `http://localhost:4001` (or your `PORT`).

## How it works

1. The server periodically loads **open, non-draft** PRs for each configured repo.
2. **All open board:** one card per such PR, with flags for **review requested** (GitHub’s requested reviewers list), **changes requested** (latest review state per reviewer), merge status when available, wait coloring, severity, and poke (same rules as the author board).
3. **Reviewers board:** GitHub’s **requested reviewers** (users and teams). **Teams** are expanded via the Org Teams API when the repo `owner` is the **organization**.
4. **Authors board:** PRs where at least one reviewer’s **latest submitted review** is **CHANGES_REQUESTED** (per reviewer login, by `submitted_at`). Those rows appear under the **PR author’s** column with who requested changes.
5. **Merge status** is shown when GitHub returns `mergeable_state` on the pull (often `null` in list responses until computed).
6. The UI refreshes from the server cache on an interval and supports **Refresh now**.

Reviewer queues match GitHub’s “still listed as a reviewer.” Author queues match “someone’s latest review is request changes,” which can overlap the reviewer list if you’re still requested after requesting changes. CODEOWNERS alone does not create rows unless GitHub also shows requested reviewers / submitted reviews as above.

### UI: wait color, severity, poke

- **Wait color** uses hours since the PR’s **`updated_at`**: green (&lt;24h), yellow (&lt;3d), orange (&lt;1w), red (older). It is a proxy for staleness, not “time since review was requested.”
- **Severity** is chosen by the author on **Authors · address feedback** cards and stored locally in `pr-meta.json` (not on GitHub). Everyone sees a **Priority** pill on cards for that PR.
- **Poke** (author only) posts a short **@mention comment** on the PR. The comment appears as the **`GITHUB_TOKEN` account**, not as the author. Cooldown is per reviewer per PR (`POKE_COOLDOWN_HOURS`).

## Extending

- **GitLab / Bitbucket:** add a similar fetcher module and map results to the same JSON shape the client expects (`/api/queues`).
- **Webhooks:** you can trigger `POST /api/refresh` from a GitHub webhook handler instead of relying only on polling.
