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

`asOf` is the status date for the forecast: the end of that working day. It defaults to `occurredAt` and never goes
backwards. Between events, the engine assumes work progressed as the previous forecast said, unless you record
otherwise (see `RECORD_PROGRESS` below).

## 3. Effects

| `op` | Fields | Use for |
|---|---|---|
| `ADJUST_ESTIMATE` | `taskId`, `delta` | A task needs more (or less) effort. On a started task it changes the effort remaining |
| `ADD_TASK` | `task`, `dependsOn[]`, `blocks[]` | New scope, rework, a new shared feature |
| `REMOVE_TASK` | `taskId` | Scope removed. Its predecessors are reconnected to its successors |
| `ADD_DEPENDENCY`, `REMOVE_DEPENDENCY` | `predecessorId`, `successorId` | A dependency discovered or dropped |
| `BLOCK_UNTIL` | `taskId`, `date` (or `null` to clear) | Blocked until a date: assets late, a client decision |
| `SET_CAPACITY` | `teamId`, `from`, `headcount` | Team size changes, from a date after the plan started |
| `RECORD_PROGRESS` | `taskId`, `startedOn`, `remaining`, `finishedOn` | What actually happened. `null` clears a field |
| `TRANSFER_OWNER` | `taskId`, `toPersonId`, `contextCost` | Reassignment; the context cost becomes extra effort |

Work that has already started cannot be made to wait for something new, and finished work cannot be re-estimated (add a
rework task). The `422` response says which effect failed and why.

A new task for every module, as in the late-extinguisher example:

```powershell
$effects = 1..7 | ForEach-Object {
  @{ op = 'ADD_TASK'
     task = @{ id = "m$_.ext"; moduleId = "m$_"; teamId = 'dev'; name = "m$_ extinguisher integration"; estimate = 2 }
     dependsOn = @("m$_.dev"); blocks = @("m$_.alpha") }
}
Post '/projects/thriveni/events/preview' @{
  type = 'SCOPE_CHANGE'; title = 'Extinguisher in every module'; phase = 'DEVELOPMENT'; createdBy = 'lxd'
  occurredAt = '2026-10-14'; effects = $effects
}
```

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
```

`sequential` charges each event with the change it caused; the shares always add up to the total.
`counterfactual` removes each event in turn and reports how much sooner the project would have finished, plus an
`interaction` for delay that overlapping events share. Events are grouped into categories by their `type` and `phase`
(see [DESIGN.md §3.7](../DESIGN.md)), so choose the event type with that in mind.

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

- locked modules, and the project's calendar, teams, capacity and features, are frozen (`409 LOCKED`)
- you can still refine modules that are not locked yet; history is rebuilt under a new plan revision and the old one is
  kept. If that would break a recorded event, the edit is refused and nothing changes (`409 EDIT_BREAKS_HISTORY`)

## Errors

Every error is `{ "error": "CODE", "message": "...", "details": ... }`. In PowerShell, read it from the exception:

```powershell
try { Post '/projects/thriveni/events' $event } catch { $_.ErrorDetails.Message | ConvertFrom-Json }
```
