// The critical path and float, for every dependency type and lead or lag. The test of
// truth is brute force on the real scheduler: a task is critical when a one-working-day
// slip moves some project's finish, and its float is the most it can slip without that.

import test from 'node:test';
import assert from 'node:assert/strict';
import { computeSchedule, makeCalendar, toDayNumber, toIso } from '../public/shared/scheduler.js';

// By the standard definition. test/firm-links.test.js covers firm leads.
const STANDARD = { firmLeads: false };
const TODAY = '2026-01-05';
const TYPES = ['FS', 'SS', 'FF', 'SF'];
const LAGS = [-60, -45, -30, -20, -10, -5, -1, 0, 1, 5, 10, 20, 30, 45, 60];

const task = (id, fields = {}) => ({
  id, name: id, parentId: null, start: '2026-06-01', duration: 5, milestone: false, manual: false,
  status: 'not_started', progress: 0, deps: [], ...fields,
});
const dep = (taskId, type = 'FS', lag = 0) => ({ taskId, type, lag });
const project = (id, tasks, calendar = {}) => ({ id, name: id, calendar, tasks });
const schedule = (...projects) => computeSchedule(projects, TODAY, STANDARD).tasks;

const projectFinishes = (tasks, projects) => projects.map((p) => p.tasks
  .filter((t) => !tasks.get(t.id).isSummary)
  .map((t) => tasks.get(t.id).end).sort().at(-1));

// Every broken link and by how much, as "task<-predecessor:buffer", leaving out those on
// one task.
const brokenLinks = (tasks, projects, except) => projects.flatMap((p) => p.tasks)
  .filter((t) => t.id !== except && !tasks.get(t.id).isSummary)
  .flatMap((t) => {
    const c = tasks.get(t.id);
    return c.conflicts.map((pred) => `${t.id}<-${pred}:${c.links.find((l) => l.taskId === pred)?.buffer}`);
  })
  .sort();
// Total days those links are short by.
const shortBy = (broken) => broken.reduce((sum, entry) => sum - Number(entry.split(':').at(-1)), 0);

// Checks every open task against what actually happens when it slips. A slip matters
// when it moves a project's finish or breaks a link into a task that won't move for it.
// Negative float is how far a task must come earlier to mend the links it breaks.
function assertMatchesSlips(projects, label) {
  const result = computeSchedule(projects, TODAY, STANDARD);
  if (result.cycle) return 0;
  let checked = 0;
  for (const p of projects) {
    const cal = makeCalendar(p.calendar);
    for (const t of p.tasks) {
      const c = result.tasks.get(t.id);
      if (c.isSummary || t.status === 'complete' || t.manual) continue;
      const slipped = (days) => {
        const copy = structuredClone(projects);
        const moved = copy.flatMap((q) => q.tasks).find((x) => x.id === t.id);
        moved.start = toIso(cal.add(toDayNumber(c.start), days));
        moved.startSet = true;
        if (moved.trackBy === 'dates') moved.finish = toIso(cal.add(toDayNumber(c.end), days));
        const tasks = computeSchedule(copy, TODAY, STANDARD).tasks;
        // A task tracked by dates can break its own links by coming earlier, which isn't
        // what its float measures.
        return { start: tasks.get(t.id).start, finishes: projectFinishes(tasks, copy), broken: brokenLinks(tasks, copy, t.id) };
      };
      const where = `${label}: ${t.id}, float ${c.float}`;
      assert.equal(c.critical, c.float <= 0, where);
      const now = slipped(0);
      const effect = ({ finishes, broken }) => ({ finishes, broken });
      if (c.float >= 0) {
        assert.deepEqual(effect(slipped(c.float)), effect(now), `slipping by its float moved a finish or broke a link, ${where}`);
        assert.notDeepEqual(effect(slipped(c.float + 1)), effect(now), `one day past its float did nothing, ${where}`);
      } else {
        // It breaks a link into a task that won't move. Coming earlier by its float makes
        // that link less short, unless its own links hold it where it is. It may not mend
        // it, since another subtask of a summary can be breaking the same link, and coming
        // earlier still can help a task further on that shows its own negative float.
        assert.ok(now.broken.length > 0, `negative float with no broken link, ${where}`);
        const at = slipped(c.float);
        if (at.start === toIso(cal.add(toDayNumber(c.start), c.float))) {
          assert.ok(shortBy(at.broken) < shortBy(now.broken), `coming earlier by its float mended nothing, ${where}`);
          assert.notDeepEqual(slipped(c.float + 1).broken, at.broken, `one day short of its float mended as much, ${where}`);
        }
      }
      checked++;
    }
  }
  return checked;
}

// ---- hand-worked examples ------------------------------------------------------------

const flags = (tasks, ...ids) => Object.fromEntries(ids.map((id) => [id, [tasks.get(id).float, tasks.get(id).critical]]));

test('SF -30: the predecessor ends the project, so the earlier successor has float', () => {
  const tasks = schedule(project('p', [task('A'), task('B', { startSet: false, deps: [dep('A', 'SF', -30)] })]));
  assert.deepEqual([tasks.get('B').start, tasks.get('B').end], ['2026-04-13', '2026-04-17']);
  // B may finish as late as the project does: Apr 17 to Jun 5 is 35 working days.
  assert.deepEqual(flags(tasks, 'A', 'B'), { A: [0, true], B: [35, false] });
});

test('SF -30: when the successor leads on to the finish, the predecessor is critical too', () => {
  const tasks = schedule(project('p', [
    task('A'),
    task('B', { startSet: false, deps: [dep('A', 'SF', -30)] }),
    task('C', { startSet: false, duration: 80, deps: [dep('B')] }),
  ]));
  // A's start sets B, B sets C, and C ends the project, though A sits later than B on the page.
  assert.deepEqual(flags(tasks, 'A', 'B', 'C'), { A: [0, true], B: [0, true], C: [0, true] });
});

test('SF -30: everything has float when another task ends the project', () => {
  const tasks = schedule(project('p', [
    task('A'),
    task('B', { startSet: false, deps: [dep('A', 'SF', -30)] }),
    task('L', { duration: 40 }),
  ]));
  assert.deepEqual(flags(tasks, 'A', 'B', 'L'), { A: [35, false], B: [70, false], L: [0, true] });
});

test('the same two tasks, by type, with the successor ending the project', () => {
  // A: Jun 1 to 5. The successor is 40 days long, so it runs past A and ends the project,
  // and every type passes a slip in A on to it.
  for (const type of TYPES) {
    for (const lag of [-30, -5, 0, 5, 30]) {
      const tasks = schedule(project('p', [
        task('A'),
        task('B', { startSet: false, duration: 80, deps: [dep('A', type, lag)] }),
      ]));
      if (tasks.get('B').end > tasks.get('A').end) {
        assert.deepEqual(flags(tasks, 'A', 'B'), { A: [0, true], B: [0, true] }, `${type} ${lag}`);
      }
    }
  }
});

test('a set start later than the link needs takes the predecessor off the path', () => {
  for (const type of TYPES) {
    for (const lag of [-30, 0, 30]) {
      const tasks = schedule(project('p', [
        task('A'),
        task('B', { start: '2027-01-04', duration: 10, deps: [dep('A', type, lag)] }),
      ]));
      assert.equal(tasks.get('B').critical, true, `${type} ${lag}`);
      assert.equal(tasks.get('A').critical, false, `${type} ${lag}`);
    }
  }
});

test('by the standard, a saved plan with an SF -30 link on a task tracked by dates', () => {
  // test3 runs Jan 19 to 25, test1 follows at FS +10, and test2 has fixed dates and
  // an SF -30 link on test1, which requires it to finish no earlier than Dec 28.
  const tasks = schedule(project('p', [
    task('overall', { startSet: false }),
    task('test1', { parentId: 'overall', start: '2027-01-13', duration: 4, deps: [dep('test3', 'FS', 10)] }),
    task('test2', { parentId: 'overall', start: '2026-12-17', trackBy: 'dates', finish: '2027-01-13', duration: 20, deps: [dep('test1', 'SF', -30)] }),
    task('test3', { parentId: 'overall', start: '2027-01-19', startSet: false }),
  ]));
  assert.deepEqual([tasks.get('test1').start, tasks.get('test1').end], ['2027-02-09', '2027-02-12']);
  assert.deepEqual(flags(tasks, 'test1', 'test2', 'test3'), { test1: [0, true], test2: [22, false], test3: [0, true] });
  assert.deepEqual(tasks.get('test2').conflicts, []);
  // It finishes 18 working days before test1 starts, 12 fewer than the 30 in the link, so
  // it's 12 later than required: Dec 28 to Jan 13, with no holidays in this calendar.
  assert.deepEqual(tasks.get('test2').links, [{ taskId: 'test1', buffer: 12, firm: false }]);
});

test('to make a task hold up another by 30 days, link it the other way round', () => {
  // "test2 must finish 30 days before test1 starts" as a real requirement on test1.
  const tasks = schedule(project('p', [
    task('test2', { start: '2026-12-17', duration: 20 }),
    task('test1', { startSet: false, duration: 4, deps: [dep('test2', 'FS', 30)] }),
  ]));
  assert.deepEqual(flags(tasks, 'test1', 'test2'), { test1: [0, true], test2: [0, true] });
});

// ---- links into tasks that won't move -----------------------------------------------------

test('a task feeding a fixed-date task has no more float than that link allows', () => {
  // The CSP V3 plan: Flight Test 2 has fixed dates and ends the project, Aircraft
  // Integration must finish before it starts, and so must Flight Orders.
  const cal = { durationUnit: 'calendar' };
  const lag = (taskId) => ({ ...dep(taskId), lagUnit: 'calendar' });
  const tasks = schedule(project('p', [
    task('phase', { startSet: false }),
    task('ft2', { ...cal, parentId: 'phase', start: '2027-01-20', trackBy: 'dates', finish: '2027-01-29', duration: 10, manual: true, deps: [lag('orders'), lag('integration')] }),
    task('integration', { ...cal, parentId: 'phase', start: '2027-01-18', duration: 2, manual: true }),
    task('orders', { ...cal, parentId: 'phase', start: '2026-11-30', duration: 14, manual: true }),
  ]));
  // Before, both were measured against the project finish: 10 and 47 days.
  assert.deepEqual(flags(tasks, 'integration', 'orders', 'ft2'), { integration: [0, true], orders: [37, false], ft2: [0, true] });
});

for (const [label, fields] of [['set by hand', { manual: true }], ['tracked by dates', { trackBy: 'dates', finish: '2026-06-12' }]]) {
  test(`a task breaking a link into a task ${label} has negative float`, () => {
    const tasks = schedule(project('p', [
      task('A', { duration: 10 }), // Jun 1 to 12
      task('B', { start: '2026-06-08', duration: 5, ...fields, deps: [dep('A')] }),
      task('C', { duration: 30 }), // ends the project, so B has room of its own
    ]));
    assert.deepEqual(tasks.get('B').conflicts, ['A']);
    // A must finish by Jun 5 for B to start on Jun 8: it is 5 working days behind.
    assert.deepEqual(flags(tasks, 'A'), { A: [-5, true] });
  });
}

test('a complete task no longer limits the tasks before it', () => {
  const tasks = schedule(project('p', [
    task('A', { duration: 10 }),
    task('B', { start: '2026-06-08', duration: 5, manual: true, status: 'complete', progress: 100, deps: [dep('A')] }),
    task('C', { duration: 30 }),
  ]));
  assert.deepEqual(flags(tasks, 'A'), { A: [20, false] });
});

// ---- how much room a link has -----------------------------------------------------------

test('every link reports its buffer, for every type and lag', () => {
  for (const type of TYPES) {
    for (const lag of LAGS) {
      const follow = schedule(project('p', [task('A'), task('B', { startSet: false, deps: [dep('A', type, lag)] })]));
      assert.deepEqual(follow.get('B').links, [{ taskId: 'A', buffer: 0, firm: false }], `${type} ${lag} following`);

      const required = follow.get('B').start;
      const late = toIso(makeCalendar().add(toDayNumber(required), 7));
      const held = schedule(project('p', [task('A'), task('B', { start: late, deps: [dep('A', type, lag)] })]));
      assert.deepEqual(held.get('B').links, [{ taskId: 'A', buffer: 7, firm: false }], `${type} ${lag} held later`);

      const early = toIso(makeCalendar().add(toDayNumber(required), -7));
      const broken = schedule(project('p', [task('A'), task('B', { start: early, manual: true, deps: [dep('A', type, lag)] })]));
      assert.deepEqual(broken.get('B').links, [{ taskId: 'A', buffer: -7, firm: false }], `${type} ${lag} broken`);
    }
  }
});

test('a summary reports the buffer of its tightest subtask', () => {
  const tasks = schedule(project('p', [
    task('A'),
    task('S', { deps: [dep('A', 'SS', -5)] }),
    task('held', { parentId: 'S', startSet: false }),
    task('later', { parentId: 'S', start: '2026-12-01' }),
  ]));
  assert.deepEqual(tasks.get('S').links, [{ taskId: 'A', buffer: 0, firm: false }]);
});

// ---- summary tasks as predecessors --------------------------------------------------------

for (const type of ['SS', 'SF']) {
  test(`${type} on a summary: subtasks sharing the first start don't drive it alone`, () => {
    const tasks = schedule(project('p', [
      task('S'),
      task('k1', { parentId: 'S', start: '2026-06-01', duration: 5 }),
      task('k2', { parentId: 'S', start: '2026-06-01', duration: 5 }),
      task('B', { startSet: false, deps: [dep('S', type, -30)] }),
      task('C', { startSet: false, duration: 120, deps: [dep('B')] }),
    ]));
    // Slipping either one leaves the other holding the summary's start.
    assert.equal(tasks.get('C').critical, true);
    assert.equal(tasks.get('k1').critical, false);
    assert.equal(tasks.get('k2').critical, false);
  });

  test(`${type} on a summary: a first subtask alone drives it, until the next one starts`, () => {
    const tasks = schedule(project('p', [
      task('S'),
      task('k1', { parentId: 'S', start: '2026-06-01', duration: 5 }),
      task('k2', { parentId: 'S', start: '2026-06-08', duration: 5 }),
      task('B', { startSet: false, deps: [dep('S', type, -30)] }),
      task('C', { startSet: false, duration: 120, deps: [dep('B')] }),
    ]));
    assert.equal(tasks.get('k1').critical, true);
    assert.equal(tasks.get('k2').critical, false);
  });
}

test('FS and FF on a summary: only a subtask finishing last can drive it', () => {
  for (const type of ['FS', 'FF']) {
    const tasks = schedule(project('p', [
      task('S'),
      task('short', { parentId: 'S', duration: 2 }),
      task('long', { parentId: 'S', duration: 9 }),
      task('B', { startSet: false, duration: 90, deps: [dep('S', type, -5)] }),
    ]));
    assert.equal(tasks.get('long').critical, true, type);
    assert.equal(tasks.get('short').critical, false, type);
    assert.equal(tasks.get('short').float, 7, type);
  }
});

// ---- every type and large lag, by brute force ---------------------------------------------

test('every type with lag from -60 to +60 matches a real slip, two tasks', () => {
  for (const type of TYPES) {
    for (const lag of LAGS) {
      for (const [a, b] of [[5, 3], [3, 5], [1, 1], [8, 40], [40, 8]]) {
        for (const startSet of [false, true]) {
          assertMatchesSlips([project('p', [
            task('A', { duration: a }),
            task('B', { start: '2026-03-02', startSet, duration: b, deps: [dep('A', type, lag)] }),
          ])], `${type} ${lag} ${a}/${b} startSet ${startSet}`);
        }
      }
    }
  }
});

test('every pair of types with large leads and lags matches a real slip, three tasks', () => {
  for (const first of TYPES) {
    for (const second of TYPES) {
      for (const lag1 of [-30, -5, 0, 5, 30]) {
        for (const lag2 of [-30, -5, 0, 5, 30]) {
          assertMatchesSlips([project('p', [
            task('A', { duration: 12 }),
            task('B', { startSet: false, duration: 7, deps: [dep('A', first, lag1)] }),
            task('C', { startSet: false, duration: 30, deps: [dep('B', second, lag2)] }),
          ])], `${first} ${lag1} then ${second} ${lag2}`);
        }
      }
    }
  }
});

test('every type with large lag matches a real slip across different calendars', () => {
  const calendars = [{}, { workWeekends: true }, { holidays: ['2026-05-25', '2026-06-08', '2026-04-03'] }];
  for (const type of TYPES) {
    for (const lag of [-45, -30, -1, 0, 1, 30, 45]) {
      for (const from of calendars) {
        for (const to of calendars) {
          assertMatchesSlips([
            project('one', [task('A', { duration: 8 })], from),
            project('two', [task('B', { startSet: false, duration: 12, deps: [dep('A', type, lag)] })], to),
          ], `${type} ${lag} ${JSON.stringify(from)} to ${JSON.stringify(to)}`);
        }
      }
    }
  }
});

function randomSource(seed) {
  let s = seed;
  return (n) => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) % n;
  };
}

// A random plan using everything a task can be. Repeatable from its seed.
function randomPlan(seed, { calendars = [{}], summaries = false, dates = false }) {
  const random = randomSource(seed);
  const projects = calendars.map((calendar, i) => project(`p${i}`, [], calendar));
  const ids = [];
  const link = (id) => dep(id, TYPES[random(4)], LAGS[random(LAGS.length)]);
  if (summaries) for (const p of projects) p.tasks.push(task(`s-${p.id}`));
  const count = 3 + random(7);
  for (let i = 0; i < count; i++) {
    const deps = ids.filter(() => random(3) === 0).map(link);
    if (summaries && random(5) === 0) deps.push(link(`s-${projects[0].id}`));
    const p = projects[random(projects.length)];
    const milestone = random(7) === 0;
    const fields = {
      start: `2026-0${3 + random(6)}-${String(1 + random(27)).padStart(2, '0')}`,
      duration: milestone ? 0 : 1 + random(40),
      milestone,
      deps,
      startSet: random(2) === 0,
      parentId: summaries && random(3) === 0 && !deps.some((d) => d.taskId.startsWith('s-')) ? `s-${p.id}` : null,
    };
    if (dates && !milestone && random(4) === 0) {
      fields.trackBy = 'dates';
      fields.startSet = true;
      fields.finish = toIso(toDayNumber(fields.start) + fields.duration);
    }
    p.tasks.push(task(`t${i}`, fields));
    ids.push(`t${i}`);
  }
  for (const p of projects) {
    if (!p.tasks.some((t) => t.parentId === `s-${p.id}`)) p.tasks = p.tasks.filter((t) => t.id !== `s-${p.id}`);
  }
  const known = new Set(projects.flatMap((p) => p.tasks.map((t) => t.id)));
  for (const t of projects.flatMap((p) => p.tasks)) t.deps = t.deps.filter((d) => known.has(d.taskId));
  return projects;
}

for (const [label, options] of [
  ['one project', {}],
  ['two projects', { calendars: [{}, {}] }],
  ['different calendars', { calendars: [{}, { workWeekends: true }] }],
  ['holidays', { calendars: [{ holidays: ['2026-05-25', '2026-07-03'] }, {}] }],
  ['tasks tracked by dates', { dates: true }],
  ['summary tasks', { summaries: true }],
  ['all of it', { calendars: [{}, { workWeekends: true }], summaries: true, dates: true }],
]) {
  test(`random plans with large leads and lags match real slips: ${label}`, () => {
    let checked = 0;
    for (let seed = 1; seed <= 200; seed++) checked += assertMatchesSlips(randomPlan(seed, options), `seed ${seed}`);
    assert.ok(checked > 400, `only ${checked} tasks were checked`);
  });
}
