import type { Dependency, Module, Plan, Task } from '../types';

/**
 * The Thriveni reference project from DESIGN.md §6.
 * Starts Mon 5 Oct 2026; the critical path is exactly 20 working days, so baseline delivery is Fri 30 Oct 2026.
 * Numbers are illustrative (the spec's own examples are).
 */

/** Working days per module for storyboard (LXD), art, and development. Alpha follows development. */
const MODULE_DURATIONS = [
  { sb: 2, art: 3, dev: 5 }, // m1
  { sb: 2, art: 3, dev: 4 }, // m2
  { sb: 3, art: 4, dev: 5 }, // m3
  { sb: 2, art: 4, dev: 5 }, // m4
  { sb: 3, art: 4, dev: 6 }, // m5, critical
  { sb: 2, art: 3, dev: 5 }, // m6
  { sb: 3, art: 3, dev: 5 }, // m7
] as const;

export function buildThriveni(): Plan {
  const modules: Module[] = [
    ...MODULE_DURATIONS.map((_, i): Module => ({ id: `m${i + 1}`, name: `Module ${i + 1}`, kind: 'DELIVERABLE' })),
    { id: 'shared', name: 'Shared systems', kind: 'SHARED' },
    { id: 'project', name: 'Integration & delivery', kind: 'PROJECT' },
  ];

  const tasks: Task[] = [];
  const dependencies: Dependency[] = [];
  const task = (id: string, moduleId: string, teamId: string, name: string, estimate: number): void => {
    tasks.push({ id, moduleId, teamId, kind: 'TASK', name, estimate });
  };
  const milestone = (id: string, moduleId: string, teamId: string, name: string): void => {
    tasks.push({ id, moduleId, teamId, kind: 'MILESTONE', name, estimate: 0 });
  };
  const after = (predecessorId: string, successorId: string): void => {
    dependencies.push({ predecessorId, successorId, type: 'FS' });
  };

  MODULE_DURATIONS.forEach((d, i) => {
    const m = `m${i + 1}`;
    task(`${m}.sb`, m, 'lxd', `${m} storyboard`, d.sb);
    task(`${m}.art`, m, 'art', `${m} art`, d.art);
    task(`${m}.dev`, m, 'dev', `${m} development`, d.dev);
    milestone(`${m}.alpha`, m, 'pm', `${m} alpha`);
    after(`${m}.sb`, `${m}.art`);
    after(`${m}.art`, `${m}.dev`);
    after(`${m}.dev`, `${m}.alpha`);
  });

  task('shared.menu', 'shared', 'dev', 'Menu UI', 4);
  task('shared.loc', 'shared', 'dev', 'Localization', 3);
  task('shared.eval', 'shared', 'dev', 'Evaluation system', 5);
  after('shared.menu', 'shared.loc');

  task('proj.review', 'project', 'pm', 'Client review', 1);
  task('proj.chg.dev', 'project', 'dev', 'Client changes: development', 2);
  task('proj.chg.art', 'project', 'art', 'Client changes: art', 1);
  task('proj.chg.lxd', 'project', 'lxd', 'Client changes: LXD', 1);
  task('proj.integration', 'project', 'dev', 'Integration', 1);
  task('proj.qa', 'project', 'qa', 'QA', 2);
  task('proj.beta', 'project', 'qa', 'Beta build', 1);
  milestone('proj.delivery', 'project', 'pm', 'Delivery');

  MODULE_DURATIONS.forEach((_, i) => after(`m${i + 1}.alpha`, 'proj.review'));
  for (const c of ['proj.chg.dev', 'proj.chg.art', 'proj.chg.lxd']) {
    after('proj.review', c);
    after(c, 'proj.integration');
  }
  after('shared.loc', 'proj.integration');
  after('shared.eval', 'proj.integration');
  after('proj.integration', 'proj.qa');
  after('proj.qa', 'proj.beta');
  after('proj.beta', 'proj.delivery');

  const startDate = '2026-10-05';
  return {
    calendar: { startDate, weekendDays: [0, 6], holidays: [] },
    teams: [
      { id: 'pm', name: 'PM' },
      { id: 'lxd', name: 'LXD' },
      { id: 'art', name: 'Art' },
      { id: 'dev', name: 'Development' },
      { id: 'qa', name: 'QA' },
    ],
    capacity: [
      { teamId: 'pm', from: startDate, headcount: 1 },
      { teamId: 'lxd', from: startDate, headcount: 2 },
      { teamId: 'art', from: startDate, headcount: 3 },
      { teamId: 'dev', from: startDate, headcount: 4 },
      { teamId: 'qa', from: startDate, headcount: 2 },
    ],
    modules,
    tasks,
    dependencies,
    deliveryTaskId: 'proj.delivery',
  };
}
