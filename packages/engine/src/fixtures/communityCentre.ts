import type { Dependency, Module, PhaseModel, Plan, Task } from '../types';

/**
 * A second sample project, and not a VR training: a small community centre, built on site. It exists to show the tool is
 * for every kind of project: its modules are parts of a building, and its phases (brief, design, construction,
 * inspection, handover) are its own.
 *
 * Starts Mon 5 Oct 2026. The critical path is 33 working days, so the baseline handover is Wed 18 Nov 2026:
 *
 *   survey 3, excavation 4, concrete 3 (foundations signed off at 10), steel frame 6, roof 4, inspection 1
 *   (structure signed off at 21), plaster 4, floor and paint 3 (fit-out complete at 28), final inspection 2,
 *   snagging 3 (handover at 33). The electrics and plumbing run beside the roof and are done by 21.
 */
export const COMMUNITY_CENTRE_PHASES: PhaseModel = {
  phases: [
    { id: 'BRIEF', name: 'Brief' },
    { id: 'DESIGN', name: 'Design' },
    { id: 'CONSTRUCTION', name: 'Construction' },
    { id: 'INSPECTION', name: 'Inspection' },
    { id: 'HANDOVER', name: 'Handover' },
    { id: 'AFTER_HANDOVER', name: 'After handover' },
  ],
  buildStarts: 'CONSTRUCTION',
  afterBuild: 'INSPECTION',
};

export function buildCommunityCentre(): Plan {
  const modules: Module[] = [
    { id: 'foundations', name: 'Foundations', kind: 'DELIVERABLE' },
    { id: 'structure', name: 'Structure', kind: 'DELIVERABLE' },
    { id: 'fitout', name: 'Fit-out', kind: 'DELIVERABLE' },
    { id: 'services', name: 'Services', kind: 'SHARED' },
    { id: 'handover', name: 'Inspection and handover', kind: 'PROJECT' },
  ];

  const tasks: Task[] = [];
  const dependencies: Dependency[] = [];
  const task = (id: string, moduleId: string, teamId: string, name: string, estimate: number): void => {
    tasks.push({ id, moduleId, teamId, kind: 'TASK', name, estimate });
  };
  const milestone = (id: string, moduleId: string, teamId: string, name: string): void => {
    tasks.push({ id, moduleId, teamId, kind: 'MILESTONE', name, estimate: 0 });
  };
  const after = (predecessorId: string, ...successorIds: string[]): void => {
    for (const successorId of successorIds) dependencies.push({ predecessorId, successorId, type: 'FS' });
  };

  task('f.survey', 'foundations', 'design', 'Site survey', 3);
  task('f.excavation', 'foundations', 'civil', 'Excavation', 4);
  task('f.concrete', 'foundations', 'civil', 'Pour concrete', 3);
  milestone('f.signoff', 'foundations', 'pm', 'Foundations signed off');
  after('f.survey', 'f.excavation');
  after('f.excavation', 'f.concrete');
  after('f.concrete', 'f.signoff');

  task('s.frame', 'structure', 'build', 'Steel frame', 6);
  task('s.roof', 'structure', 'build', 'Roof', 4);
  task('s.inspect', 'structure', 'inspect', 'Structure inspection', 1);
  milestone('s.signoff', 'structure', 'pm', 'Structure signed off');
  after('f.signoff', 's.frame');
  after('s.frame', 's.roof');
  after('s.roof', 's.inspect');
  after('s.inspect', 's.signoff');

  task('v.electrical', 'services', 'trades', 'Electrical first fix', 5);
  task('v.plumbing', 'services', 'trades', 'Plumbing first fix', 4);
  after('s.frame', 'v.electrical', 'v.plumbing');

  task('o.plaster', 'fitout', 'trades', 'Plastering', 4);
  task('o.floor', 'fitout', 'trades', 'Flooring', 3);
  task('o.paint', 'fitout', 'trades', 'Painting', 3);
  milestone('o.done', 'fitout', 'pm', 'Fit-out complete');
  after('s.signoff', 'o.plaster');
  after('v.electrical', 'o.plaster');
  after('v.plumbing', 'o.plaster');
  after('o.plaster', 'o.floor', 'o.paint');
  after('o.floor', 'o.done');
  after('o.paint', 'o.done');

  task('h.inspection', 'handover', 'inspect', 'Final inspection', 2);
  task('h.snagging', 'handover', 'build', 'Snagging', 3);
  milestone('h.handover', 'handover', 'pm', 'Handover');
  after('o.done', 'h.inspection');
  after('h.inspection', 'h.snagging');
  after('h.snagging', 'h.handover');

  const startDate = '2026-10-05';
  return {
    calendar: { startDate, weekendDays: [0, 6], holidays: [] },
    teams: [
      { id: 'pm', name: 'Project management' },
      { id: 'design', name: 'Design' },
      { id: 'civil', name: 'Groundworks' },
      { id: 'build', name: 'Builders' },
      { id: 'trades', name: 'Trades' },
      { id: 'inspect', name: 'Inspector' },
    ],
    capacity: [],
    modules,
    tasks,
    dependencies,
    deliveryTaskId: 'h.handover',
    phases: COMMUNITY_CENTRE_PHASES,
  };
}
