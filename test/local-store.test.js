import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { LocalStore, STORAGE_KEY } from '../public/js/local-store.js';
import { applyChange } from '../public/shared/routes.js';
import { HttpError } from '../public/shared/store-core.js';

// Stands in for the browser's localStorage, including a size limit.
function fakeStorage(limit = Infinity) {
  const items = new Map();
  return {
    blocked: false,
    getItem(key) {
      if (this.blocked) throw new Error('Blocked');
      return items.has(key) ? items.get(key) : null;
    },
    setItem(key, value) {
      if (this.blocked || value.length > limit) throw new Error('QuotaExceededError');
      items.set(key, value);
    },
    removeItem(key) {
      items.delete(key);
    },
  };
}

beforeEach(() => {
  globalThis.localStorage = fakeStorage();
});

const change = (store, method, path, body = {}) => applyChange(store, method, path, body);

test('projects, tasks and history come back in a new session', () => {
  const first = new LocalStore();
  assert.equal(first.hasSavedCopy(), false);
  const { body } = change(first, 'POST', '/api/projects', { name: 'Mine' });
  const task = change(first, 'POST', `/api/projects/${body.createdId}/tasks`, { name: 'Do it', pocName: 'Ana' });
  change(first, 'POST', `/api/tasks/${task.body.createdId}/updates`, { note: 'Started', actor: 'Ana' });

  const second = new LocalStore();
  assert.equal(second.hasSavedCopy(), true);
  const project = second.snapshot().projects[0];
  assert.equal(project.name, 'Mine');
  assert.equal(project.tasks[0].pocName, 'Ana');
  assert.ok(project.tasks[0].computed.start, 'scheduled in the browser');
  assert.ok(project.tasks[0].history.some((h) => h.type === 'update' && h.note === 'Started'));
  assert.equal(second.snapshot().saving, false);
});

test('two tabs do not overwrite each other', () => {
  const tabA = new LocalStore();
  const tabB = new LocalStore();
  change(tabA, 'POST', '/api/projects', { name: 'From A' });
  tabB.load();
  change(tabB, 'POST', '/api/projects', { name: 'From B' });
  tabA.load();
  assert.deepEqual(tabA.snapshot().projects.map((p) => p.name), ['From A', 'From B']);
});

test('a change that does not fit is refused and nothing is lost', () => {
  const store = new LocalStore();
  change(store, 'POST', '/api/projects', { name: 'Kept' });
  const stored = localStorage.getItem(STORAGE_KEY);
  const limited = fakeStorage(stored.length + 5);
  limited.setItem(STORAGE_KEY, stored);
  globalThis.localStorage = limited;

  const revision = store.state.revision;
  assert.throws(() => change(store, 'POST', '/api/projects', { name: 'Too much' }), (error) => error instanceof HttpError && error.status === 507);
  assert.equal(store.state.revision, revision);
  assert.deepEqual(store.snapshot().projects.map((p) => p.name), ['Kept']);
  assert.equal(localStorage.getItem(STORAGE_KEY), stored);
});

test('blocked storage refuses changes without claiming they were kept', () => {
  localStorage.blocked = true;
  const store = new LocalStore();
  assert.equal(store.hasSavedCopy(), false);
  assert.throws(() => change(store, 'POST', '/api/projects', { name: 'Nope' }), HttpError);
  assert.equal(store.snapshot().projects.length, 0);
});

test('unreadable data is set aside, not overwritten', () => {
  for (const damaged of ['{not json', '{"projects":"nope"}', 'null']) {
    globalThis.localStorage = fakeStorage();
    localStorage.setItem(STORAGE_KEY, damaged);
    const store = new LocalStore();
    assert.equal(store.damaged, true, damaged);
    assert.equal(store.snapshot().projects.length, 0);
    assert.equal(localStorage.getItem(`${STORAGE_KEY}.damaged`), damaged);
    change(store, 'POST', '/api/projects', { name: 'Fresh start' });
    assert.equal(localStorage.getItem(`${STORAGE_KEY}.damaged`), damaged);
  }
});

test('dependency types and negative lags survive a new session in the browser', () => {
  const first = new LocalStore();
  const projectId = change(first, 'POST', '/api/projects', { name: 'Links' }).body.createdId;
  const a = change(first, 'POST', `/api/projects/${projectId}/tasks`, { name: 'A', start: '2026-01-14', duration: 5 }).body.createdId;
  const expected = { FS: '2026-01-19', SS: '2026-01-12', FF: '2026-01-14', SF: '2026-01-07' };
  for (const type of Object.keys(expected)) {
    change(first, 'POST', `/api/projects/${projectId}/tasks`, { name: type, start: '2024-06-03', duration: 3, deps: [{ taskId: a, type, lag: -2 }] });
  }

  const tasks = new LocalStore().snapshot().projects[0].tasks;
  for (const [type, start] of Object.entries(expected)) {
    const task = tasks.find((t) => t.name === type);
    assert.deepEqual(task.deps, [{ taskId: a, type, lag: -2 }]);
    assert.equal(task.computed.start, start, type);
  }
});

test('clearing storage empties the store', () => {
  const store = new LocalStore();
  change(store, 'POST', '/api/projects', { name: 'Gone' });
  localStorage.removeItem(STORAGE_KEY);
  store.load();
  assert.equal(store.snapshot().projects.length, 0);
});

test('sample projects, export and import work with no server', () => {
  const store = new LocalStore();
  const sample = change(store, 'POST', '/api/sample');
  assert.ok(sample.body.importResult.added > 0);
  const exported = store.exportAll();

  globalThis.localStorage = fakeStorage();
  const other = new LocalStore();
  assert.equal(other.snapshot().projects.length, 0);
  change(other, 'POST', '/api/import', { data: JSON.parse(JSON.stringify(exported)), mode: 'replace' });
  assert.equal(other.snapshot().projects.length, exported.projects.length);
  assert.throws(() => change(other, 'POST', '/api/import', { data: { nope: true }, mode: 'merge' }), HttpError);
  assert.equal(other.snapshot().projects.length, exported.projects.length);
});
