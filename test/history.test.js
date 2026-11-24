// History that doesn't fill up while a plan is entered: quick edits by one person merge
// into one entry, edits straight after creating a task are part of creating it, and
// while a project is being planned every edit goes into "created". Merged entries keep
// each step, for "Show every change".

import test from 'node:test';
import assert from 'node:assert/strict';
import { MERGE_WINDOW_MS, StoreCore } from '../public/shared/store-core.js';

const LATER = MERGE_WINDOW_MS + 1000;

function setup(t, { planning = false } = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-23T09:00:00Z') });
  const store = new StoreCore();
  const projectId = store.createProject({ name: 'P', planning });
  const a = store.createTask(projectId, { name: 'A', start: '2026-12-07', duration: 5, actor: 'Ann' });
  const find = (id) => store.snapshot().projects.flatMap((p) => p.tasks).find((x) => x.id === id);
  const history = (id) => find(id).history;
  const tick = (ms) => t.mock.timers.tick(ms);
  return { store, projectId, a, find, history, tick };
}
const fieldsOf = (entry) => Object.fromEntries((entry.changes ?? []).map((c) => [c.field, [c.from, c.to]]));

test('quick edits by one person are one entry, from where each field started to where it ended', (t) => {
  const { store, a, history, tick } = setup(t);
  tick(LATER);
  store.updateTask(a, { start: '2026-12-08', actor: 'Ann' });
  tick(60 * 1000);
  store.updateTask(a, { start: '2026-12-09', actor: 'Ann' });
  tick(9 * 60 * 1000); // each edit keeps the window open, measured from the last one
  store.updateTask(a, { start: '2026-12-10', duration: 8, actor: 'Ann' });
  const [, entry, ...rest] = history(a);
  assert.equal(rest.length, 0);
  assert.equal(entry.type, 'edit');
  assert.deepEqual(fieldsOf(entry), { start: ['2026-12-07', '2026-12-10'], duration: [5, 8] });
  assert.deepEqual(entry.steps.map((s) => s.changes.find((c) => c.field === 'start').to), ['2026-12-08', '2026-12-09', '2026-12-10']);
  assert.equal(entry.steps.at(-1).author, 'Ann');
  assert.equal(entry.at, '2026-11-23T09:10:01.000Z');
  assert.equal(entry.lastAt, '2026-11-23T09:20:01.000Z');
});

test('a field put back where it started drops out, and an entry left with none keeps its steps', (t) => {
  const { store, a, history, tick } = setup(t);
  tick(LATER);
  store.updateTask(a, { start: '2026-12-08', manual: true, actor: 'Ann' });
  store.updateTask(a, { start: '2026-12-07', actor: 'Ann' });
  assert.deepEqual(fieldsOf(history(a)[1]), { manual: [false, true] });
  store.updateTask(a, { manual: false, actor: 'Ann' });
  const entry = history(a)[1];
  assert.deepEqual(entry.changes, []);
  assert.equal(entry.steps.length, 3);
});

test('another person, a gap past the window, or a posted update starts a new entry', (t) => {
  const { store, a, history, tick } = setup(t);
  tick(LATER);
  store.updateTask(a, { duration: 6, actor: 'Ann' });
  store.updateTask(a, { duration: 7, actor: 'Bo' });
  tick(LATER);
  store.updateTask(a, { duration: 8, actor: 'Bo' });
  store.addUpdate(a, { note: 'Vendor is late', actor: 'Bo' });
  store.updateTask(a, { duration: 9, actor: 'Bo' });
  assert.deepEqual(history(a).map((e) => `${e.type} ${e.author}`), ['create Ann', 'edit Ann', 'edit Bo', 'edit Bo', 'update Bo', 'edit Bo']);
  assert.equal(history(a)[1].steps, undefined, 'an entry that took nothing in has no steps');
});

test('edits straight after creating a task are part of creating it', (t) => {
  const { store, a, history, tick } = setup(t);
  tick(2 * 60 * 1000);
  store.updateTask(a, { pocName: 'Cy', actor: 'Ann' });
  store.updateTask(a, { duration: 10, actor: 'Ann' });
  let [created, ...rest] = history(a);
  assert.equal(rest.length, 0);
  assert.equal(created.type, 'create');
  assert.equal(created.note, 'Task created');
  assert.deepEqual(fieldsOf(created), { pocName: ['', 'Cy'], duration: [5, 10] });
  assert.deepEqual(created.steps.map((s) => s.type), ['create', 'edit', 'edit']);

  tick(LATER);
  store.updateTask(a, { duration: 11, actor: 'Ann' });
  [created, ...rest] = history(a);
  assert.deepEqual(rest.map((e) => e.type), ['edit']);
});

test('a task moved by another task keeps its own entry; moved by its own edit, it joins the edit', (t) => {
  const { store, projectId, a, find, history, tick } = setup(t);
  const b = store.createTask(projectId, { name: 'B', duration: 3, startSet: false, deps: [{ taskId: a, type: 'FS' }], actor: 'Ann' });
  tick(LATER);
  store.updateTask(a, { duration: 7, actor: 'Ann' });
  store.updateTask(a, { duration: 8, actor: 'Ann' });
  const moves = history(b).filter((e) => e.type === 'schedule');
  assert.equal(moves.length, 1, 'repeat moves for the same cause merge');
  assert.match(moves[0].note, /"A"/);
  assert.equal(moves[0].changes.find((c) => c.field === 'schedEnd').to, find(b).computed.end);
  assert.equal(history(b).at(-1).type, 'schedule', 'not folded into B\'s creation');

  // A milestone switch reschedules the task itself: that's part of the edit.
  tick(LATER);
  store.updateTask(b, { milestone: true, actor: 'Ann' });
  const last = history(b).at(-1);
  assert.equal(last.type, 'edit');
  assert.ok(last.changes.some((c) => c.field === 'milestone'));
  assert.ok(last.changes.some((c) => c.field === 'schedEnd'));
});

test('while a project is being planned, every change goes into each task\'s "created" entry', (t) => {
  const { store, projectId, a, history, tick } = setup(t, { planning: true });
  const b = store.createTask(projectId, { name: 'B', duration: 3, startSet: false, deps: [{ taskId: a, type: 'FS' }], actor: 'Ann' });
  tick(LATER);
  store.updateTask(a, { duration: 9, actor: 'Ann' });
  store.addUpdate(a, { note: 'Kickoff done', actor: 'Ann' });
  tick(3 * LATER);
  store.updateTask(a, { pocName: 'Dee', actor: 'Bo' });
  assert.deepEqual(history(a).map((e) => e.type), ['create', 'update']);
  assert.deepEqual(fieldsOf(history(a)[0]), { duration: [5, 9], pocName: ['', 'Dee'] });
  assert.deepEqual(history(a)[0].steps.map((s) => s.author), ['Ann', 'Ann', 'Bo']);
  assert.deepEqual(history(b).map((e) => e.type), ['create'], 'B moving is part of setting it up too');

  // A baseline is the agreed plan, so changes are listed from then on.
  store.setBaseline(projectId, true);
  assert.equal(store.snapshot().projects[0].planning, undefined);
  tick(LATER);
  store.updateTask(a, { duration: 10, actor: 'Bo' });
  assert.deepEqual(history(a).map((e) => e.type), ['create', 'update', 'edit']);
});

test('new projects start in planning, and the setting can be changed both ways', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const store = new StoreCore();
  const id = store.createProject({ name: 'New' });
  const project = () => store.snapshot().projects[0];
  assert.equal(project().planning, true);
  store.updateProject(id, { planning: false });
  assert.equal('planning' in project(), false, 'stored only when on');
  store.updateProject(id, { planning: true });
  assert.equal(project().planning, true);
  store.updateProject(id, { name: 'Renamed' });
  assert.equal(project().planning, true, 'other settings leave it alone');
});

test('a merged entry keeps at most 100 steps, the first and the latest', (t) => {
  const { store, a, history, tick } = setup(t);
  tick(LATER);
  for (let i = 1; i <= 130; i++) store.updateTask(a, { duration: 5 + (i % 2 ? 1 : 0) + (i === 130 ? 3 : 0), actor: 'Ann' });
  const entry = history(a)[1];
  assert.equal(entry.steps.length, 100);
  assert.equal(entry.stepsDropped, 30);
  assert.deepEqual(entry.steps[0].changes, [{ field: 'duration', label: 'Duration', from: 5, to: 6 }]);
  assert.deepEqual(fieldsOf(entry), { duration: [5, 8] });
});

test('steps, last change times and planning survive export and import, and junk is dropped', (t) => {
  const { store, projectId, a, tick } = setup(t, { planning: true });
  tick(LATER);
  store.updateTask(a, { duration: 9, actor: 'Ann' });
  const file = structuredClone(store.exportAll());
  const other = new StoreCore();
  other.importAll(structuredClone(file), 'replace');
  const [project] = other.snapshot().projects;
  assert.equal(project.planning, true);
  const [created] = project.tasks[0].history;
  assert.deepEqual(created, store.snapshot().projects[0].tasks[0].history[0]);

  const raw = file.projects[0];
  raw.tasks[0].history[0].steps.push('junk', { type: 'bogus', changes: 'x', author: 7 });
  raw.tasks[0].history[0].stepsDropped = -3;
  delete raw.planning; // an export from before planning existed
  other.importAll(file, 'replace');
  const [again] = other.snapshot().projects;
  assert.equal('planning' in again, false);
  const steps = again.tasks[0].history[0].steps;
  assert.equal(steps.length, 3);
  assert.deepEqual(steps[2], { at: steps[2].at, type: 'edit', author: 'Anonymous' });
  assert.equal(again.tasks[0].history[0].stepsDropped, undefined);
  assert.equal(projectId, again.id);
});

test('action items merge quick edits the same way', (t) => {
  const { store, projectId, tick } = setup(t);
  const id = store.createAction(projectId, { name: 'Chase', actor: 'Ann' });
  const actionHistory = () => store.snapshot().projects[0].actions.find((x) => x.id === id).history;
  store.updateAction(id, { pocName: 'Bo', actor: 'Ann' });
  tick(LATER);
  store.updateAction(id, { progress: 20, actor: 'Ann' });
  store.updateAction(id, { progress: 40, actor: 'Ann' });
  assert.deepEqual(actionHistory().map((e) => e.type), ['create', 'edit']);
  assert.deepEqual(fieldsOf(actionHistory()[1]).progress, [0, 40]);
});
