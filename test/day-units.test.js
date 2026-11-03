// Durations and lags that count calendar days instead of working days. November 2026
// starts on a Sunday, so Nov 6 is a Friday and Nov 7 and 8 are a weekend.

import test from 'node:test';
import assert from 'node:assert/strict';
import { computeSchedule, durationClock, makeCalendar, toDayNumber, toIso } from '../public/shared/scheduler.js';
import { StoreCore } from '../public/shared/store-core.js';

const TODAY = '2026-01-05';
const STANDARD = { firmLeads: false };

const task = (id, fields = {}) => ({
  id, name: id, parentId: null, start: '2026-11-02', duration: 5, milestone: false, manual: false,
  status: 'not_started', progress: 0, deps: [], ...fields,
});
const dep = (taskId, type = 'FS', lag = 0, lagUnit) => ({ taskId, type, lag, ...(lagUnit ? { lagUnit } : {}) });
const project = (id, tasks, calendar = {}) => ({ id, name: id, calendar, tasks });
const schedule = (projects, options = STANDARD) => computeSchedule(projects, TODAY, options).tasks;
const dates = (tasks, id) => [tasks.get(id).start, tasks.get(id).end];

// ---- durations ---------------------------------------------------------------------

test('a calendar duration runs through the weekend, and a working one skips it', () => {
  const tasks = schedule([project('p', [
    task('work', { duration: 7 }),
    task('cal', { duration: 7, durationUnit: 'calendar' }),
  ])]);
  assert.deepEqual(dates(tasks, 'work'), ['2026-11-02', '2026-11-10']);
  assert.deepEqual(dates(tasks, 'cal'), ['2026-11-02', '2026-11-08']);
  assert.equal(tasks.get('cal').duration, 7);
});

test('a calendar duration runs through holidays too', () => {
  const tasks = schedule([project('p', [task('cal', { duration: 3, durationUnit: 'calendar', start: '2026-11-03' })], { holidays: ['2026-11-04'] })]);
  assert.deepEqual(dates(tasks, 'cal'), ['2026-11-03', '2026-11-05']);
});

test('a calendar task can start on a weekend, and a working one moves off it', () => {
  const tasks = schedule([project('p', [
    task('cal', { start: '2026-11-07', duration: 2, durationUnit: 'calendar' }),
    task('work', { start: '2026-11-07', duration: 2 }),
  ])]);
  assert.deepEqual(dates(tasks, 'cal'), ['2026-11-07', '2026-11-08']);
  assert.deepEqual(dates(tasks, 'work'), ['2026-11-09', '2026-11-10']);
});

test('a milestone stays on working days whatever unit it was left with', () => {
  const tasks = schedule([project('p', [task('m', { start: '2026-11-07', milestone: true, duration: 0, durationUnit: 'calendar' })])]);
  assert.deepEqual(dates(tasks, 'm'), ['2026-11-09', '2026-11-09']);
});

test('tracked by dates, a calendar task counts every day and keeps both dates', () => {
  const tasks = schedule([project('p', [
    task('cal', { trackBy: 'dates', start: '2026-11-07', finish: '2026-11-15', durationUnit: 'calendar' }),
    task('work', { trackBy: 'dates', start: '2026-11-09', finish: '2026-11-15' }),
  ])]);
  assert.deepEqual([...dates(tasks, 'cal'), tasks.get('cal').duration], ['2026-11-07', '2026-11-15', 9]);
  assert.equal(tasks.get('work').duration, 5);
});

test('a summary with only a weekend subtask still has a duration', () => {
  const tasks = schedule([project('p', [
    task('s'),
    task('c', { parentId: 's', start: '2026-11-07', duration: 2, durationUnit: 'calendar' }),
  ])]);
  assert.equal(tasks.get('s').duration, 1);
});

// ---- lags: one hand-worked case for each type, each way -----------------------------------

// The predecessor runs Mon Nov 2 to Fri Nov 6. Followers have one day, so start = finish.
const pred = () => task('A');
const follower = (type, lag, lagUnit, fields = {}) => task('B', { duration: 1, startSet: false, deps: [dep('A', type, lag, lagUnit)], ...fields });
const whenFollowing = (...args) => schedule([project('p', [pred(), follower(...args)])]).get('B').start;

for (const [type, lag, unit, expected, why] of [
  ['FS', 3, 'calendar', '2026-11-10', 'Sat, Sun and Mon pass, then Tuesday'],
  ['FS', 3, undefined, '2026-11-12', 'Mon, Tue and Wed pass, then Thursday'],
  ['FS', 1, 'calendar', '2026-11-09', 'Saturday passes, so Sunday, which moves to Monday'],
  ['FS', -3, 'calendar', '2026-11-04', 'three days back from the Saturday after'],
  ['SS', 5, 'calendar', '2026-11-09', 'Saturday Nov 7 moves to Monday'],
  ['SS', 5, undefined, '2026-11-09', 'five working days on'],
  ['SS', 3, 'calendar', '2026-11-05', 'Monday plus three'],
  ['SS', -2, 'calendar', '2026-11-02', 'Saturday Oct 31 moves to Monday'],
  ['SS', -2, undefined, '2026-10-29', 'two working days back'],
  ['FF', 2, 'calendar', '2026-11-09', 'Sunday moves to Monday'],
  ['FF', 2, undefined, '2026-11-10', 'two working days on'],
  ['FF', 4, 'calendar', '2026-11-10', 'Friday plus four'],
  ['FF', -1, 'calendar', '2026-11-05', 'Friday less one'],
  ['SF', 8, 'calendar', '2026-11-09', 'Monday plus seven is a Monday'],
  ['SF', -3, 'calendar', '2026-10-29', 'Monday less four'],
  ['SF', -1, 'calendar', '2026-11-02', 'Saturday Oct 31 moves to Monday'],
]) {
  test(`${type} ${lag} ${unit ?? 'working'} days lands on ${expected}: ${why}`, () => {
    assert.equal(whenFollowing(type, lag, unit), expected);
  });
}

test('a calendar lag lands a calendar task on the weekend', () => {
  assert.equal(whenFollowing('FS', 0, 'calendar', { durationUnit: 'calendar' }), '2026-11-07');
  assert.equal(whenFollowing('SS', 5, 'calendar', { durationUnit: 'calendar' }), '2026-11-07');
  assert.equal(whenFollowing('FF', 2, 'calendar', { durationUnit: 'calendar' }), '2026-11-08');
});

test('a working lag still lands a calendar task on a working day', () => {
  assert.equal(whenFollowing('FS', 0, undefined, { durationUnit: 'calendar' }), '2026-11-09');
});

test('a task with a working duration after a calendar lag still runs on working days', () => {
  const tasks = schedule([project('p', [pred(), follower('FS', 1, 'calendar', { duration: 3 })])]);
  assert.deepEqual(dates(tasks, 'B'), ['2026-11-09', '2026-11-11']);
});

test('finishing on a calendar lag counts back through the follower\'s own days', () => {
  const lag = (lagUnit, durationUnit) => schedule([project('p', [pred(), task('B', { duration: 3, durationUnit, startSet: false, deps: [dep('A', 'FF', 4, lagUnit)] })])]);
  assert.deepEqual(dates(lag('calendar', 'working'), 'B'), ['2026-11-06', '2026-11-10']);
  assert.deepEqual(dates(lag('calendar', 'calendar'), 'B'), ['2026-11-08', '2026-11-10']);
});

test('what follows a task finishing on a weekend starts on the next working day', () => {
  const tasks = schedule([project('p', [
    task('cal', { start: '2026-11-06', duration: 3, durationUnit: 'calendar' }),
    task('next', { startSet: false, deps: [dep('cal')] }),
  ])]);
  assert.equal(tasks.get('cal').end, '2026-11-08');
  assert.equal(tasks.get('next').start, '2026-11-09');
});

test('a calendar lag ignores the holidays of both projects', () => {
  const tasks = schedule([
    project('up', [task('A')], { holidays: ['2026-11-10'] }),
    project('down', [task('B', { duration: 1, startSet: false, deps: [dep('A', 'FS', 3, 'calendar')] })], { holidays: ['2026-11-09'] }),
  ]);
  assert.equal(tasks.get('B').start, '2026-11-10');
});

test('working days are what a missing unit means, so older plans do not move', () => {
  const plan = (unit) => [project('p', [
    task('A', { durationUnit: unit }),
    task('B', { startSet: false, durationUnit: unit, deps: [{ ...dep('A', 'SF', -7), ...(unit ? { lagUnit: unit } : {}) }] }),
    task('C', { startSet: false, durationUnit: unit, deps: [{ ...dep('A', 'FS', 4), ...(unit ? { lagUnit: unit } : {}) }] }),
  ])];
  const view = (tasks) => ['A', 'B', 'C'].map((id) => ({ ...tasks.get(id), durationUnit: undefined }));
  assert.deepEqual(view(schedule(plan(undefined))), view(schedule(plan('working'))));
});

// ---- firm leads ---------------------------------------------------------------------

test('a firm calendar lead that lands on a weekend moves earlier, staying ahead of its rule', () => {
  const firm = (type, lag) => schedule([project('p', [task('A', { start: '2026-11-09' }), follower(type, lag, 'calendar')])], {}).get('B').start;
  // SF -8 lands on Saturday Oct 31, and SS -2 on Saturday Nov 7.
  assert.equal(firm('SF', -8), '2026-10-30');
  assert.equal(firm('SS', -2), '2026-11-06');
  // The same links by the standard only set the earliest date, so they move later.
  const standard = (type, lag) => schedule([project('p', [task('A', { start: '2026-11-09' }), follower(type, lag, 'calendar')])]).get('B').start;
  assert.equal(standard('SF', -8), '2026-11-02');
  assert.equal(standard('SS', -2), '2026-11-09');
});

test('a firm calendar lead has no buffer on its own date, and reports lateness in calendar days', () => {
  const plan = (start) => computeSchedule([project('p', [
    task('A', { start: '2026-11-09' }),
    task('B', { duration: 1, start, deps: [dep('A', 'SS', -2, 'calendar')] }),
  ])], TODAY, {}).tasks.get('B');
  assert.deepEqual(plan('2026-11-06').links, [{ taskId: 'A', buffer: 0, firm: true, unit: 'calendar' }]);
  assert.deepEqual(plan('2026-11-06').conflicts, []);
  const late = plan('2026-11-09');
  assert.deepEqual(late.links, [{ taskId: 'A', buffer: 3, firm: true, unit: 'calendar' }]);
  assert.deepEqual(late.conflicts, ['A']);
});

// ---- float and the critical path, by brute force -----------------------------------------

const projectFinishes = (tasks, projects) => projects.map((p) => p.tasks
  .filter((t) => !tasks.get(t.id).isSummary)
  .map((t) => tasks.get(t.id).end).sort().at(-1));

// Each open task's float is the most it can slip, on its own clock, moving no finish.
function assertMatchesSlips(projects, label) {
  const result = computeSchedule(projects, TODAY, STANDARD);
  if (result.cycle) return 0;
  const finishes = projectFinishes(result.tasks, projects);
  let checked = 0;
  for (const p of projects) {
    const clockCal = makeCalendar(p.calendar);
    for (const t of p.tasks) {
      const c = result.tasks.get(t.id);
      if (c.isSummary) continue;
      const clock = durationClock(t, clockCal);
      const slipped = (days) => {
        const copy = structuredClone(projects);
        const moved = copy.flatMap((q) => q.tasks).find((x) => x.id === t.id);
        moved.start = toIso(clock.add(toDayNumber(c.start), days));
        moved.startSet = true;
        return projectFinishes(computeSchedule(copy, TODAY, STANDARD).tasks, copy);
      };
      const where = `${label}: ${t.id}, float ${c.float}`;
      assert.ok(c.float >= 0, `negative float, ${where}`);
      assert.equal(c.critical, c.float === 0, where);
      assert.deepEqual(slipped(c.float), finishes, `slipping by its float moved a finish, ${where}`);
      assert.notDeepEqual(slipped(c.float + 1), finishes, `one day past its float moved nothing, ${where}`);
      checked++;
    }
  }
  return checked;
}

const UNITS = ['working', 'calendar'];
const TYPES = ['FS', 'SS', 'FF', 'SF'];

test('every type, lag and pair of units matches a real slip, starting on every day of a week', () => {
  let checked = 0;
  for (const type of TYPES) {
    for (const lag of [-30, -9, -3, -1, 0, 1, 3, 9, 30]) {
      for (const lagUnit of UNITS) {
        for (const aUnit of UNITS) {
          for (const bUnit of UNITS) {
            for (let day = 2; day <= 8; day++) {
              const plan = [project('p', [
                task('A', { start: `2026-11-0${day}`, durationUnit: aUnit }),
                task('B', { duration: 4, durationUnit: bUnit, startSet: false, deps: [dep('A', type, lag, lagUnit)] }),
              ])];
              checked += assertMatchesSlips(plan, `${type} ${lag} ${lagUnit}, A ${aUnit}, B ${bUnit}, day ${day}`);
            }
          }
        }
      }
    }
  }
  assert.equal(checked, 4032, 'every case ran'); assert.ok(checked > 4000, `checked ${checked}`);
});

test('random plans mixing units, calendars and links match real slips', () => {
  let seed = 20261102;
  const random = (n) => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return Math.floor((seed / 4294967296) * n);
  };
  const pick = (list) => list[random(list.length)];
  let checked = 0;
  for (let round = 0; round < 400; round++) {
    const calendars = [{}, { holidays: ['2026-11-11', '2026-11-27', '2026-12-25'] }];
    const tasksOf = [[], []];
    const everyTask = [];
    const count = 3 + random(6);
    for (let i = 0; i < count; i++) {
      const home = random(2);
      const deps = everyTask.length && random(4) ? [dep(pick(everyTask), pick(TYPES), pick([-20, -7, -2, 0, 1, 4, 11]), pick(UNITS))] : [];
      const made = task(`t${i}`, {
        start: toIso(toDayNumber('2026-11-02') + random(30)),
        duration: 1 + random(12),
        durationUnit: pick(UNITS),
        startSet: deps.length ? random(2) === 0 ? false : undefined : undefined,
        deps,
      });
      tasksOf[home].push(made);
      everyTask.push(made.id);
    }
    const plan = [project('a', tasksOf[0], calendars[0]), project('b', tasksOf[1], calendars[1])].filter((p) => p.tasks.length);
    checked += assertMatchesSlips(plan, `round ${round}`);
  }
  assert.ok(checked > 1500, `checked ${checked}`);
});

// ---- saving ---------------------------------------------------------------------------

const store = () => {
  const s = new StoreCore({ saving: true });
  s.persist = () => {};
  return s;
};
const tasksOf = (s) => s.snapshot().projects[0].tasks;

function plannedStore() {
  const s = store();
  const id = s.createProject({ name: 'P' });
  s.createTask(id, { name: 'A', start: '2026-11-02', duration: 7 });
  return { s, a: tasksOf(s)[0], projectId: id };
}

test('new tasks count working days', () => {
  assert.equal(plannedStore().a.durationUnit, 'working');
});

test('switching a duration keeps the number and moves the dates, and history says so', () => {
  const { s, a } = plannedStore();
  assert.equal(a.computed.end, '2026-11-10');
  s.updateTask(a.id, { durationUnit: 'calendar' });
  const after = tasksOf(s)[0];
  assert.deepEqual([after.duration, after.computed.end], [7, '2026-11-08']);
  const changes = after.history.flatMap((h) => h.changes ?? []);
  assert.deepEqual(changes.find((c) => c.field === 'durationUnit'), { field: 'durationUnit', label: 'Duration counts', from: 'Working days', to: 'Calendar days' });
  assert.ok(!after.history.some((h) => h.type === 'schedule'), 'its own edit is not also a reschedule');
});

test('switching a task tracked by dates keeps the dates and changes the number', () => {
  const { s, a } = plannedStore();
  s.updateTask(a.id, { trackBy: 'dates', end: '2026-11-10' });
  assert.equal(tasksOf(s)[0].duration, 7);
  s.updateTask(a.id, { durationUnit: 'calendar' });
  const after = tasksOf(s)[0];
  assert.deepEqual([after.duration, after.computed.start, after.computed.end], [9, '2026-11-02', '2026-11-10']);
});

test('dragging a finish on a calendar task counts calendar days', () => {
  const { s, a } = plannedStore();
  s.updateTask(a.id, { durationUnit: 'calendar' });
  s.updateTask(a.id, { end: '2026-11-15' });
  assert.equal(tasksOf(s)[0].duration, 14);
});

test('a new task tracked by dates uses its calendar duration for the finish', () => {
  const s = store();
  const id = s.createProject({ name: 'P' });
  s.createTask(id, { name: 'A', start: '2026-11-02', duration: 7, durationUnit: 'calendar', trackBy: 'dates' });
  const [made] = tasksOf(s);
  assert.deepEqual([made.finish, made.duration], ['2026-11-08', 7]);
});

test('an unknown unit is refused, for a duration and for a lag', () => {
  const { s, a, projectId } = plannedStore();
  assert.throws(() => s.updateTask(a.id, { durationUnit: 'weeks' }), /working days or calendar days/);
  s.createTask(projectId, { name: 'B' });
  const b = tasksOf(s)[1];
  assert.throws(() => s.updateTask(b.id, { deps: [{ taskId: a.id, type: 'FS', lag: 1, lagUnit: 'hours' }] }), /working days or calendar days/);
  assert.equal(tasksOf(s)[1].deps.length, 0);
});

test('a link stores its unit only when it is the exception, and history shows it', () => {
  const { s, a, projectId } = plannedStore();
  s.createTask(projectId, { name: 'B' });
  const b = tasksOf(s)[1];
  s.updateTask(b.id, { deps: [{ taskId: a.id, type: 'FS', lag: 3, lagUnit: 'working' }] });
  assert.deepEqual(tasksOf(s)[1].deps, [{ taskId: a.id, type: 'FS', lag: 3 }]);
  s.updateTask(b.id, { deps: [{ taskId: a.id, type: 'FS', lag: 3, lagUnit: 'calendar' }] });
  assert.deepEqual(tasksOf(s)[1].deps, [{ taskId: a.id, type: 'FS', lag: 3, lagUnit: 'calendar' }]);
  const changes = tasksOf(s)[1].history.flatMap((h) => h.changes ?? []).filter((c) => c.field === 'deps');
  assert.deepEqual(changes.at(-1).to, 'A (FS+3cd)');
  s.updateTask(b.id, { deps: [{ taskId: a.id, type: 'FS', lag: 0, lagUnit: 'calendar' }] });
  assert.deepEqual(tasksOf(s)[1].history.flatMap((h) => h.changes ?? []).filter((c) => c.field === 'deps').at(-1).to, 'A (FS+0cd)');
});

test('units survive an export and import, and files without them count working days', () => {
  const { s, a, projectId } = plannedStore();
  s.updateTask(a.id, { durationUnit: 'calendar' });
  s.createTask(projectId, { name: 'B', deps: [{ taskId: a.id, type: 'SS', lag: 4, lagUnit: 'calendar' }] });
  const exported = structuredClone(s.exportAll());

  const again = store();
  again.importAll(exported, 'replace');
  const [first, second] = tasksOf(again);
  assert.equal(first.durationUnit, 'calendar');
  assert.deepEqual(second.deps[0].lagUnit, 'calendar');

  const older = structuredClone(exported);
  for (const t of older.projects[0].tasks) {
    delete t.durationUnit;
    for (const d of t.deps) delete d.lagUnit;
  }
  const fromOlder = store();
  fromOlder.importAll(older, 'replace');
  assert.deepEqual(tasksOf(fromOlder).map((t) => t.durationUnit), ['working', 'working']);
  assert.equal(tasksOf(fromOlder)[1].deps[0].lagUnit, undefined);
});

test('a summary ignores a unit sent to it', () => {
  const { s, a, projectId } = plannedStore();
  s.createTask(projectId, { name: 'Child', parentId: a.id });
  s.updateTask(a.id, { durationUnit: 'calendar' });
  assert.equal(tasksOf(s)[0].durationUnit, 'working');
});

test('cross-project links report their lag unit and a buffer in calendar days', () => {
  const { crossLinks } = computeSchedule([
    project('up', [task('A')]),
    project('down', [task('B', { start: '2026-11-20', deps: [dep('A', 'FS', 1, 'calendar')] })]),
  ], TODAY, STANDARD);
  assert.deepEqual(
    [crossLinks[0].lagUnit, crossLinks[0].unit, crossLinks[0].buffer, crossLinks[0].state],
    ['calendar', 'calendar', 11, 'buffer'],
  );
});
