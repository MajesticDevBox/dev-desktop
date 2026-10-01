# Dev Desktop

A persistent, always-on dashboard for the projects you are working on. It auto-discovers the git repos in your
repos folder and shows live data for each one, plus the tools and links you use to work on it.

**Live data per project**

- Git: branch, uncommitted / unpushed / behind counts, recent commits
- GitHub: open PRs, open issues, latest CI run (needs `GITHUB_TOKEN` for private repos)
- Docker: containers that belong to the project (matched via their compose working dir), with start / stop / restart / logs
- Health: uptime checks with latency sparkline for any staging / prod / local URL you flag

**Workflow support**: quick links bar, per-project links and tools, saved commands (copy, or copy with `cd`),
"Open in VS Code" links, notes, tags, pinning, search (`/`), and sorting by activity / uncommitted / needs attention.

Updates are pushed to the browser over Server-Sent Events, so cards change without a reload.

## Run it

```bash
cp .env.example .env      # set REPOS_PATH (default G:/Github Repos) and optionally GITHUB_TOKEN
docker compose up -d --build
```

Open <http://localhost:7070>. It restarts with Docker (`restart: unless-stopped`).

## How it works

- **Discovery**: every folder directly under `REPOS_PATH` that contains `.git` becomes a project. Repos with a commit in the
  last `ACTIVE_WINDOW_DAYS` (30) are marked *Active* the first time they are seen; everything else lands in *Archived*.
  Toggle with Activate / Archive. Only active projects are polled aggressively.
- **Persistence**: projects, links, commands, notes and health history live in SQLite on the `dev-desktop-data` volume
  (`/data/dev-desktop.db`). Rebuilding or recreating the container keeps them. Live git / docker / GitHub state is
  re-read on start.
- **Seeded commands**: npm scripts (`dev`, `start`, `build`, `test`, `lint`) and compose up / logs are added once when a repo is
  discovered; edit them in the project drawer.
- **Docker matching**: a container belongs to a project when its `com.docker.compose.project.working_dir` folder name (or compose
  project name) equals the repo folder name. Anything else shows under "Other containers".
- **Health checks** to `localhost` URLs are routed to `host.docker.internal`, so a link to `http://localhost:3000`
  monitors the service on your machine.
- Repos are mounted **read-only**; the dashboard never modifies them.

## Configuration

All optional, set in `.env` (see `.env.example`): `REPOS_PATH`, `PORT`, `GITHUB_TOKEN`, `GITHUB_TOKENS`, `ACTIVE_WINDOW_DAYS`,
`GIT_REFRESH_SECONDS`, `DOCKER_REFRESH_SECONDS`, `HEALTH_REFRESH_SECONDS`, `GITHUB_REFRESH_SECONDS`, `RESCAN_SECONDS`,
`GIT_CONCURRENCY`.

## Security notes

- The Docker socket is mounted so the dashboard can list and control containers. That is root-equivalent access to your Docker host,
  so the port is published on `127.0.0.1` only and there is no login. Do not expose it beyond localhost without adding auth.
  If you never want start / stop, remove the socket mount; the rest keeps working.
- `GITHUB_TOKEN` / `GITHUB_TOKENS` stay in `.env` (git-ignored) and are only sent to `api.github.com`.
- Multiple orgs: set `GITHUB_TOKENS=org1=tokenA,org2=tokenB`. The token is chosen by the repo's owner; `GITHUB_TOKEN` is the fallback.

## Develop

```bash
npm test                                   # parser tests (node:test)
REPOS_DIR=/path/to/repos DATA_DIR=./data node src/server.js
```

Requires Node 22.13+ (uses the built-in `node:sqlite`, so there are no npm dependencies).

## API (for scripts)

`GET /api/state` · `GET /api/events` (SSE) · `POST /api/refresh` · `POST /api/rescan` · `PATCH /api/projects/:id` ·
`POST /api/projects/:id/links` · `POST /api/projects/:id/commands` · `POST /api/links` (global quick link)
