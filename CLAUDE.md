# Dev Desktop

Persistent dashboard of active projects (git / GitHub / Docker / uptime data + links and commands). Node 22, no npm deps
(built-in `node:sqlite`), vanilla JS front-end, single container. See README.md for behaviour and config.

## Layout
- `src/server.js` HTTP + SSE + routes; `src/live.js` pollers and live state; `src/scan.js` repo discovery
- `src/projects.js` DB access + snapshot; `src/collectors/{git,docker,github,health}.js`
- `public/` UI (index.html, app.js, style.css); `test/` node:test parsers

## Run / verify
- Start: `docker compose up -d --build` (or `./setup.ps1`), UI at http://localhost:7070
- Check: `docker compose ps` shows healthy; `curl http://localhost:7070/api/state` lists projects from `/repos`
- Tests: `npm test` (needs Node 22.13+)
- State persists in the `dev-desktop-data` volume; `docker compose down` keeps it, `down -v` deletes it.

## Conventions
- Repos are mounted read-only; never write to them.
- Port stays bound to 127.0.0.1 (Docker socket is mounted, no auth).
- Keep zero npm dependencies unless there is a strong reason.
