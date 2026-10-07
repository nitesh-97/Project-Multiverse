# Project Multiverse

A project execution intelligence layer: it keeps the original plan, records the events that change it, propagates
their impact through dependencies and capacity, and explains why the delivery date moved.

- [PROJECT_MULTIVERSE_SPEC.md](PROJECT_MULTIVERSE_SPEC.md): what the product is and why
- [DESIGN.md](DESIGN.md): how it works (domain model, engine, schema, API) and the decisions behind it
- [docs/API.md](docs/API.md): the HTTP API, with PowerShell examples
- [docs/TESTING.md](docs/TESTING.md): a guided hour of testing, with expected results (start here to try it)

## Status

| Part | State |
|---|---|
| `packages/engine`: scheduling, events and plan edits, forecast snapshots, timeline, attribution, advisories | built, 312 tests |
| `packages/server`: SQLite persistence and the HTTP API | built, 120 tests |
| `packages/web`: timeline, Control Room and Retro views | not started |

## Requirements

Node 22.13 or newer (developed on Node 24). Nothing else: SQLite is built into Node.

## Quick start

```bash
npm install
npm test                 # engine and server tests (432 in all)
npm run typecheck
```

Load the Thriveni reference project, with three demo events so there is history to look at:

```bash
npm run seed -w @multiverse/server -- --events
npm start -w @multiverse/server
```

The server listens on `http://127.0.0.1:4000` and keeps its data in `packages/server/data/multiverse.sqlite` (npm runs
workspace scripts from the package folder; change with `DB_PATH`, `PORT`, `HOST`). Then, in another terminal:

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
packages/web      (not started)
```

## Security

There is no authentication. The server binds to `127.0.0.1` so only this machine can reach it. Do not set `HOST` to
something public without adding authentication first.
