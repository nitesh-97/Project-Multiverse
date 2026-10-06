# Project Multiverse --- Product & Development Specification

**Status:** Initial Product Specification\
**Purpose:** Source-of-truth document for starting a local development
project with Codex\
**Working name:** Project Multiverse\
**Product category:** Project Execution Intelligence Platform\
**Primary domain:** Complex, cross-functional enterprise projects,
initially optimized for VR/Unity module production

------------------------------------------------------------------------

# 1. Executive Summary

Project Multiverse is a project execution intelligence platform for
teams where work is distributed across multiple functions, dependencies
are strong, scope evolves during execution, and delays are difficult to
explain after the fact.

It is **not intended to initially replace Zoho/Jira or become another
generic task manager**.

The system should sit above the existing task-management workflow and
answer questions that conventional task trackers do not answer well:

-   What was the original plan?
-   What is actually happening?
-   What changed?
-   When did it change?
-   Why did it change?
-   Who or what was affected?
-   How much additional effort did it create?
-   Did it affect the project's critical path?
-   When did the project first become likely to miss its original date?
-   What is the current forecast?
-   How did the forecast evolve over time?
-   What caused the final delay?
-   Could the issue have been identified earlier?

The central product promise is:

> **See how your project got here --- and where it is going.**

The central management question is:

> **"We are delayed. Why, by how much, when did it happen, and what does
> it mean for the final delivery?"**

------------------------------------------------------------------------

# 2. Background / Problem Context

The product is motivated by a real enterprise VR development workflow.

A typical project contains multiple modules. Several teams work in
parallel:

-   PM / Project Management
-   LXD / Storyboard
-   Art
-   Development
-   QA
-   Sometimes additional shared/system teams

A typical module lifecycle is:

1.  Project planning
2.  Storyboard / LXD work
3.  Art assets, animation and scene work
4.  Development
5.  LXD feedback
6.  Alpha build / playthrough
7.  Client feedback
8.  Changes by relevant teams
9.  Common feature integration
10. QA
11. Beta build
12. Final delivery

With multiple modules, several modules can be developed in parallel.
Client feedback may arrive for multiple modules together. Team members
can be reassigned during the project.

The current task-tracking system can track work, but does not adequately
capture the causes and propagation of project variance.

------------------------------------------------------------------------

# 3. Major Problems Identified

## 3.1 Incomplete scope at project start

Development features are often less predictable than Art and LXD work.

A feature may initially sound simple or remain vague. After development
begins, LXD or PM feedback may refine or change the requirement.

This can make additional development effort look like developer
inefficiency even when the underlying problem was insufficient scope
clarity.

The system must distinguish:

-   Original scope
-   Requirement clarification
-   New scope
-   Defect/rework
-   Feedback-driven change

Additional effort must not automatically be classified as individual
inefficiency.

------------------------------------------------------------------------

## 3.2 Late discovery of common features

Example: Thriveni project.

There were 7 modules. Each module required an extinguisher mechanic.

Initially, modules were developed without the extinguisher interaction
and later the mechanic was integrated.

If the complete scope had been known at planning time, the common
extinguisher mechanic could have been planned as a shared feature and
development could have progressed in parallel with LXD and Art.

This created avoidable repeated integration/rework.

Project Multiverse should detect repeated/common features across modules
and encourage planning shared systems early.

Examples:

-   Extinguisher system
-   Localization
-   Evaluation system
-   Menu UI
-   Common interaction systems
-   Shared animations
-   Shared code
-   Common UI

------------------------------------------------------------------------

## 3.3 Late architectural decisions

Example: TMP → UniText migration.

Custom UI was initially built using TMP.

Later, during multilingual localization, UI text needed to be converted
to UniText.

Existing UI scripts referenced TMP components. After migration, scripts
had to be modified to use UniText across many scenes.

The issue was not simply "localization took time."

The deeper issue was:

> A downstream requirement was not incorporated into an upstream
> technical architecture decision.

The system should identify important downstream constraints before
implementation starts.

Potential concept:

**Definition of Ready / Technical Readiness**

Before development starts, important architectural decisions should be
identified and resolved where possible.

------------------------------------------------------------------------

## 3.4 Dependencies are not sufficiently visible

Some tasks are independent while others are dependent.

Example:

Storyboard → Art → Development → Alpha → Client Review → Rework →
Integration → QA → Beta

Other activities may happen in parallel.

A task can be late without affecting the final project if it is not on
the critical path.

Conversely, a small delay on a critical dependency can move the entire
project.

The system therefore needs a dependency graph rather than only a flat
task list.

------------------------------------------------------------------------

## 3.5 Resource allocation changes are not properly represented

Project timelines depend on available capacity.

Example:

Planned:

-   Development: 4 people
-   Art: 3 people
-   LXD: 2 people

If Development capacity is reduced from 4 to 2 people, the original plan
may no longer be realistic.

The system should record capacity changes and model their schedule
impact rather than treating resulting delays as individual productivity
problems.

------------------------------------------------------------------------

## 3.6 Context transfer when people are reassigned

A task may be started by Developer A and later transferred to Developer
B.

Developer B may spend significant time understanding:

-   Existing code
-   Existing architecture
-   Previous decisions
-   Known bugs
-   Current state
-   Previous feedback

This is a real project cost.

The system should maintain ownership history and context-transfer
events.

It should answer:

-   Who originally implemented this?
-   When was ownership transferred?
-   What was the state at transfer?
-   When was the issue discovered?
-   Who fixed it?

This should be an accountability/traceability system, not a blame
system.

------------------------------------------------------------------------

## 3.7 Scope must be explicit before work starts

Each major work item should have a clear scope.

The purpose is two-sided accountability:

-   Team members should not be forced to silently absorb expanding
    scope.
-   Team members should not claim completion while agreed work remains
    incomplete.

The system should therefore establish a **Scope Contract** and
**Acceptance Criteria** before execution.

Original scope should become immutable once execution starts.

New work should be recorded as a Scope Change.

------------------------------------------------------------------------

## 3.8 Feedback is not sufficiently tracked

LXD feedback is currently not tracked with the same rigor as QA or
development work.

A change that looks simple to LXD may require significant architectural
or implementation work for Development.

The system should allow any team member to record feedback or
observations about:

-   Requirement
-   Quality
-   Dependency
-   Delay
-   Rework
-   Technical issue
-   Resource issue
-   Process issue
-   Clarification

The purpose is to create project evidence that can be discussed during
retrospectives.

Feedback should be associated with:

-   Project
-   Module
-   Task
-   Source team/person
-   Affected team/person
-   Phase
-   Category
-   Description
-   Expected/actual impact
-   Status
-   Time discovered
-   Whether it could have been identified earlier

------------------------------------------------------------------------

## 3.9 Feedback timing matters

The system should distinguish when feedback was discovered.

Possible phases:

-   Planning
-   Storyboard
-   Art
-   Development
-   Internal review
-   Alpha
-   Client review
-   QA
-   Beta
-   Post-delivery

Example insight:

> 28% of LXD observations were discovered after development completion.

This is more useful than saying:

> "LXD gave too much feedback."

The objective is to improve when information becomes available.

------------------------------------------------------------------------

## 3.10 High-cost / low-value features

Sometimes a feature consumes substantial implementation effort but has
relatively low training/learning impact.

Example: a new evaluation end screen that displays individual
sub-scenario scores based on completion time.

The implementation requires:

-   Playing the module
-   Recording normal-user completion times
-   Establishing average/baseline timing
-   Creating new scoring logic
-   Updating UI
-   Potentially modifying existing systems
-   Existing dashboard incompatibility
-   Additional manual work
-   Additional testing
-   Additional maintenance

The previous evaluation system already had:

-   Existing evaluation panel
-   Online dashboard
-   Pass/fail scoring
-   Ready-made setup tooling

The new feature had a relatively low training impact while introducing
substantial engineering and operational cost.

Project Multiverse should therefore provide a **Feature Impact
Assessment** before or during approval.

Potential dimensions:

-   Training value
-   Client value
-   Business value
-   Implementation effort
-   Reusability
-   Maintenance cost
-   Existing-system compatibility
-   Manual work introduced
-   Dashboard/backend impact
-   QA impact

The system should not automatically reject such features. It should make
the tradeoff visible.

------------------------------------------------------------------------

# 4. Product Vision

Project Multiverse should maintain a living, historical model of project
execution.

The system connects:

**Plan → Scope → Dependencies → Resources → Work → Events → Impact →
Forecast → Outcome**

The product should make the project explainable.

A project should never reach the end with only:

> "We were 7 days late."

It should be possible to say:

> "The original delivery was October 25. The current delivery became
> October 30. Two days came from late scope discovery, one day from late
> LXD feedback, one day from a capacity reduction, and one day from
> rework. The first forecast indicating that October 25 was no longer
> achievable occurred on October 12."

------------------------------------------------------------------------

# 5. Product Principles

## 5.1 Do not replace task management initially

Zoho/Jira/etc. can remain the task system of record.

Project Multiverse should initially be the execution intelligence layer.

------------------------------------------------------------------------

## 5.2 Do not build employee surveillance

Avoid:

-   Productivity scoring
-   "Developer efficiency" rankings
-   Individual performance dashboards based on time alone

The primary unit of analysis should be:

**Work → Dependency → Change → Delay → Impact**

People are part of the history, not the target.

------------------------------------------------------------------------

## 5.3 Preserve the original plan

Do not overwrite the original timeline.

The original plan is an immutable baseline.

New forecasts create new timeline states/branches.

------------------------------------------------------------------------

## 5.4 Distinguish effort from schedule impact

A 3-day task does not necessarily create a 3-day project delay.

If it runs in parallel, project impact may be zero.

A 1-day task on the critical path may create a 1-day project delay.

------------------------------------------------------------------------

## 5.5 Capture events, not just tasks

The most important new object is an Event.

Examples:

-   Feedback received
-   Requirement changed
-   Scope expanded
-   Dependency blocked
-   Resource added
-   Resource removed
-   Task delayed
-   Task completed
-   Defect discovered
-   Rework required
-   Client feedback
-   Technical decision changed
-   Ownership transferred

Events explain why the project changed.

------------------------------------------------------------------------

# 6. Core Data Model

Initial conceptual model:

``` text
PROJECT
│
├── REQUIREMENTS
│
├── MILESTONES
│
├── MODULES
│   │
│   ├── TASKS
│   ├── DEPENDENCIES
│   ├── OWNERS
│   ├── ACCEPTANCE CRITERIA
│   └── FEEDBACK
│
├── RESOURCES
│
├── FEATURES
│
├── EVENTS
│
├── CHANGES
│
└── FORECASTS
```

A more detailed relationship model:

``` text
Project
 ├── Modules
 │    ├── Tasks
 │    ├── Features
 │    ├── Dependencies
 │    ├── Feedback
 │    └── Events
 │
 ├── Milestones
 ├── Teams
 ├── Resources
 ├── Requirements
 └── Forecast Snapshots
```

------------------------------------------------------------------------

# 7. Event Model

Every event should contain enough information to reconstruct its impact.

Conceptual structure:

``` text
Event
- id
- projectId
- moduleId
- taskId (optional)
- type
- category
- title
- description
- createdBy
- affectedTeam
- affectedOwner
- phase
- createdAt
- occurredAt
- estimatedEffortImpact
- estimatedScheduleImpact
- actualEffortImpact (optional)
- actualScheduleImpact (optional)
- status
- source
- parentEventId (optional)
- linkedRequirementId (optional)
- linkedFeatureId (optional)
```

Initial event types:

-   FEEDBACK
-   SCOPE_CHANGE
-   REQUIREMENT_CHANGE
-   BLOCKER
-   DEPENDENCY_DELAY
-   RESOURCE_CHANGE
-   REWORK
-   DEFECT
-   TECHNICAL_DECISION
-   OWNERSHIP_TRANSFER
-   CLIENT_FEEDBACK
-   TASK_DELAY
-   TASK_COMPLETION
-   MILESTONE_CHANGE

------------------------------------------------------------------------

# 8. Project Blueprint

Before execution begins, a project should define:

-   Project name
-   Modules
-   Target delivery
-   Teams
-   Resources
-   Milestones
-   Major features
-   Common features
-   Dependencies
-   Languages/localization requirements
-   Evaluation requirements
-   Acceptance criteria
-   Initial estimates

Example:

``` text
Project: Thriveni VR Training
Modules: 7
Target delivery: 30 Oct

Teams:
- LXD
- Art
- Development
- QA

Common systems:
- Extinguisher
- Localization
- Evaluation
- Menu
```

------------------------------------------------------------------------

# 9. Scope Contract

Each major task/module should define:

## In Scope

Explicit expected functionality.

## Dependencies

Inputs required before work can proceed.

## Acceptance Criteria

Objective definition of completion.

## Estimate

Expected effort.

## Owner

Current accountable owner.

## Scope State

Original scope must be preserved.

Any addition after execution begins becomes a Scope Change.

Example:

``` text
SCOPE CHANGE #01

Added:
Two-hand extinguisher interaction

Requested by:
LXD

Estimated effort:
+1.5 days

Affected:
Development
QA

Status:
Approved
```

------------------------------------------------------------------------

# 10. Definition of Ready

A task/module should not simply be "assigned."

It should have a readiness assessment.

Example:

``` text
DEVELOPMENT READY?

Storyboard       ✓
Assets           ✓
Technical spec   ⚠
Dependencies     ✓
Acceptance       ✓
Common features  ✗

Result:
NOT FULLY READY
```

Readiness should identify missing information before work begins.

Potential readiness dimensions:

-   Scope defined
-   Storyboard ready
-   Art dependencies ready
-   Technical decisions resolved
-   Common features identified
-   Dependencies known
-   Acceptance criteria defined
-   Resources assigned
-   Localization architecture defined
-   Evaluation requirements defined

------------------------------------------------------------------------

# 11. Common Feature Detection

If the same feature is associated with multiple modules, Project
Multiverse should identify it as a candidate common/shared feature.

Example:

``` text
M1 → Extinguisher
M2 → Extinguisher
M3 → Extinguisher
M4 → Extinguisher
M5 → Extinguisher
M6 → Extinguisher
M7 → Extinguisher
```

System insight:

> Common Feature Detected: Extinguisher System\
> Used by: 7 modules\
> Recommendation: Plan shared implementation before individual module
> integration.

This should initially be an advisory rule, not an automatic
architectural decision.

------------------------------------------------------------------------

# 12. Feature Impact Assessment

Before accepting significant new features:

``` text
Feature: Scenario Timing Analytics

Training value:       LOW
Client value:         MEDIUM
Implementation:       HIGH
Reusability:          LOW
Maintenance:          HIGH
Dashboard impact:     HIGH
Manual work:          HIGH
```

This produces a tradeoff warning such as:

> High implementation cost / low training impact.

The decision remains with the project stakeholders.

------------------------------------------------------------------------

# 13. Dependency Graph

The execution engine should model tasks and milestones as a directed
graph.

Example:

``` text
Storyboard
    ↓
Assets
    ↓
Development
    ↓
Alpha
    ↓
Client Review
 ┌──┼──┐
Dev Art LXD
 └──┼──┘
    ↓
Integration
    ↓
QA
    ↓
Beta
    ↓
Delivery
```

Dependencies should support:

-   finish-to-start
-   start-to-start where needed later
-   optional future dependency types

For MVP, start with a simple finish-to-start model.

------------------------------------------------------------------------

# 14. Critical Path and Delay Propagation

The system should calculate schedule impact based on dependencies.

Conceptually:

``` text
Task delay
    ↓
Find downstream dependencies
    ↓
Determine available float
    ↓
Determine whether critical path is affected
    ↓
Propagate schedule impact
    ↓
Recalculate milestones
    ↓
Recalculate project forecast
```

Important distinction:

**Effort impact != Schedule impact**

Example:

``` text
Task A +2 days
Task A is not critical
Project impact = 0 days
```

versus:

``` text
Task B +1 day
Task B is critical
Project impact = +1 day
```

------------------------------------------------------------------------

# 15. Resource-Aware Forecasting

The project plan must account for capacity.

Track:

-   planned resources
-   available resources
-   allocation
-   resource changes
-   start/end dates
-   team capacity

Example:

``` text
Original:
Development = 4 people

Current:
Development = 2 people

Capacity:
100% → 50%

Forecast impact:
+3 days
```

The system should describe this as a capacity change rather than
individual underperformance.

For MVP, use a simple capacity model rather than sophisticated resource
optimization.

------------------------------------------------------------------------

# 16. Forecast Engine

The system should maintain four important date concepts:

1.  Original date
2.  Previous forecast
3.  Current forecast
4.  Actual date

Whenever a meaningful event occurs:

``` text
Event
 ↓
Recalculate dependencies
 ↓
Recalculate capacity
 ↓
Calculate critical path
 ↓
Calculate milestone dates
 ↓
Generate new forecast snapshot
```

A forecast snapshot should be immutable.

This creates forecast history.

------------------------------------------------------------------------

# 17. Multiverse Timeline

This is the signature visualization.

The original timeline remains visible.

Every meaningful forecast change creates a new branch/state.

Example:

``` text
Original ───────────────────── Oct 25
                  \
Revision 1 ─────────────────── Oct 27
                     \
Revision 2 ─────────────────── Oct 30
```

Each branch should be inspectable.

Clicking a branch/delay should reveal:

-   Trigger event
-   Date
-   Description
-   Affected tasks
-   Affected modules
-   Effort impact
-   Schedule impact
-   Critical path status
-   Forecast before event
-   Forecast after event

------------------------------------------------------------------------

# 18. Control Room View

The primary management interface should be visually simple.

Conceptually:

``` text
PROJECT CONTROL ROOM

THRIVENI

Original Delivery: 25 Oct
Current Forecast:  30 Oct
Variance:          +5 days

Progress:          78%

Current bottleneck:
Localization
    ↓
Evaluation
    ↓
QA

Delay contributors:
Late scope discovery       +2d
Late LXD feedback          +1d
Resource change            +1d
Rework                     +1d
```

The management view should answer:

-   Where are we?
-   Are we on time?
-   When will we finish?
-   Why are we late?
-   What is currently blocking us?
-   What is likely to become the next bottleneck?

------------------------------------------------------------------------

# 19. Train-Control-Room Mental Model

The visual language can use the user's train-control-room analogy.

-   Route → Project roadmap
-   Station → Milestone
-   Train → Current project state
-   Delay → Schedule variance
-   Signal → Risk/blocker
-   Alternate route → Timeline branch
-   Control room → Management dashboard
-   Journey history → Project timeline history

A milestone can behave like a station.

The current project position is like a train.

The forecast is the predicted arrival time.

When a delay occurs, downstream station arrival times update.

------------------------------------------------------------------------

# 20. Forecast History

Each milestone should maintain forecast history.

Example:

``` text
CLIENT ALPHA

Original:
15 Oct

Forecast:
01 Oct → 15 Oct
05 Oct → 16 Oct
08 Oct → 18 Oct
12 Oct → 19 Oct
```

This allows management to identify **forecast drift**.

The project did not necessarily become late suddenly.

The forecast may have deteriorated gradually.

An important future metric:

> **Time between first detectable risk and recognized schedule impact.**

------------------------------------------------------------------------

# 21. Accountability / Ownership Timeline

Each work item should preserve ownership history.

Example:

``` text
MODULE 03

Sep 02
Dev A assigned

Sep 05
Implementation started

Sep 08
LXD feedback

Sep 09
Dev A updated

Sep 12
Dev A reassigned

Sep 13
Dev B assigned

Sep 13
Context transfer

Sep 14
Bug identified

Sep 15
Dev B fixed
```

This lets the system answer:

-   Who owned the work when the issue was introduced?
-   When was the issue first observable?
-   When was it discovered?
-   When did ownership transfer?
-   Who fixed it?

The objective is traceability, not blame.

------------------------------------------------------------------------

# 22. Feedback System

Any team member should be able to create feedback/observation.

Suggested fields:

``` text
Module
Task
From
To / Affected Team
Category
Description
Phase discovered
Could it have been identified earlier?
Estimated effort impact
Estimated schedule impact
Status
Resolution
```

Initial categories:

-   Requirement
-   Scope Change
-   Quality
-   Clarification
-   Dependency
-   Blocker
-   Rework
-   Technical
-   Resource
-   Process
-   Client Feedback

------------------------------------------------------------------------

# 23. Feedback Timing Analytics

The system should calculate where feedback is discovered.

Example:

``` text
LXD FEEDBACK

Storyboard       45%
Development      30%
Alpha            20%
Post-Alpha        5%
```

Useful derived metrics:

-   \% feedback found before development
-   \% feedback found during development
-   \% feedback found after development
-   \% feedback found during Alpha
-   average feedback latency
-   feedback-related effort
-   feedback-related schedule impact

------------------------------------------------------------------------

# 24. Retrospective Engine

At project completion, automatically generate a project retrospective.

Example:

``` text
PROJECT RETROSPECTIVE

Planned: 25 days
Actual:  31 days
Variance: +6 days

Delay contributors:
Scope changes        +2.5d
Late feedback        +1.5d
Capacity changes     +1.0d
Dependency delays    +0.5d
Rework               +0.5d
```

Process observations:

``` text
4 requirements discovered after Dev started

3 common features identified after
individual module development

28% of LXD feedback occurred after
development completion

2 tasks transferred between developers

Localization architecture decision occurred
after UI implementation
```

The retrospective should be evidence-based rather than memory-based.

------------------------------------------------------------------------

# 25. Core Product Loop

The central loop is:

``` text
PLAN
  ↓
EXECUTE
  ↓
EVENTS
  ↓
ANALYZE
  ↓
FORECAST
  ↓
PLAN / REPLAN
  ↓
EXECUTE
  ↓
...
```

The system continuously compares:

> **Plan vs Reality**

------------------------------------------------------------------------

# 26. MVP Scope

The first prototype should contain only five major capabilities.

## MVP 1 --- Project Blueprint

Support:

-   Project
-   Modules
-   Teams
-   Milestones
-   Tasks
-   Dependencies
-   Original estimates

## MVP 2 --- Scope & Feedback Events

Support:

-   Feedback
-   Scope change
-   Blocker
-   Dependency
-   Resource change
-   Rework

## MVP 3 --- Timeline / Multiverse

Support:

-   Original timeline
-   Current timeline
-   Milestone dates
-   Timeline branches
-   Forecast

## MVP 4 --- Impact Engine

Support:

-   Task delay
-   Milestone delay
-   Dependency propagation
-   Critical-path impact
-   Forecast delivery date

## MVP 5 --- Retro

Generate:

-   Planned vs actual
-   Delay contributors
-   Late feedback
-   Scope changes
-   Resource changes
-   Rework
-   Ownership history

------------------------------------------------------------------------

# 27. Explicitly Out of Scope for MVP

Do NOT initially build:

-   Full Zoho/Jira replacement
-   Chat system
-   HR/performance tracking
-   Individual productivity scoring
-   Complex AI chatbot
-   Advanced resource optimization
-   Mobile app
-   Full timesheet platform
-   Enterprise billing
-   Complex notification platform
-   Automatic employee ranking

These can be considered later only if validated by real usage.

------------------------------------------------------------------------

# 28. First Killer Workflow / Prototype Scenario

Use the Thriveni project as the first realistic demonstration.

## Step 1

Create:

``` text
Project: Thriveni
Modules: 7
Target: 30 Oct
```

## Step 2

Define common features:

-   Extinguisher
-   Localization
-   Evaluation
-   Project UI

## Step 3

System detects:

> Extinguisher affects 7 modules but has no shared implementation task.

## Step 4

Development starts.

## Step 5

LXD submits a feedback event.

## Step 6

Developer estimates:

> +2 days

## Step 7

System calculates:

``` text
Original delivery: 30 Oct
Current forecast:  1 Nov
Variance:          +2 days
```

## Step 8

Management opens Multiverse.

They see:

``` text
ORIGINAL
──────────────────────────── Oct 30
                    \
                     \ +2d
                      \
CURRENT
──────────────────────────── Nov 1
```

## Step 9

Click the branch.

System shows:

``` text
Cause:
Late LXD requirement

Affected modules:
7

Estimated effort:
2 days

Critical path:
YES
```

## Step 10

At completion:

> Retro generated automatically.

This workflow is the first proof-of-concept target.

------------------------------------------------------------------------

# 29. Suggested Technical Architecture

The architecture should be deliberately simple for MVP.

Conceptual layers:

``` text
┌─────────────────────────────────────┐
│             Frontend                │
│                                     │
│ Dashboard / Multiverse / Modules    │
│ Timeline / Events / Retro           │
└──────────────────┬──────────────────┘
                   │
┌──────────────────▼──────────────────┐
│              API                    │
│                                     │
│ Projects / Tasks / Events           │
│ Forecast / Dependencies / Reports   │
└──────────────────┬──────────────────┘
                   │
┌──────────────────▼──────────────────┐
│        Execution Intelligence       │
│                                     │
│ Dependency Engine                   │
│ Forecast Engine                     │
│ Critical Path                       │
│ Impact Calculation                  │
│ Event Processing                    │
└──────────────────┬──────────────────┘
                   │
┌──────────────────▼──────────────────┐
│              Data                   │
│                                     │
│ Projects                            │
│ Tasks                               │
│ Events                              │
│ Dependencies                        │
│ Forecast Snapshots                  │
│ Ownership History                   │
└─────────────────────────────────────┘
```

------------------------------------------------------------------------

# 30. Recommended Development Strategy

Do not start by building the polished UI.

Build the engine first.

## Phase 0 --- Domain validation

Before coding heavily:

1.  Convert the current problem statement into concrete domain entities.
2.  Define event types.
3.  Define task/dependency semantics.
4.  Define milestone semantics.
5.  Define forecast snapshot semantics.
6.  Define scope/change semantics.
7.  Define what constitutes a meaningful project event.

Use Thriveni as the reference project.

------------------------------------------------------------------------

## Phase 1 --- Local data model

Create:

-   Project
-   Module
-   Task
-   Milestone
-   Team
-   Resource
-   Dependency
-   Feature
-   Event
-   ForecastSnapshot

Use seeded/sample data.

Do not integrate Zoho yet.

------------------------------------------------------------------------

## Phase 2 --- Dependency/forecast engine

Implement:

1.  Task dependency graph
2.  Basic critical-path calculation
3.  Task delay propagation
4.  Milestone recalculation
5.  Project delivery forecast
6.  Forecast snapshot creation

This is the technical heart of the product.

------------------------------------------------------------------------

## Phase 3 --- Event system

Implement:

-   Feedback event
-   Scope change
-   Blocker
-   Dependency delay
-   Resource change
-   Rework
-   Ownership transfer

Every event should be persisted and linked to affected entities.

------------------------------------------------------------------------

## Phase 4 --- Multiverse visualization

Build the visual timeline:

-   Original baseline
-   Current forecast
-   Forecast branches
-   Milestones
-   Current project position
-   Delay indicators
-   Click-to-explain causes

Prioritize clarity over visual complexity.

------------------------------------------------------------------------

## Phase 5 --- Management Control Room

Build:

-   Current delivery forecast
-   Original delivery
-   Variance
-   Progress
-   Current bottleneck
-   Top delay contributors
-   Risk indicators
-   Forecast trend

------------------------------------------------------------------------

## Phase 6 --- Retrospective engine

Generate project-level analytics from stored events.

------------------------------------------------------------------------

## Phase 7 --- Real-world validation

Run the tool against one or two completed/recent projects.

Compare its reconstruction with the team's actual retrospective.

Ask:

-   Did it identify the real causes?
-   Did it miss important events?
-   Were impact estimates useful?
-   Was the forecast understandable?
-   Did PMs find the control-room view useful?
-   Did developers feel unfairly judged?
-   Did the event system create too much overhead?

Only after this validation should integrations and automation become
priorities.

------------------------------------------------------------------------

# 31. Future Integrations

Potential later integrations:

-   Zoho
-   Jira
-   Git
-   Slack
-   Microsoft Teams
-   Google Calendar
-   CI/CD systems
-   Unity build pipeline
-   Issue trackers

The first integration should likely be the existing task-management
system.

But integration should come **after** the local execution model is
proven.

------------------------------------------------------------------------

# 32. Future AI Opportunities

AI should not be the foundation of MVP.

Once structured project data exists, AI can later provide:

### Risk prediction

> "Based on similar projects, this module has a high probability of
> missing Alpha."

### Scope ambiguity detection

> "This feature description lacks acceptance criteria."

### Dependency detection

> "These 5 modules appear to depend on the same feature."

### Feedback analysis

> "This feedback appears to introduce scope rather than identify a
> defect."

### Retrospective summarization

> "Most schedule variance came from late requirement discovery."

### Forecast explanation

> "Delivery moved from Oct 25 to Oct 30 primarily because of three
> events."

AI should explain and assist the underlying data model rather than
replace it.

------------------------------------------------------------------------

# 33. Success Metrics for MVP

The MVP should be evaluated using measurable outcomes.

## Forecast accuracy

How close is the forecast to actual completion?

## Early detection

How much earlier can the system identify schedule risk?

## Root-cause accuracy

Does the system correctly explain why projects slipped?

## Retro usefulness

Can the team reconstruct project issues without relying primarily on
memory?

## Planning quality

Does Definition of Ready reduce late-discovered requirements?

## Rework reduction

Does identifying common features and scope changes reduce repeated work?

## Adoption

Do team members actually record meaningful events?

## Management usefulness

Can PMs understand current project health within a few minutes?

------------------------------------------------------------------------

# 34. Key Product Metrics

Potential metrics:

### Schedule

-   Original duration
-   Forecast duration
-   Actual duration
-   Schedule variance
-   Forecast drift

### Scope

-   Original scope items
-   Added scope
-   Removed scope
-   Scope changes after development
-   Late-discovered requirements

### Feedback

-   Feedback count
-   Feedback by team
-   Feedback by phase
-   Late feedback %
-   Feedback effort
-   Feedback schedule impact

### Dependencies

-   Number of dependencies
-   Blocked time
-   Critical-path dependencies
-   Dependency-related delay

### Resources

-   Planned capacity
-   Actual capacity
-   Resource changes
-   Capacity-related delay

### Rework

-   Reopened tasks
-   Rework effort
-   Rework schedule impact
-   Rework cause

### Forecast

-   Original delivery
-   Current forecast
-   Forecast history
-   Number of forecast revisions
-   First date risk became visible

------------------------------------------------------------------------

# 35. Important Terminology

Use consistent terminology throughout the product.

  Product concept     Meaning
  ------------------- ---------------------------------------------------------
  Plan                Original expected project execution
  Baseline            Immutable original plan
  Forecast            Current expected future
  Forecast Snapshot   Historical forecast at a point in time
  Event               Something that changes or explains project state
  Scope Change        New/changed work after original scope
  Feedback            Observation/request from a stakeholder
  Rework              Work that must be repeated or modified
  Dependency          Relationship between work items
  Milestone           Significant project checkpoint
  Critical Path       Dependency path that determines delivery
  Capacity            Available team/resource ability
  Impact              Effect of an event on effort/schedule
  Branch              A new timeline state resulting from changed assumptions
  Multiverse          Historical set of plan/forecast states
  Control Room        Management-facing project overview

------------------------------------------------------------------------

# 36. Product Safety / Organizational Principle

Project Multiverse should explicitly avoid becoming a surveillance or
blame platform.

The product should communicate:

> **Explain the system, not blame the person.**

Examples:

Bad:

> Developer X caused a 3-day delay.

Better:

> Development schedule increased by 3 days after two scope changes and a
> resource reassignment.

Ownership history can still be available for accountability and
traceability.

------------------------------------------------------------------------

# 37. Final Product Definition

Project Multiverse is:

> **A project execution intelligence platform that maintains a living,
> historical model of a project's plan and execution, records the events
> that cause deviations, propagates their impact through dependencies
> and capacity, and continuously visualizes both the original plan and
> the evolving forecast.**

It is not primarily a task manager.

It is not primarily a reporting dashboard.

It is not primarily an employee productivity tracker.

Its core value is:

> **Turning project execution history into an explainable, continuously
> updated model of project reality.**

------------------------------------------------------------------------

# 38. The Core Data Question

Every important project event should help answer:

``` text
What was planned?
      ↓
What changed?
      ↓
When did it change?
      ↓
Why did it change?
      ↓
Who/what was affected?
      ↓
How much effort did it create?
      ↓
Did it affect the critical path?
      ↓
How did the forecast change?
```

If the product can answer these questions reliably, the Multiverse
visualization becomes meaningful.

------------------------------------------------------------------------

# 39. Immediate Next Action for Codex

When starting the local project, do NOT ask Codex to build the complete
application immediately.

Start with:

1.  Read this specification.
2.  Propose a domain model.
3.  Propose the database schema.
4.  Propose the API contract.
5.  Propose the dependency/forecast engine design.
6.  Identify ambiguities in the model.
7.  Create a small seeded Thriveni project.
8.  Implement the execution engine before the polished UI.
9.  Add tests for delay propagation and forecast snapshots.
10. Build the Multiverse visualization after the underlying model is
    working.

The first technical milestone should be:

> **Given a project with modules, tasks, dependencies, milestones and
> events, the system can calculate the original timeline, accept a delay
> event, propagate its impact, generate a new forecast, preserve the old
> forecast, and explain why the forecast changed.**

If that works, the fundamental idea of Project Multiverse is working.

------------------------------------------------------------------------

# 40. First Codex Milestone

The first working demo should support this exact scenario:

``` text
Thriveni
7 modules
Target: Oct 30

        Original Timeline
              ↓
Extinguisher feature added late
              ↓
Affected: 7 modules
              ↓
Estimated impact: +2 days
              ↓
Dependency engine
              ↓
Current forecast: Nov 1
              ↓
Create forecast snapshot
              ↓
Multiverse visualization
              ↓
Click +2 day branch
              ↓
Show:
- Cause
- Affected modules
- Effort impact
- Schedule impact
- Critical path
- Original forecast
- New forecast
```

This is the smallest meaningful proof of the product concept.

------------------------------------------------------------------------

# 41. North Star

The ultimate experience should be:

A PM opens Project Multiverse and immediately understands:

> **Where the project is.**

> **Where it was supposed to be.**

> **Where it is now expected to finish.**

> **What caused the difference.**

> **When the difference started.**

> **What is currently threatening the delivery.**

And a developer/team lead can drill down and understand:

> **Which work, dependency, requirement, feedback or resource change
> caused the forecast to move.**

That is the core of Project Multiverse.
