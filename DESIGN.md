# Project Multiverse — Design Proposal (v0.1)

Companion to [PROJECT_MULTIVERSE_SPEC.md](PROJECT_MULTIVERSE_SPEC.md). Covers spec §39 steps 2–6: domain model, DB schema,
API contract, engine design, and the ambiguities with their resolutions.
Nothing is built yet. This document is the thing to review before any code is written.

---

## 0. Decisions locked

### From the product owner

| # | Question | Decision |
|---|----------|----------|
| 1 | Calendar | **Working days only.** Weekends (and optional holidays) are skipped everywhere. |
| 2 | Delay attribution | Engine author's choice for now (see §3.7). Must be **swappable** — the owner will test scenarios and change the logic. |
| 3 | Parallelism | The "7 modules" event is only an example. Modules may run in parallel or not; the engine must not assume either. |
| 4 | Branches | The central line is the **original plan**. A module that deviates from its plan gets its **own timeline branch**, so there can be many branches. **Confirmed: one branch per deviating module.** |
| 5 | Baseline lock | **Per module.** |
| 6 | Data entry | **Manual** for now. No integrations, no automation. |
| 7 | Example numbers | Illustrative only. Inconsistencies in the spec are not bugs. |

### Defaults chosen here (change if wrong)

| # | Topic | Default |
|---|-------|---------|
| A | Weekend | Sat + Sun, configurable per project. Holiday list per project, empty by default. |
| B | Stack | TypeScript on Node 24 · SQLite (`node:sqlite`) · Fastify · Vitest · React + Vite (UI later). npm workspaces. |
| C | Clock | The engine never reads "now". Every calculation takes an explicit `asOf` date, meaning the **end** of that working day, so scenarios are repeatable and testable. |
| D | Capacity | Team-level speed factor (`current headcount / planned headcount`). **No resource contention** between parallel tasks. See §3.4. **Confirmed acceptable for now.** |
| E | Delivery lane | Post-Alpha work and the delivery milestone live in a `PROJECT` module, so the project delivery line is that module's branch. See §3.6. |
| F | Delay unit | Fractional working days allowed (`1.5d`). Dates are derived from them. |

---

## 1. Repository layout

```
project-multiverse/
├─ packages/
│  ├─ engine/      pure TypeScript, NO I/O, NO Date.now(), NO database. All the intelligence lives here.
│  │                Also holds the Thriveni reference fixture (src/fixtures), used by tests, seed and demo.
│  ├─ server/      Fastify API + SQLite persistence + seed scripts. Thin: loads data, calls engine, stores results.
│  └─ web/         React + Vite. Built last (Phase 4+).
└─ DESIGN.md
```

Rule: `engine` never imports from `server` or `web`. The same engine can later run in the browser for instant what-if previews.

---

## 2. Domain model

Terminology follows spec §35.

```
Project ─┬─ Calendar (weekend days, holidays)
         ├─ Team ── Person
         ├─ TeamCapacity   (team, from-date, headcount)       first row = planned headcount
         ├─ Module         kind: DELIVERABLE | SHARED | PROJECT, lockedAt?, scope contract
         │    └─ Task      kind: TASK | MILESTONE, estimate, team, owner?
         ├─ Dependency     predecessor → successor, type FS
         ├─ Feature        ↔ Modules (many-to-many), optional sharedTaskId
         ├─ Requirement
         ├─ Event          append-only log; carries typed Effects
         ├─ ForecastSnapshot   immutable, append-only
         └─ OwnershipHistory
```

**Design choices that matter**

1. **Milestones are tasks with `kind = MILESTONE` and zero duration.** The graph then has one node type. The project's delivery date is one designated milestone.
2. **Every task belongs to a module.** Shared work (extinguisher, localization, evaluation, menu UI) lives in a `SHARED` module. Post-Alpha work (client review → integration → QA → beta) and the delivery milestone live in a `PROJECT` module. Baseline lock works the same way for all three kinds.
3. **Estimates are in "work-days at planned capacity"** (effort). Elapsed time is *derived* from effort and capacity. This is what separates effort from schedule (spec §5.4).
4. **The plan tables hold only the baseline.** Once a module is locked its rows are frozen. Everything that happens afterwards — new scope, delays, progress, capacity changes — is an **Event** with typed **Effects**. The *current* plan is `replay(baseline, events)`, computed in memory, never stored as mutable rows. This gives one source of truth and makes counterfactual attribution possible.
5. **Events must be machine-applicable.** The spec's `estimatedEffortImpact` number alone cannot tell the engine *which* task moves. So an event carries `effects[]` (§2.2). The spec's descriptive fields stay on the event for analytics.

### 2.1 Event (spec §7 + `effects` + `asOf`)

```ts
interface Event {
  id: string; projectId: string; moduleId?: string; taskId?: string;
  type: EventType;                 // FEEDBACK | SCOPE_CHANGE | REQUIREMENT_CHANGE | BLOCKER | DEPENDENCY_DELAY |
                                   // RESOURCE_CHANGE | REWORK | DEFECT | TECHNICAL_DECISION | OWNERSHIP_TRANSFER |
                                   // CLIENT_FEEDBACK | TASK_DELAY | TASK_COMPLETION | MILESTONE_CHANGE
  category: string; title: string; description: string;
  phase: Phase;                    // PLANNING | STORYBOARD | ART | DEVELOPMENT | INTERNAL_REVIEW | ALPHA | CLIENT_REVIEW | QA | BETA | POST_DELIVERY
  createdBy: string; sourceTeamId?: string; affectedTeamId?: string; affectedOwnerId?: string;
  occurredAt: ISODate;             // when it happened in the real world
  recordedAt: Timestamp;           // when it was entered (system-set)
  asOf: ISODate;                   // status date used for the forecast it triggers (default occurredAt, clamped >= previous asOf)
  couldHaveBeenEarlier?: boolean;
  estimatedEffortImpact?: WorkDays;   estimatedScheduleImpact?: WorkDays;  // from preview, §5
  actualEffortImpact?: WorkDays;      actualScheduleImpact?: WorkDays;     // filled in later
  status: 'ACTIVE' | 'VOIDED';
  parentEventId?: string; linkedRequirementId?: string; linkedFeatureId?: string;
  effects: Effect[];
}
```

### 2.2 Effects — how an event changes the plan

```ts
type Effect =
  | { op: 'ADD_TASK';          task: TaskDef; dependsOn: TaskId[]; blocks: TaskId[] }   // new scope, rework, new shared feature
  | { op: 'ADJUST_ESTIMATE';   taskId: TaskId; delta: WorkDays }                        // +/-; on a started task it adjusts remaining work
  | { op: 'REMOVE_TASK';       taskId: TaskId }                                         // scope removed
  | { op: 'ADD_DEPENDENCY';    predecessorId: TaskId; successorId: TaskId }
  | { op: 'REMOVE_DEPENDENCY'; predecessorId: TaskId; successorId: TaskId }
  | { op: 'BLOCK_UNTIL';       taskId: TaskId; date: ISODate }                          // external dependency / blocker: earliest start
  | { op: 'SET_CAPACITY';      teamId: TeamId; from: ISODate; headcount: number }
  | { op: 'RECORD_PROGRESS';   taskId: TaskId; startedOn?: ISODate; remaining?: WorkDays; finishedOn?: ISODate }
  | { op: 'TRANSFER_OWNER';    taskId: TaskId; toPersonId: PersonId; contextCost?: WorkDays };  // contextCost becomes added effort
```

- **Effort impact** of an event = sum of estimate added or removed by its effects (`ADD_TASK`, `ADJUST_ESTIMATE`, `REMOVE_TASK`, `TRANSFER_OWNER.contextCost`). Capacity, blockers and dependencies have zero effort impact.
- **Schedule impact** of an event = change in project variance caused by applying it (§3.5). It is *computed*, never typed in.

### 2.3 Other conventions

- **Corrections.** Events are never edited or deleted. A mistaken event is set to `VOIDED`: replay skips it, and a new snapshot records the correction.
- **Back-dated events** are allowed. They keep their true `occurredAt`. The snapshot's `asOf` is clamped so it never goes earlier than the previous snapshot's.
- **Ownership** is a separate append-only table. An `OWNERSHIP_TRANSFER` event writes a row and may add context-transfer effort.
- **No individual metrics.** There are no per-person delay or efficiency views anywhere (spec §5.2, §36). Ownership history is for traceability only.

---

## 3. Engine design

### 3.1 Time model

- Input dates are `YYYY-MM-DD` strings. The engine converts them to **working-day offsets** using the project calendar. Offset `t` means the end of the t-th working day since the project start, so offset 0 is the start of day 1.
- A date used as a *start* (`startedOn`, `BLOCK_UNTIL`) means the **start** of that day. A date used as a *finish* or status date (`finishedOn`, `asOf`) means the **end** of that day. A weekend date resolves to the nearest working-day boundary.
- Durations and positions are fractional working days. A date is derived by `date(offset) = workday[max(ceil(offset), 1) − 1]`.
- No timezone arithmetic exists anywhere, which removes a whole class of off-by-one bugs.

### 3.2 Pipeline

```
Baseline plan ─┐
               ├─ replay(effects up to event k) ─► Current plan ─► schedule(asOf) ─► Schedule ─► Snapshot k
Events 1..k  ──┘
```

`schedule(plan, asOf)` is a pure function. Same inputs, same output, always.

### 3.3 Scheduling algorithm (forward / backward pass)

Forward pass in topological order. Cycles are rejected when a dependency is added.

| Node state | Start | Finish |
|------------|-------|--------|
| Completed | actual start | actual finish |
| In progress | actual start | `asOf` + time to burn the remaining effort at the team's capacity |
| Not started | `max(asOf, finish of all predecessors, BLOCK_UNTIL)` | start + time to burn the estimate at capacity |
| Milestone | — | `max(finish of predecessors)` |

Backward pass from the delivery milestone (late finish = forecast delivery) gives **total float** per task. **Critical path** = tasks with zero float. For the backward pass the engine uses each task's *forward-resolved elapsed duration* — a small approximation when a task would hit a different capacity window if slipped. It is documented and tested against textbook CPM examples.

Also computed: free float, and the **driving chain** (the unfinished critical tasks in order). That chain is what the Control Room shows as "current bottleneck". The next likely bottleneck is the near-critical chain with the least float.

### 3.4 Capacity

`factor(team, day) = headcount(team, day) / plannedHeadcount(team)`. A task needing `w` effort-days finishes at the first moment where the integral of its team's factor from the start equals `w`.
Example: Dev 4 → 2 people from day 9 means factor 0.5, so 5 remaining effort-days take 10 elapsed days.

Known limitations, deliberate for MVP (spec §15, §27): no resource levelling, so 7 parallel Dev tasks don't compete for 4 people. Adding people is linear (no ramp-up or coordination cost). Both can be added later without changing the data model.

### 3.5 Forecast snapshots and variance

Every snapshot stores both numbers it needs:

```
baselineDelivery   = schedule(baseline plan, asOf = start).delivery
forecastDelivery   = schedule(current plan, asOf).delivery
variance           = forecastDelivery − baselineDelivery            (working days)
stepDays           = variance(k) − variance(k−1)                    ← schedule impact of event k
```

Storing `baselineDelivery` in each snapshot handles module-level locking. If someone refines an *unlocked* module's plan, both baseline and forecast move together and the variance does not, so planning is never counted as delay.

The same logic applies per module: each snapshot stores every module's `baselineFinish` and `forecastFinish` (the finish of its last task), which is what the branches in §3.6 are built from.

Revision 0 is created when the first module is locked. A snapshot contains: per-task start/finish/float, per-module and per-milestone baseline vs forecast, the critical path, the trigger event, the effort impact, and an `engineVersion`. Snapshots are append-only (enforced by DB triggers). Because they store *results*, history survives a later change to the algorithm.

### 3.6 Multiverse timeline (branches)

Derived from snapshots; there is no `branches` table. **One branch per deviating module.**

- **Original line**: the baseline plan (revision 0). Never changes.
- Each snapshot stores, for every module, `baselineFinish` and `forecastFinish`. Module variance = forecast − baseline.
- A module **deviates** when its variance ≠ 0. The first time that happens it gets a branch off the original line. Each later snapshot that changes the module's variance adds a step to that branch.

```ts
interface Branch {
  moduleId: ModuleId;
  forkAt: ISODate;                 // asOf of the first snapshot in which the module deviated
  baselineFinish: ISODate;  currentFinish: ISODate;  currentDelta: WorkDays;
  status: 'OPEN' | 'MERGED';       // MERGED = back to variance 0 after a recovery
  steps: BranchStep[];
}
interface BranchStep {
  snapshotId: string;  eventId: string;
  delta: WorkDays;                 // change in this module's variance at this step
  finishAfter: ISODate;
  origin: 'DIRECT' | 'PROPAGATED'; // DIRECT: the event's effects touch this module's tasks
  fromModuleIds?: ModuleId[];      // PROPAGATED: modules upstream on the driving chain
  deliveryDelta: WorkDays;         // what the same snapshot did to project delivery
  absorbed: boolean;               // delta > 0 but deliveryDelta = 0: absorbed by float
  onCriticalPath: boolean;
}
```

- **Delivery branch.** The delivery milestone sits in the `PROJECT` module, so the project delivery line is simply that module's branch. A delay in M5 therefore produces an M5 branch (DIRECT) and a delivery branch (PROPAGATED, `fromModuleIds = [M5]`), linked by that field.
- **Absorbed delay.** A module can slip without moving delivery. It still gets its branch, flagged `absorbed`, so the slip is visible and so is the float that protected the project.
- **Recovery** (`delta < 0`) bends the branch back toward the original line. At variance 0 it is `MERGED`; if the module deviates again the branch re-opens.
- **No schedule effect.** An event that adds effort but moves no module's finish creates no branch step. It still shows as an event marker with its effort impact.
- Per-module variance, step and origin are all computed from stored snapshots plus the driving chain, so nothing extra is persisted.

### 3.7 Delay attribution (v1, swappable)

```ts
interface AttributionStrategy {
  name: string;
  attribute(baseline: Plan, events: Event[]): Contribution[];   // [{ eventId, category, days }], must sum to total variance
}
```

**v1 = `sequential`.** Replay events in recorded order. Event k's contribution is `stepDays(k)`. This telescopes, so contributions sum *exactly* to the final variance. It is simple and auditable. Its weakness is order dependence: if two events overlap on the critical path, whichever came first absorbs the credit or blame.

**Planned v2 = `counterfactual`.** Remove each event in turn and replay, then report the marginal days plus an explicit "interaction" remainder. The strategy interface exists so the owner can compare both on test scenarios.

Roll-up into spec §24 categories uses a configurable table:

| Condition | Contributor |
|-----------|-------------|
| `SCOPE_CHANGE`, `REQUIREMENT_CHANGE` | Scope changes (→ "Late scope discovery" if raised after the module's development started) |
| `FEEDBACK`, `CLIENT_FEEDBACK` | Late feedback (only if phase is later than the work it concerns) |
| `RESOURCE_CHANGE`, `TRANSFER_OWNER` cost | Capacity changes |
| `BLOCKER`, `DEPENDENCY_DELAY` | Dependency delays |
| `REWORK`, `DEFECT` | Rework |
| `TASK_DELAY` with no explaining event | Estimation / unexplained variance |

The unexplained bucket matters: without it a task that simply overran would be silently dropped, and the contributors would no longer add up to the variance.

### 3.8 Advisories (rules, never blockers)

- **Common feature detection** (spec §11): a Feature linked to ≥ N modules (default 2) with no `sharedTaskId` yields an advisory with module count and recommendation.
- Each advisory is a pure function `(plan) → Finding[]`. Definition of Ready and Feature Impact Assessment (spec §10, §12) will be added the same way after the MVP. The columns to hold them are nullable and reserved.

### 3.9 Derived views

- **Progress %** = completed effort ÷ total current effort (effort-weighted, not task-count).
- **Forecast drift** = delivery forecast across snapshots over time.
- **First breach** = first snapshot where forecast > baseline (spec §20 "first detectable risk"). Cheap to add because every snapshot is stored.

---

## 4. Database schema (SQLite)

```sql
projects          (id PK, name, start_date, target_date, weekend_days TEXT /*json*/, delivery_task_id)
holidays          (project_id, date)
teams             (id PK, project_id, name)
people            (id PK, team_id, name)
team_capacity     (team_id, from_date, headcount)                    -- first row = planned
modules           (id PK, project_id, name, kind /*DELIVERABLE|SHARED|PROJECT*/, scope_json, locked_at NULL)
tasks             (id PK, project_id, module_id, team_id, owner_id NULL, kind /*TASK|MILESTONE*/, name,
                   estimate REAL, start_no_earlier_than NULL, feature_id NULL)
dependencies      (predecessor_id, successor_id, type DEFAULT 'FS', PRIMARY KEY (predecessor_id, successor_id))
features          (id PK, project_id, name, shared_task_id NULL)
module_features   (module_id, feature_id)
requirements      (id PK, project_id, module_id NULL, text, status, discovered_phase)
events            (id PK, project_id, seq INTEGER, type, category, title, description, phase, module_id, task_id,
                   created_by, source_team_id, affected_team_id, affected_person_id,
                   occurred_at, recorded_at, as_of, status DEFAULT 'ACTIVE', parent_event_id,
                   linked_requirement_id, linked_feature_id, could_have_been_earlier,
                   est_effort, est_schedule, actual_effort, actual_schedule, effects_json)
forecast_snapshots(id PK, project_id, revision, trigger_event_id NULL, as_of, recorded_at,
                   baseline_delivery, forecast_delivery, variance_days, step_days, effort_impact,
                   critical_path_json, schedule_json, modules_json, engine_version)
ownership_history (task_id, person_id, from_date, to_date NULL, event_id NULL)
```

**Enforced in the database, not only in code**

- `BEFORE INSERT/UPDATE/DELETE` on `tasks` aborts if the module has `locked_at` set. New work after lock must come through an event.
- `BEFORE INSERT/DELETE` on `dependencies` aborts if the *successor's* module is locked.
- `BEFORE UPDATE/DELETE` on `forecast_snapshots` and `events` (except the `status` column) aborts.

---

## 5. API contract (REST + JSON)

| Method & path | Purpose |
|---|---|
| `POST /projects`, `GET /projects/:id` | Create project / load full model |
| `POST/PATCH/DELETE /projects/:id/{teams,people,modules,tasks,dependencies,features,capacity}` | Blueprint editing. Rejected with `409` on locked modules |
| `POST /projects/:id/modules/:mid/lock` | Freeze baseline. The first lock also writes revision 0 |
| `GET /projects/:id/advisories` | Common-feature findings (more later) |
| `POST /projects/:id/events/preview` | **Dry run.** Body is an event with effects. Returns `{ effortImpact, scheduleImpact, deliveryBefore, deliveryAfter, criticalPathBefore, criticalPathAfter, affectedTasks, moduleDeltas, absorbed }`. Persists nothing |
| `POST /projects/:id/events` | Persist event, apply effects, write snapshot. Returns `{ event, snapshot, branch? }` |
| `POST /projects/:id/events/:eid/void` | Void a mistaken event, writes a correcting snapshot |
| `GET /projects/:id/events` | Filter by type, phase, module, team |
| `GET /projects/:id/forecast` | Current forecast + critical path |
| `GET /projects/:id/snapshots`, `/snapshots/:sid` | Forecast history |
| `GET /projects/:id/timeline` | Original line + one branch per deviating module (with steps), for the Multiverse view |
| `GET /projects/:id/milestones/:tid/history` | Forecast history of one milestone (spec §20) |
| `GET /projects/:id/control-room` | Original, forecast, variance, progress, bottleneck, top contributors |
| `GET /projects/:id/retro?strategy=sequential` | Planned vs actual, contributors, late-feedback %, ownership history |

`preview` is how the spec's step 6→7 works: the developer says "+2 days", the system answers "delivery moves 2 working days (30 Oct → 3 Nov), critical path: yes".

---

## 6. Thriveni seed and the five reference scenarios

**Calendar.** Start Mon 5 Oct 2026, target Fri 30 Oct 2026 = exactly 20 working days.

**Teams.** PM, LXD, Art, Dev, QA. All capacity factors 1.0.

**Per module** (7 modules, parallel). Chain: Storyboard (LXD) → Art → Dev → Alpha milestone. Durations in working days:

| Module | SB | Art | Dev | Alpha at | Float to the Alpha join |
|---|---|---|---|---|---|
| M1 | 2 | 3 | 5 | 10 | 3 |
| M2 | 2 | 3 | 4 | 9 | 4 |
| M3 | 3 | 4 | 5 | 12 | 1 |
| M4 | 2 | 4 | 5 | 11 | 2 |
| M5 | 3 | 4 | 6 | **13** | **0 (critical)** |
| M6 | 2 | 3 | 5 | 10 | 3 |
| M7 | 3 | 3 | 5 | 11 | 2 |

**After Alpha** (all modules join; these tasks and the delivery milestone live in the `PROJECT` module): Client Review (PM, 1d) → Dev changes (2d) ‖ Art changes (1d) ‖ LXD changes (1d) → Integration (Dev, 1d) → QA (2d) → Beta (QA, 1d) → **Delivery milestone**. 13 + 1 + 2 + 1 + 2 + 1 = **20**.

**Shared module.** Menu UI (Dev 4d) → Localization (Dev 3d); Evaluation system (Dev 5d). Both feed Integration, with large float. The Extinguisher feature is linked to all 7 modules and deliberately has **no shared task**, so the advisory fires (spec §28 step 3).

### Reference scenarios — these become the first engine tests

| # | Event | Expected result |
|---|---|---|
| T1 | Baseline | Delivery **Fri 30 Oct** (offset 20). Critical path: M5 chain → Client Review → Dev changes → Integration → QA → Beta. No branches |
| T2 | M2 Dev **+3d** (float 4) | Effort +3. **M2 branch +3** (Alpha 9 → 12), flagged `absorbed`. Delivery **0**, with 1 day of float left |
| T3 | M5 Dev **+1d** (critical) | **M5 branch +1** (DIRECT) and **delivery branch +1** (PROPAGATED from M5) → offset 21 = **Mon 2 Nov** (skips the weekend) |
| T4 | M3 Dev **+3d** (float 1) | **M3 branch +3**; delivery **+2** → offset 22 = **Tue 3 Nov**. Critical path **switches** from M5 to M3. M5 has no branch |
| HS | Hero (spec §28/§40): LXD feedback means every module needs an *Extinguisher integration* task (Dev, 2d) inserted between its Dev and Alpha tasks; `linkedFeature = Extinguisher` | Effort **+14**, schedule **+2**, because the seven tasks run in parallel. **7 module branches (+2 each)** plus the **delivery branch +2** (PROPAGATED from M5). Critical path **yes** → **Tue 3 Nov**. Original and new forecast both retained |

HS deliberately models what actually happened on Thriveni: the extinguisher was integrated module by module, so the repeated cost is real. The advisory in §3.8 would have flagged this at planning time. Its **14 effort-days vs 2 schedule-days** is also the clearest demonstration of "effort ≠ schedule impact" (spec §5.4).

> Heads-up: the spec says "Nov 1" for the +2 case. With working-days-only in 2026, 1 Nov is a Sunday, so the demo shows **3 Nov**. This is correct behaviour.

Combined check for attribution: apply T2, then T3, then HS in order. Sequential contributions are `0, +1, +2` and must sum to the final variance of **+3** (offset 23 vs 20 → forecast Wed 4 Nov).

A capacity scenario (Dev 4 → 2 people from a chosen day) is added with its own hand-computed numbers when the capacity code is written. Their correctness matters, and I don't want to publish numbers I haven't verified.

---

## 7. Test plan

Pure-function tests in `packages/engine`, run by Vitest, before any server or UI exists:

1. **Calendar**: weekend skipping, holidays, date ↔ offset round-trip, fractional days.
2. **Graph**: topological order, cycle rejection, unknown ids.
3. **CPM**: textbook networks, float, critical path, ties (multiple critical paths).
4. **Scenarios T1–T4 and HS** above, exactly as tabulated.
5. **Capacity**: factor changes mid-task, factor ≥ 1, zero capacity is an error not an infinite loop.
6. **Progress**: completed / in-progress tasks use actuals and never move earlier than `asOf`.
7. **Replay**: applying effects in order is deterministic; voided events are skipped.
8. **Snapshots**: append-only, forecast history preserved, `stepDays` telescopes to total variance.
9. **Attribution**: contributions sum to variance for both strategies on every scenario (counterfactual includes the interaction remainder).
10. **Advisory**: Extinguisher with 7 modules and no shared task is flagged; adding a shared task clears it.
11. **Branches**: one per deviating module; DIRECT vs PROPAGATED origin and `fromModuleIds`; `absorbed` flag (T2); critical-path switch (T4); recovery and `MERGED`; no branch for a module that never deviates.

---

## 8. Assumptions to confirm

Resolved: branches are per deviating module, and capacity ignores contention. Still open:

1. **Delivery lane (§3.6).** Post-Alpha tasks and the delivery milestone sit in a `PROJECT` module, so the delivery branch is that module's branch. Delays that originate in a `SHARED` or `PROJECT` task also get a branch of their own. Is that the right granularity?
2. **Fork position.** A branch leaves the original line at the `asOf` of the first snapshot where the module deviated. The UI might prefer to fork at the module's planned position of the affected task. Both are derivable, so this can be settled when the timeline UI is built.
3. **Weekend** is Sat + Sun. If the team works alternate Saturdays, the calendar needs a rule for that.
4. **Variance is measured against the computed baseline**, not against `target_date`. In the seed they coincide. When they differ the Control Room should show both ("2 days of float to target" vs "+3 behind baseline"). This is not designed yet.
5. **Late-discovery classification** (§3.7) depends on knowing when a module's development started, from `RECORD_PROGRESS` effects. If nobody records progress, the classifier falls back to the event's `phase`.
6. **Hero scenario differs from the spec's numbers.** The spec says "estimated effort 2 days"; here each of the 7 modules gets a 2-day task (14 effort-days, +2 schedule). You said the numbers are illustrative, so I chose the version that exercises per-module branches.

---

## 9. Proposed build order

Follows spec §30. Each step ends in something testable.

1. **Scaffold** the workspace, TypeScript, Vitest, typecheck. *(done)*
2. **Engine core**: calendar → graph → capacity → forward/backward pass → T1, plus plan-level equivalents of T2–T4. *(done: 59 tests passing)*
3. **Effects + replay + snapshots**: T2, T3, T4, HS pass. This is the spec §39 milestone as a test.
4. **Attribution + advisories + timeline builder**, with strategy interface.
5. **Server + SQLite + seed** and the API from §5, tested with the Thriveni seed.
6. **Multiverse timeline UI**, then Control Room, then Retro view.
