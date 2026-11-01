import test from 'node:test';
import assert from 'node:assert/strict';
import { computeSchedule, makeCalendar, toDayNumber, toIso } from '../src/scheduler.js';

const TODAY = '2026-01-05'; // a Monday

const task = (id, fields = {}) => ({
  id,
  name: id,
  parentId: null,
  start: TODAY,
  duration: 5,
  milestone: false,
  manual: false,
  status: 'not_started',
  progress: 0,
  deps: [],
  ...fields,
});
const dep = (taskId, type = 'FS', lag = 0) => ({ taskId, type, lag });
const project = (id, tasks, calendar) => ({ id, name: id, calendar: calendar ?? {}, tasks });
const run = (...projects) => computeSchedule(projects, TODAY);

test('calendar skips weekends and holidays', () => {
  const cal = makeCalendar({ holidays: ['2026-01-06'] });
  const mon = toDayNumber('2026-01-05');
  assert.equal(toIso(cal.add(mon, 1)), '2026-01-07');
  assert.equal(toIso(cal.next(toDayNumber('2026-01-10'))), '2026-01-12');
  assert.equal(toIso(cal.add(toDayNumber('2026-01-12'), -1)), '2026-01-09');
  assert.equal(cal.count(mon, toDayNumber('2026-01-11')), 4);
});

test('duration counts working days and spans the weekend', () => {
  const { tasks } = run(project('p', [task('a', { duration: 7 })]));
  assert.equal(tasks.get('a').start, '2026-01-05');
  assert.equal(tasks.get('a').end, '2026-01-13');
});

test('a start on a weekend snaps forward to Monday', () => {
  const { tasks } = run(project('p', [task('a', { start: '2026-01-10', duration: 1 })]));
  assert.equal(tasks.get('a').start, '2026-01-12');
});

test('finish-to-start pushes the successor to the next working day', () => {
  const { tasks } = run(project('p', [task('a'), task('b', { deps: [dep('a')] })]));
  assert.equal(tasks.get('a').end, '2026-01-09');
  assert.equal(tasks.get('b').start, '2026-01-12');
  assert.equal(tasks.get('b').driverId, 'a');
  assert.equal(tasks.get('b').delay, 5);
});

test('a later requested start wins over the dependency', () => {
  const { tasks } = run(project('p', [task('a', { duration: 1 }), task('b', { start: '2026-02-02', deps: [dep('a')] })]));
  assert.equal(tasks.get('b').start, '2026-02-02');
  assert.equal(tasks.get('b').driverId, null);
});

test('start-to-start, finish-to-finish and start-to-finish with lag', () => {
  const { tasks } = run(
    project('p', [
      task('a', { start: '2026-01-12', duration: 5 }),
      task('ss', { deps: [dep('a', 'SS', 2)], duration: 3 }),
      task('ff', { deps: [dep('a', 'FF', 1)], duration: 2 }),
      task('sf', { deps: [dep('a', 'SF')], duration: 2 }),
    ]),
  );
  assert.equal(tasks.get('ss').start, '2026-01-14');
  assert.equal(tasks.get('ff').end, '2026-01-19');
  assert.equal(tasks.get('ff').start, '2026-01-16');
  assert.equal(tasks.get('sf').end, '2026-01-09');
});

test('negative lag overlaps the predecessor', () => {
  const { tasks } = run(project('p', [task('a'), task('b', { deps: [dep('a', 'FS', -2)] })]));
  assert.equal(tasks.get('b').start, '2026-01-08');
});

test('a milestone lands on its predecessor finish; its successor starts the next day', () => {
  const { tasks } = run(
    project('p', [
      task('a'),
      task('m', { milestone: true, duration: 0, deps: [dep('a')] }),
      task('b', { deps: [dep('m')] }),
    ]),
  );
  assert.equal(tasks.get('m').start, '2026-01-09');
  assert.equal(tasks.get('m').end, '2026-01-09');
  assert.equal(tasks.get('b').start, '2026-01-12');
});

test('summary rolls up dates, weighted progress and status from subtasks', () => {
  const { tasks } = run(
    project('p', [
      task('s'),
      task('a', { parentId: 's', duration: 2, status: 'complete', progress: 100 }),
      task('b', { parentId: 's', duration: 6, start: '2026-01-07', status: 'in_progress', progress: 50 }),
    ]),
  );
  const s = tasks.get('s');
  assert.equal(s.isSummary, true);
  assert.equal(s.start, '2026-01-05');
  assert.equal(s.end, '2026-01-14');
  assert.equal(s.progress, 63);
  assert.equal(s.status, 'in_progress');
});

test('a dependency on a summary constrains all of its subtasks', () => {
  const { tasks } = run(
    project('p', [task('a'), task('s', { deps: [dep('a')] }), task('c1', { parentId: 's' }), task('c2', { parentId: 's' })]),
  );
  assert.equal(tasks.get('c1').start, '2026-01-12');
  assert.equal(tasks.get('c2').start, '2026-01-12');
  assert.equal(tasks.get('s').start, '2026-01-12');
});

test('cross-project dependency moves the other project and is reported', () => {
  const { tasks, crossLinks, projects } = run(
    project('p1', [task('a', { duration: 10 })]),
    project('p2', [task('b', { deps: [dep('a')] }), task('c', { start: '2026-03-02', deps: [dep('a')] })]),
  );
  assert.equal(tasks.get('b').start, '2026-01-19');
  assert.equal(crossLinks.length, 2);
  const byTo = Object.fromEntries(crossLinks.map((l) => [l.toTaskId, l]));
  assert.equal(byTo.b.state, 'driving');
  assert.equal(byTo.c.state, 'buffer');
  assert.ok(byTo.c.buffer > 0);
  assert.equal(projects.get('p1').downstream, 2);
  assert.equal(projects.get('p2').upstream, 2);
});

test('each project keeps its own calendar across a link', () => {
  const { tasks } = run(
    project('p1', [task('a', { start: '2026-01-05', duration: 5 })]),
    project('p2', [task('b', { deps: [dep('a')], duration: 1 })], { workWeekends: true }),
  );
  assert.equal(tasks.get('b').start, '2026-01-10');
});

test('loops are detected, including across projects and through summaries', () => {
  assert.ok(run(project('p', [task('a', { deps: [dep('b')] }), task('b', { deps: [dep('a')] })])).cycle.length);
  assert.ok(
    run(project('p1', [task('a', { deps: [dep('b')] })]), project('p2', [task('b', { deps: [dep('a')] })])).cycle.length,
  );
  assert.ok(run(project('p', [task('s', { deps: [dep('c')] }), task('c', { parentId: 's' })])).cycle.length);
});

test('critical path holds the longest chain and float measures the rest', () => {
  const { tasks } = run(
    project('p', [
      task('a', { duration: 5 }),
      task('b', { duration: 10, deps: [dep('a')] }),
      task('c', { duration: 2, deps: [dep('a')] }),
      task('d', { duration: 1, deps: [dep('b'), dep('c')] }),
    ]),
  );
  for (const id of ['a', 'b', 'd']) assert.equal(tasks.get(id).critical, true, id);
  assert.equal(tasks.get('c').critical, false);
  assert.equal(tasks.get('c').float, 8);
});

test('critical path follows a link into another project', () => {
  const { tasks } = run(
    project('p1', [task('a', { duration: 5 }), task('long', { duration: 3 })]),
    project('p2', [task('b', { duration: 30, deps: [dep('a')] })]),
  );
  assert.equal(tasks.get('a').critical, true);
});

test('manual tasks stay put and flag a conflict', () => {
  const { tasks, crossLinks } = run(
    project('p1', [task('a', { duration: 10 })]),
    project('p2', [task('b', { manual: true, deps: [dep('a')] })]),
  );
  assert.equal(tasks.get('b').start, TODAY);
  assert.deepEqual(tasks.get('b').conflicts, ['a']);
  assert.equal(tasks.get('b').health, 'at_risk');
  assert.equal(crossLinks[0].state, 'conflict');
});

test('completed tasks do not move when a predecessor slips', () => {
  const { tasks } = run(
    project('p', [task('a', { duration: 20 }), task('b', { status: 'complete', progress: 100, deps: [dep('a')] })]),
  );
  assert.equal(tasks.get('b').start, TODAY);
  assert.deepEqual(tasks.get('b').conflicts, []);
});

test('health reflects dates and status', () => {
  const past = '2025-12-01';
  const { tasks } = run(
    project('p', [
      task('late', { start: past, duration: 2, status: 'in_progress' }),
      task('slip', { start: past, duration: 60 }),
      task('blocked', { status: 'blocked' }),
      task('done', { start: past, duration: 2, status: 'complete' }),
      task('fine'),
    ]),
  );
  assert.equal(tasks.get('late').health, 'late');
  assert.equal(tasks.get('slip').health, 'at_risk');
  assert.equal(tasks.get('blocked').health, 'at_risk');
  assert.equal(tasks.get('done').health, 'complete');
  assert.equal(tasks.get('fine').health, 'on_track');
});

test('outline numbers follow the hierarchy', () => {
  const { tasks } = run(project('p', [task('a'), task('b'), task('c', { parentId: 'b' }), task('d', { parentId: 'b' }), task('e', { parentId: 'd' })]));
  assert.equal(tasks.get('a').wbs, '1');
  assert.equal(tasks.get('d').wbs, '2.2');
  assert.equal(tasks.get('e').wbs, '2.2.1');
  assert.equal(tasks.get('e').depth, 2);
});
