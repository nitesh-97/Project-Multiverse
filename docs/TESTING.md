# Testing guide (second round)

About an hour. You will load the Thriveni reference project, throw events at it, and judge whether the answers are the
ones you would want. This guide drives the server from PowerShell, which prints readable summaries. The web app has its
own guide: [TESTING-UI.md](TESTING-UI.md).

Everything below was run against the real server before this guide was written, and the numbers are what it produced.
If you see something different, that is a finding: tell me what you typed and what you saw.

## What changed since the first round

Your answers from the first round are all implemented. In short:

- **Holidays** can be added by the PM during the project (`Mv-Holiday`). A holiday counts as a delay.
- **Every change after the project starts is recorded in history.** Changing the plan of a module that has *not* started
  is a **plan edit** (`Mv-PlanEdit`): it is recorded, but it moves the plan, so it is not counted as delay. Changing a
  module that *has* started is an **event**. Each is refused for the other kind of module, and says so.
- **Two lateness figures**: against the plan, and against the date promised to the client (`Mv-Status`).
- **Both attribution methods** side by side: `Mv-Attribution -Strategy both`.
- **Work the forecast assumes is finished but nobody recorded is flagged**, and a late actual now pushes the work after it.
- **The extinguisher is one shared effort** (the per-module version is kept for contrast).

## 1. Set up

**Terminal 1** (the server):

```powershell
cd "C:\AI Test Projects\Project Multiverse"
npm test                                    # 415 engine + 205 server + 176 web tests should pass

Remove-Item packages\server\data -Recurse -Force -ErrorAction SilentlyContinue    # start clean
npm run seed -w @multiverse/server                                    # project "thriveni": the main one
npm run seed -w @multiverse/server -- --id overlap                    # one fresh copy per scenario below,
npm run seed -w @multiverse/server -- --id cap                        # so they do not interfere
npm run seed -w @multiverse/server -- --id rec
npm run seed -w @multiverse/server -- --id late
npm run seed -w @multiverse/server -- --id holiday
npm run seed -w @multiverse/server -- --id warn
npm run seed -w @multiverse/server -- --id draft --unlocked m7        # m7 left unlocked on purpose
npm start -w @multiverse/server                                       # leave this running
```

Node prints "SQLite is an experimental feature" a few times. That is expected.

**Terminal 2** (you):

```powershell
cd "C:\AI Test Projects\Project Multiverse"
. .\scripts\mv.ps1        # note the leading dot
Mv-Help
```

Start over at any time: stop the server (Ctrl+C), delete `packages\server\data`, and repeat the seed lines.

## 2. The project you are testing

Thriveni: 7 modules, starts **Mon 5 Oct 2026**, planned delivery **Fri 30 Oct 2026** (20 working days), promised to the
client for the same day. Saturdays and Sundays are skipped. Task ids look like `m5.dev`.

```
each module:  storyboard (sb) -> art -> dev -> alpha          then, for everyone:
                                                              client review -> changes -> integration -> QA -> beta -> delivery
```

| Module | M1 | M2 | M3 | M4 | M5 | M6 | M7 |
|---|---|---|---|---|---|---|---|
| Days to Alpha (sb + art + dev) | 10 | 9 | 12 | 11 | **13** | 10 | 11 |
| Float (days it can slip without moving delivery) | 3 | 4 | 1 | 2 | **0** | 3 | 2 |

**M5 is the critical module**: a day lost there is a day lost on delivery. Other modules have float.
Shared work (menu, localization, evaluation) has plenty of float. The extinguisher is used by all 7 modules and
starts with no shared task.

Dates you will use as "status dates" (`-On`): the forecast is made as of the **end** of that day. 13 and 14 Oct are
when most development is under way.

**Events and plan edits.** An *event* is something that happened to work that is under way (a delay, a finish, a team
change). A *plan edit* is a change to the plan of a module that has not started. Locking a module (`Mv-Lock`) says its
work has started. All the projects here are fully locked except `draft`, where M7 is not.

## 3. Scenarios

Work in order for 1 to 5 and 10 (they build on each other in project `thriveni`); the rest each have their own project.
Add `-Preview` to any command to see what it *would* do without recording it.

### 1. The starting point

```powershell
Mv-Status
Mv-Forecast
Mv-Advisories
```

Expect: original plan **Fri 30 Oct**, forecast the same, **client date on the day**, and a critical path through M5
(`m5.sb` to `proj.delivery`). One advisory: the extinguisher is used by 7 modules but has no shared task.

### 2. A delay that float absorbs

```powershell
Mv-Delay -Task m2.dev -Days 3 -On 2026-10-13 -Id late-m2 -Preview      # ask first
Mv-Delay -Task m2.dev -Days 3 -On 2026-10-13 -Id late-m2               # then record
```

Expect: M2 is 3 days later, **delivery does not move**, marked "absorbed by float".

### 3. A delay on the critical path

```powershell
Mv-Delay -Task m5.dev -Days 1 -On 2026-10-14 -Type DEPENDENCY_DELAY -Id blocked -Title "M5 waiting on client assets"
Mv-Status
```

Expect: delivery **Mon 2 Nov**: one day later, but a weekend in between. M5 slipped directly; the delivery line moved
"via m5". `Mv-Status` now shows **client date: 1 working day LATE**. It also shows "Warnings: 17": ignore it until
scenario 14.

### 4. The late extinguisher, as it really happened: one shared effort

```powershell
Mv-Extinguisher -On 2026-10-14 -Preview
Mv-Extinguisher -On 2026-10-14 -Id extinguisher
Mv-Status
Mv-Advisories
```

Expect: **+2 work-days of effort and +2 days on delivery** (Mon 2 Nov to **Wed 4 Nov**). One lane moves, the delivery
lane, directly. "Affects: the feature is used by m1 ... m7": the seven modules are affected without being changed. The
critical path changes. `Mv-Status`: **+3 against the plan, client date 3 working days late**. And the extinguisher
advisory is **gone**: the work was done once, for everyone.

**For contrast**, the same need met module by module (project `late`, preview only):

```powershell
Mv-Use late
Mv-Extinguisher -On 2026-10-14 -PerModule -Preview
```

Expect: **+14 effort-days** for the same 2 days of delivery, in seven lanes plus delivery. Same date, very different cost.

### 5. Read the results

```powershell
Mv-Use thriveni
Mv-Timeline -Steps       # one line per module that left its plan, and which event moved it
Mv-History               # delivery at every step; the first time the plan was breached
Mv-Events
Mv-Attribution -Strategy both
```

Expect the timeline: **M2 +3** (absorbed), **M5 +1**, **delivery +3 in two steps** (+1 via M5, +2 directly). Attribution:
extinguisher **+2** ("Late scope discovery"), M5 event **+1** ("Dependency delays"), M2 slip **0** ("Estimation /
unexplained variance"). Both methods agree here because nothing overlaps (see scenario 6).

### 6. Overlapping delays: where the two attribution methods differ (project `overlap`)

```powershell
Mv-Use overlap
Mv-Delay -Task m5.dev -Days 1 -On 2026-10-14 -Type DEPENDENCY_DELAY -Id m5-assets-late
Mv-Delay -Task m3.dev -Days 3 -On 2026-10-14 -Id m3-rework
Mv-Attribution -Strategy both
```

Expect delivery **Tue 3 Nov** (+2). `sequential` says **+1 and +1**. `counterfactual` says **0 and +1, plus 1 day of
interaction**: M3's longer slip hides M5's, so removing the M5 event alone would not have saved a day.

### 7. A team shrinks (project `cap`)

```powershell
Mv-Use cap
Mv-Capacity -Team dev -From 2026-10-14 -Headcount 2 -On 2026-10-13
```

Expect: no extra effort, delivery **Thu 12 Nov** (+9 working days). Every module with development left moves.

### 8. Something finishes early (project `rec`)

```powershell
Mv-Use rec
Mv-Done -Task m5.dev -On 2026-10-16
```

Expect: delivery **Thu 29 Oct** (one day earlier, not three: M3 now sets the pace). The explanation credits M5.

### 9. Something the plan cannot accept (project `late`)

```powershell
Mv-Use late
Mv-Extinguisher -On 2026-10-22 -PerModule
Mv-Block -Task m1.art -Until 2026-10-20 -On 2026-10-14
```

Expect two refusals, and nothing recorded: by 22 Oct every Alpha has already happened, so new work cannot be made a
prerequisite of it; and M1 art has already started by 14 Oct, so it cannot be blocked.

### 10. A mistake

```powershell
Mv-Use thriveni
Mv-Void -Event blocked -On 2026-10-15 -Reason "wrong module"
Mv-Events                # the event is still there, marked VOIDED
Mv-Timeline -Steps       # the M5 and delivery lanes show a void step
```

Expect delivery **Tue 3 Nov** (+2): without the M5 event, only the extinguisher remains.

### 11. Locked work

```powershell
Mv-PlanEdit -Task m1.dev -Days 1 -On 2026-10-20
Mv-Call PATCH "/projects/thriveni/tasks/m1.dev" @{ estimate = 99 }
```

Expect two refusals. The first: M1 is locked, so changes to it are events, not planning. The second: the plan rows
cannot be edited directly once the project has started; record a plan edit or an event. (The database refuses this
too, even if you bypass the API.)

### 12. Planning a module that has not started (project `draft`)

M7 is not locked here. M5 slips a day on the first day of the project; then M7's plan is made longer.

```powershell
Mv-Use draft
Mv-Delay -Task m5.dev -Days 1 -On 2026-10-05 -Type DEPENDENCY_DELAY -Id m5-slip
Mv-Status                                                                # Mon 2 Nov, +1 against the plan
Mv-PlanEdit -Task m7.dev -Days 3 -On 2026-10-06 -Reason "client added a scene" -Id longer-m7 -Preview
Mv-PlanEdit -Task m7.dev -Days 3 -On 2026-10-06 -Reason "client added a scene" -Id longer-m7
Mv-Status
Mv-PlanEdits
Mv-Timeline
Mv-Attribution -Strategy both
```

Expect: M7 now takes 14 days to Alpha, longer than M5's 13, so **the plan itself moves to Mon 2 Nov**. The forecast stays
Mon 2 Nov, so the delay against the plan goes from **+1 to 0**. The output says "the plan itself moved +1 working day
(this is planning, not delay)". `Mv-Status` shows the original plan (Fri 30 Oct), the plan as refined (Mon 2 Nov), and the
client date still **1 working day late**. The timeline lists the plan edit. The attribution (sequential) reads
**M5 slip +1 ("Dependency delays"), plan edit -1 ("Planning changes"), total 0**.

Now the refusals, still in `draft`:

```powershell
Mv-PlanEdit -Task m6.dev -Days 1 -On 2026-10-07          # M6 is locked
Mv-Delay -Task m7.dev -Days 1 -On 2026-10-08             # M7 is not locked
```

Expect: the first says changes to M6 are events. The second says M7's plan can still be edited, so record a plan edit.

Then, work under way:

```powershell
Mv-Delay -Task m2.dev -Days 0 -On 2026-10-14 -Title "Weekly check-in"
Mv-PlanEdit -Task m7.dev -Days 1 -On 2026-10-15          # refused: M7 development has started
Mv-Status                                                 # warns that M7 is under way but not locked
Mv-Lock -Module m7
Mv-Delay -Task m7.dev -Days 1 -On 2026-10-15             # now an event: accepted
Mv-Status
```

Expect: by 14 Oct M7 development is under way, so a plan edit to it is refused ("a change to started work is an event,
not a planning change"). Once M7 is locked, the delay is an event: delivery **Tue 3 Nov**, **+1 against the refined plan**,
client date **2 working days late**.

### 13. A holiday (project `holiday`)

```powershell
Mv-Use holiday
Mv-Holiday -Date 2026-10-28 -On 2026-10-14 -Preview
Mv-Holiday -Date 2026-10-28 -On 2026-10-14 -Id hol
Mv-Status
Mv-Holiday -Date 2026-10-24 -On 2026-10-15               # a Saturday
Mv-Holiday -Date 2026-10-14 -On 2026-10-15               # in the past
```

Expect: the holiday on Wed 28 Oct pushes delivery from Fri 30 Oct to **Mon 2 Nov** (+1), no extra effort, on the delivery
lane, caused directly. Client date **1 working day late**. The two refusals: a Saturday is already a non-working day;
and a holiday must be after the status date (history is not rewritten).

### 14. Work the forecast assumes is finished (project `warn`)

Nobody records anything. The forecast carries on as planned, and tells you what it is assuming.

```powershell
Mv-Use warn
Mv-Delay -Task m2.dev -Days 0 -On 2026-10-14 -Title "Weekly check-in"
Mv-Status                                   # Warnings: 17
Mv-Advisories                               # which tasks, and when each was forecast to finish
Mv-Done -Task m1.sb -On 2026-10-06          # confirm one, on the day it was forecast
Mv-Status                                   # 16
Mv-Done -Task m5.art -On 2026-10-15 -Title "M5 art finally finished"    # confirm one that finished LATE
Mv-Status
```

Expect: by the end of 14 Oct the forecast has **17 tasks finished** that nobody has recorded (14 module tasks, 3 shared).
Confirming M1 storyboard on its forecast day changes no date. Then M5 art is recorded as finished on Thu 15 Oct instead of
Tue 13 Oct: **delivery moves to Tue 3 Nov (+2)**, because the development after it cannot have started on the 14th.

### 15. Your own scenario

Pick two or three things that really happened on Thriveni and enter them with the commands above (`Mv-Send` takes any
event if none of the shortcuts fit). Then compare with what your team concluded in its retrospective:

- Did the numbers match your memory of how late it was, and why?
- Was there an event you could not express?
- Was anything on the screen confusing?

### 16. Try to break it

- Misspell a task id, give a date like `2026-13-45`, use a task that does not exist, void the same event twice.
- Stop the server (Ctrl+C), start it again, and run `Mv-Status`: everything should still be there.
- Run two commands quickly one after the other.

Every refusal should say what was wrong. If one is cryptic, or something that should have failed succeeded, that is a
finding.

## 4. Things that are not bugs

- **No screen yet.** The timeline, Control Room and retro views are the next step.
- **People are not double-booked.** Seven parallel development tasks do not compete for four developers. The capacity
  model only scales speed up or down (you said this was fine for now).
- **Unrecorded work is assumed on plan**, and flagged. A quietly late task looks on time until someone records it, but the
  system now says which tasks it is taking on trust.
- **Plan edits cannot touch work that has started**, even in an unlocked module. Once work is under way, a change to it is
  an event.
- **Dates only**, no times of day. Saturday and Sunday are never working days; holidays are added as you go.
- **No login.** It only listens on this machine.

## 5. Questions I need you to answer

Short answers are fine. The scenario to look at is in brackets.

1. **Events on unlocked modules** [12]: you said the system should guard this. I made it **refuse**, with a pointer to plan
   edits. Would you rather it **warned** and let the event through?
2. **Holidays count as delay** [13]: a holiday is an event, so it appears as a delay under "Capacity changes". Is that how
   you want it shown, or should a holiday be a planned calendar change that does not count as late?
3. **Plan edits in the retro** [12]: a plan edit that absorbs an earlier slip appears as a negative share ("Planning
   changes -1"). Does that read the way you want?
4. **Too many warnings?** [14]: if nobody records anything there are 17 warnings by day 8. Would you rather see them grouped
   by module, only the critical path first, or just a count with a link?
5. **When is a module "started"?** [12]: today you lock a module by hand when its work begins, and the system warns when work
   is forecast under way on an unlocked module. Is a manual lock right, or should it happen when its first task is recorded as started?
6. **The shared extinguisher** [4]: it resolves the advisory because the work sits outside any one module. Is "done once,
   for everyone" the right test?
7. **Client date** [3, 12]: `Mv-Status` shows "N working days LATE" against the client date. Is that the wording and the
   unit (working days) you want on the Control Room?
8. **What surprised you?** Any forecast you did not believe. Paste the command and the output.

To report a problem, paste the command you ran and what it printed.
