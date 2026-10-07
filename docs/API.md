# Project Multiverse API guide

The reference for every endpoint and error is in [DESIGN.md §5](../DESIGN.md). This guide shows the flows in order,
with PowerShell. Start the server first (see the [README](../README.md)); the examples assume
`http://127.0.0.1:4000` and the seeded `thriveni` project.

```powershell
$api = 'http://127.0.0.1:4000'
function Post($path, $body) { Invoke-RestMethod "$api$path" -Method Post -ContentType 'application/json' -Body ($body | ConvertTo-Json -Depth 8) }
```

Dates are `YYYY-MM-DD`. Durations are working days (Saturday and Sunday are skipped, plus any holidays). Every request
body is strict: a misspelled field is a `400` that names it.

## 1. Look at the project

```powershell
Invoke-RestMethod "$api/projects/thriveni"                  # the blueprint, locks, and current forecast
Invoke-RestMethod "$api/projects/thriveni/forecast"         # per-task dates, float, critical path
Invoke-RestMethod "$api/projects/thriveni/advisories"       # "Extinguisher is used by 7 modules but has no shared task"
```

## 2. Ask what an event would do, then record it

An event says what happened, and carries **effects**: the typed changes it makes to the plan. The engine computes the
schedule impact from the effects; you never type it in.

```powershell
$event = @{
  id         = 'm4-slip'
  type       = 'TASK_DELAY'
  title      = 'M4 development needs 2 more days'
  phase      = 'DEVELOPMENT'
  createdBy  = 'priya'
  occurredAt = '2026-10-16'
  effects    = @(@{ op = 'ADJUST_ESTIMATE'; taskId = 'm4.dev'; delta = 2 })
}

(Post '/projects/thriveni/events/preview' $event).explanation   # writes nothing
(Post '/projects/thriveni/events' $event)                        # records it
```

The explanation tells you:

| Field | Meaning |
|---|---|
| `stepDays` | Working days this event moved the delivery date |
| `effortImpact` | Effort-days it added. A 14-effort-day change can cost only 2 schedule days |
| `absorbed` | A module slipped but float protected delivery |
| `onCriticalPath` | The event touched the critical path, or delivery moved |
| `modules[]` | Each module that moved: `DIRECT` (the event touched it) or `PROPAGATED` (it moved because something upstream did, with `fromModuleIds`) |
| `criticalPath` | Before, after, and what entered or left |
| `tasks[]` | Tasks added, removed or moved |
| `linkedModuleIds` | If the event names a feature (`linkedFeatureId`): the modules that use it. They are affected without being changed |
| `baselineStepDays` | How far the *plan* moved (non-zero only for plan edits) |

`asOf` is the status date for the forecast: the end of that working day. It defaults to `occurredAt` and never goes
backwards. Between events, the engine assumes work progressed as the previous forecast said, unless you record
otherwise (see `RECORD_PROGRESS` below). **An event is refused for a module that is not locked** (it is still being planned):
use a plan edit instead (section 3b).

## 3. Effects

| `op` | Fields | Use for |
|---|---|---|
| `ADJUST_ESTIMATE` | `taskId`, `delta` | A task needs more (or less) effort. On a started task it changes the effort remaining |
| `ADD_TASK` | `task`, `dependsOn[]`, `blocks[]` | New scope, rework, a new shared feature |
| `REMOVE_TASK` | `taskId` | Scope removed. Its predecessors are reconnected to its successors |
| `ADD_DEPENDENCY`, `REMOVE_DEPENDENCY` | `predecessorId`, `successorId` | A dependency discovered or dropped |
| `BLOCK_UNTIL` | `taskId`, `date` (or `null` to clear) | Blocked until a date: assets late, a client decision |
| `SET_CAPACITY` | `teamId`, `from`, `headcount` | Team size changes, from a date after the plan started |
| `ADD_HOLIDAY` | `date` | A public holiday. It must be after the status date and a normal working day. It counts as a delay |
| `RECORD_PROGRESS` | `taskId`, `startedOn`, `remaining`, `finishedOn` | What actually happened. `null` clears a field. It also **confirms** the task (see section 8). A finish later than forecast pushes the work after it |
| `TRANSFER_OWNER` | `taskId`, `toPersonId`, `contextCost` | Reassignment; the context cost becomes extra effort |

Work that has already started cannot be made to wait for something new, and finished work cannot be re-estimated (add a
rework task). The `422` response says which effect failed and why.

The late extinguisher, as the team experienced it: one shared 2-day effort between the client changes and integration,
linked to the feature so the system knows all seven modules use it (and the "common feature has no shared task"
advisory is resolved):

```powershell
Post '/projects/thriveni/events/preview' @{
  type = 'SCOPE_CHANGE'; title = 'Extinguisher system'; phase = 'DEVELOPMENT'; createdBy = 'lxd'
  occurredAt = '2026-10-14'; linkedFeatureId = 'extinguisher'
  effects = @(@{ op = 'ADD_TASK'
                 task = @{ id = 'proj.ext'; moduleId = 'project'; teamId = 'dev'; name = 'Extinguisher system'; estimate = 2; featureId = 'extinguisher' }
                 dependsOn = @('proj.chg.dev'); blocks = @('proj.integration') })
}
```

Done module by module instead (a 2-day task in each of the 7 modules) it would cost 14 effort-days for the same 2 days
of delivery, in seven lanes. Build it with `1..7 | ForEach-Object { @{ op = 'ADD_TASK'; task = @{ id = "m$_.ext"; ... } } }`.

## 3b. Planning changes: plan edits

An *event* is something that happened to work that is under way: it counts as delay. A *plan edit* is a change to the
plan of a module that **has not started yet**: re-estimating, adding or removing work, changing dependencies. It is
recorded in history with who, when and why, but it moves the **plan** as well as the forecast, so it is planning, not
delay. Which one applies is decided by whether the module is locked.

```powershell
$edit = @{
  id = 'longer-m7'; title = 'M7 development re-estimated'; reason = 'client added a scene'; createdBy = 'planner'
  asOf = '2026-10-06'
  effects = @(@{ op = 'ADJUST_ESTIMATE'; taskId = 'm7.dev'; delta = 3 })
}
(Post '/projects/draft/plan-edits/preview' $edit).explanation     # writes nothing
Post '/projects/draft/plan-edits' $edit                           # records it
Invoke-RestMethod "$api/projects/draft/plan-edits"                # the planning changes so far
```

A plan edit may use `ADD_TASK`, `ADJUST_ESTIMATE`, `REMOVE_TASK`, `ADD_DEPENDENCY`, `REMOVE_DEPENDENCY` and `BLOCK_UNTIL`.
Capacity, holidays and actuals are always events. It is refused for a module that is locked (use an event), for work
that has already started (even in an unlocked module), and for anything an event added.

## 4. See the result

```powershell
Invoke-RestMethod "$api/projects/thriveni/timeline"      # original line + one branch per deviating module
Invoke-RestMethod "$api/projects/thriveni/snapshots"     # the forecast at every revision (?full=true for tasks)
Invoke-RestMethod "$api/projects/thriveni/snapshots/2"   # one snapshot, and why it differs from the one before
Invoke-RestMethod "$api/projects/thriveni/history"       # delivery drift, and the first date it was breached
Invoke-RestMethod "$api/projects/thriveni/milestones/proj.delivery/history"
Invoke-RestMethod "$api/projects/thriveni/events?status=active&phase=DEVELOPMENT"
```

## 5. Who or what caused the delay

```powershell
Invoke-RestMethod "$api/projects/thriveni/attribution"                          # sequential (default)
Invoke-RestMethod "$api/projects/thriveni/attribution?strategy=counterfactual"
Invoke-RestMethod "$api/projects/thriveni/attribution?strategy=both"            # side by side, as the retrospective shows
```

`sequential` charges each event with the change it caused; the shares always add up to the total.
`counterfactual` removes each event in turn and reports how much sooner the project would have finished, plus an
`interaction` for delay that overlapping events share. Events are grouped into categories by their `type` and `phase`
(see [DESIGN.md §3.7](../DESIGN.md)), so choose the event type with that in mind. Plan edits (section 3b) take part too, under *Planning changes*:
a plan edit that absorbs an earlier slip shows as a negative share, so the shares still add up to the total.

## 6. Correcting a mistake

Events are never edited or deleted. Withdraw one and the forecast is rebuilt without it; both stay in the log.

```powershell
Post '/projects/thriveni/events/m4-slip/void' @{ asOf = '2026-10-19'; reason = 'entered against the wrong module' }
```

This is refused (`409 CANNOT_VOID`) if a later event relied on the one you are withdrawing.

## 7. Starting a new project

```powershell
Post '/projects' @{ id = 'acme'; name = 'Acme induction'; startDate = '2026-11-02'; targetDate = '2026-12-11' }
```

Then load the blueprint in one call with `PUT /projects/acme/blueprint` (teams, capacity, modules, tasks, dependencies,
features, and the delivery milestone), or build it piece by piece with the `POST` endpoints. A draft may be incomplete;
`GET /projects/acme/validate` lists every problem. The body shape matches the plan in
[packages/engine/src/fixtures/thriveni.ts](../packages/engine/src/fixtures/thriveni.ts).

Capacity rows give a team's headcount from a date; the earliest row is the planned headcount, and the schedule
speeds up or slows down in proportion when it changes.

**Locking.** `POST /projects/acme/modules/m1/lock` starts execution of a module: from then on its scope is read-only and
changes are events. The first lock starts the project and writes revision 0, the original plan. After that:

- the plan rows are frozen for good (`409 LOCKED`, and the message says what to do): every later change is *recorded*,
  as an event (module started) or a plan edit (module not started), so history shows it
- you can still lock more modules

## 8. Work the forecast assumes, and the client date

Between events the forecast assumes work went as planned. Anything it has assumed *finished* that nobody has recorded is
flagged, so a quietly late task is asked about rather than trusted:

```powershell
Invoke-RestMethod "$api/projects/thriveni/advisories"   # includes UNCONFIRMED_COMPLETION warnings, one per task
```

Confirm a task by recording what happened. If it finished later than forecast, the work after it moves too:

```powershell
Post '/projects/thriveni/events' @{
  type = 'TASK_COMPLETION'; title = 'M5 art finished'; phase = 'DEVELOPMENT'; createdBy = 'dev-lead'
  occurredAt = '2026-10-15'
  effects = @(@{ op = 'RECORD_PROGRESS'; taskId = 'm5.art'; finishedOn = '2026-10-15' })
}
```

The advisories also warn about a module that is not locked but whose work the forecast has under way.

The forecast carries two measures of lateness. `variance` is against the **plan**. `target` is against the **date promised
to the client**, in working days (`daysToSpare`: positive is days to spare, negative is late):

```powershell
(Invoke-RestMethod "$api/projects/thriveni/forecast").target     # { date = '2026-10-30'; daysToSpare = -3 }
Invoke-RestMethod "$api/projects/thriveni" -Method Get           # forecast.target here too
```

The client date is the project's `targetDate`; change it with `PATCH /projects/:id`.

## Errors

Every error is `{ "error": "CODE", "message": "...", "details": ... }`. In PowerShell, read it from the exception:

```powershell
try { Post '/projects/thriveni/events' $event } catch { $_.ErrorDetails.Message | ConvertFrom-Json }
```
