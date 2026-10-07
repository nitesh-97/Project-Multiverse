import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Event, PhaseModel } from '@multiverse/engine';
import { App } from '../src/App';
import { adjust, event } from './fixtures';
import { fakeServer } from './fakeServer';
import type { FakeOptions, FakeServer } from './fakeServer';

// The demo history: M2 absorbed (float), M5 critical, and the extinguisher found late as one shared 2-day effort.
const demo: Event[] = [
  event('t2', '2026-10-13', [adjust('m2.dev', 3)], { title: 'M2 development +3' }),
  event('t3', '2026-10-14', [adjust('m5.dev', 1)], { title: 'M5 waiting on client assets', type: 'DEPENDENCY_DELAY' }),
  event(
    'ext',
    '2026-10-14',
    [{ op: 'ADD_TASK', task: { id: 'proj.ext', moduleId: 'project', teamId: 'dev', kind: 'TASK', name: 'Extinguisher system', estimate: 2, featureId: 'extinguisher' }, dependsOn: ['proj.chg.dev'], blocks: ['proj.integration'] }],
    { title: 'Extinguisher in every module', type: 'SCOPE_CHANGE', linkedFeatureId: 'extinguisher', couldHaveBeenEarlier: true },
  ),
];

let server: FakeServer;

function open(options: FakeOptions = {}, hash = '', today = '2026-10-14') {
  server = fakeServer(options);
  vi.stubGlobal('fetch', server.fetch);
  window.location.hash = hash;
  return render(<App today={today} />);
}

const tab = (name: string) => screen.findByRole('tab', { name });

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the timeline comes first', () => {
  it('opens on the timeline of the first project, with the headline figures', async () => {
    open({ events: demo });
    expect(await screen.findByText('Where the project is heading')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Timeline' }).getAttribute('aria-selected')).toBe('true');
    // Original, forecast, client date.
    // The original plan and the client date are both Fri 30 Oct.
    expect((await screen.findAllByText('Fri 30 Oct', { selector: '.tile .value' })).length).toBe(2);
    expect(screen.getByText('Wed 4 Nov', { selector: '.tile .value' })).toBeTruthy();
    expect(screen.getByText('3 working days late')).toBeTruthy();
    expect(screen.getByText('3 working days past the client date')).toBeTruthy();
    expect(window.location.hash).toBe('#/thriveni/timeline');
  });

  it('shows where we are right now, like the train on its route', async () => {
    open({ events: demo }, '', '2026-10-14');
    const dot = await screen.findByRole('img', { name: 'We are here: Wed 14 Oct' });
    expect(dot.querySelector('circle.here-pulse')).not.toBeNull();
    expect(within(dot as unknown as HTMLElement).getByText('We are here')).toBeTruthy(); // a word, not only a colour
  });

  it('draws a branch for each module that moved, delivery first', async () => {
    open({ events: demo });
    const chart = await screen.findByRole('group', { name: /Multiverse timeline/ });
    const lanes = within(chart as HTMLElement).getAllByText(/^(Delivery forecast|Module 2|Module 5)$/, { selector: 'text.lane-name' });
    expect(lanes.map((l) => l.textContent)).toEqual(['Delivery forecast', 'Module 2', 'Module 5']);
    expect(within(chart as HTMLElement).getAllByRole('button').length).toBeGreaterThanOrEqual(6); // 3 markers + a node on each of 3 branches... and more
  });

  it('explains a change when its node is clicked: why the date moved', async () => {
    open({ events: demo });
    const node = await screen.findByRole('button', { name: /M5 waiting on client assets: Module 5 \+1 working day/ });
    fireEvent.click(node);
    expect(await screen.findByText(/Delivery moves later, from Fri 30 Oct to Mon 2 Nov \(\+1 working day\)/)).toBeTruthy();
    expect(screen.getByText('Modules that moved')).toBeTruthy();
    expect(server.calls.some((c) => c.path === '/projects/thriveni/snapshots/2')).toBe(true);
    // Clicking again closes it.
    fireEvent.click(node);
    await waitFor(() => expect(screen.queryByText('Modules that moved')).toBeNull());
  });

  it('is reachable by keyboard: Enter on a node opens it', async () => {
    open({ events: demo });
    const node = await screen.findByRole('button', { name: /M2 development \+3: Module 2 \+3 working days/ });
    fireEvent.keyDown(node, { key: 'Enter' });
    expect(await screen.findByText('Delivery does not move: float absorbed the slip.')).toBeTruthy();
  });

  it('offers the same picture as a table', async () => {
    open({ events: demo });
    fireEvent.click(await screen.findByRole('button', { name: 'Show table' }));
    const rows = await screen.findAllByRole('row');
    expect(rows.some((r) => r.textContent?.includes('Module 5') && r.textContent.includes('+1 working day'))).toBe(true);
    expect(rows.some((r) => r.textContent?.includes('Extinguisher in every module'))).toBe(true);
  });

  it('draws a planning change that moved the plan as a solid diamond, and where the plan now ends', async () => {
    const edit = { id: 'longer-m7', title: 'M7 re-estimated', createdBy: 'planner', asOf: '2026-10-06', effects: [{ op: 'ADJUST_ESTIMATE' as const, taskId: 'm7.dev', delta: 3 }] };
    open({ planEdits: [edit], unlocked: ['m7'] });
    await screen.findByText('Nothing has slipped');
    const chart = document.querySelector('svg.chart') as SVGElement;
    const diamonds = [...chart.querySelectorAll('path')].filter((p) => p.getAttribute('d')?.includes('l 7 7 l -7 7 l -7 -7 z') && p.getAttribute('stroke-linejoin') === 'round');
    expect(diamonds).toHaveLength(1);
    expect(diamonds[0]?.getAttribute('fill')).toBe('var(--ink)'); // it moved the plan, so it is not drawn as "nothing happened"
    expect(within(chart as unknown as HTMLElement).getByText('Plan now Mon 2 Nov')).toBeTruthy();
    expect(screen.getByText(/Planning has moved the plan itself away from the original/)).toBeTruthy();
  });

  it('says so when nothing has moved', async () => {
    open();
    expect(await screen.findByText('Nothing has slipped')).toBeTruthy();
    expect(screen.getByText(/on its original plan/)).toBeTruthy();
  });
});

describe('the project view and a module’s own view', () => {
  const dots = () => document.querySelectorAll('svg.chart [data-dot]');
  const laneNames = () => [...document.querySelectorAll('svg.chart text.lane-name')].map((l) => l.textContent);

  it('has a dot for each module start and finish, and says what each is', async () => {
    open({ events: demo });
    await screen.findByRole('group', { name: /Multiverse timeline of the project/ });
    await waitFor(() => expect(dots()).toHaveLength(18));
    expect(screen.getByRole('button', { name: /Module 5 starts\. Open this module's timeline/ })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'm5 alpha, forecast Thu 22 Oct' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Delivery, forecast Wed 4 Nov' })).toBeTruthy();
  });

  it('opens a module’s own timeline from its start dot, with a dot for each task and a branch for each that moved', async () => {
    open({ events: demo });
    fireEvent.click(await screen.findByRole('button', { name: /Module 5 starts/ }));
    expect(await screen.findByText('Module 5: where it is heading')).toBeTruthy();
    expect(window.location.hash).toBe('#/thriveni/timeline/m5');
    await waitFor(() => expect(dots()).toHaveLength(4));
    expect(laneNames()).toEqual(['m5 development', 'm5 alpha']);
    expect(server.calls.some((c) => c.path === '/projects/thriveni/modules/m5/timeline')).toBe(true);
  });

  it('goes back to the project, and the address follows', async () => {
    open({ events: demo });
    fireEvent.click(await screen.findByRole('button', { name: /Module 5 starts/ }));
    await screen.findByText('Module 5: where it is heading');
    fireEvent.click(screen.getByRole('button', { name: /Back to the project/ }));
    expect(await screen.findByText('Where the project is heading')).toBeTruthy();
    expect(window.location.hash).toBe('#/thriveni/timeline');
    await waitFor(() => expect(dots()).toHaveLength(18));
  });

  it('can be opened without aiming at a dot, from a list of the modules', async () => {
    open({ events: demo });
    fireEvent.click(await screen.findByRole('button', { name: 'Module 2' }));
    expect(await screen.findByText('Module 2: where it is heading')).toBeTruthy();
    expect(laneNames()).toEqual(['m2 development', 'm2 alpha']);
  });

  it('opens straight from an address', async () => {
    open({ events: demo }, '#/thriveni/timeline/m5');
    expect(await screen.findByText('Module 5: where it is heading')).toBeTruthy();
  });

  it('explains a task’s branch, as the project view explains a module’s', async () => {
    open({ events: demo }, '#/thriveni/timeline/m5');
    fireEvent.click(await screen.findByRole('button', { name: /M5 waiting on client assets: m5 development \+1 working day/ }));
    expect(await screen.findByText(/Delivery moves later, from Fri 30 Oct to Mon 2 Nov \(\+1 working day\)/)).toBeTruthy();
    expect(server.calls.some((c) => c.path === '/projects/thriveni/snapshots/2')).toBe(true);
  });

  it('shows the module’s own figures: planned, forecast, and how many tasks are done', async () => {
    open({ events: demo }, '#/thriveni/timeline/m5');
    await screen.findByText('Module 5: where it is heading');
    expect(screen.getByText('Planned to finish')).toBeTruthy();
    expect(screen.getByText('Wed 21 Oct', { selector: '.tile .value' })).toBeTruthy();
    expect(screen.getByText('Thu 22 Oct', { selector: '.tile .value' })).toBeTruthy();
    expect(screen.getByText('2 of 4')).toBeTruthy(); // storyboard and art are done by 14 Oct
  });

  it('says so when nothing in the module has slipped', async () => {
    open({ events: demo }, '#/thriveni/timeline/m1');
    expect(await screen.findByText('Nothing in this module has slipped')).toBeTruthy();
  });

  it('says when there is no such module', async () => {
    open({ events: demo }, '#/thriveni/timeline/nope');
    expect((await screen.findByRole('alert')).textContent).toContain('Module "nope" was not found');
  });

  it('leaves the module when another tab is chosen, and the timeline tab is the project again', async () => {
    open({ events: demo }, '#/thriveni/timeline/m5');
    await screen.findByText('Module 5: where it is heading');
    fireEvent.click(await tab('Control room'));
    await screen.findByText('What is setting the pace');
    fireEvent.click(await tab('Timeline'));
    expect(await screen.findByText('Where the project is heading')).toBeTruthy();
    expect(window.location.hash).toBe('#/thriveni/timeline');
  });
});

describe('flagging a task as a project milestone', () => {
  const dotFor = (key: string) => document.querySelector(`svg.chart [data-dot="${key}"]`);

  it('adds a dot for it, lists it, and takes it off again', async () => {
    open({ events: demo });
    expect(await screen.findByText('Nothing flagged yet.')).toBeTruthy();
    fireEvent.change(await screen.findByLabelText('Task to flag as a milestone'), { target: { value: 'proj.review' } });
    fireEvent.click(screen.getByRole('button', { name: 'Flag as a milestone' }));
    await waitFor(() => expect(server.calls.some((c) => c.method === 'PUT' && c.path === '/projects/thriveni/milestone-flags/proj.review')).toBe(true));
    await waitFor(() => expect(dotFor('task:proj.review')).not.toBeNull());

    fireEvent.click(await screen.findByRole('button', { name: 'Remove the flag from Client review' }));
    await waitFor(() => expect(dotFor('task:proj.review')).toBeNull());
    expect(server.calls.some((c) => c.method === 'DELETE' && c.path === '/projects/thriveni/milestone-flags/proj.review')).toBe(true);
  });

  it('starts with what is already flagged', async () => {
    open({ events: demo, flagged: ['proj.qa'] });
    await waitFor(() => expect(dotFor('task:proj.qa')).not.toBeNull());
    expect(await screen.findByRole('button', { name: 'Remove the flag from QA' })).toBeTruthy();
  });

  it('does not offer a flag that is already on', async () => {
    open({ events: demo, flagged: ['proj.qa'] });
    const select = (await screen.findByLabelText('Task to flag as a milestone')) as HTMLSelectElement;
    expect([...select.options].some((o) => o.value === 'proj.qa')).toBe(false);
    expect([...select.options].some((o) => o.value === 'proj.review')).toBe(true);
  });
});

describe('a project with phases of its own', () => {
  const BUILDING: PhaseModel = {
    phases: [
      { id: 'BRIEF', name: 'Brief' },
      { id: 'DRAWINGS', name: 'Drawings' },
      { id: 'CONSTRUCTION', name: 'Construction' },
      { id: 'INSPECTION', name: 'Inspection' },
      { id: 'HANDOVER', name: 'Handover' },
    ],
    buildStarts: 'CONSTRUCTION',
    afterBuild: 'INSPECTION',
  };

  it('asks where the project was using its own phases, starting where building starts', async () => {
    open({ phases: BUILDING });
    fireEvent.click(await tab('Record a change'));
    await screen.findByText('What happened?');
    fireEvent.click(screen.getByRole('button', { name: /A task takes longer or shorter/ }));
    const select = (await screen.findByLabelText('Where was the project when this came up?')) as HTMLSelectElement;
    expect([...select.options].map((o) => o.text)).toEqual(['Brief', 'Drawings', 'Construction', 'Inspection', 'Handover']);
    expect(select.value).toBe('CONSTRUCTION');
  });

  it('records the phase chosen, and shows it by name in the history', async () => {
    open({ phases: BUILDING });
    fireEvent.click(await tab('Record a change'));
    await screen.findByText('What happened?');
    fireEvent.click(screen.getByRole('button', { name: /A task takes longer or shorter/ }));
    fireEvent.change(await screen.findByLabelText(/Which task/), { target: { value: 'm3.dev' } });
    fireEvent.change(screen.getByLabelText(/Change in effort/), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('Where was the project when this came up?'), { target: { value: 'INSPECTION' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview the effect' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Record this event' }));
    await screen.findByText(/Recorded: m3 development takes 1 working day longer/);
    expect(server.calls.find((c) => c.method === 'POST' && c.path === '/projects/thriveni/events')?.body).toMatchObject({ phase: 'INSPECTION' });
    expect(await screen.findByText('Inspection', { selector: '.log-meta .tag' })).toBeTruthy();
  });

  it('shows feedback in the retrospective by those phases', async () => {
    const feedback = [
      event('f1', '2026-10-13', [], { type: 'FEEDBACK', phase: 'DRAWINGS', title: 'Early note' }),
      event('f2', '2026-10-14', [], { type: 'CLIENT_FEEDBACK', phase: 'INSPECTION', title: 'Inspector' }),
    ];
    open({ phases: BUILDING, events: feedback }, '#/thriveni/retro');
    expect(await screen.findByText(/of the feedback \(1 of 2\) arrived after development had finished/)).toBeTruthy();
    // Feedback before building finished is drawn quiet; from the project's own "after building" phase on, it is not.
    const bar = (label: string) => screen.getByText(label).closest('.bar-row')?.querySelector('.bar');
    expect(bar('Drawings')?.classList.contains('muted-bar')).toBe(true);
    expect(bar('Inspection')?.classList.contains('muted-bar')).toBe(false);
  });
});

describe('the control room', () => {
  it('shows the forecast against both the plan and the client date', async () => {
    open({ events: demo }, '#/thriveni/control-room');
    expect(await screen.findByText('Wed 4 Nov 2026')).toBeTruthy();
    expect(screen.getAllByText('3 working days late').length).toBeGreaterThan(0);
    expect(screen.getAllByText('3 working days past the client date').length).toBeGreaterThan(0);
    expect(screen.getAllByText('+3 d').length).toBeGreaterThan(0);
    expect(screen.getAllByText('3 d late').length).toBeGreaterThan(0);
  });

  it('names what is setting the pace, the chain, and the next likely bottleneck', async () => {
    open({ events: demo }, '#/thriveni/control-room');
    expect(await screen.findByText('What is setting the pace')).toBeTruthy();
    const chain = screen.getByRole('list', { name: 'Critical chain' });
    const steps = within(chain).getAllByRole('listitem').map((li) => li.textContent);
    expect(steps[0]).toBe('m5 development');
    expect(steps).toContain('Extinguisher system');
    expect(steps[steps.length - 1]).toBe('Delivery');
    expect(screen.getByText('Likely next bottleneck')).toBeTruthy();
  });

  it('says how much of the progress is only assumed', async () => {
    open({ events: demo }, '#/thriveni/control-room');
    expect(await screen.findByText(/0% confirmed by someone/)).toBeTruthy();
  });

  it('lists what needs confirming, grouped', async () => {
    const withAdvisories = fakeServer({ events: demo });
    vi.stubGlobal('fetch', withAdvisories.fetch);
    server = withAdvisories;
    window.location.hash = '#/thriveni/control-room';
    render(<App today="2026-10-14" />);
    expect(await screen.findByText('Needs attention')).toBeTruthy();
    expect(screen.getByText('Nothing to confirm')).toBeTruthy(); // the fake sends none: the real server's are tested there
  });

  it('shares the delay out by cause, and shows how the forecast moved', async () => {
    open({ events: demo }, '#/thriveni/control-room');
    expect(await screen.findByText('Where the delay came from')).toBeTruthy();
    expect(screen.getByText('Late scope discovery')).toBeTruthy();
    expect(screen.getByText('Dependency delays')).toBeTruthy();
    expect(screen.getByRole('img', { name: /Forecast delivery against the plan over 4 forecasts/ })).toBeTruthy();
    expect(screen.getByText(/First later than the plan after “M2 development \+3”|First later than the plan after “M5 waiting on client assets”/)).toBeTruthy();
  });

  it('has a row for every module with its progress', async () => {
    open({ events: demo }, '#/thriveni/control-room');
    await screen.findByText('Modules', { selector: 'h2' });
    const rows = screen.getAllByRole('row').map((r) => r.textContent ?? '');
    expect(rows.filter((r) => /^Module [1-7]/.test(r)).length).toBe(7);
    expect(rows.some((r) => r.startsWith('Shared systems'))).toBe(true);
  });
});

describe('the retrospective', () => {
  it('shows both ways of sharing the delay, and what was learned', async () => {
    open({ events: demo }, '#/thriveni/retro');
    expect(await screen.findByText('Planned against actual')).toBeTruthy();
    expect(screen.getByText('In the order it happened')).toBeTruthy();
    expect(screen.getByText('Each change on its own')).toBeTruthy();
    expect(screen.getByText('1 requirement discovered after development had started')).toBeTruthy();
    expect(screen.getByText('1 common feature (Extinguisher) identified only after development had started')).toBeTruthy();
    expect(screen.getByText('The project is still under way: these figures are the current forecast, and will change.')).toBeTruthy();
  });

  it('counts feedback by when it arrived', async () => {
    const feedback: Event[] = [
      event('f1', '2026-10-13', [], { type: 'CLIENT_FEEDBACK', phase: 'ALPHA', title: 'Alpha review', sourceTeamId: 'lxd' }),
      event('f2', '2026-10-14', [], { type: 'FEEDBACK', phase: 'DEVELOPMENT', title: 'Early note', sourceTeamId: 'art' }),
    ];
    open({ events: feedback }, '#/thriveni/retro');
    expect(await screen.findByText(/of the feedback \(1 of 2\) arrived after development had finished/)).toBeTruthy();
    expect(screen.getByText('50%', { selector: 'strong' })).toBeTruthy();
  });

  it('says there is nothing to learn yet when nothing has happened', async () => {
    open({}, '#/thriveni/retro');
    expect(await screen.findByText('Nothing to report yet')).toBeTruthy();
    expect(screen.getByText('No feedback recorded')).toBeTruthy();
  });
});

describe('recording a change', () => {
  const goToRecord = async () => {
    fireEvent.click(await tab('Record a change'));
    return screen.findByText('What happened?');
  };

  it('offers the standard things as buttons with an example of each', async () => {
    open({ events: demo });
    await goToRecord();
    expect(screen.getByRole('button', { name: /A task takes longer or shorter/ })).toBeTruthy();
    expect(screen.getByText('e.g. The report draft needs 1 more day')).toBeTruthy();
    expect(screen.getByText('e.g. Wednesday 28 Oct is a holiday')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Feedback arrives/ })).toBeTruthy();
  });

  it('previews what it would do, then records it, then shows it in the history and on the timeline', async () => {
    open({ events: demo });
    await goToRecord();
    fireEvent.click(screen.getByRole('button', { name: /A task takes longer or shorter/ }));
    fireEvent.change(await screen.findByLabelText(/Which task/), { target: { value: 'm3.dev' } });
    fireEvent.change(screen.getByLabelText(/Change in effort/), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview the effect' }));

    // The preview is not a recording.
    expect(await screen.findByText(/If you record this/)).toBeTruthy();
    expect(server.calls.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual(['/projects/thriveni/events/preview']);
    expect(server.state().snapshots.length).toBe(4);

    fireEvent.click(screen.getByRole('button', { name: 'Record this event' }));
    expect(await screen.findByText(/Recorded: m3 development takes 3 working days longer/)).toBeTruthy();

    const posted = server.calls.find((c) => c.method === 'POST' && c.path === '/projects/thriveni/events');
    expect(posted?.body).toMatchObject({
      type: 'TASK_DELAY',
      taskId: 'm3.dev',
      moduleId: 'm3',
      createdBy: 'PM',
      occurredAt: '2026-10-14',
      asOf: '2026-10-14',
      effects: [{ op: 'ADJUST_ESTIMATE', taskId: 'm3.dev', delta: 3 }],
    });
    expect(server.state().snapshots.length).toBe(5);
    await waitFor(() => expect(screen.getAllByText('m3 development takes 3 working days longer').length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole('button', { name: 'See it on the timeline' }));
    expect(await screen.findByText('Where the project is heading')).toBeTruthy();
    await waitFor(() => expect(screen.getAllByText('Module 3').length).toBeGreaterThan(0));
  });

  it('asks again rather than guessing when the form is not filled in, and sends nothing', async () => {
    open({ events: demo });
    await goToRecord();
    fireEvent.click(screen.getByRole('button', { name: /A task takes longer or shorter/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Preview the effect' }));
    expect(await screen.findByText('Pick the task.')).toBeTruthy();
    expect(server.calls.filter((c) => c.method === 'POST')).toEqual([]);
  });

  it('shows what the server said when it refuses', async () => {
    open({ events: demo });
    await goToRecord();
    fireEvent.click(screen.getByRole('button', { name: /A public holiday/ }));
    fireEvent.change(await screen.findByLabelText(/Day off/), { target: { value: '2026-10-28' } });
    server.failing.add('/events/preview');
    fireEvent.click(screen.getByRole('button', { name: 'Preview the effect' }));
    expect((await screen.findByRole('alert')).textContent).toContain('The server fell over.');
    expect(screen.queryByRole('button', { name: 'Record this event' })).toBeNull();
  });

  it('records a planning change for a module that has not started, as planning and not delay', async () => {
    // On 6 Oct M7 has not begun its development, so the plan for it can still be changed.
    open({ unlocked: ['m7'] }, '', '2026-10-06');
    await goToRecord();
    fireEvent.click(screen.getByRole('button', { name: /Re-estimate work that has not started/ }));
    fireEvent.change(await screen.findByLabelText(/Which task/), { target: { value: 'm7.dev' } });
    fireEvent.change(screen.getByLabelText(/Change in effort/), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview the effect' }));
    expect(await screen.findByText('The plan itself moves +1 working day. This is planning, not delay.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Record this planning change' }));
    expect(await screen.findByText(/Recorded: m7 development re-estimated by \+3 working days/)).toBeTruthy();
    expect(server.calls.some((c) => c.path === '/projects/thriveni/plan-edits' && c.method === 'POST')).toBe(true);
    expect(server.state().snapshots[server.state().snapshots.length - 1]?.variance).toBe(0);
  });

  it('will not offer a planning change when every module has started', async () => {
    open({ events: demo });
    await goToRecord();
    const button = screen.getByRole('button', { name: /Re-estimate work that has not started/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(within(button).getByText(/nothing left to plan/)).toBeTruthy();
  });

  it('records new work, linked to the shared feature', async () => {
    open({ events: [] });
    await goToRecord();
    fireEvent.click(screen.getByRole('button', { name: /New work turns up/ }));
    fireEvent.change(await screen.findByLabelText(/What is the work/), { target: { value: 'Extinguisher system' } });
    fireEvent.change(screen.getByLabelText(/Which team does it/), { target: { value: 'dev' } });
    fireEvent.click(screen.getByLabelText('Client changes: development'));
    fireEvent.change(screen.getByLabelText(/It must finish before/), { target: { value: 'proj.integration' } });
    fireEvent.change(screen.getByLabelText(/Is it a feature several modules need/), { target: { value: 'extinguisher' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview the effect' }));
    expect(await screen.findByText(/Delivery moves later/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Record this event' }));
    await screen.findByText(/Recorded: New work: Extinguisher system/);
    const posted = server.calls.find((c) => c.method === 'POST' && c.path.endsWith('/events'));
    expect(posted?.body).toMatchObject({
      type: 'SCOPE_CHANGE',
      linkedFeatureId: 'extinguisher',
      effects: [{ op: 'ADD_TASK', task: { id: 'new.extinguisher-system', featureId: 'extinguisher', estimate: 2 }, dependsOn: ['proj.chg.dev'], blocks: ['proj.integration'] }],
    });
  });

  it('withdraws a mistaken event, keeping it in the history', async () => {
    open({ events: demo });
    await goToRecord();
    fireEvent.click(await screen.findByRole('button', { name: 'Withdraw M5 waiting on client assets' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Withdraw as/ }));
    await waitFor(() => expect(server.calls.some((c) => c.path.endsWith('/events/t3/void'))).toBe(true));
    expect(await screen.findByText('withdrawn')).toBeTruthy();
    expect(screen.getByText('M5 waiting on client assets')).toBeTruthy(); // still there, struck through
    expect(server.state().snapshots.length).toBe(5);
  });

  it.each([
    ['today is before the last status date', '2026-10-07', '2026-10-14'],
    ['today is after the last status date', '2026-10-20', '2026-10-20'],
  ])('starts a form on the later of today and the last status date: %s', async (_why, today, expected) => {
    open({ events: demo }, '', today);
    await goToRecord();
    fireEvent.click(screen.getByRole('button', { name: /A public holiday/ }));
    expect(((await screen.findByLabelText('When did this happen?')) as HTMLInputElement).value).toBe(expected);
  });

  it('remembers who is recording', async () => {
    open({ events: demo });
    await goToRecord();
    fireEvent.change(screen.getByLabelText('Your name, for the record'), { target: { value: 'Asha' } });
    expect(window.localStorage.getItem('mv.name')).toBe('Asha');
    fireEvent.click(screen.getByRole('button', { name: /A public holiday/ }));
    expect(((await screen.findByLabelText('Recorded by')) as HTMLInputElement).value).toBe('Asha');
  });
});

describe('a project that has not started', () => {
  it('sends you to start a module, and starts the project when you do', async () => {
    open({ notStarted: true });
    expect(await screen.findByText('This project has not started yet')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Go to Record a change' }));
    expect(await screen.findByText(/The project has not started/)).toBeTruthy();
    expect(screen.queryByText('What happened?')).toBeNull();
    expect(server.calls.some((c) => c.path.includes('/current-tasks'))).toBe(false); // nothing to read yet

    fireEvent.click(screen.getByRole('button', { name: 'Start Module 1' }));
    expect(await screen.findByText('What happened?')).toBeTruthy();
    expect(screen.getByText(/1 of 9 started/)).toBeTruthy();
  });
});

describe('when things go wrong', () => {
  it('says the server cannot be reached, and tries again on request', async () => {
    server = fakeServer({ events: demo });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    window.location.hash = '';
    render(<App today="2026-10-14" />);
    expect(await screen.findByText('Could not reach the Multiverse server. Is it running?')).toBeTruthy();

    vi.stubGlobal('fetch', server.fetch);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Where the project is heading')).toBeTruthy();
  });

  it('shows an error for the one view that failed, and the rest still works', async () => {
    open({ events: demo }, '#/thriveni/control-room');
    await screen.findByText('What is setting the pace');
    cleanup();
    server = fakeServer({ events: demo });
    server.failing.add('/control-room');
    vi.stubGlobal('fetch', server.fetch);
    render(<App today="2026-10-14" />);
    expect((await screen.findByRole('alert')).textContent).toContain('The server fell over.');
    fireEvent.click(await tab('Retrospective'));
    expect(await screen.findByText('Planned against actual')).toBeTruthy();
  });

  it('says so when there are no projects', async () => {
    server = fakeServer();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })));
    window.location.hash = '';
    render(<App today="2026-10-14" />);
    expect(await screen.findByText('There are no projects yet')).toBeTruthy();
  });
});

describe('the shell', () => {
  it('opens the view in the address', async () => {
    open({ events: demo }, '#/thriveni/retro');
    expect(await screen.findByText('Planned against actual')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Retrospective' }).getAttribute('aria-selected')).toBe('true');
  });

  it('falls back to the timeline for a tab it does not know', async () => {
    open({ events: demo }, '#/thriveni/nonsense');
    expect(await screen.findByText('Where the project is heading')).toBeTruthy();
  });

  it('switches tabs and keeps the address in step', async () => {
    open({ events: demo });
    fireEvent.click(await tab('Control room'));
    expect(await screen.findByText('What is setting the pace')).toBeTruthy();
    expect(window.location.hash).toBe('#/thriveni/control-room');
  });

  it('applies and remembers the theme', async () => {
    open({ events: demo });
    fireEvent.change(await screen.findByLabelText('Theme'), { target: { value: 'dark' } });
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(window.localStorage.getItem('mv.theme')).toBe('dark');
    fireEvent.change(screen.getByLabelText('Theme'), { target: { value: 'auto' } });
    expect(document.documentElement.getAttribute('data-theme')).toBeNull();
  });

  it('keeps the old picture on screen, dimmed, while it refreshes', async () => {
    open({ events: demo });
    await screen.findByText('Where the project is heading');
    fireEvent.click(await tab('Record a change'));
    await screen.findByText('What happened?');
    fireEvent.click(screen.getByRole('button', { name: /A public holiday/ }));
    fireEvent.change(await screen.findByLabelText(/Day off/), { target: { value: '2026-10-28' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview the effect' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Record this event' }));
    await screen.findByText(/Recorded: Holiday on Wed 28 Oct/);
    // The history refreshed with the new event, and nothing went blank on the way.
    expect(screen.queryByText('Loading')).toBeNull();
    expect((await screen.findAllByText('Holiday on Wed 28 Oct')).length).toBeGreaterThan(0);
  });
});
