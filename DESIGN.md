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
│  └─ web/         React + Vite. Four screens over the API (§10). Hand-built SVG charts, no chart library.
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
  phase: Phase;                    // one of the project's own phases (§2.4): "which phase was the project in when this came up?"
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
  | { op: 'TRANSFER_OWNER';    taskId: TaskId; toPersonId: PersonId; contextCost?: WorkDays }   // contextCost becomes added effort
  | { op: 'ADD_HOLIDAY';       date: ISODate };                                                 // a day nobody works; must be after the status date
```

Rules the engine enforces (each failure is an `EffectError` naming the event and the effect):

- **Started work cannot be made to wait for something new.** `ADD_TASK.blocks`, `ADD_DEPENDENCY` and `BLOCK_UNTIL` are rejected on a task that has started. Silently ignoring them would let someone believe they had changed the forecast.
- **Finished work cannot be re-estimated, re-owned or removed.** Rework is a new `ADD_TASK`. `REMOVE_TASK` is rejected once a task has started.
- **`REMOVE_TASK` reconnects the chain.** Removing `X` from `A → X → B` leaves `A → B`, as if `X` took no time. The delivery milestone cannot be removed.
- **`SET_CAPACITY` only changes capacity** after the team's planned-headcount date; it cannot redefine the plan.
- **`RECORD_PROGRESS` merges.** Fields left out are kept, `null` clears one, recording `finishedOn` clears `remaining`, and `remaining` needs a start date. It also **confirms**: it clears the engine's "assumed" mark on the task, and if it says the task finished *later* than the forecast assumed, the work after it is re-derived from the corrected finish (§3.2).
- **`ADD_HOLIDAY`** only for a future working day: not on or before the status date (history is not rewritten), not a weekend, not an existing holiday. A holiday changes no working-day count, only the dates they fall on, so variance is measured in the *current* calendar (§3.5).
- **Duplicates and typos fail loudly**: an existing dependency, a missing one being removed, an unknown task, a malformed date.
- The result must still be a valid plan: no cycles, no dangling references.

- **Effort impact** of an event = sum of estimate added or removed by its effects (`ADD_TASK`, `ADJUST_ESTIMATE`, `REMOVE_TASK`, `TRANSFER_OWNER.contextCost`). Capacity, blockers and dependencies have zero effort impact.
- **Schedule impact** of an event = change in project variance caused by applying it (§3.5). It is *computed*, never typed in.

### 2.3 Other conventions

- **The log.** The project history is an ordered log whose entries are an `EVENT`, a `PLAN` edit or a `VOID`. Engine functions take and return this log; persistence assigns each entry a `seq`. **Every change after the project starts is a log entry**: nothing is edited in place, and nothing is rebuilt silently.
- **Events vs plan edits.** An *event* is something that happened to work that is under way: it is slippage, and it counts as delay. A *plan edit* (`PlanEdit`) is a planning change to a module that **has not started**: re-estimating, adding or removing work, changing dependencies. It is recorded in the log with who, when and why, but it moves the **baseline** as well as the forecast, because planning is not delay. The rule is per module: once a module is locked its work has started, so changes to it are events; before that they are plan edits. Plan edits may only use `ADD_TASK`, `ADJUST_ESTIMATE`, `REMOVE_TASK`, `ADD_DEPENDENCY`, `REMOVE_DEPENDENCY` and `BLOCK_UNTIL`; capacity, holidays and actuals are always events. A plan edit is refused for work that has already started (even in an unlocked module), and an event is refused for a module that is not locked, with a pointer to the other route.
- **Corrections.** Events are never edited or deleted. A mistaken event is withdrawn by a `VOID` entry that names it. The plan is rebuilt from the baseline without that event (effects do not always commute, so subtracting is not enough) and a `VOID` snapshot records the change, with negative effort and schedule impact. A void is refused if a later event relied on the one being withdrawn (for example, it adjusted a task the voided event added).
- **Back-dated events** are allowed. They keep their true `occurredAt`. The snapshot's `asOf` is clamped so it never goes earlier than the previous snapshot's.
- **Ownership** is a separate append-only table. An `OWNERSHIP_TRANSFER` event writes a row and may add context-transfer effort.
- **No individual metrics.** There are no per-person delay or efficiency views anywhere (spec §5.2, §36). Ownership history is for traceability only.

### 2.4 Phases belong to the project

The tool is for every kind of project, so the list of phases an event can be "found in" is the project's own (`Plan.phases`, a `PhaseModel`): an ordered list of `{ id, name }`, plus the two the retrospective needs to know about: the phase where **building starts** (scope found from here on is *late discovery*) and the **first phase after building** (feedback from here on arrived *after development*). A game has storyboard, art and development; a building has brief, design, construction and inspection.

- **Defaults.** A new project gets a generic set (`DEFAULT_PHASES`: Planning, Design, Build, Review, Client acceptance, Testing, Release, After delivery) unless it brings its own at creation. A project that has none stored (made before phases were the project's own) is taken to have `LEGACY_PHASES`, the Thriveni list, so everything already recorded keeps its meaning.
- **Checked.** `validatePhaseModel` reports every problem at once: at least two phases, unique ids without spaces, names, and "after building" coming after "building starts". An event naming a phase the project does not have is refused (`EVENT_REJECTED`), listing the ones it does.
- **Frozen at the start.** Phases can be set at creation and changed until the project starts. After that they are fixed, because events already refer to them.

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

**Assumed progress is flagged, not trusted.** "On plan unless told otherwise" means forecasts are only as honest as the recorded actuals, so everything carry-forward assumes is marked `assumed` on the task. A task the forecast has finished that nobody has confirmed becomes an `UNCONFIRMED_COMPLETION` warning (§3.8); recording progress clears the mark and the warning. Carrying on with work someone recorded as started keeps it confirmed; it is only the *finish* that becomes an assumption.

**A recorded actual can contradict an assumption.** If someone records that a task finished later than forecast, the tasks after it cannot have started when the old forecast said. The assumed progress downstream of it (reached only through other assumed tasks; recorded progress is reality and is left alone) is **re-derived** from the corrected finish: each such task starts when its predecessors really finished, or at its assumed start if later, and is then finished, in progress or not started according to where the status date falls. This keeps retroactive recording accurate: if art finished two days ago, development started two days ago, not today. (Resetting to "not started" would be pessimistic by exactly that lag.) Recording how much work is left also overrides an assumed finish.

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

`baselineDelivery` is stored in each snapshot because **the plan can move**. A plan edit (§2.3) refines the plan of a module that has not started: the baseline and the forecast both change, so variance does not, and planning is never counted as delay by itself. When it does change variance (a plan that grows enough to absorb an earlier slip), that step is recorded against the plan edit, so the history, the timeline and the attribution all show it. Revision 0 is the *original* plan and never changes; `baselineStepDays` on a snapshot says how far the plan itself moved at that step.

**Variance is measured in the current calendar.** Offsets count working days, so adding a holiday changes no offset, only the dates they fall on. The baseline (made under the old calendar) is therefore re-expressed in today's working days before comparing (`rebaseOffset`): a baseline delivery at offset 20 (Fri 30 Oct) is offset 19 once a holiday lands before it, so a forecast that stays at offset 20 (now Mon 2 Nov) is +1 day late. Each snapshot records the `calendar` it was made under, and the explanation measures task movement the same way, so a holiday shows the tasks after it moving later.

**Two measures of lateness.** *Variance* compares the forecast with the **plan**. *Days to the client date* (`slackToTarget`) compares it with the date **promised to the client**, in working days: positive is days to spare, negative is late. They differ whenever the plan had slack against the promise or has been refined since; both are shown, because "late against the plan" and "late against the client" are different conversations.

The same logic applies per module: each snapshot stores every module's `baselineFinish` and `forecastFinish` (the finish of its last task), which is what the branches in §3.6 are built from.

Revision 0 is created when the first module is locked. A snapshot contains: per-task start/finish/float, per-module and per-milestone baseline vs forecast, the critical path, the trigger (event, plan edit or void), the effort impact, the calendar, the modules a linked feature is used by (`linkedModuleIds`: "affected" without being changed), and an `engineVersion`. Snapshots are append-only (enforced by DB triggers). Because they store *results*, history survives a later change to the algorithm. Variance and step are reported to a millionth of a working day, so numerical noise can never read as a real change (a step of 0.000000001 would otherwise create a phantom branch).

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
  revision: number;  kind: 'EVENT' | 'PLAN' | 'VOID';  eventId: string;  asOf: ISODate;   // eventId: the event or plan edit
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
  original: { delivery; modules[]; milestones[] };   // the plan as it was at the start (revision 0), never changes
  current:  { delivery; planDelivery; variance; asOf };   // planDelivery: the plan as it stands after plan edits
  branches: Branch[];              // in the order modules first deviated
  markers:  EventMarker[];         // every event, plan edit and void, including those that moved nothing
}
```

- **Delivery branch.** The delivery milestone sits in the `PROJECT` module, so the project delivery line is simply that module's branch. A delay in M5 therefore produces an M5 branch (DIRECT) and a delivery branch (PROPAGATED, `fromModuleIds = [M5]`), linked by that field.
- **Absorbed delay.** A module can slip without moving delivery. It still gets its branch, flagged `absorbed`, so the slip is visible and so is the float that protected the project.
- **Recovery** (`delta < 0`) bends the branch back toward the original line. At variance 0 it is `MERGED`; if the module deviates again the branch re-opens.
- **No schedule effect.** An event that adds effort but moves no module's finish creates no branch step. It still shows as an event marker with its effort impact (`noScheduleEffect`).
- **Voids** add a `VOID` step to every branch the voided event had moved, naming the withdrawn event.
- **Plan edits** are markers (`kind: PLAN`, with `baselineStepDays`), because refining the plan of an unstarted module moves the plan, not a lane away from it. A branch step appears only if the edit changes a module's variance: for example, lengthening M7's plan can leave the delivery lane *less* late than before, which is a negative step on that lane, caused by the plan edit.
- **Two lines on the original track.** `original` is the plan as it was when the project started. `current.planDelivery` is the plan as it stands. They coincide until a plan edit moves the plan; the forecast and variance are measured against the second.
- **`fromModuleIds`** looks upstream on the *new* driving chain for delays, and on the *old* one for recoveries. When M5 finishes early and the critical path switches to M3, the delivery gain is still attributed to M5, not to M3, which did not change.
- Per-module variance, step and origin are all computed from stored snapshots plus the driving chain, so nothing extra is persisted. `buildTimeline(state)` derives it on demand.

### 3.6b The two levels: project view and module view

The Multiverse timeline has two levels, and the branching rule is the same at both: a deviation from the original plan is a new branch. Both are derived from the stored snapshots (`buildMilestones`, `buildModuleView`), so nothing extra is persisted except which tasks the project manager flagged.

**The project view** is the whole project as dots on the original line:

| Dot | Where | Opens |
|---|---|---|
| **Module start** (`MODULE_START`) | the earliest start of any of the module's tasks, drawn as the left edge of that day | the module's own view |
| **Module finish** (`MODULE_FINISH`) | the module's last task; if that is a milestone (an alpha, a delivery) the dot takes its name | |
| **Milestone** (`MILESTONE`) | a milestone task inside a module, or **any task the project manager flagged** | |

Every dot carries where it was in the original plan, where the plan now has it, where it is forecast, its variance (calendar-aware, like a module's), whether it has been reached, and whether it is critical. Branches are the modules that moved, as before. The definition is deliberately generic: modules start and finish in any project, and "flag a task" covers whatever else a team calls a checkpoint.

**The module view** is the same picture one level down. Each task's finish is a dot (original, plan, forecast, variance, state, critical, added). A **branch for each task** that moved from its plan, with a step for every event that moved it: `DIRECT` if the event touched the task, `PROPAGATED` if it moved because something earlier on the driving chain moved (naming the nearest such task, `fromTaskIds`). Added work has no original and shows as a branch whose first step is `ADDED`. Planning changes make no steps: they move the plan and the forecast together, so they are markers only.

**Flags.** Which tasks the project manager flagged live in `milestone_flags`, a view setting rather than part of the plan: they can change at any time, before or after the project starts, and are not frozen. A flagged id may belong to work that exists only in the log.

**Dots that coincide.** Many dots fall on the same day (every module starts together). Dots within a few pixels are one cluster and are stacked in rows, most important on the line, then alternately above and below, so each can be seen and hovered.

### 3.7 Delay attribution (swappable)

This is the part the owner will tune after trying scenarios, so it has three separate seams: the **strategy** (how days are divided), the **category rules** (how events are grouped), and a **reconciliation check** (no strategy can lose or invent days).

```ts
interface AttributionStrategy {
  name: string;
  attribute(input: { origin: Plan; log: LogEntry[]; state: ProjectState }): {
    contributions: { eventId; days; effortDays }[];   // eventId: an event's id, or a plan edit's
    interaction: WorkDays;          // days no single entry accounts for
  };
}
attributeDelay(state, { strategy?, rules? }) → { strategy, totalVariance, contributions[], interaction, byCategory[] }
```

`attributeDelay` throws if `Σ contributions + interaction ≠ total variance`, naming the strategy. A strategy under development fails loudly instead of producing a retro that does not add up.

Both strategies replay only the **active** entries (a voided event is skipped entirely), from the *origin* plan, not stored snapshots, so voids never distort the shares. **Plan edits are contributors too.** They are steps in the history, and one can change variance: lengthening M7's plan can absorb an earlier M5 slip, which shows as a negative share in category **Planning changes**, so the shares still add up. The retrospective shows **both strategies side by side** (`?strategy=both`).

**`sequential` (default).** Entry k's contribution is `stepDays(k)`. This telescopes, so contributions sum *exactly* to the total and `interaction` is always 0. Simple and auditable. Its weakness is order dependence: when two events overlap on the critical path, whichever was recorded first takes the credit or blame.

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
| `SCOPE_CHANGE`, `REQUIREMENT_CHANGE` | **Late scope discovery** if the phase is the project's "building starts" phase (`PhaseModel.buildStarts`) or later, else Scope changes |
| `FEEDBACK` | **Late feedback** if the phase is the project's "first phase after building" (`PhaseModel.afterBuild`) or later, else Feedback |
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

- **Common feature detection** (spec §11): a feature used by ≥ N modules (default 2) with no shared implementation task yields an advisory with the module count and a recommendation. A feature is *used by* a module if it is listed against it (`Feature.moduleIds`) or one of the module's tasks implements it (`Task.featureId`). Only `DELIVERABLE` modules count, because shared and project modules are where shared work lives, not consumers of it. A feature has a shared implementation when `Feature.sharedTaskId` names an existing task, **or when any task that implements it sits outside the deliverable modules**: work done once, for everyone. So recording the extinguisher as one shared effort resolves the advisory; implementing it seven times inside the modules does not.
- **Unconfirmed completion** (`WARNING`): a task the forecast has finished but nobody has recorded (§3.2). One warning per task, earliest forecast finish first, with the date and what to do. Milestones are not flagged. If nobody records anything this is a lot of warnings (17 by day 8 on Thriveni); grouping is a presentation question for the UI.
- **Module started but not locked** (`WARNING`, raised by the server because it needs to know which modules are locked): an unlocked module with work the forecast has under way or finished. Lock it so changes are recorded as events; plan edits are refused for work that has started.
- On the Thriveni seed exactly one advisory fires at the start: *"Common feature detected: Extinguisher is used by 7 modules but has no shared implementation task."* Localization, evaluation and the menu each have a shared task and are not flagged.
- Each advisory is a pure function `(plan) → Advisory[]`; `Plan.features` is optional and never affects the schedule. Definition of Ready and Feature Impact Assessment (spec §10, §12) will be added the same way after the MVP. The columns to hold them are nullable and reserved.

### 3.9 Derived views

All computed from stored snapshots; nothing extra is persisted.

- **Forecast drift** (`forecastDrift`) = the delivery forecast at every revision.
- **Milestone history** (`milestoneHistory`) = one milestone's baseline and forecast at every revision (spec §20).
- **Days to the client date** (`slackToTarget`) = working days between the forecast and the date promised to the client; computed from the project's target date and the snapshot's calendar, so it is always current and is not stored in snapshots.
- **First breach** (`firstBreach`) = first snapshot where forecast > plan. This is *recognised* schedule impact. The spec §20 metric "time between first detectable risk and recognized impact" needs a notion of *detectable* risk (for example, float to target shrinking to zero) that is not designed yet.
- **Progress %** (`buildControlRoom`) = completed effort ÷ total current effort, effort-weighted so a ten-day task counts for ten times a one-day task. A finished task counts its estimate; one under way counts estimate minus remaining effort. `confirmedPercent` counts only what someone recorded; the gap is progress the forecast is taking on trust.
- **Bottleneck** (`buildControlRoom`) = the first unfinished task on the driving chain is what is setting the pace now; the unfinished, non-critical tasks with the least float (default: two working days or less) are the likely next bottleneck.
- **Retro** (`buildRetro`) = planned against actual, both attribution strategies, when feedback arrived (by phase, and the share after development finished), and what scope, resource, rework, dependency and planning changes cost. Observations are plain sentences, only for things that happened.

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
                   plan_revision, started_at, created_at, phases JSON /* NULL = the legacy phases */)
milestone_flags   (project_id, task_id, flagged_at, flagged_by)   -- a view setting: not frozen when the project starts
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
plan_edits        (project_id, id, seq, title, reason, created_by, as_of, recorded_at, effects_json)   -- seq is shared with events
event_voids       (project_id, id, seq, event_id, as_of, reason, recorded_at)    -- seq is shared with events
forecast_snapshots(project_id, plan_revision, revision, kind, event_id, void_id, as_of, recorded_at,
                   baseline_delivery, forecast_delivery, variance_days, step_days, effort_impact,
                   engine_version, snapshot_json)
```

**Enforced in the database, not only in code.** Each of these is tested by running raw SQL that bypasses the API.

- A task of a **locked module** cannot be inserted, changed, moved into, or deleted. New work after lock must be an event.
- A **dependency** whose successor is in a locked module cannot be added or removed.
- A locked module cannot be changed, unlocked or deleted.
- **Once the project has started, the plan rows are frozen entirely**: tasks, dependencies, modules (name, kind, scope), teams, capacity, features, and the calendar and delivery milestone. The rows are the plan *as it was at the start*. Every later change is a recorded plan edit or event, never an edit to the rows, so history shows it. The one thing that may still change is locking another module (`locked_at`). Name and target date stay editable: they are only labels.
- `events`, `event_voids`, `plan_edits` and `forecast_snapshots` are **append-only**. Corrections are new rows.

- A project's **phases** can be set until it starts, then they are frozen too (events refer to them).

All trigger messages begin `LOCKED:`, which the API turns into `409`, and they say what to do instead.

**Upgrading a database made by an earlier version.** The schema is applied on every start. Before it is, `openDatabase` adds any column an older database lacks (today: `projects.phases`). It only ever adds: nothing is rewritten, so existing data is untouched, and projects without phases of their own are read as having the legacy ones.

**What is stored and what is derived.** Stored: the plan rows as they were at the start, the log (events, plan edits and voids, one shared sequence) and the snapshots as they were recorded. Derived on each request: the engine's current plan, by replaying the log over the rows. Recording, previewing, attribution and advisories use the replay. History views (forecast, snapshots, timeline) read the stored snapshots, so history shows what was recorded at the time even if the algorithm later changes.

### Plan revisions: only for adopting a newer engine

A plan revision is a complete set of snapshots for a project's history. The first lock writes revision 1. `POST /projects/:id/rebuild-history` writes a new revision using the current engine and keeps the old one, so that history can be re-derived after the algorithm improves; views follow the current revision. Nothing is ever updated or deleted.

Planning changes **do not** create revisions. An earlier design rebuilt history under a new revision whenever an unlocked module was edited, which made the change invisible. They are now plan edits in the log (§2.3), so history shows what changed, when and why.

---

## 5. API (REST + JSON), as built

Run it with `npm start -w @multiverse/server` (default `http://127.0.0.1:4000`). Examples for each flow are in [docs/API.md](docs/API.md). All bodies are strict: an unknown or misspelled field is a `400` naming its path.

| Group | Endpoints |
|---|---|
| Health | `GET /health` |
| Projects | `POST /projects` (optionally with its own `phases`) · `GET /projects` · `GET /projects/:id` · `PATCH /projects/:id` (name, target date; calendar and phases until started) · `PUT /projects/:id/delivery` · `GET /projects/:id/validate` |
| Blueprint (before the project starts) | `PUT /projects/:id/blueprint` (whole plan at once) · `POST/PATCH/DELETE` on `/teams`, `/modules`, `/tasks`, `/features` · `POST /capacity`, `DELETE /capacity?teamId=&from=` · `POST /dependencies`, `DELETE /dependencies/:predecessorId/:successorId` |
| Locking | `POST /projects/:id/modules/:moduleId/lock` (the first lock starts the project and writes revision 0) |
| Events | `POST /projects/:id/events/preview` · `POST /projects/:id/events` · `GET /projects/:id/events` (filter by `type`, `phase`, `moduleId`, `teamId`, `status`) · `GET /projects/:id/events/:eventId` · `POST /projects/:id/events/:eventId/void` |
| Plan edits | `POST /projects/:id/plan-edits/preview` · `POST /projects/:id/plan-edits` · `GET /projects/:id/plan-edits` |
| Milestone flags | `GET /projects/:id/milestone-flags` · `PUT` and `DELETE /projects/:id/milestone-flags/:taskId` (flag a task as a project milestone, or take the flag off; allowed at any time) |
| Views | `GET /projects/:id/forecast` (with `target`: days to spare or late against the client date) · `/snapshots` (`?full=true`) · `/snapshots/:revision` · `/timeline` (the project view: the original line, branches, markers, and the milestone dots) · `/modules/:moduleId/timeline` (one module: a dot for each task, a branch for each task that moved) · `/history` · `/milestones/:taskId/history` · `/advisories` (`?minModules=`) · `/attribution` (`?strategy=sequential\|counterfactual\|both`) |
| Plan | `GET /projects/:id/plan` · `/plan-revisions` · `POST /projects/:id/rebuild-history` |

`preview` is how the spec's step 6→7 works: the developer says "+2 days", the system answers with the schedule and effort impact, whether it is on the critical path, and the modules affected. It applies exactly the checks recording does and writes nothing. Plan edits have the same preview.

**Which route?** Changes to a module that has **started** (locked) are *events*. Changes to the plan of a module that has **not** started are *plan edits*. Each route refuses the other's modules and says so. Capacity, holidays and actuals are always events.

**Errors** are always `{ error, message, details? }`:

| Status | `error` | Meaning |
|---|---|---|
| 400 | `BAD_REQUEST` | Malformed JSON, or a field is missing, misspelled, or invalid (`details` lists each path). Also a plan edit that uses an effect planning may not (capacity, holidays, actuals) |
| 404 | `NOT_FOUND` | No such project, task, event, snapshot or route |
| 409 | `LOCKED` | The database refused: the module is locked, or the project has started and its plan rows cannot be edited directly |
| 409 | `NOT_STARTED` | Lock a module first |
| 409 | `ALREADY_LOCKED`, `PROJECT_STARTED`, `ALREADY_EXISTS`, `ALREADY_VOIDED`, `REFERENCE` | State conflicts |
| 409 | `CANNOT_VOID` | A later entry relied on the event you are voiding |
| 422 | `INVALID_PLAN` | The blueprint is not a valid plan; `details` lists every problem |
| 422 | `EVENT_REJECTED` | The event or plan edit cannot be applied, or is for the wrong kind of module, or names things that do not exist; the message names the effect |
| 500 | `INTERNAL` | Unexpected. The body never contains internals; details are in the server log |

**Atomicity.** Every write is one transaction. A rejected event or plan edit leaves no row behind, and the next entry still takes the next number in the log.

**Security.** There is no authentication: it is a local tool. The server listens on `127.0.0.1` only unless `HOST` is set, so nothing else on the network can reach it. Do not expose it without adding authentication.

**Screens.** `GET /projects/:id/control-room` (the engine's control room plus `target`, per-module `locked`, `contributors` and `advisories`), `/retro` (plus `target`) and `/current-tasks` (the plan as it stands, including work added after the start). Their shapes are in `packages/engine/src/contract.ts`; the server is type-checked against that file, so a field cannot be renamed on one side only.

**The page.** If `packages/web/dist` exists (`npm run build -w @multiverse/web`), the server also serves it at `/`, with a content security policy that lets it load only its own files. Built files are named by their contents and cached for good; the page itself is never cached. An unknown path is still the API's JSON 404.

**Not built yet:** people and ownership endpoints, creating a project from the UI, and CORS (not needed: the page and the API share an origin, and in development Vite proxies).

---

## 6. Thriveni seed and the five reference scenarios

**A second sample, not a VR training.** `--sample community-centre` seeds a small community centre built on site (foundations, structure, services, fit-out, inspection and handover), Mon 5 Oct to Wed 18 Nov 2026 (33 working days), with phases of its own: brief, design, construction, inspection, handover, after handover. Its three demo events (rain delays the concrete pour, the client asks for a second fire exit, the inspector leaves a note) move handover to Mon 23 Nov (+3). It exists to show, and to test, that nothing in the tool is specific to VR.

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
| HS | Hero (spec §28/§40): LXD feedback means the **extinguisher system** is needed. It was **one shared 2-day effort**, done between the client changes and integration; `linkedFeature = Extinguisher` | Effort **+2**, schedule **+2**, one lane: the **delivery lane +2** (DIRECT). `linkedModuleIds` = M1–M7 (affected, not changed). Critical path **yes** → **Tue 3 Nov**. The "common feature without a shared task" advisory is **resolved**. Original and new forecast both retained |
| HS7 | Contrast: the same need met module by module, a 2-day task in each of the 7 modules | Effort **+14**, schedule **+2**, because the seven tasks run in parallel. **7 module branches (+2 each)** plus the delivery branch +2 (PROPAGATED from M5). The advisory is **not** resolved |

HS is how the team experienced it on Thriveni: built once, for everyone. HS7 is kept as a scenario because it is the clearest demonstration of "effort ≠ schedule impact" (spec §5.4: **14 effort-days vs 2 schedule-days**) and it exercises per-module branches; it is what the cost would have been without a shared implementation. The advisory in §3.8 would have flagged the need at planning time.

> Heads-up: the spec says "Nov 1" for the +2 case. With working-days-only in 2026, 1 Nov is a Sunday, so the demo shows **3 Nov**. This is correct behaviour.

Combined check for attribution: apply T2, then T3, then HS in order. Sequential contributions are `0, +1, +2` and must sum to the final variance of **+3** (offset 23 vs 20 → forecast Wed 4 Nov).

**CAP (capacity).** Event recorded Tue 13 Oct (offset 7): Dev drops from 4 to 2 people from Wed 14 Oct. Every Dev task with work left now takes twice as long: M5 Dev 6d → 12d (ends 19), M3 Dev 5d → 10d (ends 17), client changes 2d → 4d, integration 1d → 2d. So 19 + review 1 + changes 4 + integration 2 + QA 2 + beta 1 = **29**. Expected: effort **0**, schedule **+9** → **Thu 12 Nov**; M1–M7 and the delivery lane all deviate DIRECT (the capacity change touches them), while the Shared module is unaffected because its work finished by day 7. This is the "describe it as a capacity change, not underperformance" case (spec §15).

**HOL (holiday).** Wed 28 Oct is added as a public holiday on Wed 14 Oct. It changes no working-day count, only dates, so delivery stays at offset 20 but is now **Mon 2 Nov**: **+1** (variance measured in the new calendar), caused by a capacity change, DIRECT on the delivery lane. Only the tasks after the holiday (QA, beta, delivery) move. A holiday on a weekend, on the status date or earlier, or one already added is refused.

**PLAN (planning change).** M7 Dev is re-estimated from 5 to 8 days on Tue 6 Oct, before M7's work has started. M7 now takes 14 days to Alpha, longer than M5's 13, so the **plan** moves from Fri 30 Oct to Mon 2 Nov, the forecast moves with it, and variance is **0**: planning, not delay. Revision 0 still says Fri 30 Oct. If M5 had slipped a day on Mon 5 Oct (+1), the edit **absorbs** it: variance goes from +1 to 0, the step is **−1**, and the attribution reads *Dependency delays +1, Planning changes −1*, total 0. Refused: a locked module (that is an event), work that has already started (by 14 Oct M7 development is under way), and any effect that is not planning.

**LATE (a late actual).** Someone records that M5 art finished Thu 15 Oct (offset 9) instead of Tue 13 Oct (7). The development that the forecast had assumed started on the 14th cannot have, so it starts on the 15th: delivery **+2**, Tue 3 Nov. Recorded retroactively on Tue 20 Oct the answer is the same (development has been running since the 15th), not +5, which "starts today" would give. A task recorded as finished *earlier* than forecast changes nothing after it.

**UNCONFIRMED.** By the end of Wed 14 Oct the forecast has 17 tasks finished (14 module tasks, 3 shared) that nobody has recorded. Each is flagged until its progress is recorded; milestones and work merely under way are not.

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
13. **Calendar**: `rebaseOffset` (including half-days); a holiday moves dates and variance but no offsets; weekend, past and duplicate holidays refused; a holiday can be voided; variance and the explanation agree.
14. **Plan edits**: the plan moves and variance does not; a later slip is absorbed with the right signs; voiding an event keeps plan edits; refusals (started work, non-planning effects, work an event added, reused ids); both attribution strategies reconcile with plan edits in the log; replay from the log is identical.
15. **Late actuals**: recorded finish later than forecast pushes assumed successors (same-day, retroactive, chained); earlier finish changes nothing; recorded work is never overridden; recording "remaining" overrides an assumed finish.
16. **Unconfirmed work**: flagged, ordered, cleared by recording, stays cleared, never milestones, never changes the forecast.
17. **Client date and shared feature**: `slackToTarget` in working days and in the current calendar; the extinguisher as one shared task (+2, one lane, `linkedModuleIds`, advisory resolved) against the per-module version (advisory not resolved).
18. **Server**: raw SQL cannot change plan rows, plan edits or snapshots once the project has started; events on unlocked modules and plan edits on locked ones are refused with a pointer to the right route; stored history equals a fresh engine replay with plan edits in the log; holidays, targets, warnings and `strategy=both` over HTTP.

---

## 8. Decisions and open questions

### Decided (from testing the first version)

| Topic | Decision |
|---|---|
| Delivery lane | Delays that start in shared work or in the post-Alpha phase get their own line, and delivery is its own line. (As built.) |
| Calendar | Saturday and Sunday are off. Holidays are added by hand by the PM during the project, as a recorded event (`ADD_HOLIDAY`); a holiday counts as a delay and is attributed to capacity. |
| Variance | Show both: against the **plan**, and against the **date promised to the client** (days to spare or late). |
| Attribution | The retrospective shows **both** strategies side by side. |
| Category labels | The rules and wording are right: a label depends on the event's `type` and `phase`. |
| Assumed progress | **Flag** a task the forecast has finished that nobody has recorded (`UNCONFIRMED_COMPLETION`). |
| Changes after the project starts | **Every change is recorded as history.** Planning changes to a module that has not started are *plan edits* in the log (they move the plan, not the delay); changes to a module that has started are events. Nothing is edited in place and nothing is rebuilt silently. |
| Events on unlocked modules | Refused, with a pointer to plan edits. (The decision was "yes, guard it"; refuse was chosen over warn. Say if you would rather it warned.) A separate warning is raised for an unlocked module whose work is forecast under way. |
| The extinguisher | It was **one shared effort**, not seven per-module tasks. The hero scenario is now one shared 2-day task; the per-module version is kept as a contrast scenario. Recording shared work resolves the common-feature advisory. |
| Entering events | For standard cases the UI should offer **buttons and example text** (delay, finished, capacity, holiday, block, plan edit, void). The PowerShell helper's one-line commands are the prototype. |
| First screen | The **Multiverse timeline** comes first, then the Control Room, then the Retro view. |

### Decided (from testing the web app)

| Topic | Decision |
|---|---|
| Two views of the timeline | The Multiverse timeline has **two levels**. The **project view** shows the whole project as dots on the original line: each module’s start and finish, and any task the project manager flagged. Clicking a module’s start dot (coloured, one colour for each module) opens that **module’s own timeline**, with a dot for each of its tasks. The branching rule is the same at both levels: a deviation from the original plan is a new branch (a branch for each module that moved on the project view; a branch for each task that moved on a module’s view). Leaving the module view returns to the project view. **Built** (§3.6b). |
| Generic, not just VR | The tool is for **every kind of project**, not only VR modules. The definition of a *project milestone* is the same for all projects; a *module* is like a big sub-task with its own timeline. |
| What a milestone is | **Automatic, plus flagged.** Every module’s start and finish is a dot on its own; a milestone task inside a module is one too; and the project manager can flag any other task as a project milestone (a view setting, allowed at any time). On a module’s own view the dots are **each task’s finish**. **Built.** |
| Phases | **Each project defines its own** (§2.4), with a generic starting set. The retrospective’s "after development" follows the project’s own "building starts" and "first phase after building". The community-centre sample shows it with a building’s phases. **Built.** |
| "We are here" | A **glowing green dot** shows where the project is right now on the timeline, like the live position of a train (spec section 19: train = current state). It follows today’s date, not the last re-forecast; the blue status line still shows when the forecast was last re-worked. **Built.** |
| Branch start | A branch leaves the original line a short way before the day of the change. Keep. |
| Time axis | Calendar dates with weekends shaded. Keep. |
| Control room, needs-attention grouping, standard forms | Fine as they are for now. More feedback will come once PMs try it on a real project. |
| Preview, then record | Useful. Keep. |
| Date on a form | Starts on today. Keep. |
| Retrospective | Both strategies read clearly. Keep. |
| People | "Recording as" stays a typed name; accounts and ownership come later. |
| What next | Continue with the plan: after the screens, the spec’s next phase is real-world validation with PMs and a real project. |

### Still open

1. **Fork position.** *(Settled in the UI.)* A branch leaves the original line a short way before the `asOf` of the first snapshot where the module deviated, and arrives at its first node on that day. Forking at the planned position of the affected task is still derivable if you prefer it.
2. **Late-discovery classification** (§3.7) uses the event's `phase`. If someone picks the wrong phase the label is wrong; whether the engine should second-guess it from recorded progress is open.
3. **Unconfirmed warnings are many** if nobody records anything (17 by day 8). The Control Room groups them by kind and shows two of each, with the rest one click away. Grouping by module, or showing only the critical path first, is still possible.
4. **A holiday is an event**, so it counts as delay under *Capacity changes*. If the team prefers holidays to appear as planned calendar changes rather than delay, that is a labelling change.
5. **A plan edit that absorbs a slip** shows as a negative share ("Planning changes −1") in the retro. Confirm this reads the way you want.
6. **No authentication.** Fine for a local tool bound to `127.0.0.1`. Needed before anyone else uses it over a network.
7. **Phases cannot be edited once the project starts**, and there is no screen to define them yet (they are set when a project is created through the API). Adding or renaming a phase mid-project, which would not disturb events already recorded, is possible later.
8. **A flagged task that is later taken out of the plan** stays in the flag list, shown as "no longer in the plan", until someone removes the flag.
9. **New-work dots with no original position** (work added after the project started, then flagged) are drawn where they are forecast, with a ring marking them as added. Whether they should sit on the original line at all is a presentation question.

---

## 9. Proposed build order

Follows spec §30. Each step ends in something testable.

1. **Scaffold** the workspace, TypeScript, Vitest, typecheck. *(done)*
2. **Engine core**: calendar → graph → capacity → forward/backward pass → T1, plus plan-level equivalents of T2–T4. *(done: 59 tests passing)*
3. **Effects + replay + snapshots + explanation**: T2, T3, T4, HS, CAP, recovery and void all pass through the event log. This is the spec §39 milestone as a test. *(done: 169 tests passing; step 4 below builds on `explainSnapshot`)*
4. **Attribution + advisories + timeline builder**, with strategy interface. *(done: 242 tests passing)*
5. **Server + SQLite + seed** and the API from §5, tested with the Thriveni seed. *(done)*
5b. **First round of testing feedback** (§8): holidays, plan edits as recorded history, client-date variance, both attribution strategies, unconfirmed-work warnings, the shared extinguisher, events refused on unlocked modules, and a fix to late actuals. *(done: 312 engine and 120 server tests, plus a manual run of every scenario against the real server)*
6. **UI**: the Multiverse timeline first, then the Control Room, then the Retro view, and a screen to record changes. Standard events as buttons with example text; the Control Room shows both variances; the Retro shows both attribution strategies. *(done: 350 engine, 163 server and 117 web tests; see §10)*
6b. **Third round of testing** (§8): the timeline in two levels (project view with milestone dots, a module’s own view, flagged milestones), the glowing "we are here" dot, phases that belong to the project (with an upgrade for older databases), generic wording, and a non-VR sample (a community centre). *(done: 415 engine, 205 server and 176 web tests)*

---

## 10. The web app, as built

`packages/web`: React 19 and Vite, TypeScript, no state library and no chart library. Run it with `npm run dev -w @multiverse/web` while developing (Vite on 5173, proxying to the API on 4000), or build it (`npm run build -w @multiverse/web`) and let the server serve it at `/`.

### Screens

| Tab | What it is for | Built from |
|---|---|---|
| **Timeline** (first) | The Multiverse view, at two levels (§3.6b). The **project view**: the original plan is one line with a dot for each milestone (each module’s start, coloured by module, and finish, plus any task the project manager flagged); a branch leaves it for each module that has moved, delivery on its own emphasised branch. Click a module’s start dot to open **that module’s own view**: a dot for each task, and a branch for each task that moved. Branch nodes are the changes that moved it (hollow: float absorbed it). A row of markers along the top is every recorded change (circle = event, diamond = planning change, cross = withdrawn; solid when it moved the schedule or the plan). Weekends and holidays are shaded; the status date and client date are lines; a glowing green dot shows where we are today. Click or press Enter on a node or marker for the explanation. A table view has the same facts. | `/timeline`, `/modules/:id/timeline`, `/milestone-flags`, `/forecast`, `/events`, `/plan-edits`, `/snapshots/:n` |
| **Control room** | One hero date and both lateness figures (against the plan; against the client date). Original plan, plan now, progress with how much is confirmed, status date. What is setting the pace, the critical chain in order, the likely next bottleneck and a watch list. Where the delay came from. How the forecast has moved. A row for every module. What needs attention, grouped. | `/control-room` |
| **Retrospective** | Planned against actual. **Both** attribution strategies side by side, with the changes behind each. When feedback arrived (the share after development finished, by phase and by team). What each kind of change cost. Who tasks moved between. Plain-language findings. | `/retro` |
| **Record a change** | Start modules (the first lock starts the project). The standard cases as buttons with an example sentence each; a short form for the one picked; **preview** (what it would do, nothing written) and then **record**. The history of everything recorded, with withdraw. | `/current-tasks`, `/events`, `/plan-edits`, preview and record routes |

### How it is put together

- **Pure view-model code, tested without a browser.** `lib/timelineLayout.ts` (where everything goes, at either level: one scene, `layoutScene`, with a project adapter and a module adapter), `lib/templates.ts` (the forms: answers in, API payload out), `lib/explain.ts` and `lib/describe.ts` (words for a change and for an effect), `lib/format.ts`, `lib/dates.ts`, `lib/palette.ts`. Components only draw what these decide.
- **The forms are checked against the real API.** A server test posts what every template builds to the real server (preview, then record). That test found a real mismatch: the engine refuses to hold back a task that has already begun, but the form offered it. The form now offers only what the engine will take (`tasksFor` scopes: open, waiting, unstarted, any).
- **One contract.** `packages/engine/src/contract.ts` names every shape the API serves. The server is compiled against it (`packages/server/src/contract-check.ts`) and the web app is written against it.
- **Refresh model.** Recording or locking bumps a version; each view reloads. The old picture stays on screen, dimmed, until the new one arrives: no skeleton, no jump. A change of project drops the old data at once.
- **The address is the state.** `#/<project>/<tab>`, so a view can be linked to and the back button works.
- **Dates.** Every instant the engine reports is the *end* of a working day, so it is drawn at the right edge of that day. A status date that falls on a day off is drawn at the end of the last working day before it. The default date on a form is the later of today and the last status date, because the forecast never goes backwards.
- **Text from the API is never parsed as HTML.** React escapes it; nothing uses `innerHTML`. The server sends a content security policy with the page.

### Chart rules adopted

From the data-visualisation checklist the charts follow:

- Each module keeps one colour throughout, assigned in plan order and never by rank, so a module does not change colour when others deviate. Delivery is ink. The eight series colours are the validated categorical palette (light and dark are separately stepped); a ninth module would be neutral grey, never a generated hue.
- Status is never colour alone: good, warning and critical each have their own icon and a word.
- Three light-mode hues are under 3:1 contrast on the page, so every branch has visible direct labels (name at the left, finish date and slip at the right) and there is a table view.
- One axis per chart, thin marks, solid hairline grid, direct labels only where they fit, values in text colours rather than series colours.
- Hover and keyboard focus show the same readout; everything a tooltip says is also in the explanation panel or the table.
- Light, dark and system themes; layouts checked at 375 px with no sideways scrolling (the timeline scrolls inside its own frame).
- Dots that fall on the same day are stacked in rows rather than printed on top of each other, and the line and branches make room for the tallest stack. A label is printed only where nothing is stacked above it and there is room to either side; the rest are a hover away.
- The address is the state: `#/<project>/timeline/<module>` is a module’s own view, so the back button and a shared link both work. Only the timeline tab has a module open; any other tab is the whole project.

### Not in the UI yet

Creating a project, defining a project’s phases (they are set through the API when it is created), editing the blueprint before the start, people and ownership, zooming a very long project, export and print, and authentication.
