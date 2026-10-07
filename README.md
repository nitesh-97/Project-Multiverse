# Project Multiverse

A project execution intelligence layer: it keeps the original plan, records the events that change it, propagates
their impact through dependencies and capacity, and explains why the delivery date moved.

- [PROJECT_MULTIVERSE_SPEC.md](PROJECT_MULTIVERSE_SPEC.md): what the product is and why
- [DESIGN.md](DESIGN.md): how it works (domain model, engine, schema, API) and the decisions behind it
- [docs/API.md](docs/API.md): the HTTP API, with PowerShell examples
- [docs/TESTING-UI.md](docs/TESTING-UI.md): a guided half hour with the web app (start here to try it)
- [docs/TESTING.md](docs/TESTING.md): the longer scenario guide, driven from PowerShell, with expected results

## Status

| Part | State |
|---|---|
| `packages/engine`: scheduling, events and plan edits, forecast snapshots, timeline (project and module views), attribution, advisories, control room, retro, per-project phases | built, 415 tests |
| `packages/server`: SQLite persistence, the HTTP API, and serving the web app | built, 205 tests |
| `packages/web`: Multiverse timeline (project view and module view), Control room, Retrospective, and recording changes | built, 176 tests |

## Requirements

Node 22.13 or newer (developed on Node 24). Nothing else: SQLite is built into Node.

## Quick start

```bash
npm install
npm test                 # engine, server and web tests (796 in all)
npm run typecheck
```

**The quickest way to try it** is one command. It starts a demo database from nothing (its own file, `data/demo.sqlite`,
never your real data), loads four sample projects, builds the web app and starts the server:

```bash
npm run demo
```

Open **http://127.0.0.1:4000**. Or, to set things up yourself: load the Thriveni reference project, with three demo events so
there is history to look at, build the web app, and start the server:

```bash
npm run seed -w @multiverse/server -- --events
npm run build -w @multiverse/web
npm start -w @multiverse/server
```

Open **http://127.0.0.1:4000**. The timeline comes first. The server keeps its data in
`packages/server/data/multiverse.sqlite` (npm runs workspace scripts from the package folder; change with `DB_PATH`,
`PORT`, `HOST`).

Thriveni is a VR training. To see a project of a different kind, with phases of its own, load the community-centre sample
(a building) before starting the server:

```bash
npm run seed -w @multiverse/server -- --sample community-centre --events
```

While working on the web app, run the server and Vite side by side and open http://127.0.0.1:5173 (it reloads as you
edit, and proxies to the API):

```bash
npm start -w @multiverse/server
npm run dev -w @multiverse/web
```

The API can be used directly as well. In a terminal:

```powershell
Invoke-RestMethod http://127.0.0.1:4000/projects/thriveni/forecast
Invoke-RestMethod http://127.0.0.1:4000/projects/thriveni/timeline
Invoke-RestMethod http://127.0.0.1:4000/projects/thriveni/attribution
```

Leave out `--events` to start from the original plan (delivery Fri 30 Oct 2026) and record your own. To start over,
delete the database file.

Node prints "SQLite is an experimental feature". That is expected and harmless.

## Layout

```
packages/engine   pure TypeScript: no I/O, no clock. All the intelligence lives here.
packages/server   Fastify API + SQLite. Thin: loads data, calls the engine, stores results.
packages/web      React + Vite. Four screens over the API; hand-built SVG charts. The server serves its build.
```

## Security

There is no authentication. The server binds to `127.0.0.1` so only this machine can reach it. Do not set `HOST` to
something public without adding authentication first.
