// How a task gets its dates: following its links, from a start someone set, or from
// a pair of dates. Also how those choices are saved, changed, exported and displayed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { computeSchedule } from '../public/shared/scheduler.js';
import { HttpError, StoreCore } from '../public/shared/store-core.js';
import { describeDep, describeLinkBuffer, parseLag } from '../public/js/util.js';

// By the standard definition. test/firm-links.test.js covers firm leads.
const STANDARD = { firmLeads: false };
const TODAY = '2026-01-05';
const TYPES = ['FS', 'SS', 'FF', 'SF'];
const task = (id, fields = {}) => ({
  id, name: id, parentId: null, start: '2026-06-01', duration: 3, milestone: false, manual: false,
  status: 'not_started', progress: 0, deps: [], ...fields,
});
const dep = (taskId, type = 'FS', lag = 0) => ({ taskId, type, lag });
const project = (id, tasks, calendar = {}) => ({ id, name: id, calendar, tasks });
const run = (...projects) => computeSchedule(projects, TODAY, STANDARD);

// Predecessor Wed 14 to Tue 20 Jan 2026. Successor 3 working days. Each is [lag, start, finish].
const LINK_DATES = {
  FS: [[-5, '2026-01-14', '2026-01-16'], [-2, '2026-01-19', '2026-01-21'], [0, '2026-01-21', '2026-01-23'], [3, '2026-01-26', '2026-01-28']],
  SS: [[-5, '2026-01-07', '2026-01-09'], [-2, '2026-01-12', '2026-01-14'], [0, '2026-01-14', '2026-01-16'], [3, '2026-01-19', '2026-01-21']],
  FF: [[-5, '2026-01-09', '2026-01-13'], [-2, '2026-01-14', '2026-01-16'], [0, '2026-01-16', '2026-01-20'], [3, '2026-01-21', '2026-01-23']],
  SF: [[-5, '2026-01-02', '2026-01-06'], [-2, '2026-01-07', '2026-01-09'], [0, '2026-01-09', '2026-01-13'], [3, '2026-01-14', '2026-01-16']],
};
const PRED = { start: '2026-01-14', duration: 5 };

// ---- following links --------------------------------------------------------------

for (const type of TYPES) {
  test(`${type}: a task with no set start goes exactly where its link puts it, earlier or later`, () => {
    for (const [lag, start, end] of LINK_DATES[type]) {
      for (const stored of ['2025-06-02', '2026-06-01']) {
        const { tasks } = run(project('p', [
          task('a', PRED),
          task('b', { start: stored, startSet: false, deps: [dep('a', type, lag)] }),
        ]));
        const b = tasks.get('b');
        assert.deepEqual([b.start, b.end], [start, end], `${type} ${lag} from ${stored}`);
        assert.equal(b.driverId, 'a');
        assert.equal(b.delay, 0);
        assert.equal(b.followsLinks, true);
        assert.equal(b.linkStart, start);
      }
    }
  });
}

test('with no links, a task with no set start stays on its stored start', () => {
  const { tasks } = run(project('p', [task('a', { start: '2026-01-14', startSet: false })]));
  assert.equal(tasks.get('a').start, '2026-01-14');
  assert.equal(tasks.get('a').followsLinks, false);
  assert.equal(tasks.get('a').linkStart, null);
});

test('with several links, the latest requirement decides', () => {
  const { tasks } = run(project('p', [
    task('a', { start: '2026-01-05', duration: 5 }),
    task('z', { start: '2026-01-19', duration: 5 }),
    task('b', { startSet: false, duration: 1, deps: [dep('a', 'FS', -2), dep('z', 'SS', -1)] }),
  ]));
  assert.equal(tasks.get('b').start, '2026-01-16');
  assert.equal(tasks.get('b').driverId, 'z');
});

test('a chain of tasks following links moves together, and back', () => {
  const chain = (start) => run(project('p', [
    task('a', { start, duration: 5 }),
    task('b', { startSet: false, deps: [dep('a', 'FS', -1)] }),
    task('c', { startSet: false, deps: [dep('b', 'SF', 0)] }),
  ])).tasks;
  assert.equal(chain('2026-01-05').get('b').start, '2026-01-09');
  const moved = chain('2026-01-12');
  assert.equal(moved.get('b').start, '2026-01-16');
  assert.equal(moved.get('c').end, '2026-01-15');
  assert.equal(chain('2026-01-05').get('c').end, '2026-01-08');
});

test('a subtask with no set start follows a link held by its summary', () => {
  const { tasks } = run(project('p', [
    task('a', PRED),
    task('s', { deps: [dep('a', 'SS', -2)] }),
    task('c', { parentId: 's', startSet: false }),
  ]));
  assert.equal(tasks.get('c').start, '2026-01-12');
  assert.equal(tasks.get('s').start, '2026-01-12');
});

test('a milestone with no set start follows its link', () => {
  const { tasks } = run(project('p', [
    task('a', PRED),
    task('m', { milestone: true, duration: 0, startSet: false, deps: [dep('a', 'FS', -2)] }),
  ]));
  assert.equal(tasks.get('m').start, '2026-01-16');
});

// ---- a start someone set ------------------------------------------------------------

test('what links allow is the latest of them, on a task that holds its own date', () => {
  const { tasks } = run(project('p', [
    task('a', { start: '2026-01-05', duration: 2 }),
    task('z', { start: '2026-01-19', duration: 2 }),
    task('y', { start: '2026-01-05', duration: 2 }),
    task('b', { start: '2026-03-02', deps: [dep('a'), dep('z'), dep('y')] }),
  ]));
  assert.equal(tasks.get('b').linkStart, '2026-01-21');
});

test('a set start holds a task later than its links need, and reports what they allow', () => {
  for (const startSet of [true, undefined]) { // missing is how older data arrives
    for (const type of TYPES) {
      const [, allowed] = LINK_DATES[type][1];
      const { tasks } = run(project('p', [
        task('a', PRED),
        task('b', { start: '2026-03-02', startSet, deps: [dep('a', type, -2)] }),
      ]));
      assert.equal(tasks.get('b').start, '2026-03-02', type);
      assert.equal(tasks.get('b').linkStart, allowed, type);
      assert.equal(tasks.get('b').followsLinks, false, type);
    }
  }
});

test('a link can still push a set start later, and it returns when the link moves back', () => {
  const schedule = (start) => run(project('p', [
    task('a', { start, duration: 5 }),
    task('b', { start: '2026-01-14', startSet: true, deps: [dep('a')] }),
  ])).tasks.get('b');
  assert.equal(schedule('2026-01-12').start, '2026-01-19');
  assert.equal(schedule('2026-01-12').delay, 3);
  assert.equal(schedule('2026-01-05').start, '2026-01-14');
});

// ---- tracked by dates ---------------------------------------------------------------

const byDates = (id, start, finish, fields = {}) => task(id, { trackBy: 'dates', start, finish, ...fields });

test('tracked by dates: the dates hold and the duration is the working days between them', () => {
  const cases = [
    ['2026-01-05', '2026-01-09', 5],
    ['2026-01-05', '2026-01-05', 1],
    ['2026-01-08', '2026-01-13', 4], // over a weekend
    ['2026-01-05', '2026-01-30', 20],
  ];
  for (const [start, finish, duration] of cases) {
    const { tasks } = run(project('p', [byDates('a', start, finish, { duration: 99 })]));
    assert.deepEqual([tasks.get('a').start, tasks.get('a').end, tasks.get('a').duration], [start, finish, duration]);
  }
});

test('a milestone marked as tracked by dates is still a milestone', () => {
  const { tasks } = run(project('p', [
    byDates('m', '2026-01-05', '2026-01-09', { milestone: true, duration: 0 }),
    task('a', { start: '2026-01-05', duration: 9 }),
  ]));
  assert.equal(tasks.get('m').end, '2026-01-05');
  assert.equal(tasks.get('m').duration, 0);
});

test('tracked by dates: holidays reduce the duration and dates on days off snap inward', () => {
  const calendar = { holidays: ['2026-01-07'] };
  assert.equal(run(project('p', [byDates('a', '2026-01-05', '2026-01-09')], calendar)).tasks.get('a').duration, 4);
  // Sat 10 to Sun 18 Jan: Mon 12 to Fri 16.
  const a = run(project('p', [byDates('a', '2026-01-10', '2026-01-18')])).tasks.get('a');
  assert.deepEqual([a.start, a.end, a.duration], ['2026-01-12', '2026-01-16', 5]);
  // A weekend alone: the next working day, one day long.
  const b = run(project('p', [byDates('a', '2026-01-10', '2026-01-11')])).tasks.get('a');
  assert.deepEqual([b.start, b.end, b.duration], ['2026-01-12', '2026-01-12', 1]);
});

test('tracked by dates: links never move it, and a link it breaks is a conflict', () => {
  for (const type of TYPES) {
    for (const [lag, required] of LINK_DATES[type]) {
      for (const [start, finish] of [['2026-01-05', '2026-01-07'], ['2026-03-02', '2026-03-04']]) {
        const { tasks } = run(project('p', [task('a', PRED), byDates('b', start, finish, { deps: [dep('a', type, lag)] })]));
        const b = tasks.get('b');
        assert.deepEqual([b.start, b.end], [start, finish], `${type} ${lag}`);
        assert.deepEqual(b.conflicts, required > start ? ['a'] : [], `${type} ${lag} at ${start}`);
      }
    }
  }
});

test('tracked by dates: its span, not a stale duration, decides FF and SF conflicts', () => {
  // Five days, Mon 12 to Fri 16 Jan, with an old duration of 1. An FF on a predecessor
  // finishing Fri 16 is met exactly, whatever the stored duration says.
  const { tasks } = run(project('p', [
    task('a', { start: '2026-01-12', duration: 5 }),
    byDates('b', '2026-01-12', '2026-01-16', { duration: 1, deps: [dep('a', 'FF')] }),
  ]));
  assert.deepEqual(tasks.get('b').conflicts, []);
});

test('tracked by dates: as a predecessor, its dates drive what follows', () => {
  const { tasks } = run(project('p', [
    byDates('a', '2026-01-14', '2026-01-20'),
    task('fs', { startSet: false, deps: [dep('a', 'FS', -2)] }),
    task('ff', { startSet: false, deps: [dep('a', 'FF', 1)] }),
  ]));
  assert.equal(tasks.get('fs').start, '2026-01-19');
  assert.equal(tasks.get('ff').end, '2026-01-21');
});

test('tracked by dates: float is measured from the dates', () => {
  const { tasks } = run(project('p', [
    byDates('a', '2026-01-05', '2026-01-07'),
    byDates('z', '2026-01-05', '2026-01-16'),
  ]));
  assert.equal(tasks.get('a').float, 7);
  assert.equal(tasks.get('z').float, 0);
});

// ---- saving -------------------------------------------------------------------------

function setup() {
  const store = new StoreCore();
  const projectId = store.createProject({ name: 'P' });
  const a = store.createTask(projectId, { name: 'A', start: '2026-01-14', duration: 5 });
  const find = (id) => store.snapshot().projects.flatMap((p) => p.tasks).find((t) => t.id === id);
  return { store, projectId, a, find };
}
const refused = (fn, pattern) => assert.throws(fn, (e) => e instanceof HttpError && e.status === 400 && pattern.test(e.message));

test('a new task has no set start unless one is given', () => {
  const { store, projectId, a, find } = setup();
  assert.equal(find(a).startSet, true);
  const b = store.createTask(projectId, { name: 'B' });
  assert.equal(find(b).startSet, false);
  assert.equal(find(b).trackBy, 'duration');
  const c = store.createTask(projectId, { name: 'C', deps: [{ taskId: a, type: 'SS', lag: -2 }] });
  assert.equal(find(c).computed.start, '2026-01-12');
  const child = store.createTask(projectId, { name: 'Sub', parentId: c });
  assert.equal(find(child).startSet, false);
});

test('adding a link pulls a new task in, and typing a date takes over', () => {
  const { store, projectId, a, find } = setup();
  const b = store.createTask(projectId, { name: 'B', duration: 3 });
  store.updateTask(b, { deps: [{ taskId: a, type: 'FS', lag: -2 }] });
  assert.equal(find(b).computed.start, '2026-01-19');

  store.updateTask(b, { start: '2026-03-02', actor: 'Ana' });
  assert.equal(find(b).startSet, true);
  assert.equal(find(b).computed.start, '2026-03-02');
  assert.equal(find(b).computed.linkStart, '2026-01-19');
  const edit = find(b).history.findLast((h) => h.type === 'edit');
  assert.equal(edit.changes.find((c) => c.field === 'startRule').to, 'Set by hand');

  store.updateTask(b, { startSet: false, actor: 'Ana' });
  assert.equal(find(b).computed.start, '2026-01-19');
  assert.equal(find(b).history.findLast((h) => h.type === 'edit').changes[0].to, 'Follows links');
});

test('a task keeps its place when the link it follows is removed, or its predecessor deleted', () => {
  const { store, projectId, a, find } = setup();
  const b = store.createTask(projectId, { name: 'B', duration: 3, deps: [{ taskId: a, type: 'FS' }] });
  const c = store.createTask(projectId, { name: 'C', duration: 3, deps: [{ taskId: a, type: 'FS' }] });
  assert.equal(find(b).computed.start, '2026-01-21');
  store.updateTask(b, { deps: [] });
  assert.equal(find(b).computed.start, '2026-01-21');
  store.deleteTask(a);
  assert.equal(find(c).computed.start, '2026-01-21');
});

test('data saved before these settings existed keeps its dates, and can opt in', () => {
  const { store, projectId, a, find } = setup();
  const b = store.createTask(projectId, { name: 'B', start: '2026-03-02', duration: 3, deps: [{ taskId: a, type: 'SS', lag: -2 }] });
  const old = store.state.projects[0].tasks.find((t) => t.id === b);
  delete old.startSet;
  delete old.trackBy;
  delete old.finish;
  assert.equal(find(b).computed.start, '2026-03-02');
  store.updateTask(b, { notes: 'Touched' });
  assert.equal(find(b).computed.start, '2026-03-02');
  store.updateTask(b, { startSet: false });
  assert.equal(find(b).computed.start, '2026-01-12');
});

test('turning on manual scheduling holds a task where it is', () => {
  const { store, projectId, a, find } = setup();
  const b = store.createTask(projectId, { name: 'B', duration: 3, deps: [{ taskId: a }] });
  const before = find(b).computed.start;
  store.updateTask(b, { manual: true });
  assert.equal(find(b).computed.start, before);
  store.updateTask(a, { start: '2026-03-02' });
  assert.equal(find(b).computed.start, before);
  assert.deepEqual(find(b).computed.conflicts, [a]);
});

test('turning on manual scheduling holds a pushed task where it is, not at its set start', () => {
  const { store, projectId, a, find } = setup();
  const b = store.createTask(projectId, { name: 'B', start: '2026-01-05', duration: 3, deps: [{ taskId: a }] });
  assert.equal(find(b).computed.start, '2026-01-21');
  store.updateTask(b, { manual: true });
  assert.equal(find(b).computed.start, '2026-01-21');
});

test('switching to dates holds a pushed task where it is, not at its set start', () => {
  const { store, projectId, a, find } = setup();
  const b = store.createTask(projectId, { name: 'B', start: '2026-01-05', duration: 3, deps: [{ taskId: a }] });
  store.updateTask(b, { trackBy: 'dates' });
  assert.deepEqual([find(b).start, find(b).finish, find(b).duration], ['2026-01-21', '2026-01-23', 3]);
});

test('switching to dates keeps the current dates and fills in the duration from then on', () => {
  const { store, projectId, a, find } = setup();
  const b = store.createTask(projectId, { name: 'B', duration: 3, deps: [{ taskId: a }] });
  store.updateTask(b, { trackBy: 'dates', actor: 'Ana' });
  assert.equal(find(b).trackBy, 'dates');
  assert.deepEqual([find(b).start, find(b).finish], ['2026-01-21', '2026-01-23']);

  store.updateTask(b, { end: '2026-02-03' });
  assert.equal(find(b).duration, 10);
  assert.equal(find(b).computed.duration, 10);
  store.updateTask(b, { start: '2026-01-26' });
  assert.equal(find(b).duration, 7);
  assert.equal(find(b).computed.end, '2026-02-03');

  const changes = find(b).history.flatMap((h) => h.changes ?? []);
  assert.ok(changes.some((c) => c.field === 'trackBy' && c.from === 'Duration' && c.to === 'Dates'));
  assert.ok(changes.some((c) => c.field === 'finish' && c.to === '2026-02-03'));
  assert.ok(changes.some((c) => c.field === 'duration' && c.to === 7));
});

test('a task tracked by dates stays put when its predecessor moves, and shows the conflict', () => {
  const { store, projectId, a, find } = setup();
  const b = store.createTask(projectId, { name: 'B', trackBy: 'dates', start: '2026-01-21', end: '2026-01-23', deps: [{ taskId: a }] });
  assert.deepEqual(find(b).computed.conflicts, []);
  store.updateTask(a, { start: '2026-02-02' });
  assert.equal(find(b).computed.start, '2026-01-21');
  assert.deepEqual(find(b).computed.conflicts, [a]);
});

test('switching back to duration keeps the length, and the dates fill in again', () => {
  const { store, projectId, a, find } = setup();
  const b = store.createTask(projectId, { name: 'B', trackBy: 'dates', start: '2026-03-02', end: '2026-03-06', deps: [{ taskId: a }] });
  store.updateTask(b, { trackBy: 'duration' });
  const task = find(b);
  assert.equal(task.trackBy, 'duration');
  assert.equal(task.finish, null);
  assert.equal(task.duration, 5);
  assert.equal(task.startSet, false);
  assert.deepEqual([task.computed.start, task.computed.end], ['2026-01-21', '2026-01-27']);
  store.updateTask(b, { duration: 2 });
  assert.equal(find(b).computed.end, '2026-01-22');
});

test('moving a task tracked by dates moves both dates, as dragging its bar does', () => {
  const { store, projectId, find } = setup();
  const b = store.createTask(projectId, { name: 'B', trackBy: 'dates', start: '2026-03-02', end: '2026-03-06' });
  store.updateTask(b, { start: '2026-03-09', end: '2026-03-13' });
  assert.deepEqual([find(b).computed.start, find(b).computed.end, find(b).duration], ['2026-03-09', '2026-03-13', 5]);
});

test('a calendar change updates the duration of a task tracked by dates, not its dates', () => {
  const { store, projectId, find } = setup();
  const b = store.createTask(projectId, { name: 'B', trackBy: 'dates', start: '2026-03-02', end: '2026-03-06' });
  store.updateProject(projectId, { calendar: { holidays: ['2026-03-04'] } });
  assert.equal(find(b).duration, 4);
  assert.deepEqual([find(b).computed.start, find(b).computed.end], ['2026-03-02', '2026-03-06']);
});

test('changes that do not make sense for a task tracked by dates are refused', () => {
  const { store, projectId, find } = setup();
  const b = store.createTask(projectId, { name: 'B', trackBy: 'dates', start: '2026-03-02', end: '2026-03-06' });
  refused(() => store.updateTask(b, { duration: 3 }), /tracked by dates/);
  refused(() => store.updateTask(b, { end: '2026-03-01' }), /before the start/);
  refused(() => store.updateTask(b, { start: '2026-03-07' }), /before the start/);
  refused(() => store.updateTask(b, { trackBy: 'someday' }), /duration or by dates/);
  assert.deepEqual([find(b).start, find(b).finish, find(b).duration], ['2026-03-02', '2026-03-06', 5]);
  refused(() => store.createTask(projectId, { name: 'C', trackBy: 'dates', start: '2026-03-02', end: '2026-03-01' }), /before the start/);
});

test('a milestone cannot be tracked by dates, and becoming one ends it', () => {
  const { store, projectId, find } = setup();
  const m = store.createTask(projectId, { name: 'M', milestone: true, start: '2026-03-02' });
  refused(() => store.updateTask(m, { trackBy: 'dates' }), /milestone/);
  refused(() => store.createTask(projectId, { name: 'N', milestone: true, trackBy: 'dates' }), /milestone/);

  const b = store.createTask(projectId, { name: 'B', trackBy: 'dates', start: '2026-03-02', end: '2026-03-06' });
  store.updateTask(b, { milestone: true });
  assert.equal(find(b).trackBy, 'duration');
  assert.equal(find(b).finish, null);
  assert.equal(find(b).duration, 0);
});

test('a summary ignores these settings because its dates roll up', () => {
  const { store, projectId, find } = setup();
  const s = store.createTask(projectId, { name: 'S', start: '2026-03-02' });
  store.createTask(projectId, { name: 'Sub', parentId: s, start: '2026-04-06', duration: 2 });
  store.updateTask(s, { trackBy: 'dates', end: '2026-12-01' });
  assert.equal(find(s).trackBy, 'duration');
  assert.equal(find(s).computed.start, '2026-04-06');
  assert.equal(find(s).computed.end, '2026-04-07');
});

test('these settings survive export and import, and a bad file changes nothing', () => {
  const { store, projectId, find } = setup();
  const dates = store.createTask(projectId, { name: 'Dates', trackBy: 'dates', start: '2026-03-02', end: '2026-03-06' });
  const links = store.createTask(projectId, { name: 'Links', deps: [{ taskId: dates, type: 'SS', lag: -1 }] });
  const exported = () => JSON.parse(JSON.stringify(store.exportAll()));

  const copy = new StoreCore();
  copy.importAll(exported(), 'replace');
  const inCopy = (id) => copy.snapshot().projects[0].tasks.find((t) => t.id === id);
  assert.equal(inCopy(dates).trackBy, 'dates');
  assert.equal(inCopy(dates).finish, '2026-03-06');
  assert.equal(inCopy(links).startSet, false);
  assert.equal(inCopy(links).computed.start, find(links).computed.start);

  for (const damage of [{ finish: 'soon' }, { finish: '2026-03-01' }, { finish: null }, { trackBy: 'vibes' }]) {
    const file = exported();
    Object.assign(file.projects[0].tasks.find((t) => t.id === dates), damage);
    assert.throws(() => copy.importAll(file, 'replace'), HttpError, JSON.stringify(damage));
  }
  assert.equal(inCopy(dates).finish, '2026-03-06');

  // Files from before these settings existed.
  const old = exported();
  for (const t of old.projects[0].tasks) {
    delete t.startSet;
    delete t.trackBy;
    delete t.finish;
  }
  copy.importAll(old, 'replace');
  assert.equal(inCopy(links).startSet, true);
  assert.equal(inCopy(dates).trackBy, 'duration');
});

// ---- dependencies in plain English ----------------------------------------------------

test('a dependency is described in plain English, for every type and direction of lag', () => {
  const one = { name: 'Task 1' };
  const two = { name: 'Task 2' };
  const expected = {
    FS: ['"Task 1" starts no earlier than 30 working days before "Task 2" finishes.', '"Task 1" starts after "Task 2" finishes.', '"Task 1" starts no earlier than 2 working days after "Task 2" finishes.'],
    SS: ['"Task 1" starts no earlier than 30 working days before "Task 2" starts.', '"Task 1" starts no earlier than "Task 2" starts.', '"Task 1" starts no earlier than 2 working days after "Task 2" starts.'],
    FF: ['"Task 1" finishes no earlier than 30 working days before "Task 2" finishes.', '"Task 1" finishes no earlier than "Task 2" finishes.', '"Task 1" finishes no earlier than 2 working days after "Task 2" finishes.'],
    SF: ['"Task 1" finishes no earlier than 30 working days before "Task 2" starts.', '"Task 1" finishes no earlier than "Task 2" starts.', '"Task 1" finishes no earlier than 2 working days after "Task 2" starts.'],
  };
  for (const [type, [before, at, after]] of Object.entries(expected)) {
    assert.equal(describeDep({ type, lag: -30 }, one, two), before);
    assert.equal(describeDep({ type, lag: 0 }, one, two), at);
    assert.equal(describeDep({ type, lag: 2 }, one, two), after);
  }
});

test('the sentence says one working day, and handles milestones and a missing lag', () => {
  const one = { name: 'A' };
  const two = { name: 'B' };
  assert.equal(describeDep({ type: 'SS', lag: 1 }, one, two), '"A" starts no earlier than 1 working day after "B" starts.');
  assert.equal(describeDep({ type: 'SS', lag: -1 }, one, two, true), '"A" starts 1 working day before "B" starts.');
  assert.equal(describeDep({ type: 'SF', lag: -30 }, one, two, true), '"A" finishes 30 working days before "B" starts.');
  assert.equal(describeDep({ type: 'FS' }, one, two), '"A" starts after "B" finishes.');
  assert.equal(describeDep({ type: 'FS', lag: 0 }, { name: 'M', milestone: true }, two), '"M" falls no earlier than "B" finishes.');
  assert.equal(describeDep({ type: 'SF', lag: -3 }, { name: 'M', milestone: true }, two), '"M" falls no earlier than 3 working days before "B" starts.');
  assert.equal(describeDep({ type: 'FS', lag: 2 }, one, { name: 'M', milestone: true }), '"A" starts no earlier than 2 working days after "M" is reached.');
});

test('where a task stands against a link is said only when it differs from the link', () => {
  assert.equal(describeLinkBuffer(0, 'A'), null);
  assert.match(describeLinkBuffer(11, 'A'), /"A" is 11 working days later than this link requires, which is allowed/);
  assert.match(describeLinkBuffer(1, 'A'), /1 working day later/);
  assert.match(describeLinkBuffer(-3, 'A'), /"A" is 3 working days earlier than this link allows/);
  assert.match(describeLinkBuffer(12, 'A', true), /"A" is 12 working days later than this link allows/);
});

// ---- typing a lag -------------------------------------------------------------------

test('a typed lag is read as a whole number, or refused', () => {
  for (const [typed, lag] of [['-2', -2], ['2', 2], ['02', 2], ['0', 0], ['', 0], ['  ', 0], ['-0', -0], ['+3', 3]]) {
    assert.equal(parseLag(typed), lag, JSON.stringify(typed));
  }
  for (const typed of ['1.5', '-1.5', 'soon', '0-2', '--2', '-']) {
    assert.equal(parseLag(typed), null, JSON.stringify(typed));
  }
  // What the browser gives for text like "0-2": an empty value, flagged as bad.
  assert.equal(parseLag('', true), null);
});
