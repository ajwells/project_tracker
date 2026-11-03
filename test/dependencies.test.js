// Dependency behaviour for every type (FS, SS, FF, SF) and for positive, zero and
// negative lag. Expected dates come from hand-worked tables and from a small
// working-day list built here, never from the scheduler's own calendar code, so
// a calendar bug cannot hide by agreeing with itself.

import test from 'node:test';
import assert from 'node:assert/strict';
import { computeSchedule } from '../public/shared/scheduler.js';
import { HttpError, StoreCore } from '../public/shared/store-core.js';
import { depSuffix } from '../public/js/util.js';

// By the standard definition. test/firm-links.test.js covers firm leads.
const STANDARD = { firmLeads: false };
const TODAY = '2026-01-05';
const EARLY = '2024-06-03'; // far enough back that the requested start never decides
const TYPES = ['FS', 'SS', 'FF', 'SF'];

const task = (id, fields = {}) => ({
  id,
  name: id,
  parentId: null,
  start: EARLY,
  duration: 3,
  milestone: false,
  manual: false,
  status: 'not_started',
  progress: 0,
  deps: [],
  ...fields,
});
const dep = (taskId, type = 'FS', lag = 0) => ({ taskId, type, lag });
const project = (id, tasks, calendar = {}) => ({ id, name: id, calendar, tasks });
const run = (...projects) => computeSchedule(projects, TODAY, STANDARD);
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

// ---- an independent working-day calendar --------------------------------------

const calendarLists = new Map();

function workingDays(calendar = {}) {
  const key = JSON.stringify(calendar);
  if (!calendarLists.has(key)) calendarLists.set(key, buildWorkingDays(calendar));
  return calendarLists.get(key);
}

function buildWorkingDays({ workWeekends = false, holidays = [] } = {}) {
  const list = [];
  for (let t = Date.UTC(2023, 0, 1); t <= Date.UTC(2029, 11, 31); t += 86400000) {
    const d = new Date(t);
    const iso = d.toISOString().slice(0, 10);
    const weekend = d.getUTCDay() === 0 || d.getUTCDay() === 6;
    if (!holidays.includes(iso) && (workWeekends || !weekend)) list.push(iso);
  }
  const positions = new Map(list.map((iso, i) => [iso, i]));
  return {
    at: (i) => list[i],
    // Position of a working day, or of the next one after a day off.
    onOrAfter(iso) {
      let i = positions.get(iso);
      for (let t = Date.parse(iso); i === undefined; ) {
        t += 86400000;
        i = positions.get(new Date(t).toISOString().slice(0, 10));
      }
      return i;
    },
  };
}

// Where the successor must sit, in positions on the working-day list.
//   FS: starts the working day after the predecessor finishes, plus lag
//   SS: starts when the predecessor starts, plus lag
//   FF: finishes when the predecessor finishes, plus lag
//   SF: finishes the working day before the predecessor starts, plus lag
function expectedPosition(type, lag, predStart, predEnd, succDuration) {
  const span = succDuration - 1;
  if (type === 'FS') return predEnd + 1 + lag;
  if (type === 'SS') return predStart + lag;
  if (type === 'FF') return predEnd + lag - span;
  return predStart - 1 + lag - span;
}

// ---- hand-worked dates ---------------------------------------------------------

// Predecessor: Wed 14 Jan to Tue 20 Jan 2026 (5 working days, over a weekend).
// Successor: 3 working days. Each row is [lag, start, finish].
const HAND_WORKED = {
  FS: [
    [-10, '2026-01-07', '2026-01-09'],
    [-5, '2026-01-14', '2026-01-16'],
    [-3, '2026-01-16', '2026-01-20'],
    [-2, '2026-01-19', '2026-01-21'],
    [-1, '2026-01-20', '2026-01-22'],
    [0, '2026-01-21', '2026-01-23'],
    [1, '2026-01-22', '2026-01-26'],
    [2, '2026-01-23', '2026-01-27'],
    [3, '2026-01-26', '2026-01-28'],
    [5, '2026-01-28', '2026-01-30'],
  ],
  SS: [
    [-10, '2025-12-31', '2026-01-02'],
    [-5, '2026-01-07', '2026-01-09'],
    [-3, '2026-01-09', '2026-01-13'],
    [-2, '2026-01-12', '2026-01-14'],
    [-1, '2026-01-13', '2026-01-15'],
    [0, '2026-01-14', '2026-01-16'],
    [1, '2026-01-15', '2026-01-19'],
    [2, '2026-01-16', '2026-01-20'],
    [3, '2026-01-19', '2026-01-21'],
    [5, '2026-01-21', '2026-01-23'],
  ],
  FF: [
    [-10, '2026-01-02', '2026-01-06'],
    [-5, '2026-01-09', '2026-01-13'],
    [-3, '2026-01-13', '2026-01-15'],
    [-2, '2026-01-14', '2026-01-16'],
    [-1, '2026-01-15', '2026-01-19'],
    [0, '2026-01-16', '2026-01-20'],
    [1, '2026-01-19', '2026-01-21'],
    [2, '2026-01-20', '2026-01-22'],
    [3, '2026-01-21', '2026-01-23'],
    [5, '2026-01-23', '2026-01-27'],
  ],
  SF: [
    [-10, '2025-12-26', '2025-12-30'],
    [-5, '2026-01-02', '2026-01-06'],
    [-3, '2026-01-06', '2026-01-08'],
    [-2, '2026-01-07', '2026-01-09'],
    [-1, '2026-01-08', '2026-01-12'],
    [0, '2026-01-09', '2026-01-13'],
    [1, '2026-01-12', '2026-01-14'],
    [2, '2026-01-13', '2026-01-15'],
    [3, '2026-01-14', '2026-01-16'],
    [5, '2026-01-16', '2026-01-20'],
  ],
};

for (const type of TYPES) {
  test(`${type}: hand-worked dates for lag from -10 to +5`, () => {
    for (const [lag, start, end] of HAND_WORKED[type]) {
      const { tasks } = run(project('p', [
        task('a', { start: '2026-01-14', duration: 5 }),
        task('b', { deps: [dep('a', type, lag)] }),
      ]));
      assert.deepEqual([tasks.get('b').start, tasks.get('b').end], [start, end], `${type} lag ${lag}`);
    }
  });
}

test('negative lag crosses a holiday as well as a weekend', () => {
  // Predecessor Mon 12 to Fri 16 Jan. Wed 14 is a holiday, so it finishes Mon 19.
  const calendar = { holidays: ['2026-01-14'] };
  const expected = {
    // Finish Mon 19, back 2 working days past the weekend: start Fri 16.
    FS: ['2026-01-16', '2026-01-16'],
    // Start Mon 12, back 2 working days: Thu 8.
    SS: ['2026-01-08', '2026-01-08'],
    // Finish Mon 19, back 2 working days: Thu 15.
    FF: ['2026-01-15', '2026-01-15'],
    // Day before start is Fri 9, back 2 more: Wed 7.
    SF: ['2026-01-07', '2026-01-07'],
  };
  for (const type of TYPES) {
    const { tasks } = run(project('p', [
      task('a', { start: '2026-01-12', duration: 5 }),
      task('b', { duration: 1, deps: [dep('a', type, -2)] }),
    ], calendar));
    assert.equal(tasks.get('a').end, '2026-01-19');
    assert.deepEqual([tasks.get('b').start, tasks.get('b').end], expected[type], type);
  }
});

// ---- every combination, checked against the independent calendar -----------------

const CALENDARS = {
  'Monday to Friday': {},
  'seven days a week': { workWeekends: true },
  'with holidays': { holidays: ['2026-01-01', '2026-01-19', '2026-01-20', '2026-02-16', '2026-03-03'] },
};

for (const [label, calendar] of Object.entries(CALENDARS)) {
  test(`every type and lag from -15 to +15 lands correctly, ${label}`, () => {
    const days = workingDays(calendar);
    // Every day of a week, so predecessors start and finish on all weekdays.
    const predStarts = range(12, 18).map((d) => `2026-01-${d}`);
    for (const type of TYPES) {
      for (const lag of range(-15, 15)) {
        for (const predStart of predStarts) {
          for (const predDuration of [1, 2, 5, 9]) {
            for (const succDuration of [1, 2, 5, 9]) {
              const { tasks } = run(project('p', [
                task('a', { start: predStart, duration: predDuration }),
                task('b', { duration: succDuration, deps: [dep('a', type, lag)] }),
              ], calendar));
              const first = days.onOrAfter(predStart);
              const start = expectedPosition(type, lag, first, first + predDuration - 1, succDuration);
              const where = `${type} lag ${lag}, predecessor ${predStart} for ${predDuration}d, successor ${succDuration}d`;
              assert.equal(tasks.get('b').start, days.at(start), `start: ${where}`);
              assert.equal(tasks.get('b').end, days.at(start + succDuration - 1), `finish: ${where}`);
            }
          }
        }
      }
    }
  });
}

test('each extra day of lag moves the successor exactly one working day, including through zero', () => {
  const days = workingDays();
  for (const type of TYPES) {
    let previous = null;
    for (const lag of range(-12, 12)) {
      const { tasks } = run(project('p', [
        task('a', { start: '2026-01-14', duration: 5 }),
        task('b', { deps: [dep('a', type, lag)] }),
      ]));
      const position = days.onOrAfter(tasks.get('b').start);
      if (previous !== null) assert.equal(position, previous + 1, `${type} from lag ${lag - 1} to ${lag}`);
      previous = position;
    }
  }
});

test('a chain of two links adds up, for every pair of types with negative lag', () => {
  const days = workingDays();
  for (const first of TYPES) {
    for (const second of TYPES) {
      const { tasks } = run(project('p', [
        task('a', { start: '2026-02-02', duration: 4 }),
        task('b', { duration: 3, deps: [dep('a', first, -2)] }),
        task('c', { duration: 2, deps: [dep('b', second, -1)] }),
      ]));
      const a = days.onOrAfter('2026-02-02');
      const b = expectedPosition(first, -2, a, a + 3, 3);
      const c = expectedPosition(second, -1, b, b + 2, 2);
      assert.equal(tasks.get('b').start, days.at(b), `b in ${first}-2 then ${second}-1`);
      assert.equal(tasks.get('c').start, days.at(c), `c in ${first}-2 then ${second}-1`);
    }
  }
});

test('with several predecessors the latest requirement wins and is named as the driver', () => {
  const { tasks } = run(project('p', [
    task('a', { start: '2026-01-05', duration: 5 }), // finishes Fri 9
    task('z', { start: '2026-01-19', duration: 5 }), // starts Mon 19, finishes Fri 23
    task('fs', { duration: 1, deps: [dep('a', 'FS', -2), dep('z', 'SS', -1)] }),
    task('ff', { duration: 1, deps: [dep('z', 'FF', -3), dep('a', 'FF', 4)] }),
    task('sf', { duration: 1, deps: [dep('z', 'SF', -2), dep('a', 'SF', -1)] }),
  ]));
  assert.equal(tasks.get('fs').start, '2026-01-16'); // SS-1 from z beats FS-2 from a
  assert.equal(tasks.get('fs').driverId, 'z');
  assert.equal(tasks.get('ff').start, '2026-01-20'); // FF-3 from z beats FF+4 from a
  assert.equal(tasks.get('ff').driverId, 'z');
  assert.equal(tasks.get('sf').start, '2026-01-14'); // SF-2 from z beats SF-1 from a
  assert.equal(tasks.get('sf').driverId, 'z');
});

test('the successor follows its predecessor forward and back, whatever the type and lag', () => {
  const days = workingDays();
  for (const type of TYPES) {
    for (const lag of [-4, -1, 0, 3]) {
      const schedule = (start) => run(project('p', [
        task('a', { start, duration: 5 }),
        task('b', { deps: [dep('a', type, lag)] }),
      ])).tasks.get('b').start;
      const before = days.onOrAfter(schedule('2026-01-12'));
      assert.equal(days.onOrAfter(schedule('2026-01-19')), before + 5, `${type} ${lag} after a slip`);
      assert.equal(days.onOrAfter(schedule('2026-01-12')), before, `${type} ${lag} after moving back`);
    }
  }
});

// ---- the requested start -------------------------------------------------------

test('a link only ever delays: a requested start later than the link allows is kept', () => {
  // The README's rule: "A task starts on the date you ask for, or later if its
  // predecessors require it." So a task never moves earlier because of a link.
  for (const type of TYPES) {
    for (const lag of [-5, -1, 0]) {
      const { tasks } = run(project('p', [
        task('a', { start: '2026-01-05', duration: 5 }),
        task('b', { start: '2026-03-02', deps: [dep('a', type, lag)] }),
      ]));
      assert.equal(tasks.get('b').start, '2026-03-02', `${type} ${lag}`);
      assert.equal(tasks.get('b').driverId, null, `${type} ${lag}`);
      assert.equal(tasks.get('b').delay, 0, `${type} ${lag}`);
    }
  }
});

test('tasks requesting the same start: which links change anything', () => {
  // Two new tasks both default to today, so this is what people see first.
  const dates = {};
  for (const type of TYPES) {
    for (const lag of [-2, 0]) {
      const { tasks } = run(project('p', [
        task('a', { start: '2026-01-12', duration: 5 }),
        task('b', { start: '2026-01-12', duration: 5, deps: [dep('a', type, lag)] }),
      ]));
      dates[`${type}${lag}`] = tasks.get('b').start;
    }
  }
  assert.deepEqual(dates, {
    'FS-2': '2026-01-15', // overlaps the last two days
    FS0: '2026-01-19',
    'SS-2': '2026-01-12', // would be Thu 8, requested start holds
    SS0: '2026-01-12',
    'FF-2': '2026-01-12', // would be Wed 7, requested start holds
    FF0: '2026-01-12',
    'SF-2': '2026-01-12', // would be Fri 2, requested start holds
    SF0: '2026-01-12', // would be Mon 5, requested start holds
  });
});

test('delay counts the working days a link pushed the task past its request', () => {
  const { tasks } = run(project('p', [
    task('a', { start: '2026-01-05', duration: 5 }),
    task('fs', { start: '2026-01-05', deps: [dep('a', 'FS', -2)] }),
    task('ss', { start: '2026-01-05', deps: [dep('a', 'SS', 3)] }),
    task('ff', { start: '2026-01-05', duration: 2, deps: [dep('a', 'FF', -1)] }),
  ]));
  assert.equal(tasks.get('fs').delay, 3);
  assert.equal(tasks.get('ss').delay, 3);
  assert.equal(tasks.get('ff').delay, 2);
});

test('a manual task stays put and reports a conflict only when the link is really broken', () => {
  const days = workingDays();
  const manualStart = '2026-01-14';
  for (const type of TYPES) {
    for (const lag of range(-8, 8)) {
      const { tasks } = run(project('p', [
        task('a', { start: '2026-01-12', duration: 5 }),
        task('b', { start: manualStart, manual: true, deps: [dep('a', type, lag)] }),
      ]));
      const a = days.onOrAfter('2026-01-12');
      const required = expectedPosition(type, lag, a, a + 4, 3);
      const broken = required > days.onOrAfter(manualStart);
      assert.equal(tasks.get('b').start, manualStart, `${type} ${lag}`);
      assert.deepEqual(tasks.get('b').conflicts, broken ? ['a'] : [], `${type} ${lag}`);
    }
  }
});

test('a completed task stays put and never reports a conflict', () => {
  for (const type of TYPES) {
    for (const lag of [-3, 0, 3]) {
      const { tasks } = run(project('p', [
        task('a', { start: '2026-02-02', duration: 5 }),
        task('b', { start: '2026-01-05', status: 'complete', progress: 100, deps: [dep('a', type, lag)] }),
      ]));
      assert.equal(tasks.get('b').start, '2026-01-05', `${type} ${lag}`);
      assert.deepEqual(tasks.get('b').conflicts, [], `${type} ${lag}`);
    }
  }
});

// ---- milestones ------------------------------------------------------------------

test('a milestone successor sits on the right day for every type and lag', () => {
  // Predecessor: Wed 14 to Tue 20 Jan.
  const expected = {
    FS: { [-2]: '2026-01-16', [-1]: '2026-01-19', 0: '2026-01-20', 2: '2026-01-22' },
    SS: { [-2]: '2026-01-12', [-1]: '2026-01-13', 0: '2026-01-14', 2: '2026-01-16' },
    FF: { [-2]: '2026-01-16', [-1]: '2026-01-19', 0: '2026-01-20', 2: '2026-01-22' },
    SF: { [-2]: '2026-01-09', [-1]: '2026-01-12', 0: '2026-01-13', 2: '2026-01-15' },
  };
  for (const type of TYPES) {
    for (const [lag, date] of Object.entries(expected[type])) {
      const { tasks } = run(project('p', [
        task('a', { start: '2026-01-14', duration: 5 }),
        task('m', { milestone: true, duration: 0, deps: [dep('a', type, Number(lag))] }),
      ]));
      assert.equal(tasks.get('m').start, date, `${type} ${lag}`);
      assert.equal(tasks.get('m').end, date, `${type} ${lag}`);
    }
  }
});

test('a milestone predecessor drives a task correctly for every type and lag', () => {
  // Milestone on Wed 14 Jan. Successor: 3 working days. Each value is [start, finish].
  const expected = {
    FS: { [-2]: ['2026-01-13', '2026-01-15'], 0: ['2026-01-15', '2026-01-19'], 2: ['2026-01-19', '2026-01-21'] },
    SS: { [-2]: ['2026-01-12', '2026-01-14'], 0: ['2026-01-14', '2026-01-16'], 2: ['2026-01-16', '2026-01-20'] },
    FF: { [-2]: ['2026-01-08', '2026-01-12'], 0: ['2026-01-12', '2026-01-14'], 2: ['2026-01-14', '2026-01-16'] },
    SF: { [-2]: ['2026-01-07', '2026-01-09'], 0: ['2026-01-09', '2026-01-13'], 2: ['2026-01-13', '2026-01-15'] },
  };
  for (const type of TYPES) {
    for (const [lag, dates] of Object.entries(expected[type])) {
      const { tasks } = run(project('p', [
        task('m', { start: '2026-01-14', milestone: true, duration: 0 }),
        task('b', { deps: [dep('m', type, Number(lag))] }),
      ]));
      assert.deepEqual([tasks.get('b').start, tasks.get('b').end], dates, `${type} ${lag}`);
    }
  }
});

// ---- summary tasks ---------------------------------------------------------------

test('a dependency on a summary uses its rolled-up dates, for every type and lag', () => {
  const days = workingDays();
  for (const type of TYPES) {
    for (const lag of [-3, 0, 2]) {
      const { tasks } = run(project('p', [
        task('s'),
        task('x', { parentId: 's', start: '2026-01-12', duration: 2 }),
        task('y', { parentId: 's', start: '2026-01-14', duration: 6 }),
        task('b', { deps: [dep('s', type, lag)] }),
      ]));
      assert.equal(tasks.get('s').start, '2026-01-12');
      assert.equal(tasks.get('s').end, '2026-01-21');
      const start = expectedPosition(type, lag, days.onOrAfter('2026-01-12'), days.onOrAfter('2026-01-21'), 3);
      assert.equal(tasks.get('b').start, days.at(start), `${type} ${lag}`);
    }
  }
});

test('a dependency held by a summary applies to each subtask, for every type and lag', () => {
  const days = workingDays();
  for (const type of TYPES) {
    for (const lag of [-3, 0, 2]) {
      const { tasks } = run(project('p', [
        task('a', { start: '2026-02-02', duration: 5 }),
        task('s', { deps: [dep('a', type, lag)] }),
        task('short', { parentId: 's', duration: 1 }),
        task('long', { parentId: 's', duration: 4 }),
      ]));
      const a = days.onOrAfter('2026-02-02');
      for (const [id, duration] of [['short', 1], ['long', 4]]) {
        const start = expectedPosition(type, lag, a, a + 4, duration);
        assert.equal(tasks.get(id).start, days.at(start), `${id} ${type} ${lag}`);
      }
    }
  }
});

// ---- across projects -------------------------------------------------------------

test('a link across projects lands the same as one inside a project', () => {
  for (const type of TYPES) {
    for (const [lag, start, end] of HAND_WORKED[type]) {
      const { tasks } = run(
        project('one', [task('a', { start: '2026-01-14', duration: 5 })]),
        project('two', [task('b', { deps: [dep('a', type, lag)] })]),
      );
      assert.deepEqual([tasks.get('b').start, tasks.get('b').end], [start, end], `${type} ${lag}`);
    }
  }
});

test('the successor project counts lag in its own calendar', () => {
  // Predecessor works weekends: Thu 8, Fri 9, Sat 10 Jan. The successor does not.
  const expected = {
    FS: { [-3]: '2026-01-08', [-2]: '2026-01-09', [-1]: '2026-01-12', 0: '2026-01-12', 1: '2026-01-13' },
    // The predecessor starts Thu 8.
    SS: { [-2]: '2026-01-06', [-1]: '2026-01-07', 0: '2026-01-08', 1: '2026-01-09', 2: '2026-01-12' },
    // The finish, Sat 10, counts as Mon 12 on the successor's calendar.
    FF: { [-2]: '2026-01-08', [-1]: '2026-01-09', 0: '2026-01-12', 1: '2026-01-13' },
    SF: { [-1]: '2026-01-06', 0: '2026-01-07', 1: '2026-01-08', 2: '2026-01-09', 3: '2026-01-12' },
  };
  for (const type of TYPES) {
    for (const [lag, date] of Object.entries(expected[type])) {
      const { tasks } = run(
        project('weekends', [task('a', { start: '2026-01-08', duration: 3 })], { workWeekends: true }),
        project('weekdays', [task('b', { duration: 1, deps: [dep('a', type, Number(lag))] })]),
      );
      assert.equal(tasks.get('a').end, '2026-01-10');
      assert.equal(tasks.get('b').start, date, `${type} ${lag}`);
    }
  }
});

test('more lag never moves a successor earlier, even between different calendars', () => {
  const calendars = [{}, { workWeekends: true }, { holidays: ['2026-01-12', '2026-01-13'] }];
  for (const type of TYPES) {
    for (const from of calendars) {
      for (const to of calendars) {
        let previous = '';
        for (const lag of range(-10, 10)) {
          const { tasks } = run(
            project('one', [task('a', { start: '2026-01-08', duration: 3 })], from),
            project('two', [task('b', { duration: 2, deps: [dep('a', type, lag)] })], to),
          );
          assert.ok(tasks.get('b').start >= previous, `${type} lag ${lag}, ${JSON.stringify(from)} to ${JSON.stringify(to)}`);
          previous = tasks.get('b').start;
        }
      }
    }
  }
});

test('the Links tab reports buffer and state for every type and negative lag', () => {
  for (const type of TYPES) {
    for (const lag of [-3, -1, 0, 2]) {
      const required = run(
        project('one', [task('a', { start: '2026-02-02', duration: 5 })]),
        project('two', [task('b', { deps: [dep('a', type, lag)] })]),
      ).tasks.get('b').start;
      assert.equal(run(
        project('one', [task('a', { start: '2026-02-02', duration: 5 })]),
        project('two', [task('b', { deps: [dep('a', type, lag)] })]),
      ).crossLinks[0].state, 'driving', `${type} ${lag}`);

      // Requesting exactly 3 working days after the required date leaves 3 of buffer.
      const days = workingDays();
      const three = days.at(days.onOrAfter(required) + 3);
      const later = run(
        project('one', [task('a', { start: '2026-02-02', duration: 5 })]),
        project('two', [task('b', { start: three, deps: [dep('a', type, lag)] })]),
      ).crossLinks[0];
      assert.equal(later.buffer, 3, `${type} ${lag}`);
      assert.equal(later.state, 'buffer', `${type} ${lag}`);
      assert.equal(later.lag, lag);
      assert.equal(later.type, type);

      // A manual task before the required date breaks the link.
      const manual = run(
        project('one', [task('a', { start: '2026-02-02', duration: 5 })]),
        project('two', [task('b', { start: '2025-11-03', manual: true, deps: [dep('a', type, lag)] })]),
      ).crossLinks[0];
      assert.ok(manual.buffer < 0, `${type} ${lag}`);
      assert.equal(manual.state, 'conflict', `${type} ${lag}`);
    }
  }
});

test('a link setting a summary in another project shows as driving', () => {
  // The summary's own duration field is out of date: its dates come from subtasks.
  for (const type of TYPES) {
    for (const lag of [-2, 0, 2]) {
      const { crossLinks } = run(
        project('one', [task('a', { start: '2026-02-02', duration: 5 })]),
        project('two', [
          task('s', { duration: 5, deps: [dep('a', type, lag)] }),
          task('only', { parentId: 's', duration: 2 }),
        ]),
      );
      assert.equal(crossLinks[0].state, 'driving', `${type} ${lag}`);
      assert.equal(crossLinks[0].buffer, 0, `${type} ${lag}`);
    }
  }
});

// ---- float and the critical path ---------------------------------------------------

const projectEnds = (tasks, projects) => projects.map((p) => p.tasks.map((t) => tasks.get(t.id).end).sort().at(-1));

// Float should mean what it says. Delay a task by its float and no project finishes
// later; delay it one day more and at least one does.
function assertFloatIsExact(projects, label) {
  const { tasks } = computeSchedule(projects, TODAY, STANDARD);
  const calendars = new Map(projects.map((p) => [p.id, workingDays(p.calendar)]));
  const baseEnds = projectEnds(tasks, projects);
  const delayed = (target, days) => {
    const copy = structuredClone(projects);
    const owner = copy.find((p) => p.tasks.some((t) => t.id === target.id));
    const calendar = calendars.get(owner.id);
    const moved = owner.tasks.find((t) => t.id === target.id);
    moved.start = calendar.at(calendar.onOrAfter(tasks.get(target.id).start) + days);
    moved.startSet = true;
    return projectEnds(computeSchedule(copy, TODAY, STANDARD).tasks, copy);
  };
  for (const p of projects) {
    for (const t of p.tasks) {
      const { float } = tasks.get(t.id);
      const where = `${label}: ${t.id} with float ${float}`;
      assert.ok(float >= 0, `negative float, ${where}`);
      assert.deepEqual(delayed(t, float), baseEnds, `using all of its float moved a finish, ${where}`);
      assert.notDeepEqual(delayed(t, float + 1), baseEnds, `one day past its float moved nothing, ${where}`);
      assert.equal(tasks.get(t.id).critical, float === 0, where);
    }
  }
}

test('a link on a summary reports the buffer of its tightest subtask', () => {
  for (const type of TYPES) {
    const { crossLinks } = run(
      project('one', [task('a', { start: '2026-02-02', duration: 5 })]),
      project('two', [
        task('s', { duration: 9, deps: [dep('a', type)] }),
        task('held', { parentId: 's', duration: 2 }),
        task('later', { parentId: 's', duration: 4, start: '2026-06-01' }),
      ]),
    );
    assert.equal(crossLinks[0].buffer, 0, type);
    assert.equal(crossLinks[0].state, 'driving', type);
  }
});

test('float is exact and critical path is right for one link of each type and lag', () => {
  for (const type of TYPES) {
    for (const lag of range(-6, 6)) {
      for (const [predDuration, succDuration] of [[5, 3], [3, 5], [1, 1], [8, 2]]) {
        assertFloatIsExact([project('p', [
          task('a', { start: '2026-01-14', duration: predDuration }),
          task('b', { start: '2026-01-05', duration: succDuration, deps: [dep('a', type, lag)] }),
        ])], `${type} ${lag} ${predDuration}/${succDuration}`);
      }
    }
  }
});

test('float is exact with negative lag when the two sides use different calendars', () => {
  const calendars = [{}, { workWeekends: true }, { holidays: ['2026-01-12', '2026-01-13'] }];
  for (const type of TYPES) {
    for (const lag of range(-5, -1)) {
      for (const from of calendars) {
        for (const to of calendars) {
          if (from === to) continue;
          for (const day of range(5, 16)) {
            assertFloatIsExact([
              project('one', [task('a', { start: `2026-01-${String(day).padStart(2, '0')}`, duration: 3 })], from),
              project('two', [task('b', { start: '2026-01-05', duration: 2, deps: [dep('a', type, lag)] })], to),
            ], `${type} ${lag} day ${day} ${JSON.stringify(from)} to ${JSON.stringify(to)}`);
          }
        }
      }
    }
  }
});

test('a predecessor finishing on a day the successor has off has no negative float', () => {
  // Thu 8, Fri 9, Mon 12 Jan on a weekday calendar. The successor is off on the 12th
  // and 13th, so it starts on the 14th. Nothing is late, so float cannot be negative.
  const { tasks } = run(
    project('one', [task('a', { start: '2026-01-08', duration: 3 })]),
    project('two', [task('b', { duration: 2, deps: [dep('a')] })], { holidays: ['2026-01-12', '2026-01-13'] }),
  );
  assert.equal(tasks.get('a').end, '2026-01-12');
  assert.equal(tasks.get('b').start, '2026-01-14');
  assert.equal(tasks.get('a').float, 0);
});

test('float is exact across random networks with different calendars', () => {
  const pairs = [[{}, { workWeekends: true }], [{}, { holidays: ['2026-02-16', '2026-03-03'] }], [{ workWeekends: true }, { holidays: ['2026-02-16'] }]];
  for (const calendars of pairs) {
    for (let seed = 1; seed <= 150; seed++) {
      assertFloatIsExact(randomNetwork(seed, calendars), `seed ${seed}, ${JSON.stringify(calendars)}`);
    }
  }
});

test('float is exact when tasks follow their links instead of holding a set start', () => {
  for (let seed = 1; seed <= 150; seed++) {
    const projects = randomNetwork(seed, [{}, { workWeekends: true }]);
    for (const t of projects.flatMap((p) => p.tasks)) t.startSet = false;
    assertFloatIsExact(projects, `seed ${seed}`);
  }
});

test('negative lag keeps the driving predecessor on the critical path', () => {
  const { tasks } = run(project('p', [
    task('a', { start: '2026-01-05', duration: 10 }),
    task('b', { duration: 5, deps: [dep('a', 'FS', -2)] }),
    task('c', { start: '2026-01-05', duration: 2 }),
  ]));
  assert.equal(tasks.get('b').start, '2026-01-15');
  assert.equal(tasks.get('a').critical, true);
  assert.equal(tasks.get('b').critical, true);
  assert.equal(tasks.get('c').critical, false);
});

// A repeatable random source, so a failure can be reproduced from its seed.
function randomSource(seed) {
  let s = seed;
  return (n) => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (((t ^ (t >>> 14)) >>> 0) % n);
  };
}

function randomNetwork(seed, calendars) {
  const random = randomSource(seed);
  const projects = calendars.map((calendar, i) => project(`p${i}`, [], calendar));
  const ids = [];
  const count = 4 + random(7);
  for (let i = 0; i < count; i++) {
    const deps = [];
    for (const id of ids) {
      if (random(3) === 0) deps.push(dep(id, TYPES[random(4)], random(11) - 5));
    }
    const milestone = random(8) === 0;
    const id = `t${i}`;
    projects[random(projects.length)].tasks.push(task(id, {
      start: `2026-02-${String(2 + random(20)).padStart(2, '0')}`,
      duration: milestone ? 0 : 1 + random(6),
      milestone,
      deps,
    }));
    ids.push(id);
  }
  return projects;
}

test('float is exact across random networks with every type and negative lag', () => {
  for (let seed = 1; seed <= 150; seed++) {
    assertFloatIsExact(randomNetwork(seed, [{}]), `seed ${seed}`);
  }
});

test('float is exact across random networks spanning two projects', () => {
  for (let seed = 1; seed <= 150; seed++) {
    assertFloatIsExact(randomNetwork(seed, [{}, {}]), `seed ${seed}`);
  }
});

test('every link in a random network is honoured, and no task is later than it has to be', () => {
  const calendars = [{}, { holidays: ['2026-02-16', '2026-03-03'] }, { workWeekends: true }];
  for (const calendar of calendars) {
    const days = workingDays(calendar);
    for (let seed = 1; seed <= 200; seed++) {
      const projects = randomNetwork(seed, [calendar, calendar]);
      const { tasks } = computeSchedule(projects, TODAY, STANDARD);
      for (const t of projects.flatMap((p) => p.tasks)) {
        const required = t.deps.map((d) => {
          const pred = tasks.get(d.taskId);
          // A milestone on an FS link shares the predecessor's last day.
          const shift = t.milestone && d.type === 'FS' ? -1 : 0;
          return shift + expectedPosition(d.type, d.lag, days.onOrAfter(pred.start), days.onOrAfter(pred.end), Math.max(1, t.duration));
        });
        const expected = Math.max(days.onOrAfter(t.start), ...required);
        assert.equal(tasks.get(t.id).start, days.at(expected), `seed ${seed}: ${t.id}, ${JSON.stringify(calendar)}`);
      }
    }
  }
});

// ---- saving, validating and displaying a lag ----------------------------------------

function storeWithTwoTasks(link = {}) {
  const store = new StoreCore();
  const projectId = store.createProject({ name: 'P' });
  const a = store.createTask(projectId, { name: 'A', start: '2026-01-14', duration: 5 });
  const b = store.createTask(projectId, { name: 'B', start: '2024-06-03', duration: 3, ...link });
  const find = (id) => store.snapshot().projects[0].tasks.find((t) => t.id === id);
  return { store, projectId, a, b, find };
}

test('saving a link schedules it, for every type and lag in the hand-worked tables', () => {
  for (const type of TYPES) {
    for (const [lag, start, end] of HAND_WORKED[type]) {
      const { store, a, b, find } = storeWithTwoTasks();
      store.updateTask(b, { deps: [{ taskId: a, type, lag }] });
      assert.equal(find(b).deps[0].lag, lag);
      assert.deepEqual([find(b).computed.start, find(b).computed.end], [start, end], `${type} ${lag}`);
    }
  }
});

test('lag accepts negative numbers and the limits, and refuses anything else', () => {
  const { store, a, b, find } = storeWithTwoTasks();
  for (const [given, kept] of [[-1, -1], [-3650, -3650], [3650, 3650], ['-2', -2], ['3', 3], [0, 0], [undefined, 0], [null, 0]]) {
    store.updateTask(b, { deps: [{ taskId: a, type: 'FS', lag: given }] });
    assert.strictEqual(find(b).deps[0].lag, kept, `lag ${given}`);
  }
  for (const given of [-3651, 3651, 1.5, -1.5, 'soon', '', true, {}, []]) {
    assert.throws(
      () => store.updateTask(b, { deps: [{ taskId: a, type: 'FS', lag: given }] }),
      (error) => error instanceof HttpError && error.status === 400 && /Lag/.test(error.message),
      `lag ${JSON.stringify(given)}`,
    );
  }
});

test('a refused lag leaves the existing link as it was', () => {
  const { store, a, b, find } = storeWithTwoTasks();
  store.updateTask(b, { deps: [{ taskId: a, type: 'SS', lag: -2 }] });
  assert.throws(() => store.updateTask(b, { deps: [{ taskId: a, type: 'FF', lag: 1.5 }] }), HttpError);
  assert.deepEqual(find(b).deps, [{ taskId: a, type: 'SS', lag: -2 }]);
});

test('dependency types other than the four are refused, and the type defaults to FS', () => {
  const { store, a, b, find } = storeWithTwoTasks();
  for (const type of ['fs', 'XX', '', 3]) {
    assert.throws(() => store.updateTask(b, { deps: [{ taskId: a, type, lag: 0 }] }), HttpError, `type ${type}`);
  }
  store.updateTask(b, { deps: [{ taskId: a, lag: -1 }] });
  assert.deepEqual(find(b).deps, [{ taskId: a, type: 'FS', lag: -1 }]);
});

test('changing the type or lag of a link reschedules and records it in history', () => {
  const { store, a, b, find } = storeWithTwoTasks();
  store.updateTask(b, { deps: [{ taskId: a, type: 'FS', lag: -2 }], actor: 'Ana' });
  assert.equal(find(b).computed.start, '2026-01-19');
  let edit = find(b).history.findLast((h) => h.type === 'edit');
  assert.equal(edit.author, 'Ana');
  assert.match(edit.changes.find((c) => c.field === 'deps').to, /^A \(FS-2d\)$/);

  store.updateTask(b, { deps: [{ taskId: a, type: 'SS', lag: -2 }], actor: 'Ana' });
  assert.equal(find(b).computed.start, '2026-01-12');
  edit = find(b).history.findLast((h) => h.type === 'edit');
  const change = edit.changes.find((c) => c.field === 'deps');
  assert.equal(change.from, 'A (FS-2d)');
  assert.equal(change.to, 'A (SS-2d)');
});

test('a predecessor moving is logged on successors linked with negative lag', () => {
  for (const type of TYPES) {
    const { store, a, b, find } = storeWithTwoTasks();
    store.updateTask(b, { deps: [{ taskId: a, type, lag: -2 }] });
    const before = find(b).computed.start;
    store.updateTask(a, { start: '2026-02-02', actor: 'Ana' });
    const after = find(b).computed.start;
    assert.ok(after > before, type);
    const entry = find(b).history.findLast((h) => h.type === 'schedule');
    assert.equal(entry.changes.find((c) => c.field === 'schedStart').to, after, type);
    assert.match(entry.note, /"A"/);
  }
});

test('negative lag does not get around loop detection', () => {
  for (const type of TYPES) {
    const { store, a, b, find } = storeWithTwoTasks();
    store.updateTask(b, { deps: [{ taskId: a, type, lag: -5 }] });
    assert.throws(
      () => store.updateTask(a, { deps: [{ taskId: b, type, lag: -5 }] }),
      (error) => error instanceof HttpError && error.status === 409,
      type,
    );
    assert.deepEqual(find(a).deps, []);
  }
});

test('types and negative lags survive export and import', () => {
  const store = new StoreCore();
  const one = store.createProject({ name: 'One' });
  const two = store.createProject({ name: 'Two' });
  const a = store.createTask(one, { name: 'A', start: '2026-01-14', duration: 5 });
  const links = TYPES.map((type, i) => ({ type, lag: -(i + 1) }));
  const ids = links.map(({ type, lag }) => store.createTask(two, { name: type, start: '2024-06-03', duration: 3, deps: [{ taskId: a, type, lag }] }));
  const before = store.snapshot();

  const copy = new StoreCore();
  copy.importAll(JSON.parse(JSON.stringify(store.exportAll())), 'replace');
  const after = copy.snapshot();
  const taskOf = (state, id) => state.projects.flatMap((p) => p.tasks).find((t) => t.id === id);
  for (const [i, id] of ids.entries()) {
    assert.deepEqual(taskOf(after, id).deps, [{ taskId: a, ...links[i] }]);
    assert.equal(taskOf(after, id).computed.start, taskOf(before, id).computed.start);
  }
  assert.deepEqual(after.crossLinks.map((l) => [l.type, l.lag]), links.map((l) => [l.type, l.lag]));

  // A file with a bad lag changes nothing.
  const exported = JSON.parse(JSON.stringify(store.exportAll()));
  exported.projects[1].tasks[0].deps[0].lag = 1.5;
  assert.throws(() => copy.importAll(exported, 'replace'), HttpError);
  assert.equal(taskOf(copy.snapshot(), ids[0]).deps[0].lag, -1);
});

test('the label on a link shows its sign', () => {
  assert.equal(depSuffix({ type: 'FS', lag: 0 }), 'FS');
  assert.equal(depSuffix({ type: 'SS', lag: 2 }), 'SS+2d');
  assert.equal(depSuffix({ type: 'FF', lag: -2 }), 'FF-2d');
  assert.equal(depSuffix({ type: 'SF', lag: -10 }), 'SF-10d');
});
