// Action items: tasks' who, what and history with no dates, kept apart from the schedule.

import test from 'node:test';
import assert from 'node:assert/strict';
import { StoreCore } from '../public/shared/store-core.js';
import { applyChange } from '../public/shared/routes.js';

const call = (store, method, path, body = {}) => applyChange(store, method, path, body);

function setup() {
  const store = new StoreCore();
  const projectId = store.createProject({ name: 'Plan' });
  const taskId = store.createTask(projectId, { name: 'Build', start: '2026-12-07', duration: 5, progress: 40, status: 'in_progress' });
  return { store, projectId, taskId };
}
const actionIn = (store, id) => store.snapshot().projects.flatMap((p) => p.actions).find((a) => a.id === id);

test('creates an action item with no dates, and records its creation', () => {
  const { store, projectId } = setup();
  const res = call(store, 'POST', `/api/projects/${projectId}/actions`, { name: '  Chase the vendor  ', actor: 'Ann' });
  assert.equal(res.status, 201);
  const action = actionIn(store, res.body.createdId);
  assert.equal(action.name, 'Chase the vendor');
  assert.equal(action.status, 'not_started');
  assert.equal(action.progress, 0);
  for (const field of ['start', 'finish', 'duration', 'deps', 'schedStart', 'computed']) assert.equal(action[field], undefined, field);
  assert.equal(action.history.length, 1);
  assert.equal(action.history[0].type, 'create');
  assert.equal(action.history[0].author, 'Ann');
});

test('edits are recorded in history with who, from and to', () => {
  const { store, projectId } = setup();
  const id = store.createAction(projectId, { name: 'Ask legal' });
  call(store, 'PATCH', `/api/actions/${id}`, { pocName: 'Bo', pocContact: 'bo@example.com', notes: 'NDA', actor: 'Ann' });
  call(store, 'PATCH', `/api/actions/${id}`, { name: 'Ask legal about the NDA', actor: 'Ann' });
  const action = actionIn(store, id);
  assert.equal(action.pocName, 'Bo');
  const [, first, second] = action.history;
  assert.deepEqual(first.changes.map((c) => c.field).sort(), ['notes', 'pocContact', 'pocName']);
  assert.deepEqual(second.changes, [{ field: 'name', label: 'Name', from: 'Ask legal', to: 'Ask legal about the NDA' }]);
  // Saving the same values again records nothing.
  call(store, 'PATCH', `/api/actions/${id}`, { pocName: 'Bo' });
  assert.equal(actionIn(store, id).history.length, 3);
});

test('status and progress keep telling the same story, as for tasks', () => {
  const { store, projectId } = setup();
  const id = store.createAction(projectId, { name: 'Order parts' });
  store.updateAction(id, { progress: 30 });
  assert.equal(actionIn(store, id).status, 'in_progress');
  store.updateAction(id, { progress: 100 });
  assert.equal(actionIn(store, id).status, 'complete');
  store.updateAction(id, { status: 'in_progress' });
  assert.equal(actionIn(store, id).progress, 90);
  store.updateAction(id, { status: 'complete' });
  assert.equal(actionIn(store, id).progress, 100);
  store.updateAction(id, { status: 'not_started' });
  assert.equal(actionIn(store, id).progress, 0);
  store.updateAction(id, { status: 'blocked' });
  assert.equal(actionIn(store, id).status, 'blocked');
});

test('posted updates go in the history', () => {
  const { store, projectId } = setup();
  const id = store.createAction(projectId, { name: 'Book the room' });
  const res = call(store, 'POST', `/api/actions/${id}/updates`, { note: 'Waiting on facilities', actor: 'Cy' });
  assert.equal(res.status, 200);
  const last = actionIn(store, id).history.at(-1);
  assert.equal(last.type, 'update');
  assert.equal(last.note, 'Waiting on facilities');
  assert.equal(last.author, 'Cy');
  assert.throws(() => store.addActionUpdate(id, { note: '   ' }), /Update is required/);
});

test('bad input is refused and leaves nothing behind', () => {
  const { store, projectId } = setup();
  const id = store.createAction(projectId, { name: 'Sign off' });
  const before = JSON.stringify(store.state);
  assert.throws(() => store.createAction(projectId, { name: ' ' }), /Action item name is required/);
  assert.throws(() => store.updateAction(id, { status: 'done' }), /Unknown status/);
  assert.throws(() => store.updateAction(id, { progress: 101 }), /Progress must be/);
  assert.throws(() => store.updateAction(id, { name: '' }), /required/);
  assert.equal(JSON.stringify(store.state), before);
  assert.throws(() => store.updateAction('nope', { name: 'x' }), (e) => e.status === 404);
  assert.throws(() => store.createAction('nope', { name: 'x' }), (e) => e.status === 404);
});

test("tasks' routes don't reach action items, and the other way round", () => {
  const { store, projectId, taskId } = setup();
  const id = store.createAction(projectId, { name: 'Follow up' });
  assert.throws(() => call(store, 'PATCH', `/api/tasks/${id}`, { name: 'x' }), (e) => e.status === 404);
  assert.throws(() => call(store, 'POST', `/api/tasks/${id}/updates`, { note: 'x' }), (e) => e.status === 404);
  assert.throws(() => call(store, 'PATCH', `/api/actions/${taskId}`, { name: 'x' }), (e) => e.status === 404);
  assert.throws(() => call(store, 'DELETE', `/api/actions/${taskId}`), (e) => e.status === 404);
});

test("action items stay out of the schedule and the project's progress", () => {
  const { store, projectId, taskId } = setup();
  const before = store.snapshot().projects[0].summary;
  const id = store.createAction(projectId, { name: 'Unrelated', status: 'complete' });
  store.updateAction(id, { status: 'blocked' });
  const after = store.snapshot();
  assert.deepEqual(after.projects[0].summary, before);
  // Editing one doesn't write schedule history on any task.
  assert.ok(after.projects[0].tasks.find((t) => t.id === taskId).history.every((e) => e.type !== 'schedule'));
});

test('deleting removes the action item, and deleting the project removes them all', () => {
  const { store, projectId } = setup();
  const a = store.createAction(projectId, { name: 'One' });
  const b = store.createAction(projectId, { name: 'Two' });
  call(store, 'DELETE', `/api/actions/${a}`);
  assert.deepEqual(store.snapshot().projects[0].actions.map((x) => x.id), [b]);
  store.deleteProject(projectId);
  assert.equal(store.snapshot().projects.length, 0);
});

test('older data with no action items reads as an empty list, and can gain some', () => {
  const store = new StoreCore();
  store.state = { schemaVersion: 1, revision: 0, projects: [{ id: 'old', name: 'Old', calendar: { workWeekends: false, holidays: [] }, tasks: [] }] };
  assert.deepEqual(store.snapshot().projects[0].actions, []);
  const id = store.createAction('old', { name: 'New' });
  assert.ok(actionIn(store, id));
});

test('export and import carry action items and their history', () => {
  const { store, projectId } = setup();
  const id = store.createAction(projectId, { name: 'Carry me', pocName: 'Di' });
  store.addActionUpdate(id, { note: 'Started' });
  store.updateAction(id, { progress: 50 });
  const file = JSON.parse(JSON.stringify(store.exportAll()));

  const other = new StoreCore();
  other.importAll(file, 'replace');
  const action = actionIn(other, id);
  assert.equal(action.name, 'Carry me');
  assert.equal(action.pocName, 'Di');
  assert.equal(action.progress, 50);
  assert.equal(action.status, 'in_progress');
  assert.deepEqual(action.history.map((e) => e.type), ['create', 'update', 'edit']);

  // An export from before action items existed still imports.
  delete file.projects[0].actions;
  other.importAll(file, 'replace');
  assert.deepEqual(other.snapshot().projects[0].actions, []);
});

test('import checks action items field by field', () => {
  const { store } = setup();
  const file = JSON.parse(JSON.stringify(store.exportAll()));
  const withActions = (actions) => ({ ...file, projects: [{ ...file.projects[0], actions }] });
  assert.throws(() => store.importAll(withActions('nope'), 'replace'), /invalid action item list/);
  assert.throws(() => store.importAll(withActions([{ id: 'a1' }]), 'replace'), /action item 1 name is required/);
  assert.throws(() => store.importAll(withActions([{ id: 'a1', name: 'x', status: 'done' }]), 'replace'), /unknown status/);
  assert.throws(() => store.importAll(withActions([{ id: 'a1', name: 'x' }, { id: 'a1', name: 'y' }]), 'replace'), /repeats id/);
  // The panel opens items by id, so one can't share an id with a task.
  const taskId = file.projects[0].tasks[0].id;
  assert.throws(() => store.importAll(withActions([{ id: taskId, name: 'x' }]), 'replace'), /repeats id/);
  // A complete item is always at 100%.
  store.importAll(withActions([{ id: 'a1', name: 'x', status: 'complete', progress: 20 }]), 'replace');
  assert.equal(actionIn(store, 'a1').progress, 100);
});

test('merging a project whose action item ids are already used gives them new ids', () => {
  const { store, projectId } = setup();
  const id = store.createAction(projectId, { name: 'Mine' });
  const file = JSON.parse(JSON.stringify(store.exportAll()));
  const copy = { ...file.projects[0], id: 'copy', tasks: [], actions: file.projects[0].actions };
  store.importAll({ ...file, projects: [copy] }, 'merge');
  const projects = store.snapshot().projects;
  const ids = projects.flatMap((p) => p.actions.map((a) => a.id));
  assert.equal(ids.length, 2);
  assert.equal(new Set(ids).size, 2);
  assert.equal(projects.find((p) => p.id === projectId).actions[0].id, id);
});
