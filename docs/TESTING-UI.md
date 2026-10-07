# Testing the web app (fourth round)

About half an hour. You will open the app, look at the project the way you described (the whole project, then one module),
flag a milestone, and try a project that is not a VR training.

Everything below was run against the real server before this guide was written, and the numbers are what it produced.
If you see something different, that is a finding: tell me what you clicked and what you saw.

## What changed since the last round

Your answers are all built or recorded in [DESIGN.md §8](../DESIGN.md):

- **Two views of the timeline.** The project view has a dot for each milestone; click a module's start dot and you are
  in that module's own timeline, with a dot for each of its tasks. Same branching rule at both levels.
- **What a milestone is.** Every module's start and finish, plus any task you flag.
- **A glowing green "We are here" dot** at today's date.
- **Phases belong to the project.** The list of phases (Storyboard, Art... for a VR training; Brief, Design,
  Construction... for a building) is the project's own.
- **Generic wording**, and a second sample project that is not VR at all: a community centre.
- **One command to start**: `npm run demo`.

## 1. Set up

```powershell
cd "C:\AI Test Projects\Project Multiverse"
npm run demo
```

That deletes and recreates its own file (`data\demo.sqlite`, never your real data), loads four projects, builds the app and
starts the server. Open **http://127.0.0.1:4000**. Press **Ctrl+C** in that window to stop. To start again from
nothing, run it again. If port 4000 is busy: `$env:PORT = 4001; npm run demo`, and open that port instead.

The four projects (pick one at the top right):

| Project | What it is |
|---|---|
| Thriveni VR Training (`thriveni`) | the VR training, with three demo events already recorded |
| Thriveni VR Training (`draft`) | the same, nothing recorded, Module 7 not started (for planning changes) |
| Thriveni VR Training (`fresh`) | the same, nothing recorded, every module started |
| Community centre (`centre`) | a building: foundations, structure, fit-out. Own phases. Three demo events |

Optional: `npm test` should show 415 engine, 205 server and 176 web tests passing.

## 2. Scenarios

### 1. The project view (`thriveni`, Timeline tab)

- Tiles: **Original plan Fri 30 Oct**, **Forecast Wed 4 Nov** (3 working days late), **Client date Fri 30 Oct**.
- On the original line there are **18 dots**: a start and a finish for each of the nine modules. All eight modules that
  start on **Mon 5 Oct** are stacked in one coloured column at the left (they start the same day, so they cannot sit on
  one spot). Each module has its own colour; the key under the chart lists them.
- Finishes are rings. They are hollow until the module is done, solid after. Among them: **Shared systems done** (Tue 13
  Oct, solid, because it is finished), **m2 alpha** (planned Thu 15 Oct) and **m5 alpha** (planned Wed 21 Oct). The big
  black dot at the right is **Delivery Fri 30 Oct**.
- **Hover** a dot. For m2 alpha: planned for Thu 15 Oct, forecast Tue 20 Oct (+3 working days). For a module start: "Click
  to open this module's own timeline".
- Branches: Delivery forecast (+3, ends Wed 4 Nov), Module 2 (+3, ends Tue 20 Oct), Module 5 (+1, ends Thu 22 Oct), as before.
- The **green dot, "We are here"**, is on the original line at *today's* date (your clock), pulsing gently. The blue line is
  the **status date**: Wed 14 Oct, when the forecast was last re-worked. They differ, and that is the point.
- Click **Show table**: the 18 milestones as rows, with planned and forecast dates.

### 2. Into a module, and back

- Click the **Module 5** start dot (the one in the coloured column at the left), or press the **Module 5** button under
  the key. The address becomes `#/thriveni/timeline/m5`.
- You see a path along the top: **← Back to the project › Module 5**. Tiles: **Planned to finish Wed 21 Oct**,
  **Forecast to finish Thu 22 Oct** (1 working day late), **Tasks done 2 of 4**.
- The chart is the same idea, one level down. The line is Module 5's own plan, with a dot for each task: **m5 storyboard** and
  **m5 art** are solid (done); **m5 development** is a ring stacked above **m5 alpha**, a diamond, because they finish
  the same day (Wed 21 Oct).
- Two branches: **m5 development** (+1, ends Thu 22 Oct) and **m5 alpha** (+1, ends Thu 22 Oct). Hover the node on
  the second: "Moved because of m5 development". Click the first node: "Delivery moves later, from Fri 30 Oct to Mon 2 Nov
  (+1 working day)", the same explanation as on the project view.
- Press **Back to the project** (or your browser's back button). You are on the project view again.
- Try the others: **Module 2** has two branches, m2 development and m2 alpha, each +3, ending Tue 20 Oct. **Module 1** says
  "Nothing in this module has slipped". **Integration and delivery** has nine tasks and nine branches: eight moved because
  of Module 5, and **Extinguisher system**, marked *new*, which was added after the project started.

### 3. Flag a milestone

Back on the project view, scroll down to **Project milestones**. It says "Nothing flagged yet."

- Choose **Client review** and press **Flag as a milestone**. A **diamond** appears on the original line at **Thu 22 Oct**,
  labelled "Client review". Hover it: planned Thu 22 Oct, forecast Fri 23 Oct (+1 working day). **Show table** now lists
  19 milestones.
- Press **Remove** next to it. The diamond goes. Flags are not "history": you can change them any time, even mid-project.

### 4. A project that is not a VR training (`Community centre`)

Pick **Community centre** at the top right.

- Tiles: **Original plan Wed 18 Nov**, **Forecast Mon 23 Nov** (3 working days late), **Client date Wed 18 Nov**. The modules
  are Foundations, Structure, Fit-out, Services, and Inspection and handover. There are **10 dots**, and each part ends on its
  own milestone: *Foundations signed off*, *Structure signed off*, *Fit-out complete*, *Services done*, and **Handover Wed 18 Nov**.
- Branches: Foundations +2 (ends Tue 20 Oct), Services +2 (Wed 4 Nov), Structure +3 (Thu 5 Nov), Fit-out +3 (Mon 16 Nov),
  and delivery +3 (Mon 23 Nov).
- Open **Structure**. It has five tasks: Steel frame, Roof, Structure inspection, Structure signed off, and **Fire exit
  door and frame**, which has a thin ring round its dot because it was added after the project started. Its branch says *new*
  and ends Wed 4 Nov.
- **Record a change** tab → **A task takes longer or shorter**. "Where was the project when this came up?" lists **Brief,
  Design, Construction, Inspection, Handover, After handover**, starting on *Construction*. For Thriveni it lists Planning,
  Storyboard, Art, Development, Internal review, Alpha, Client review, QA, Beta, After delivery, starting on *Development*.
  Each project has its own.
- **Control room**: what is setting the pace is **Pour concrete**; the chain runs Pour concrete, Foundations signed off,
  Steel frame, Fire exit door and frame, Structure inspection, Structure signed off, Plastering, Flooring, Fit-out
  complete, Final inspection, Snagging, Handover. Progress **15.4%** (8 of 52 working days of effort).
- **Retrospective**: "100% of feedback (1 of 1) arrived after development had finished" (the inspector's note, in the
  *Inspection* phase), "1 requirement discovered after development had started" (the fire exit, found during
  *Construction*), and "1 of 3 events could have been identified earlier".

### 5. Record something, and take it back (`thriveni`)

**Record a change** → **A task takes longer or shorter** → *m3 development*, **3** days, date Wed 14 Oct → **Preview the
effect**: "Delivery moves later, from Wed 4 Nov to Thu 5 Nov (+1 working day)". **Record this event**, and **See it on the
timeline**: a Module 3 branch has appeared. Open Module 3. Then **Withdraw** it from the history and the forecast returns to
Wed 4 Nov. The example sentences on the buttons are now deliberately general ("The report draft needs 1 more day").

### 6. A planning change (`draft`)

On `draft`, **Re-estimate work that has not started** → *m7 development*, **3** more days, effective from **Tue 6 Oct** →
Preview: "The plan itself moves +1 working day. This is planning, not delay." Record it. On the timeline, a diamond marker and
**Plan now Mon 2 Nov**. Open **Module 7**: planned to finish Mon 19 Oct in the original plan, and the chart's grey diamond shows where
the plan now has it (Thu 22 Oct). No branch, because nothing slipped.

### 7. Looks and hands

- **Theme**: Match system, Light, Dark. Make the window narrow: nothing should scroll sideways except the chart in its frame.
- **Keyboard only**: **Tab** onto a module's start dot and press **Enter**: its timeline opens. **Tab** through the branch
  nodes; **Enter** explains one.

### 8. Try to break it

Open `#/thriveni/timeline/nope` by hand. Open a module, then switch to **Control room** and back to **Timeline** (you should be on the
project view). Reload while inside a module (you should stay in it). Stop the server, click around, start it again.

## 3. Things that are not bugs

- **The coloured column of dots at the project start** is eight modules that start on the same day, stacked so each can be
  hovered. Dots that fall on the same day always stack.
- **On the project view only the delivery and flagged milestones carry a label.** The rest are a hover away. In a module’s own view every task is labelled where there is room.
- **"We are here"** follows your computer's date; the sample projects are dated October and November 2026, so it may sit
  before or after the blue status line.
- **A task's colour in a module's view is the module's colour.** Its branches use it too.
- **Phases can only be defined when a project is created through the API.** There is no screen for that yet.
- **A plain "takes longer" event is counted as "Estimation / unexplained variance"**, unless it names an earlier event that explains
  it. The community centre's rain delay shows up that way.
- **Withdrawn events stay visible.** The record of what was believed is kept.
- **The server prints "SQLite is an experimental feature".** Expected and harmless.

## 4. Questions I need you to answer

Put your answers under each question, then I will read them and remove them.

1. **The column of module starts.** Eight modules start on the same day, so their dots stack. Is that clear, or would you
   rather see one dot labelled "8 modules start" that you click to choose a module?
2. **Labels.** On the project view only the delivery and flagged milestones are labelled; everything else is a hover. In a
   module’s view every task is labelled where there is room. Would you like more labels on the project view, or fewer?
3. **The module view.** One dot for each task's finish, and a branch for each task that moved. Is that the right level of
   detail? Would you like each task's *start* as well?
4. **Flagging.** Flagging sits under the project chart. Is that the right place? Should a flagged task also be a dot on its
   module's own view as a milestone (it is, if it is a milestone task already)?
5. **Not just VR.** Did the community centre feel like a different kind of project, or did "module" still feel like a VR word?
   Would you want each project to call its parts something else (parts, workstreams, sections)?
6. **Phases.** They are set through the API when a project is created. Do you want a screen to create a project and define its
   phases, and is that the next thing, or is something else more important?
7. **What next?** With a real project and real PMs (the spec's next phase), what should the app be able to do before you put
   it in front of them?
