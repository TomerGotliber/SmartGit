# Review Queues

Small R&D dashboard that **polls GitHub** for open pull requests and lists **pending reviews per person** (anyone still shown as a **requested reviewer**). Optional **team** requests are expanded to individual members when the token can read org team membership.

## Prerequisites

- Node.js 20+
- A GitHub personal access token (classic or fine-grained) with access to the repositories you list

### Token permissions

- **Classic PAT:** `repo` (private repos) or `public_repo` (public only), plus **`read:org`** if you use requested **teams** and want them expanded to users.
- **Fine-grained:** read access to the chosen repos; for team expansion, include organization **Members** read where applicable.

## Configuration

Copy `.env.example` to `.env` in the project root (or set variables in your environment):

| Variable | Required | Description |
|----------|----------|-------------|
| `GITHUB_TOKEN` | Yes | PAT for API access |
| `REPOS` | Yes | Comma- or space-separated `owner/repo`, or `*` / `ALL` to use every **non-archived** repo the token can access ([list repos for the authenticated user](https://docs.github.com/en/rest/repos/repos#list-repositories-for-the-authenticated-user)) |
| `PORT` | No | API (and production UI) port, default `4001`. The Vite dev proxy reads this from the root `.env`. |
| `POLL_INTERVAL_MS` | No | Server refresh interval, default `60000` (minimum `10000`) |
| `LOG_LEVEL` | No | e.g. `info`, `debug` |

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
2. For each PR it reads GitHub’s **requested reviewers** (users and teams).
3. **Users** are keyed by login. **Teams** are expanded via the Org Teams API (repo `owner` must be the **organization**).
4. The UI refreshes from the server cache on an interval and supports **Refresh now**.

This matches GitHub’s notion of “waiting on review” for explicitly requested reviewers. It does not try to infer reviews from CODEOWNERS alone unless those owners are also requested on the PR.

## Extending

- **GitLab / Bitbucket:** add a similar fetcher module and map results to the same JSON shape the client expects (`/api/queues`).
- **Webhooks:** you can trigger `POST /api/refresh` from a GitHub webhook handler instead of relying only on polling.
