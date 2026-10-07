import type {
  ControlRoomView,
  CurrentTask,
  EventLogItem,
  EventPreview,
  ForecastView,
  ModuleView,
  PlanEditLogItem,
  PlanEditPreview,
  ProjectDetail,
  ProjectTimelineView,
  ProjectInfo,
  RecordedEventView,
  RecordedPlanEditView,
  RetroView,
  SnapshotView,
} from '@multiverse/engine';
import type { ProjectService } from './service';
import type { EventRecord, ModuleRecord, PlanEditRecord, ProjectRecord } from './store';

/**
 * Compile-time proof that what the server returns still fits the contract the web app is written against
 * (packages/engine/src/contract.ts). Nothing here runs: if a field is renamed or dropped on either side, `tsc` fails.
 */
type Fits<Actual extends Expected, Expected> = Actual extends Expected ? true : never;

export type ContractChecks = [
  Fits<ProjectRecord, ProjectInfo>,
  Fits<ModuleRecord, ProjectDetail['modules'][number]>,
  Fits<ReturnType<ProjectService['projectView']>, ProjectDetail>,
  Fits<EventRecord, EventLogItem>,
  Fits<PlanEditRecord, PlanEditLogItem>,
  Fits<ReturnType<ProjectService['controlRoom']>, ControlRoomView>,
  Fits<ReturnType<ProjectService['retro']>, RetroView>,
  Fits<ReturnType<ProjectService['currentTasks']>[number], CurrentTask>,
  Fits<ReturnType<ProjectService['forecast']>, ForecastView>,
  Fits<ReturnType<ProjectService['previewEvent']>, EventPreview>,
  Fits<ReturnType<ProjectService['previewPlanEdit']>, PlanEditPreview>,
  Fits<ReturnType<ProjectService['recordEvent']>, RecordedEventView>,
  Fits<ReturnType<ProjectService['voidEvent']>, RecordedEventView>,
  Fits<ReturnType<ProjectService['recordPlanEdit']>, RecordedPlanEditView>,
  Fits<ReturnType<ProjectService['snapshot']>, SnapshotView>,
  Fits<ReturnType<ProjectService['timeline']>, ProjectTimelineView>,
  Fits<ReturnType<ProjectService['moduleTimeline']>, ModuleView>,
];
