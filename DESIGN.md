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
  asOf: ISODate;                   // status date (end of that working day) used for the forecast it triggers; clamped >= previous asOf
  // projectId and recordedAt (system-set) live on the stored row, not on the engine's Event
  couldHaveBeenEarlier?: boolean;
  estimatedEffortImpact?: WorkDays;   estimatedScheduleImpact?: WorkDays;  // from preview, §5
  actualEffortImpact?: WorkDays;      actualScheduleImpact?: WorkDays;     // filled in later
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
  | { op: 'BLOCK_UNTIL';       taskId: TaskId; date: ISODate | null }                   // external dependency / blocker: sets earliest start (replaces any earlier one); null clears
  | { op: 'SET_CAPACITY';      teamId: TeamId; from: ISODate; headcount: number }
  | { op: 'RECORD_PROGRESS';   taskId: TaskId; startedOn?: ISODate | null; remaining?: WorkDays | null; finishedOn?: ISODate | null }
  | { op: 'TRANSFER_OWNER';    taskId: TaskId; toPersonId: PersonId; contextCost?: WorkDays };  // contextCost becomes added effort
```

Rules the engine enforces (each failure is an `EffectError` naming the event and the effect):

- **Started work cannot be made to wait for something new.** `ADD_TASK.blocks`, `ADD_DEPENDENCY` and `BLOCK_UNTIL` are rejected on a task that has started. Silently ignoring them would let someone believe they had changed the forecast.
- **Finished work cannot be re-estimated, re-owned or removed.** Rework is a new `ADD_TASK`. `REMOVE_TASK` is rejected once a task has started.
- **`REMOVE_TASK` reconnects the chain.** Removing `X` from `A → X → B` leaves `A → B`, as if `X` took no time. The delivery milestone cannot be removed.
- **`SET_CAPACITY` only changes capacity** after the team's planned-headcount date; it cannot redefine the plan.
- **`RECORD_PROGRESS` merges.** Fields left out are kept, `null` clears one, recording `finishedOn` clears `remaining`, and `remaining` needs a start date.
- **Duplicates and typos fail loudly**: an existing dependency, a missing one being removed, an unknown task, a malformed date.
- The result must still be a valid plan: no cycles, no dangling references.

- **Effort impact** of an event = sum of estimate added or removed by its effects (`ADD_TASK`, `ADJUST_ESTIMATE`, `REMOVE_TASK`, `TRANSFER_OWNER.contextCost`). Capacity, blockers and dependencies have zero effort impact.
- **Schedule impact** of an event = change in project variance caused by applying it (§3.5). It is *computed*, never typed in.

### 2.3 Other conventions

- **The log.** The project history is an ordered log whose entries are either an `EVENT` or a `VOID`. Engine functions take and return this log; persistence assigns each entry a `seq`.
- **Corrections.** Events are never edited or deleted. A mistaken event is withdrawn by a `VOID` entry that names it. The plan is rebuilt from the baseline without that event (effects do not always commute, so subtracting is not enough) and a `VOID` snapshot records the change, with negative effort and schedule impact. A void is refused if a later event relied on the one being withdrawn (for example, it adjusted a task the voided event added).
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
Snapshot k-1 ─► carry forward to asOf(k) ─► apply event k's effects ─► schedule(asOf) ─► Snapshot k
(plan + forecast)  (on-plan unless recorded)     (typed, validated)
```

`schedule(plan, asOf)` is a pure function. Same inputs, same output, always. Every step is a pure function of the previous state, so history is an immutable chain and the old forecast is preserved by construction.

**Carry-forward.** Between events nobody may have recorded progress, so the previous forecast is treated as what happened unless someone says otherwise. Tasks it had finished by the new status date become finished (at its exact offsets), tasks it had started become in progress with the effort left after burning at the team's capacity, and the rest are untouched. A `RECORD_PROGRESS` effect overrides it with the truth.
Without this, any event with a later status date would silently re-plan every unrecorded task from that date, and the forecast would jump for no reason. It also keeps data entry light: events matter, progress reports are optional. A property test checks that carrying a forecast forward with no other change reproduces it exactly.

**Known limitation.** "On plan unless told otherwise" means forecasts are only as honest as the recorded actuals. A task that is quietly running late but has no `RECORD_PROGRESS` or delay event will still look on time. Surfacing that (for example, a nudge when a task passes its forecast finish without being recorded) is future work.

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

Revision 0 is created when the first module is locked. A snapshot contains: per-task start/finish/float, per-module and per-milestone baseline vs forecast, the critical path, the trigger event, the effort impact, and an `engineVersion`. Snapshots are append-only (enforced by DB triggers). Because they store *results*, history survives a later change to the algorithm. Variance and step are reported to a millionth of a working day, so numerical noise can never read as a real change (a step of 0.000000001 would otherwise create a phantom branch).

### 3.6 Multiverse timeline (branches)

Derived from snapshots; there is no `branches` table. **One branch per deviating module.**

- **Original line**: the baseline plan (revision 0). Never changes.
- Each snapshot stores, for every module, `baselineFinish` and `forecastFinish`. Module variance = forecast − baseline.
- A module **deviates** when its variance ≠ 0. The first time that happens it gets a branch off the original line. Each later snapshot that changes the module's variance adds a step to that branch.

```ts
interface Branch {
  moduleId: ModuleId;  moduleName: string;
  isDelivery: boolean;             // this module holds the delivery milestone: it is the project delivery lane
  forkAt: ISODate;                 // asOf of the first snapshot in which the module deviated
  baselineFinish: DatedOffset | null;  currentFinish: DatedOffset;  currentDelta: WorkDays;
  status: 'OPEN' | 'MERGED';       // MERGED = back to variance 0 after a recovery
  steps: BranchStep[];
}
interface BranchStep {
  revision: number;  kind: 'EVENT' | 'VOID';  eventId: string;  asOf: ISODate;
  delta: WorkDays;                 // change in this module's variance at this step
  variance: WorkDays;              // the module's total variance after the step
  finishAfter: DatedOffset;
  origin: 'DIRECT' | 'PROPAGATED'; // DIRECT: the event's effects touch this module's tasks
  fromModuleIds: ModuleId[];       // PROPAGATED: the changed modules that explain the move
  deliveryDelta: WorkDays;         // what the same snapshot did to project delivery
  absorbed: boolean;               // delta > 0 but deliveryDelta = 0: absorbed by float
  onCriticalPath: boolean;
}
interface Timeline {
  original: { delivery; modules[]; milestones[] };   // the baseline, never changes
  current:  { delivery; variance; asOf };
  branches: Branch[];              // in the order modules first deviated
  markers:  EventMarker[];         // every event and void, including those that moved nothing
}
```

- **Delivery branch.** The delivery milestone sits in the `PROJECT` module, so the project delivery line is simply that module's branch. A delay in M5 therefore produces an M5 branch (DIRECT) and a delivery branch (PROPAGATED, `fromModuleIds = [M5]`), linked by that field.
- **Absorbed delay.** A module can slip without moving delivery. It still gets its branch, flagged `absorbed`, so the slip is visible and so is the float that protected the project.
- **Recovery** (`delta < 0`) bends the branch back toward the original line. At variance 0 it is `MERGED`; if the module deviates again the branch re-opens.
- **No schedule effect.** An event that adds effort but moves no module's finish creates no branch step. It still shows as an event marker with its effort impact (`noScheduleEffect`).
- **Voids** add a `VOID` step to every branch the voided event had moved, naming the withdrawn event.
- **`fromModuleIds`** looks upstream on the *new* driving chain for delays, and on the *old* one for recoveries. When M5 finishes early and the critical path switches to M3, the delivery gain is still attributed to M5, not to M3, which did not change.
- Per-module variance, step and origin are all computed from stored snapshots plus the driving chain, so nothing extra is persisted. `buildTimeline(state)` derives it on demand.

### 3.7 Delay attribution (swappable)

This is the part the owner will tune after trying scenarios, so it has three separate seams: the **strategy** (how days are divided), the **category rules** (how events are grouped), and a **reconciliation check** (no strategy can lose or invent days).

```ts
interface AttributionStrategy {
  name: string;
  attribute(input: { baseline: Plan; log: LogEntry[]; state: ProjectState }): {
    contributions: { eventId; days; effortDays }[];
    interaction: WorkDays;          // days no single event accounts for
  };
}
attributeDelay(state, { strategy?, rules? }) → { strategy, totalVariance, contributions[], interaction, byCategory[] }
```

`attributeDelay` throws if `Σ contributions + interaction ≠ total variance`, naming the strategy. A strategy under development fails loudly instead of producing a retro that does not add up.

Both strategies replay only the **active** events (a voided event is skipped entirely), not stored snapshots, so voids never distort the shares.

**`sequential` (default).** Event k's contribution is `stepDays(k)`. This telescopes, so contributions sum *exactly* to the total and `interaction` is always 0. Simple and auditable. Its weakness is order dependence: when two events overlap on the critical path, whichever was recorded first takes the credit or blame.

**`counterfactual`.** Remove each event in turn, replay, and report how much sooner the project would have finished without it (its marginal). Marginals do not generally add up, because overlapping events hide each other; the shortfall is reported as `interaction`. If other events build on the removed one's tasks, they are removed with it.

Worked example (M5 Dev +1 and M3 Dev +3 land together; M3 sets the pace, total +2):

| | `blocked` (M5 +1) | `m3-slip` (M3 +3) | interaction |
|---|---|---|---|
| sequential | +1 | +1 | 0 |
| counterfactual | 0 (hidden behind M3) | +1 (without it the project is only +1) | +1 |

Neither is "right". They answer different questions, which is why both exist.

**Categories** are a first-match-wins rule list (`DEFAULT_CATEGORY_RULES`), data you can edit or replace. v1 uses the event's `phase` as the signal for "late":

| Event | Category |
|---|---|
| `SCOPE_CHANGE`, `REQUIREMENT_CHANGE` | **Late scope discovery** if phase is `DEVELOPMENT` or later, else Scope changes |
| `FEEDBACK` | **Late feedback** if phase is `INTERNAL_REVIEW` or later, else Feedback |
| `CLIENT_FEEDBACK` | Client feedback |
| `RESOURCE_CHANGE`, `OWNERSHIP_TRANSFER` | Capacity changes |
| `BLOCKER`, `DEPENDENCY_DELAY` | Dependency delays |
| `REWORK`, `DEFECT` | Rework |
| `TECHNICAL_DECISION` | Technical decisions |
| `MILESTONE_CHANGE` | Milestone changes |
| `TASK_DELAY`, `TASK_COMPLETION` | Estimation / unexplained variance |
| anything else | Other |

A `TASK_DELAY` that names a `parentEventId` takes its parent's category (a delay that has an explanation on record is not "unexplained"); chains are followed and cycles cannot loop.

The unexplained bucket matters: without it a task that simply overran would be dropped, and the contributors would no longer add up to the variance.

**Known sensitivity.** Because categories come from the event's `type` and `phase`, the same extinguisher change is "Late scope discovery" if recorded as a `SCOPE_CHANGE` during development but only "Feedback" if recorded as `FEEDBACK` during development. The numbers are identical; the label depends on how it was entered. This is deliberate for v1 (the person recording the event knows what it was) but is the first thing to revisit after trying scenarios.

### 3.8 Advisories (rules, never blockers)

- **Common feature detection** (spec §11): a feature used by ≥ N modules (default 2) with no shared implementation task yields an advisory with the module count and a recommendation. A feature is *used by* a module if it is listed against it (`Feature.moduleIds`) or one of the module's tasks implements it (`Task.featureId`). Only `DELIVERABLE` modules count, because shared and project modules are where shared work lives, not consumers of it. A feature has a shared implementation when `Feature.sharedTaskId` names an existing task.
- On the Thriveni seed exactly one advisory fires: *"Common feature detected: Extinguisher is used by 7 modules but has no shared implementation task."* Localization, evaluation and the menu each have a shared task and are not flagged.
- Each advisory is a pure function `(plan) → Advisory[]`; `Plan.features` is optional and never affects the schedule. Definition of Ready and Feature Impact Assessment (spec §10, §12) will be added the same way after the MVP. The columns to hold them are nullable and reserved.

### 3.9 Derived views

All computed from stored snapshots; nothing extra is persisted.

- **Forecast drift** (`forecastDrift`) = the delivery forecast at every revision.
- **Milestone history** (`milestoneHistory`) = one milestone's baseline and forecast at every revision (spec §20).
- **First breach** (`firstBreach`) = first snapshot where forecast > baseline. This is *recognised* schedule impact. The spec §20 metric "time between first detectable risk and recognized impact" needs a notion of *detectable* risk (for example, float to target shrinking to zero) that is not designed yet.
- **Progress %** = completed effort ÷ total current effort (effort-weighted, not task-count). Not built yet; part of the Control Room.

---

## 4. Database schema (SQLite), as built

Uses Node's built-in `node:sqlite`, so there is nothing to install or compile. In Node 24 it works without a flag but prints a one-line "experimental" warning. Source: [packages/server/src/db/schema.ts](packages/server/src/db/schema.ts).

Changes from the first sketch, all deliberate:

- **Keys are scoped by project** (`PRIMARY KEY (project_id, id)`), so two projects can both have a task `m1.dev`.
- **Holidays are a JSON column on `projects`**, not a table. They freeze together with the rest of the calendar.
- **`people`, `requirements` and `ownership_history` are not built yet.** Ownership history can be derived from the log (`TRANSFER_OWNER` effects) when the Retro view needs it.
- **`forecast_snapshots` stores the whole snapshot as JSON** plus a few columns for querying, and carries a `plan_revision` (see below).
- `features.shared_task_id` has no foreign key: it may name a task that only exists once an event has added it.

```sql
projects          (id PK, name, start_date, target_date, weekend_days JSON, holidays JSON, delivery_task_id,
                   plan_revision, started_at, created_at)
teams             (project_id, id, name)
team_capacity     (project_id, team_id, from_date, headcount)           -- earliest row per team = planned
modules           (project_id, id, name, kind /*DELIVERABLE|SHARED|PROJECT*/, scope_json, locked_at)
tasks             (project_id, id, module_id, team_id, owner_id, kind /*TASK|MILESTONE*/, name,
                   estimate, start_no_earlier_than, feature_id)
dependencies      (project_id, predecessor_id, successor_id, type 'FS')
features          (project_id, id, name, shared_task_id)
module_features   (project_id, module_id, feature_id)
events            (project_id, id, seq, type, category, title, description, phase, module_id, task_id,
                   created_by, source_team_id, affected_team_id, affected_person_id,
                   occurred_at, recorded_at, as_of, parent_event_id, linked_requirement_id, linked_feature_id,
                   could_have_been_earlier, est_effort, est_schedule, actual_effort, actual_schedule, effects_json)
event_voids       (project_id, id, seq, event_id, as_of, reason, recorded_at)    -- seq is shared with events
forecast_snapshots(project_id, plan_revision, revision, kind, event_id, void_id, as_of, recorded_at,
                   baseline_delivery, forecast_delivery, variance_days, step_days, effort_impact,
                   engine_version, snapshot_json)
```

**Enforced in the database, not only in code.** Each of these is tested by running raw SQL that bypasses the API.

- A task of a **locked module** cannot be inserted, changed, moved into, or deleted. New work after lock must be an event.
- A **dependency** whose successor is in a locked module cannot be added or removed.
- A locked module cannot be changed, unlocked or deleted.
- Once the **project has started**, its calendar, delivery milestone, teams, capacity and features are frozen. Name and target date stay editable: they are only labels.
- `events`, `event_voids` and `forecast_snapshots` are **append-only**. Corrections are new rows.

All trigger messages begin `LOCKED:`, which the API turns into `409`.

**What is stored and what is derived.** Stored: the baseline rows, the log (events and voids) and the snapshots as they were recorded. Derived on each request: the engine's current plan, by replaying the log over the baseline. Recording, previewing, attribution and advisories use the replay. History views (forecast, snapshots, timeline) read the stored snapshots, so history shows what was recorded at the time even if the algorithm later changes.

### Plan revisions: how per-module locking works with one baseline

The engine assumes one baseline for the whole history. Per-module locking means modules not yet started can still be refined after others have started. Both hold because of **plan revisions**:

- The first lock starts the project and writes the whole history under plan revision 1.
- A planning edit to an **unlocked** module after that (a task estimate, a dependency, a new module) moves the baseline. The server replays the log over the new baseline and writes a **complete new set of snapshots under revision 2**. Earlier revisions are kept, never updated or deleted, and views follow the current revision.
- If an existing event could no longer apply (it referred to a task the edit removed), or the edit makes the plan invalid, the edit is refused with `409 EDIT_BREAKS_HISTORY` and **nothing changes**.
- `POST /projects/:id/rebuild-history` writes a new revision with the current engine, to adopt a newer algorithm. The old revision is kept.

Effect: refining an unlocked module is treated as planning, not delay. If M7 is re-planned from 5 to 8 days of development and that makes the original plan a day longer, the original delivery date moves with it, and an earlier M5 slip stops showing as variance because it is now hidden behind M7's longer plan. Both views remain available.

---

## 5. API (REST + JSON), as built

Run it with `npm start -w @multiverse/server` (default `http://127.0.0.1:4000`). Examples for each flow are in [docs/API.md](docs/API.md). All bodies are strict: an unknown or misspelled field is a `400` naming its path.

| Group | Endpoints |
|---|---|
| Health | `GET /health` |
| Projects | `POST /projects` · `GET /projects` · `GET /projects/:id` · `PATCH /projects/:id` (name, target date; calendar until started) · `PUT /projects/:id/delivery` · `GET /projects/:id/validate` |
| Blueprint | `PUT /projects/:id/blueprint` (whole plan at once, before start) · `POST/PATCH/DELETE` on `/teams`, `/modules`, `/tasks`, `/features` · `POST /capacity`, `DELETE /capacity?teamId=&from=` · `POST /dependencies`, `DELETE /dependencies/:predecessorId/:successorId` |
| Locking | `POST /projects/:id/modules/:moduleId/lock` (first lock starts the project and writes revision 0) |
| Events | `POST /projects/:id/events/preview` · `POST /projects/:id/events` · `GET /projects/:id/events` (filter by `type`, `phase`, `moduleId`, `teamId`, `status`) · `GET /projects/:id/events/:eventId` · `POST /projects/:id/events/:eventId/void` |
| Views | `GET /projects/:id/forecast` · `/snapshots` (`?full=true`) · `/snapshots/:revision` · `/timeline` · `/history` · `/milestones/:taskId/history` · `/advisories` (`?minModules=`) · `/attribution` (`?strategy=sequential\|counterfactual`) |
| Plan | `GET /projects/:id/plan` · `/plan-revisions` · `POST /projects/:id/rebuild-history` |

`preview` is how the spec's step 6→7 works: the developer says "+2 days", the system answers with the schedule and effort impact, whether it is on the critical path, and the modules affected. It applies exactly the checks recording does and writes nothing.

**Errors** are always `{ error, message, details? }`:

| Status | `error` | Meaning |
|---|---|---|
| 400 | `BAD_REQUEST` | Malformed JSON, or a field is missing, misspelled, or invalid (`details` lists each path) |
| 404 | `NOT_FOUND` | No such project, task, event, snapshot or route |
| 409 | `LOCKED` | The database refused: the module is locked or the project has started |
| 409 | `NOT_STARTED` | Lock a module first |
| 409 | `ALREADY_LOCKED`, `PROJECT_STARTED`, `ALREADY_EXISTS`, `ALREADY_VOIDED`, `REFERENCE` | State conflicts |
| 409 | `CANNOT_VOID` | A later event relied on the one you are voiding |
| 409 | `EDIT_BREAKS_HISTORY` | A planning edit would invalidate recorded history; nothing was changed |
| 422 | `INVALID_PLAN` | The blueprint is not a valid plan; `details` lists every problem |
| 422 | `EVENT_REJECTED` | The event cannot be applied, or names things that do not exist; the message names the effect |
| 500 | `INTERNAL` | Unexpected. The body never contains internals; details are in the server log |

**Atomicity.** Every write is one transaction. A rejected event leaves no row behind, and the next event still takes the next number in the log.

**Security.** There is no authentication: it is a local tool. The server listens on `127.0.0.1` only unless `HOST` is set, so nothing else on the network can reach it. Do not expose it without adding authentication.

**Not built yet:** `control-room` and `retro` (step 6, they need the progress and bottleneck calculations in the engine), people and ownership endpoints, and CORS (needed when the UI is served from a different port).

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

**CAP (capacity).** Event recorded Tue 13 Oct (offset 7): Dev drops from 4 to 2 people from Wed 14 Oct. Every Dev task with work left now takes twice as long: M5 Dev 6d → 12d (ends 19), M3 Dev 5d → 10d (ends 17), client changes 2d → 4d, integration 1d → 2d. So 19 + review 1 + changes 4 + integration 2 + QA 2 + beta 1 = **29**. Expected: effort **0**, schedule **+9** → **Thu 12 Nov**; M1–M7 and the delivery lane all deviate DIRECT (the capacity change touches them), while the Shared module is unaffected because its work finished by day 7. This is the "describe it as a capacity change, not underperformance" case (spec §15).

**Status dates.** T2–T4, HS and CAP are recorded with status dates of 13–14 Oct, when most Dev work is under way, so they exercise carry-forward. A further case, **recovery**, records "M5 Dev finished Fri 16 Oct" (planned for 13 days, done at 10): delivery moves **−1** to Thu 29 Oct and no further, because M3 (12) now sets the pace. The explanation attributes the gain to M5 even though the critical path moved to M3.

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
9. **Attribution**: contributions plus interaction equal the variance for both strategies on ten scenarios, including voids, recovery and capacity cuts; a custom strategy that does not add up is rejected.
10. **Advisory**: Extinguisher with 7 modules and no shared task is flagged; adding a shared task clears it; thresholds, task-derived links and shared/project modules are covered.
11. **Branches**: one per deviating module; DIRECT vs PROPAGATED origin and `fromModuleIds`; `absorbed` flag (T2); critical-path switch (T4); recovery and `MERGED`; no branch for a module that never deviates. *(the explanation data for these is tested in step 3; the branch builder itself is step 4)*
12. **Carry-forward**: jumping to, or stepping through, any status date with no other change reproduces the baseline forecast exactly. Checked on Thriveni, Thriveni with a mid-project Dev cut, and fractional estimates with a 2/3 capacity factor (the worst case for rounding drift).

---

## 8. Assumptions to confirm

Resolved: branches are per deviating module, and capacity ignores contention. Still open:

1. **Delivery lane (§3.6).** Post-Alpha tasks and the delivery milestone sit in a `PROJECT` module, so the delivery branch is that module's branch. Delays that originate in a `SHARED` or `PROJECT` task also get a branch of their own. Is that the right granularity?
2. **Fork position.** A branch leaves the original line at the `asOf` of the first snapshot where the module deviated. The UI might prefer to fork at the module's planned position of the affected task. Both are derivable, so this can be settled when the timeline UI is built.
3. **Weekend** is Sat + Sun. If the team works alternate Saturdays, the calendar needs a rule for that.
4. **Variance is measured against the computed baseline**, not against `target_date`. In the seed they coincide. When they differ the Control Room should show both ("2 days of float to target" vs "+3 behind baseline"). This is not designed yet.
5. **Late-discovery classification** (§3.7) depends on knowing when a module's development started, from `RECORD_PROGRESS` effects. If nobody records progress, the classifier falls back to the event's `phase`.
6. **Hero scenario differs from the spec's numbers.** The spec says "estimated effort 2 days"; here each of the 7 modules gets a 2-day task (14 effort-days, +2 schedule). You said the numbers are illustrative, so I chose the version that exercises per-module branches.
7. **"On plan unless told otherwise" (§3.2 carry-forward).** Between events, the engine assumes tasks progress as the previous forecast said. This keeps data entry light but means a quietly late task looks on time until someone records it. Is that the right default for the first trial, or should an unrecorded task past its forecast finish be flagged?
8. **Refining an unlocked module after the project has started (§4 plan revisions).** The server allows it and rebuilds history under a new plan revision, keeping the old one. The alternative is to forbid any plan edit once the first module is locked, which is simpler but makes per-module locking pointless. Is the revision behaviour what you want?
9. **Events on unlocked modules.** The engine and server accept an event that touches a module that has not been locked, and carry-forward can mark such a module's tasks as started. That is probably a data-entry mistake (an unlocked module's scope should simply be edited). Should the server refuse or warn?
10. **No authentication.** Fine for a local tool bound to `127.0.0.1`. Needed before anyone else uses it over a network.

---

## 9. Proposed build order

Follows spec §30. Each step ends in something testable.

1. **Scaffold** the workspace, TypeScript, Vitest, typecheck. *(done)*
2. **Engine core**: calendar → graph → capacity → forward/backward pass → T1, plus plan-level equivalents of T2–T4. *(done: 59 tests passing)*
3. **Effects + replay + snapshots + explanation**: T2, T3, T4, HS, CAP, recovery and void all pass through the event log. This is the spec §39 milestone as a test. *(done: 169 tests passing; step 4 below builds on `explainSnapshot`)*
4. **Attribution + advisories + timeline builder**, with strategy interface. *(done: 242 tests passing)*
5. **Server + SQLite + seed** and the API from §5, tested with the Thriveni seed. *(done: 89 server tests, plus a manual run of the real seed and server)*
6. **Multiverse timeline UI**, then Control Room, then Retro view.
