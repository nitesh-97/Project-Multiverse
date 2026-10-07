# Project Multiverse: helpers for trying the API from PowerShell.
#
#   . .\scripts\mv.ps1          (note the leading dot: it loads the commands into your session)
#   Mv-Help                     (lists them)
#
# Needs the server running (npm start -w @multiverse/server). Works in Windows PowerShell 5.1 and PowerShell 7.

$script:MvApi     = if ($env:MV_API) { $env:MV_API } else { 'http://127.0.0.1:4000' }
$script:MvProject = if ($env:MV_PROJECT) { $env:MV_PROJECT } else { 'thriveni' }

# ---------------------------------------------------------------------------------------------- plumbing

function Mv-Print {
    # Renders a table to text in place, so it stays in order with the lines around it.
    $text = ($input | Out-String -Width 200).Trim([char]13, [char]10)
    Write-Host $text
}

function Mv-Call {
    param([string]$Method, [string]$Path, $Body = $null)
    $req = @{ Uri = "$script:MvApi$Path"; Method = $Method; ContentType = 'application/json' }
    if ($null -ne $Body) { $req.Body = ($Body | ConvertTo-Json -Depth 12) }
    try {
        return Invoke-RestMethod @req
    }
    catch {
        $text = $_.ErrorDetails.Message
        if ($text) {
            $e = $text | ConvertFrom-Json
            Write-Host "REFUSED  $($e.error): $($e.message)" -ForegroundColor Red
            if ($e.details) { foreach ($d in @($e.details)) { if ($d -is [string]) { Write-Host "         - $d" -ForegroundColor Red } elseif ($d.path) { Write-Host "         - $($d.path): $($d.message)" -ForegroundColor Red } } }
        }
        else {
            Write-Host "Could not reach the server at $script:MvApi. Is it running? (npm start -w @multiverse/server)" -ForegroundColor Red
        }
        return $null
    }
}

function Mv-Use {
    <# Switch to another project, e.g. Mv-Use draft #>
    param([Parameter(Mandatory)][string]$Project)
    $script:MvProject = $Project
    Write-Host "Using project '$Project'"
}

function Mv-Day($d) {
    if ($null -eq $d) { return '-' }
    $dt = if ($d -is [datetime]) { $d } else { [datetime]::ParseExact([string]$d, 'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture) }
    return $dt.ToString('ddd d MMM', [Globalization.CultureInfo]::InvariantCulture)
}

function Mv-Signed($n) { return ([double]$n).ToString('+0.##;-0.##;0', [Globalization.CultureInfo]::InvariantCulture) }

function Mv-Wd($n) {
    $s = Mv-Signed $n
    if ([math]::Abs([double]$n) -eq 1) { return "$s working day" } else { return "$s working days" }
}

function Mv-Count($x) { return ($x | Measure-Object).Count }

# ---------------------------------------------------------------------------------------------- looking

function Mv-Status {
    <# Where is the project: the original plan, the plan as it stands, the forecast, and the client date. #>
    $p = Mv-Call GET "/projects/$script:MvProject"
    if (-not $p) { return }
    if (-not $p.started) { Write-Host "$($p.project.name): not started (no module locked yet)"; return }
    $f = $p.forecast
    $t = Mv-Call GET "/projects/$script:MvProject/timeline"
    $events = Mv-Count (Mv-Call GET "/projects/$script:MvProject/events")
    $edits = Mv-Count (Mv-Call GET "/projects/$script:MvProject/plan-edits")
    Write-Host "$($p.project.name)  [$script:MvProject]"
    $original = if ($t) { $t.original.delivery.date } else { $f.baselineDelivery.date }
    Write-Host "  Original plan     : $(Mv-Day $original)"
    if ($f.baselineDelivery.date -ne $original) { Write-Host "  Plan as refined   : $(Mv-Day $f.baselineDelivery.date)   (planning changes moved it)" }
    Write-Host "  Current forecast  : $(Mv-Day $f.forecastDelivery.date)   ($(Mv-Wd $f.variance) against the plan)"
    if ($f.target) {
        $room = [double]$f.target.daysToSpare
        $verdict = if ($room -lt 0) { "$([math]::Abs($room)) working day$(if ([math]::Abs($room) -ne 1) { 's' }) LATE" } elseif ($room -eq 0) { 'on the day' } else { "$room working day$(if ($room -ne 1) { 's' }) to spare" }
        Write-Host "  Client date       : $(Mv-Day $f.target.date)   ($verdict)" -ForegroundColor $(if ($room -lt 0) { 'Red' } else { 'Gray' })
    }
    Write-Host "  Status date       : $(if ($f.asOf) { Mv-Day $f.asOf } else { 'none yet' })   events: $events   plan edits: $edits"
    $unlocked = @($p.modules | Where-Object { -not $_.lockedAt } | ForEach-Object { $_.id })
    if ($unlocked.Count -gt 0) { Write-Host "  Not locked yet    : $($unlocked -join ', ')" }
    $warnings = Mv-Count ((Mv-Call GET "/projects/$script:MvProject/advisories") | Where-Object { $_.severity -eq 'WARNING' })
    if ($warnings -gt 0) { Write-Host "  Warnings          : $warnings (run Mv-Advisories)" -ForegroundColor Yellow }
}

function Mv-Forecast {
    <# The critical path: the tasks that decide the delivery date. Use -All for every task. #>
    param([switch]$All)
    $f = Mv-Call GET "/projects/$script:MvProject/forecast"
    if (-not $f) { return }
    Write-Host "Forecast delivery $(Mv-Day $f.forecastDelivery.date) (original $(Mv-Day $f.baselineDelivery.date), $(Mv-Wd $f.variance)), revision $($f.revision)"
    $tasks = @($f.tasks.PSObject.Properties | ForEach-Object { $_.Value })
    if (-not $All) { $tasks = @($tasks | Where-Object { $_.critical }) ; Write-Host 'Critical path (zero float):' }
    $tasks | Sort-Object start, finish | Select-Object @{n = 'Task'; e = { $_.id } }, @{n = 'State'; e = { $_.state } },
        @{n = 'Start'; e = { Mv-Day $_.startDate } }, @{n = 'Finish'; e = { Mv-Day $_.finishDate } },
        @{n = 'Float'; e = { $_.totalFloat } } | Format-Table -AutoSize | Mv-Print
}

function Mv-Timeline {
    <# One line per module that has deviated from its original plan. -Steps shows each event that moved it. #>
    param([switch]$Steps)
    $t = Mv-Call GET "/projects/$script:MvProject/timeline"
    if (-not $t) { return }
    Write-Host "Original delivery $(Mv-Day $t.original.delivery.date)  ->  now $(Mv-Day $t.current.delivery.date) ($(Mv-Wd $t.current.variance) against the plan)"
    if ($t.current.planDelivery.date -ne $t.original.delivery.date) { Write-Host "The plan itself now says $(Mv-Day $t.current.planDelivery.date): planning changes moved it." }
    foreach ($m in @($t.markers | Where-Object { $_.kind -eq 'PLAN' })) {
        Write-Host ("  PLAN EDIT '{0}' on {1}: the plan moved {2}" -f $m.eventId, (Mv-Day $m.asOf), (Mv-Wd $m.baselineStepDays)) -ForegroundColor Cyan
    }
    if (@($t.branches).Count -eq 0) { Write-Host 'No module has deviated from the plan.'; return }
    @($t.branches) | Select-Object @{n = 'Module'; e = { if ($_.isDelivery) { "$($_.moduleId) (delivery)" } else { $_.moduleId } } },
        @{n = 'Left plan'; e = { Mv-Day $_.forkAt } }, @{n = 'Was'; e = { Mv-Day $_.baselineFinish.date } },
        @{n = 'Now'; e = { Mv-Day $_.currentFinish.date } }, @{n = 'Change'; e = { Mv-Signed $_.currentDelta } },
        @{n = 'Status'; e = { $_.status } }, @{n = 'Steps'; e = { @($_.steps).Count } } | Format-Table -AutoSize | Mv-Print
    if ($Steps) {
        foreach ($b in $t.branches) {
            Write-Host "$($b.moduleId):"
            foreach ($s in $b.steps) {
                $why = if ($s.origin -eq 'DIRECT') { 'directly' } elseif (@($s.fromModuleIds).Count -gt 0) { "via $(@($s.fromModuleIds) -join ', ')" } else { 'because the plan moved' }
                $note = if ($s.absorbed) { '  [absorbed by float]' } elseif ($s.kind -eq 'VOID') { '  [void]' } else { '' }
                Write-Host ("  {0,6} days  by {1}  ({2}){3}" -f (Mv-Signed $s.delta), $s.eventId, $why, $note)
            }
        }
    }
}

function Mv-Events {
    param([string]$Status)
    $path = "/projects/$script:MvProject/events" + $(if ($Status) { "?status=$Status" } else { '' })
    $e = Mv-Call GET $path
    if ($null -eq $e) { Write-Host 'No events.'; return }
    @($e) | Select-Object @{n = '#'; e = { $_.seq } }, id, type, phase, @{n = 'As of'; e = { Mv-Day $_.asOf } }, status, title | Format-Table -AutoSize | Mv-Print
}

function Show-Attribution($a) {
    Write-Host "Delay attribution ($($a.strategy)): total $(Mv-Wd $a.totalVariance)"
    @($a.contributions) | Select-Object @{n = 'Entry'; e = { if ($_.kind -eq 'PLAN') { "$($_.eventId) (plan edit)" } else { $_.eventId } } }, @{n = 'Days'; e = { Mv-Signed $_.days } },
        @{n = 'Effort'; e = { Mv-Signed $_.effortDays } }, category | Format-Table -AutoSize | Mv-Print
    if ($a.interaction -ne 0) { Write-Host "  plus $(Mv-Wd $a.interaction) that overlapping events share (interaction)" }
    Write-Host 'By category:'
    @($a.byCategory) | Select-Object category, @{n = 'Days'; e = { Mv-Signed $_.days } }, @{n = 'Effort'; e = { Mv-Signed $_.effortDays } },
        @{n = 'Events'; e = { @($_.eventIds) -join ', ' } } | Format-Table -AutoSize | Mv-Print
}

function Mv-Attribution {
    <# Where did the delay come from? -Strategy sequential (default), counterfactual, or both (as the retrospective shows it). #>
    param([ValidateSet('sequential', 'counterfactual', 'both')][string]$Strategy = 'sequential')
    $a = Mv-Call GET "/projects/$script:MvProject/attribution?strategy=$Strategy"
    if (-not $a) { return }
    if ($Strategy -eq 'both') { Show-Attribution $a.sequential; Write-Host ''; Show-Attribution $a.counterfactual }
    else { Show-Attribution $a }
}

function Mv-Advisories {
    <# Things worth attention: common features nobody has planned for, tasks assumed finished but never confirmed, modules under way but not locked. #>
    $a = Mv-Call GET "/projects/$script:MvProject/advisories"
    if ($null -eq $a) { Write-Host 'No advisories.'; return }
    $all = @($a)
    foreach ($x in @($all | Where-Object { $_.rule -ne 'UNCONFIRMED_COMPLETION' })) {
        $colour = if ($x.severity -eq 'WARNING') { 'Red' } else { 'Yellow' }
        Write-Host "$($x.severity)  $($x.message)`n          $($x.recommendation)" -ForegroundColor $colour
    }
    $assumed = @($all | Where-Object { $_.rule -eq 'UNCONFIRMED_COMPLETION' })
    if ($assumed.Count -gt 0) {
        Write-Host "WARNING  $($assumed.Count) task(s) the forecast assumes are finished, but nobody has recorded them:" -ForegroundColor Red
        $assumed | Select-Object @{n = 'Task'; e = { $_.taskId } }, @{n = 'Module'; e = { $_.moduleId } }, @{n = 'Forecast finish'; e = { Mv-Day $_.forecastFinish } } | Format-Table -AutoSize | Mv-Print
        Write-Host '          Confirm each with Mv-Done -Task <id> -On <the day it really finished>, or say how much is left.' -ForegroundColor Red
    }
}

function Mv-PlanEdits {
    <# Planning changes made after the project started, as recorded in history. #>
    $e = Mv-Call GET "/projects/$script:MvProject/plan-edits"
    if ($null -eq $e) { Write-Host 'No plan edits.'; return }
    @($e) | Select-Object @{n = '#'; e = { $_.seq } }, id, @{n = 'As of'; e = { Mv-Day $_.asOf } }, createdBy, title, reason | Format-Table -AutoSize | Mv-Print
}

function Mv-History {
    <# The delivery forecast at every revision, and the first time the original date was breached. #>
    $h = Mv-Call GET "/projects/$script:MvProject/history"
    if (-not $h) { return }
    @($h.drift) | Select-Object @{n = 'Rev'; e = { $_.revision } }, kind, @{n = 'Event'; e = { $_.eventId } }, @{n = 'Delivery'; e = { Mv-Day $_.forecastDelivery.date } },
        @{n = 'Variance'; e = { Mv-Signed $_.variance } }, @{n = 'Step'; e = { Mv-Signed $_.stepDays } } | Format-Table -AutoSize | Mv-Print
    if ($h.firstBreach) { Write-Host "First later than the original date: revision $($h.firstBreach.revision) (event $($h.firstBreach.eventId))" }
    else { Write-Host 'The original date has not been breached.' }
}

function Mv-Revisions {
    <# Plan revisions: a new revision is only written when history is rebuilt with a newer engine. #>
    $r = Mv-Call GET "/projects/$script:MvProject/plan-revisions"
    if (-not $r) { return }
    Write-Host "Current plan revision: $($r.current)"
    @($r.revisions) | Select-Object planRevision, snapshots, engineVersion | Format-Table -AutoSize | Mv-Print
}

# ---------------------------------------------------------------------------------------------- doing

function Show-Explanation($x) {
    $moved = if ($x.stepDays -eq 0) { 'delivery does not move' } elseif ($x.delivery.before -eq $x.delivery.after) { "the forecast date does not move, but against the plan the delay changes by $(Mv-Wd $x.stepDays)" } elseif ($x.stepDays -gt 0) { "delivery moves LATER by $([math]::Abs($x.stepDays)) working day$(if ([math]::Abs($x.stepDays) -ne 1) { 's' })" } else { "delivery moves EARLIER by $([math]::Abs($x.stepDays)) working day$(if ([math]::Abs($x.stepDays) -ne 1) { 's' })" }
    Write-Host "  Delivery   : $(Mv-Day $x.delivery.before)  ->  $(Mv-Day $x.delivery.after)   ($moved)"
    Write-Host "  Effort     : $(Mv-Signed $x.effortImpact) work-days added"
    Write-Host "  Critical   : on the critical path: $(if ($x.onCriticalPath) { 'YES' } else { 'no' })$(if ($x.absorbed) { '   | absorbed by float' })$(if ($x.criticalPath.changed) { '   | the critical path changed' })"
    foreach ($m in @($x.modules)) {
        $why = if ($m.origin -eq 'DIRECT') { 'directly' } elseif (@($m.fromModuleIds).Count -gt 0) { "via $(@($m.fromModuleIds) -join ', ')" } else { 'because the plan moved' }
        Write-Host ("    {0,-10} {1,6} days  {2}{3}" -f $m.moduleId, (Mv-Signed $m.delta), $why, $(if ($m.absorbed) { '  [absorbed]' } else { '' }))
    }
    $added = @($x.tasks | Where-Object { $_.change -eq 'ADDED' }).Count
    if ($added -gt 0) { Write-Host "    ($added task(s) added)" }
    if ($x.baselineStepDays -ne 0) { Write-Host "  Plan       : the plan itself moved $(Mv-Wd $x.baselineStepDays) (this is planning, not delay)" -ForegroundColor Cyan }
    if (@($x.linkedModuleIds).Count -gt 0) { Write-Host "  Affects    : the feature is used by $(@($x.linkedModuleIds) -join ', ')" }
}

function Mv-Send {
    <# Preview or record any event hashtable. The shortcuts below build the common ones. #>
    param([Parameter(Mandatory)]$Event, [switch]$Preview)
    if ($Preview) {
        $r = Mv-Call POST "/projects/$script:MvProject/events/preview" $Event
        if (-not $r) { return }
        Write-Host "PREVIEW (nothing recorded): $($Event.title)" -ForegroundColor Cyan
        Show-Explanation $r.explanation
    }
    else {
        $r = Mv-Call POST "/projects/$script:MvProject/events" $Event
        if (-not $r) { return }
        Write-Host "RECORDED  event #$($r.event.seq) '$($r.event.id)': $($Event.title)" -ForegroundColor Green
        Show-Explanation $r.explanation
    }
}

function New-MvEvent($Id, $Type, $Phase, $Title, $By, $On, $Effects, $AsOf) {
    $e = @{ type = $Type; title = $Title; phase = $Phase; createdBy = $By; occurredAt = $On; effects = @($Effects) }
    if ($Id) { $e.id = $Id }
    if ($AsOf) { $e.asOf = $AsOf }
    return $e
}

$script:DatePattern = '^\d{4}-\d{2}-\d{2}$'

function Mv-Delay {
    <# A task needs more (or less) effort.   Mv-Delay -Task m5.dev -Days 1 -On 2026-10-14 [-Preview] #>
    param(
        [Parameter(Mandatory)][string]$Task, [Parameter(Mandatory)][double]$Days,
        [Parameter(Mandatory)][ValidatePattern('^\d{4}-\d{2}-\d{2}$')][string]$On,
        [string]$Type = 'TASK_DELAY', [string]$Phase = 'DEVELOPMENT', [string]$Title, [string]$By = 'tester', [string]$Id, [switch]$Preview)
    if (-not $Title) { $Title = "$Task $(Mv-Signed $Days) days" }
    Mv-Send (New-MvEvent $Id $Type $Phase $Title $By $On @(@{ op = 'ADJUST_ESTIMATE'; taskId = $Task; delta = $Days }) $null) -Preview:$Preview
}

function Mv-Done {
    <# A task actually finished.   Mv-Done -Task m5.dev -On 2026-10-16 #>
    param(
        [Parameter(Mandatory)][string]$Task, [Parameter(Mandatory)][ValidatePattern('^\d{4}-\d{2}-\d{2}$')][string]$On,
        [string]$Title, [string]$By = 'tester', [string]$Id, [switch]$Preview)
    if (-not $Title) { $Title = "$Task finished" }
    Mv-Send (New-MvEvent $Id 'TASK_COMPLETION' 'DEVELOPMENT' $Title $By $On @(@{ op = 'RECORD_PROGRESS'; taskId = $Task; finishedOn = $On }) $null) -Preview:$Preview
}

function Mv-Capacity {
    <# A team's headcount changes.   Mv-Capacity -Team dev -From 2026-10-14 -Headcount 2 -On 2026-10-13 #>
    param(
        [Parameter(Mandatory)][string]$Team, [Parameter(Mandatory)][ValidatePattern('^\d{4}-\d{2}-\d{2}$')][string]$From, [Parameter(Mandatory)][double]$Headcount,
        [Parameter(Mandatory)][ValidatePattern('^\d{4}-\d{2}-\d{2}$')][string]$On,
        [string]$Title, [string]$By = 'tester', [string]$Id, [switch]$Preview)
    if (-not $Title) { $Title = "$Team headcount -> $Headcount from $From" }
    Mv-Send (New-MvEvent $Id 'RESOURCE_CHANGE' 'DEVELOPMENT' $Title $By $On @(@{ op = 'SET_CAPACITY'; teamId = $Team; from = $From; headcount = $Headcount }) $null) -Preview:$Preview
}

function Mv-Block {
    <# A task cannot start until a date.   Mv-Block -Task m1.art -Until 2026-10-12 -On 2026-10-06 #>
    param(
        [Parameter(Mandatory)][string]$Task, [Parameter(Mandatory)][ValidatePattern('^\d{4}-\d{2}-\d{2}$')][string]$Until,
        [Parameter(Mandatory)][ValidatePattern('^\d{4}-\d{2}-\d{2}$')][string]$On,
        [string]$Title, [string]$By = 'tester', [string]$Id, [switch]$Preview)
    if (-not $Title) { $Title = "$Task blocked until $Until" }
    Mv-Send (New-MvEvent $Id 'BLOCKER' 'DEVELOPMENT' $Title $By $On @(@{ op = 'BLOCK_UNTIL'; taskId = $Task; date = $Until }) $null) -Preview:$Preview
}

function Mv-AddWork {
    <# New work.   Mv-AddWork -Task qa.extra -Module project -Team qa -Days 1 -After proj.integration -Before proj.qa -On 2026-10-14 #>
    param(
        [Parameter(Mandatory)][string]$Task, [Parameter(Mandatory)][string]$Module, [Parameter(Mandatory)][string]$Team, [Parameter(Mandatory)][double]$Days,
        [string[]]$After = @(), [string[]]$Before = @(), [Parameter(Mandatory)][ValidatePattern('^\d{4}-\d{2}-\d{2}$')][string]$On,
        [string]$Type = 'SCOPE_CHANGE', [string]$Phase = 'DEVELOPMENT', [string]$Title, [string]$By = 'tester', [string]$Id, [switch]$Preview)
    if (-not $Title) { $Title = "New task $Task ($Days days)" }
    $fx = @(@{ op = 'ADD_TASK'; task = @{ id = $Task; moduleId = $Module; teamId = $Team; name = $Task; estimate = $Days }; dependsOn = @($After); blocks = @($Before) })
    Mv-Send (New-MvEvent $Id $Type $Phase $Title $By $On $fx $null) -Preview:$Preview
}

function Mv-Extinguisher {
    <#
      The spec's example, as it happened on Thriveni: ONE shared 2-day effort that every module needed, done between
      the client changes and integration. -PerModule instead adds a 2-day task to each of the 7 modules (14 effort-days),
      to see what doing it module by module would have cost.
    #>
    param(
        [Parameter(Mandatory)][ValidatePattern('^\d{4}-\d{2}-\d{2}$')][string]$On,
        [string]$Type = 'SCOPE_CHANGE', [string]$Phase = 'DEVELOPMENT', [double]$Days = 2, [string]$Id, [switch]$PerModule, [switch]$Preview)
    if ($PerModule) {
        $fx = 1..7 | ForEach-Object {
            @{ op = 'ADD_TASK'; task = @{ id = "m$_.ext"; moduleId = "m$_"; teamId = 'dev'; name = "m$_ extinguisher integration"; estimate = $Days; featureId = 'extinguisher' }
               dependsOn = @("m$_.dev"); blocks = @("m$_.alpha") }
        }
    }
    else {
        $fx = @(@{ op = 'ADD_TASK'; task = @{ id = 'proj.ext'; moduleId = 'project'; teamId = 'dev'; name = 'Extinguisher system'; estimate = $Days; featureId = 'extinguisher' }
                   dependsOn = @('proj.chg.dev'); blocks = @('proj.integration') })
    }
    $e = New-MvEvent $Id $Type $Phase 'LXD: every module needs the extinguisher interaction' 'lxd' $On $fx $null
    $e.linkedFeatureId = 'extinguisher'
    Mv-Send $e -Preview:$Preview
}

function Mv-Holiday {
    <# A public holiday the PM adds. It must be after the status date.   Mv-Holiday -Date 2026-10-28 -On 2026-10-14 #>
    param(
        [Parameter(Mandatory)][ValidatePattern('^\d{4}-\d{2}-\d{2}$')][string]$Date,
        [Parameter(Mandatory)][ValidatePattern('^\d{4}-\d{2}-\d{2}$')][string]$On,
        [string]$Title, [string]$By = 'pm', [string]$Id, [switch]$Preview)
    if (-not $Title) { $Title = "Holiday on $Date" }
    Mv-Send (New-MvEvent $Id 'RESOURCE_CHANGE' 'DEVELOPMENT' $Title $By $On @(@{ op = 'ADD_HOLIDAY'; date = $Date }) $null) -Preview:$Preview
}

function Mv-Void {
    <# Withdraw a mistaken event. It stays in the log; the forecast is rebuilt without it.   Mv-Void -Event t3 -On 2026-10-15 #>
    param([Parameter(Mandatory)][string]$Event, [Parameter(Mandatory)][ValidatePattern('^\d{4}-\d{2}-\d{2}$')][string]$On, [string]$Reason)
    $body = @{ asOf = $On }
    if ($Reason) { $body.reason = $Reason }
    $r = Mv-Call POST "/projects/$script:MvProject/events/$Event/void" $body
    if (-not $r) { return }
    Write-Host "VOIDED    '$Event'. Delivery is now $(Mv-Day $r.snapshot.forecastDelivery.date) (the void moved it by $(Mv-Wd $r.snapshot.stepDays))" -ForegroundColor Green
}

function Mv-Lock {
    <# Start a module's work: from now on changes to it are events, not plan edits.   Mv-Lock -Module m7 #>
    param([Parameter(Mandatory)][string]$Module)
    $r = Mv-Call POST "/projects/$script:MvProject/modules/$Module/lock" @{}
    if ($r) { Write-Host "LOCKED    $Module. Changes to it are now events." -ForegroundColor Green }
}

function Mv-PlanEdit {
    <#
      Refine the plan of a module that has NOT started. Recorded in history, and it moves the plan as well as the
      forecast (planning, not delay). Refused for locked modules (use an event) and for work already under way.
        Mv-PlanEdit -Task m7.dev -Days 3 -On 2026-10-06 -Reason "client added a scene"
    #>
    param(
        [Parameter(Mandatory)][string]$Task, [Parameter(Mandatory)][double]$Days,
        [Parameter(Mandatory)][ValidatePattern('^\d{4}-\d{2}-\d{2}$')][string]$On,
        [string]$Title, [string]$Reason, [string]$By = 'planner', [string]$Id, [switch]$Preview)
    if (-not $Title) { $Title = "Plan: $Task $(Mv-Signed $Days) days" }
    $body = @{ title = $Title; createdBy = $By; asOf = $On; effects = @(@{ op = 'ADJUST_ESTIMATE'; taskId = $Task; delta = $Days }) }
    if ($Id) { $body.id = $Id }
    if ($Reason) { $body.reason = $Reason }
    if ($Preview) {
        $r = Mv-Call POST "/projects/$script:MvProject/plan-edits/preview" $body
        if (-not $r) { return }
        Write-Host "PREVIEW (nothing recorded): $Title" -ForegroundColor Cyan
    }
    else {
        $r = Mv-Call POST "/projects/$script:MvProject/plan-edits" $body
        if (-not $r) { return }
        Write-Host "RECORDED  plan edit #$($r.planEdit.seq) '$($r.planEdit.id)': $Title" -ForegroundColor Green
    }
    Show-Explanation $r.explanation
}

function Mv-Help {
    @'
Looking                                         Doing (add -Preview to any to ask "what would this do?" first)
  Mv-Status                                       Mv-Delay      -Task m5.dev -Days 1 -On 2026-10-14
  Mv-Forecast [-All]                              Mv-Done       -Task m5.dev -On 2026-10-16        (confirms a task)
  Mv-Timeline [-Steps]                            Mv-Capacity   -Team dev -From 2026-10-14 -Headcount 2 -On 2026-10-13
  Mv-Events [-Status active|voided]               Mv-Holiday    -Date 2026-10-28 -On 2026-10-14
  Mv-PlanEdits                                    Mv-Block      -Task m1.art -Until 2026-10-12 -On 2026-10-06
  Mv-Attribution [-Strategy both]                 Mv-AddWork    -Task x -Module project -Team qa -Days 1 -After a -Before b -On 2026-10-14
  Mv-Advisories                                   Mv-Extinguisher -On 2026-10-14 [-PerModule]
  Mv-History                                      Mv-Void       -Event <id> -On 2026-10-15
  Mv-Revisions                                    Mv-PlanEdit   -Task m7.dev -Days 3 -On 2026-10-06 -Reason "..."   (module not started)
  Mv-Use <project>                                Mv-Lock       -Module m7
                                                  Mv-Send <hashtable>  for anything else

Events are things that happened to work that is under way. A plan edit is a change to the plan of a module that has
not started: it is recorded too, but it moves the plan, so it is not counted as delay.
'@ | Write-Host
}

Write-Host "Project Multiverse helpers loaded (server $script:MvApi, project '$script:MvProject'). Type Mv-Help." -ForegroundColor DarkGray
