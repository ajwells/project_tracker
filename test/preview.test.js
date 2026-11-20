// Previewing a date change runs the real edit on a throwaway copy. It has to report what
// saving would do, and leave the plan alone.

import test from 'node:test';
import assert from 'node:assert/strict';
import { previewTaskEdit } from '../public/shared/preview.js';
import { StoreCore } from '../public/shared/store-core.js';

const task = (id, fields = {}) => ({
  id, name: id, parentId: null, start: '2026-06-01', duration: 5, milestone: false, manual: false,
  status: 'not_started', progress: 0, deps: [], history: [], ...fields,
});
const after = (taskId, type = 'FS', lag = 0) => ({ taskId, type, lag });
const project = (id, tasks) => ({ id, name: id, calendar: {}, tasks });

function storeWith(...projects) {
  const store = new StoreCore();
  store.state = { schemaVersion: 1, revision: 1, projects };
  return store;
}

const chain = () => storeWith(project('p', [
  task('a'),
  task('b', { startSet: false, deps: [after('a')] }),
  task('c', { startSet: false, deps: [after('b')] }),
  task('free', { start: '2026-06-01' }),
]));

const movedIds = (preview) => preview.moved.map((m) => m.id);

test('lists the tasks that would move, and how far', () => {
  const preview = previewTaskEdit(chain().snapshot(), 'a', { start: '2026-06-08' });
  assert.deepEqual(movedIds(preview), ['b', 'c']);
  assert.equal(preview.affectsOthers, true);
  assert.deepEqual([preview.moved[0].fromStart, preview.moved[0].start, preview.moved[0].shift], ['2026-06-08', '2026-06-15', 7]);
  assert.deepEqual([preview.self.fromStart, preview.self.start], ['2026-06-01', '2026-06-08']);
});

test('saves nothing and leaves the snapshot as it was', () => {
  const store = chain();
  const snapshot = store.snapshot();
  const copy = structuredClone(snapshot);
  const revision = store.state.revision;
  previewTaskEdit(snapshot, 'a', { start: '2026-06-08' });
  assert.deepEqual(snapshot, copy);
  assert.equal(store.state.revision, revision);
  assert.equal(store.state.projects[0].tasks[0].start, '2026-06-01');
});

test('matches what saving then does, in dates and in moved tasks', () => {
  const store = chain();
  const before = store.snapshot();
  const preview = previewTaskEdit(before, 'a', { start: '2026-06-10' });
  const saved = store.snapshot();
  store.updateTask('a', { start: '2026-06-10' });
  const real = store.snapshot().projects[0].tasks;
  const moved = real.filter((t) => t.id !== 'a' && t.computed.start !== saved.projects[0].tasks.find((x) => x.id === t.id).computed.start);
  assert.deepEqual(movedIds(preview), moved.map((t) => t.id));
  for (const entry of preview.moved) {
    const now = real.find((t) => t.id === entry.id).computed;
    assert.deepEqual([entry.start, entry.end], [now.start, now.end]);
  }
});

test('an unlinked task affects nothing else', () => {
  const preview = previewTaskEdit(chain().snapshot(), 'free', { start: '2026-07-01' });
  assert.deepEqual(preview.moved, []);
  assert.equal(preview.affectsOthers, false);
});

test('a slip that a later set start absorbs affects nothing else', () => {
  const store = storeWith(project('p', [task('a'), task('b', { start: '2026-09-01', deps: [after('a')] })]));
  assert.equal(previewTaskEdit(store.snapshot(), 'a', { start: '2026-06-08' }).affectsOthers, false);
});

test('a task following links can move earlier', () => {
  const store = chain();
  store.updateTask('a', { start: '2026-06-15' });
  const preview = previewTaskEdit(store.snapshot(), 'a', { start: '2026-06-01' });
  assert.deepEqual(movedIds(preview), ['b', 'c']);
  assert.ok(preview.moved.every((m) => m.shift < 0));
});

test('a successor tracked by dates holds, so the effect is a conflict and not a move', () => {
  const store = storeWith(project('p', [
    task('a'),
    task('held', { trackBy: 'dates', start: '2026-06-08', finish: '2026-06-12', deps: [after('a')] }),
  ]));
  const preview = previewTaskEdit(store.snapshot(), 'a', { start: '2026-06-15' });
  assert.deepEqual(preview.moved, []);
  assert.deepEqual(preview.conflicts.map((c) => [c.id, c.with]), [['held', ['a']]]);
  assert.equal(preview.affectsOthers, true);
});

test('a conflict already there is not reported as new', () => {
  const store = storeWith(project('p', [
    task('a', { start: '2026-06-15' }),
    task('held', { trackBy: 'dates', start: '2026-06-08', finish: '2026-06-12', deps: [after('a')] }),
  ]));
  assert.deepEqual(previewTaskEdit(store.snapshot(), 'a', { start: '2026-06-22' }).conflicts, []);
});

test('a conflict on the edited task alone does not count as affecting others', () => {
  const store = storeWith(project('p', [
    task('a', { start: '2026-06-15' }),
    task('held', { trackBy: 'dates', start: '2026-06-29', finish: '2026-07-03', deps: [after('a')] }),
  ]));
  const preview = previewTaskEdit(store.snapshot(), 'held', { start: '2026-06-16' });
  assert.deepEqual(preview.conflicts.map((c) => c.id), ['held']);
  assert.equal(preview.affectsOthers, false);
});

test('reports moves, finishes and buffers in other projects', () => {
  const store = storeWith(
    project('here', [task('a')]),
    project('there', [
      task('follows', { startSet: false, deps: [after('a')] }),
      task('spare', { start: '2026-09-01', deps: [after('a')] }),
    ]),
  );
  const preview = previewTaskEdit(store.snapshot(), 'a', { start: '2026-06-08' });
  assert.deepEqual(preview.moved.map((m) => [m.id, m.projectName]), [['follows', 'there']]);
  assert.deepEqual(preview.finishes.map((f) => f.name), ['here']);
  assert.deepEqual(preview.buffers.map((b) => b.to), ['spare']);
  assert.ok(preview.buffers[0].now < preview.buffers[0].was);
});

test('reports the project finish when it moves', () => {
  const preview = previewTaskEdit(chain().snapshot(), 'a', { start: '2026-06-08' });
  assert.equal(preview.finishes.length, 1);
  assert.ok(preview.finishes[0].to > preview.finishes[0].from);
});

test('summaries roll up without counting as moved tasks', () => {
  const store = storeWith(project('p', [
    task('parent'),
    task('kid', { parentId: 'parent' }),
    task('next', { startSet: false, deps: [after('kid')] }),
  ]));
  assert.deepEqual(movedIds(previewTaskEdit(store.snapshot(), 'kid', { start: '2026-06-08' })), ['next']);
});

test('an edit saving would refuse is refused here too', () => {
  const store = storeWith(project('p', [task('a', { trackBy: 'dates', start: '2026-06-08', finish: '2026-06-12' })]));
  assert.throws(() => previewTaskEdit(store.snapshot(), 'a', { end: '2026-06-01' }), /before the start/);
});
