// Negative SS and SF links are firm, which differs from the standard. "A finishes 30 days
// before B starts" is a rule both ways: A moves with B, can't be later than that, and has
// no more float than B. Nothing here changes dates, only conflicts, float and criticality.

import test from 'node:test';
import assert from 'node:assert/strict';
import { computeSchedule, isFirmLead, makeCalendar, toDayNumber, toIso } from '../public/shared/scheduler.js';
import { StoreCore } from '../public/shared/store-core.js';

const TODAY = '2026-01-05';
const FIRM = ['SS', 'SF'];
const task = (id, fields = {}) => ({
  id, name: id, parentId: null, start: '2026-06-01', duration: 5, milestone: false, manual: false,
  status: 'not_started', progress: 0, deps: [], ...fields,
});
const dep = (taskId, type, lag) => ({ taskId, type, lag });
const project = (id, tasks, calendar = {}) => ({ id, name: id, calendar, tasks });
const firm = (...projects) => computeSchedule(projects, TODAY).tasks;
const standard = (...projects) => computeSchedule(projects, TODAY, { firmLeads: false }).tasks;
const view = (tasks, ...ids) => Object.fromEntries(ids.map((id) => [id, [tasks.get(id).float, tasks.get(id).critical]]));

test('only a negative SS or SF is firm', () => {
  for (const [type, lag, expected] of [
    ['SS', -1, true], ['SF', -30, true], ['SS', 0, false], ['SF', 0, false], ['SS', 2, false], ['SF', 30, false],
    ['FS', -30, false], ['FF', -30, false], ['FS', 0, false], ['FF', 3, false],
  ]) {
    assert.equal(isFirmLead({ type, lag }), expected, `${type} ${lag}`);
  }
  assert.equal(isFirmLead({ type: 'SF' }), false);
});

test('your plan: test2 must finish 30 working days before test1, so it is critical', () => {
  const plan = () => [project('p', [
    task('overall', { startSet: false }),
    task('test1', { parentId: 'overall', start: '2027-02-09', duration: 4 }),
    task('test2', { parentId: 'overall', startSet: false, duration: 1, deps: [dep('test1', 'SF', -30)] }),
    task('test3', { parentId: 'overall', start: '2027-01-19', startSet: false }),
  ])];
  const tasks = firm(...plan());
  assert.deepEqual([tasks.get('test2').start, tasks.get('test2').end], ['2026-12-28', '2026-12-28']);
  assert.deepEqual(view(tasks, 'test1', 'test2', 'test3'), { test1: [0, true], test2: [0, true], test3: [14, false] });
  assert.deepEqual(tasks.get('test2').conflicts, []);
  assert.deepEqual(tasks.get('test2').links.map((l) => [l.buffer, l.firm]), [[0, true]]);
  // The standard reading, for comparison.
  assert.deepEqual(view(standard(...plan()), 'test2'), { test2: [34, false] });
});

test('the firm link still moves the earlier task with the later one', () => {
  for (const type of FIRM) {
    const startOf = (start) => firm(project('p', [
      task('A', { start }),
      task('B', { startSet: false, deps: [dep('A', type, -30)] }),
    ])).get('B').start;
    assert.equal(startOf('2026-06-08') > startOf('2026-06-01'), true, type);
  }
});

test('dates are the same as by the standard, for every firm link', () => {
  for (const type of FIRM) {
    for (const lag of [-60, -30, -5, -1]) {
      const plan = () => project('p', [
        task('A'),
        task('B', { startSet: false, deps: [dep('A', type, lag)] }),
        task('C', { start: '2027-01-04', deps: [dep('A', type, lag)] }),
      ]);
      const one = firm(plan());
      const other = standard(plan());
      for (const id of ['A', 'B', 'C']) {
        assert.deepEqual([one.get(id).start, one.get(id).end], [other.get(id).start, other.get(id).end], `${type} ${lag} ${id}`);
      }
    }
  }
});

test('the earlier task has exactly the float of the later one', () => {
  for (const type of FIRM) {
    for (const lag of [-30, -5, -1]) {
      const tasks = firm(project('p', [
        task('A'),
        task('B', { startSet: false, deps: [dep('A', type, lag)] }),
        task('L', { duration: 20 }), // ends the project 15 days after A
      ]));
      assert.equal(tasks.get('A').float, 15, `${type} ${lag}`);
      assert.equal(tasks.get('B').float, 15, `${type} ${lag}`);
      assert.deepEqual(tasks.get('B').conflicts, []);
    }
  }
});

test('later than the link allows is a conflict and at risk, whatever put it there', () => {
  const held = {
    'a set start': { start: '2026-05-25' },
    'a manual date': { start: '2026-05-25', manual: true },
    'dates': { start: '2026-05-18', trackBy: 'dates', finish: '2026-05-29', duration: 10 },
  };
  for (const [label, fields] of Object.entries(held)) {
    const tasks = firm(project('p', [task('A'), task('B', { ...fields, deps: [dep('A', 'SF', -5)] })]));
    const b = tasks.get('B');
    assert.deepEqual(b.conflicts, ['A'], label);
    assert.equal(b.health, 'at_risk', label);
    assert.ok(b.links[0].buffer > 0, label);
    assert.equal(b.critical, true, `${label}: already past the rule, so no float`);
    assert.equal(b.float, 0, label);
  }
});

test('another predecessor pushing it past the rule is a conflict', () => {
  const tasks = firm(project('p', [
    task('A'),
    task('X', { start: '2026-05-25', duration: 5 }),
    task('B', { startSet: false, duration: 2, deps: [dep('A', 'SF', -5), dep('X', 'FS', 0)] }),
  ]));
  assert.deepEqual(tasks.get('B').conflicts, ['A']);
  assert.equal(tasks.get('B').driverId, 'X');
});

test('at or ahead of the rule is no conflict, as by the rule it is the latest date', () => {
  // A manual date earlier than required breaks the link the other way, as for any link.
  const on = firm(project('p', [task('A'), task('B', { startSet: false, deps: [dep('A', 'SS', -5)] })]));
  assert.deepEqual(on.get('B').conflicts, []);
  const early = firm(project('p', [task('A'), task('B', { start: '2026-03-02', manual: true, deps: [dep('A', 'SS', -5)] })]));
  assert.deepEqual(early.get('B').conflicts, ['A']);
});

test('what leads to the earlier task is held by the rule too', () => {
  const tasks = firm(project('p', [
    task('X', { start: '2026-03-02', duration: 5 }),
    task('A', { start: '2026-06-01' }),
    task('B', { startSet: false, deps: [dep('A', 'SF', -30), dep('X', 'FS', 0)] }),
  ]));
  // B sits where the rule says, leaving X some room before it would push B past it.
  const gap = makeCalendar().diff(toDayNumber(tasks.get('X').end), toDayNumber(tasks.get('B').start)) - 1;
  assert.equal(tasks.get('B').critical, true);
  assert.equal(tasks.get('X').float, gap);
});

test('firm links chain', () => {
  const tasks = firm(project('p', [
    task('A', { duration: 5 }),
    task('B', { startSet: false, deps: [dep('A', 'SF', -10)] }),
    task('C', { startSet: false, deps: [dep('B', 'SS', -10)] }),
    task('D', { startSet: false, deps: [dep('C', 'SF', -5)] }),
  ]));
  assert.deepEqual(view(tasks, 'A', 'B', 'C', 'D'), { A: [0, true], B: [0, true], C: [0, true], D: [0, true] });
});

test('other kinds of link are left as they were', () => {
  for (const [type, lag] of [['FS', -30], ['FF', -30], ['SS', 0], ['SF', 0], ['SS', 5], ['SF', 5]]) {
    const plan = () => project('p', [
      task('A'),
      task('L', { duration: 60 }),
      task('B', { start: '2026-08-03', duration: 2, deps: [dep('A', type, lag)] }),
    ]);
    const one = firm(plan());
    const other = standard(plan());
    for (const id of ['A', 'B', 'L']) {
      assert.deepEqual([one.get(id).float, one.get(id).critical, one.get(id).conflicts], [other.get(id).float, other.get(id).critical, other.get(id).conflicts], `${type} ${lag} ${id}`);
    }
    assert.equal(one.get('B').links[0].firm, false);
  }
});

test('a completed task never shows a conflict or goes critical', () => {
  const tasks = firm(project('p', [
    task('A'),
    task('B', { start: '2026-05-25', status: 'complete', progress: 100, deps: [dep('A', 'SF', -5)] }),
  ]));
  assert.deepEqual(tasks.get('B').conflicts, []);
  assert.equal(tasks.get('B').critical, false);
});

test('a firm link on a summary: SS is about its first subtask, SF about its last', () => {
  const ss = firm(project('p', [
    task('A'),
    task('S', { deps: [dep('A', 'SS', -5)] }),
    task('first', { parentId: 'S', startSet: false }),
    task('later', { parentId: 'S', start: '2026-05-29' }),
  ]));
  assert.deepEqual(ss.get('S').conflicts, []);
  assert.equal(ss.get('first').critical, true);
  assert.equal(ss.get('later').critical, false);

  const sf = firm(project('p', [
    task('A'),
    task('S', { deps: [dep('A', 'SF', -5)] }),
    task('on', { parentId: 'S', startSet: false }),
    task('past', { parentId: 'S', start: '2026-05-25', duration: 5 }),
  ]));
  assert.deepEqual(sf.get('S').conflicts, ['A'], 'its last subtask runs past the rule');
  assert.equal(sf.get('S').health, 'at_risk');
  assert.ok(sf.get('S').links[0].buffer > 0);
});

test('a firm link on a summary predecessor follows the summary start', () => {
  const tasks = firm(project('p', [
    task('S'),
    task('k1', { parentId: 'S', start: '2026-06-01' }),
    task('k2', { parentId: 'S', start: '2026-06-15' }),
    task('B', { startSet: false, deps: [dep('S', 'SF', -5)] }),
  ]));
  assert.deepEqual(tasks.get('B').conflicts, []);
  assert.equal(tasks.get('B').float, tasks.get('k1').float);
});

test('across projects the rule and the conflict are the same, and the Links tab says so', () => {
  const on = computeSchedule([
    project('one', [task('A')]),
    project('two', [task('B', { startSet: false, deps: [dep('A', 'SF', -30)] })]),
  ], TODAY);
  assert.equal(on.crossLinks[0].state, 'driving');
  assert.equal(on.crossLinks[0].firm, true);
  const over = computeSchedule([
    project('one', [task('A')]),
    project('two', [task('B', { start: '2026-05-25', deps: [dep('A', 'SF', -30)] })]),
  ], TODAY);
  assert.equal(over.crossLinks[0].state, 'conflict');
  const off = computeSchedule([
    project('one', [task('A')]),
    project('two', [task('B', { start: '2026-05-25', deps: [dep('A', 'SF', -30)] })]),
  ], TODAY, { firmLeads: false });
  assert.equal(off.crossLinks[0].state, 'buffer');
  assert.equal(off.crossLinks[0].firm, false);
});

test('with different calendars, the rule is counted in the earlier task’s calendar', () => {
  const tasks = firm(
    project('one', [task('A', { start: '2026-06-06', duration: 3 })], { workWeekends: true }),
    project('two', [task('B', { startSet: false, deps: [dep('A', 'SF', -10)] })]),
  );
  assert.equal(tasks.get('A').critical, true);
  assert.deepEqual(tasks.get('B').conflicts, []);
  assert.equal(tasks.get('B').float, 0);
});

// Random plans with firm links everywhere: the rule itself, checked by real slips.
function randomSource(seed) {
  let s = seed;
  return (n) => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) % n;
  };
}

function randomPlan(seed) {
  const random = randomSource(seed);
  const tasks = [];
  const count = 3 + random(7);
  for (let i = 0; i < count; i++) {
    const deps = tasks.filter(() => random(3) === 0).map((t) => dep(t.id, ['SS', 'SF', 'FS', 'FF'][random(4)], [-30, -10, -3, 0, 3, 10][random(6)]));
    tasks.push(task(`t${i}`, {
      start: `2026-0${3 + random(6)}-${String(1 + random(27)).padStart(2, '0')}`,
      duration: 1 + random(30),
      startSet: random(4) !== 0 ? false : true,
      deps,
    }));
  }
  return [project('p', tasks)];
}

test('random plans: no negative float, critical means no float, no dates differ', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const projects = randomPlan(seed);
    const on = computeSchedule(projects, TODAY).tasks;
    const off = computeSchedule(projects, TODAY, { firmLeads: false }).tasks;
    for (const t of projects[0].tasks) {
      const c = on.get(t.id);
      const where = `seed ${seed}, ${t.id}`;
      assert.ok(c.float >= 0, where);
      assert.equal(c.critical, c.float === 0, where);
      assert.deepEqual([c.start, c.end], [off.get(t.id).start, off.get(t.id).end], where);
      assert.ok(c.float <= off.get(t.id).float, `firm links can only reduce float, ${where}`);
    }
  }
});

test('random plans: slipping a task within its float breaks nothing, if what it follows slips with it', () => {
  const cal = makeCalendar();
  for (let seed = 1; seed <= 300; seed++) {
    const projects = randomPlan(seed);
    const { tasks } = computeSchedule(projects, TODAY);
    const finish = (ts) => projects[0].tasks.map((t) => ts.get(t.id).end).sort().at(-1);
    const conflicted = (ts) => projects[0].tasks.filter((t) => ts.get(t.id).conflicts.length).length;
    if (conflicted(tasks)) continue; // only plans that start out sound
    for (const t of projects[0].tasks) {
      const { float } = tasks.get(t.id);
      const copy = structuredClone(projects);
      const byId = new Map(copy[0].tasks.map((x) => [x.id, x]));
      // Everything slips together by this task's float: the rule keeps its shape.
      for (const x of copy[0].tasks) {
        if (x.id !== t.id && !firmAncestors(t, projects[0].tasks).has(x.id)) continue;
        x.start = toIso(cal.add(toDayNumber(tasks.get(x.id).start), float));
        x.startSet = true;
      }
      const moved = computeSchedule(copy, TODAY).tasks;
      assert.ok(byId.has(t.id));
      assert.equal(finish(moved), finish(tasks), `seed ${seed}, ${t.id} by ${float}`);
    }
  }
});

function firmAncestors(start, all) {
  const seen = new Set();
  const walk = (t) => {
    for (const d of t.deps) {
      if (!isFirmLead(d) || seen.has(d.taskId)) continue;
      seen.add(d.taskId);
      walk(all.find((x) => x.id === d.taskId));
    }
  };
  walk(start);
  return seen;
}

test('the store and the setting: a saved plan turns firm and back, with no dates changed', () => {
  for (const firmLeads of [true, false]) {
    const store = new StoreCore({ firmLeads });
    const id = store.createProject({ name: 'P' });
    const a = store.createTask(id, { name: 'A', start: '2026-06-01' });
    const b = store.createTask(id, { name: 'B', deps: [{ taskId: a, type: 'SF', lag: -30 }] });
    const c = store.snapshot().projects[0].tasks.find((t) => t.id === b).computed;
    assert.equal(c.critical, firmLeads);
    assert.equal(c.links[0].firm, firmLeads);
    assert.equal(store.snapshot().firmLeads, firmLeads);
  }
});
