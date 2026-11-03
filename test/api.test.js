import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, parseFirmLeads, parseSaveData } from '../src/server.js';

let app;
let base;
let dir;
const headers = { 'Content-Type': 'application/json' };

async function api(method, path, body, extra = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body ? headers : {}), ...extra },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}
const post = (path, body) => api('POST', path, body);
const patch = (path, body) => api('PATCH', path, body);
const taskIn = (state, id) => state.projects.flatMap((p) => p.tasks).find((t) => t.id === id);

async function makeProject(name) {
  const { json } = await post('/api/projects', { name });
  return json.createdId;
}
async function makeTask(projectId, name, fields = {}) {
  const { json, status } = await post(`/api/projects/${projectId}/tasks`, { name, ...fields });
  assert.equal(status, 201, JSON.stringify(json));
  return json.createdId;
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tracker-test-'));
  app = createApp({ dataFile: join(dir, 'store.json'), password: '', saving: true });
  await new Promise((done) => app.server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

test('creates projects with distinct colors, and persists to disk', async () => {
  const a = await makeProject('Alpha');
  const b = await makeProject('Beta');
  const { json } = await api('GET', '/api/state');
  const colors = json.projects.filter((p) => [a, b].includes(p.id)).map((p) => p.color);
  assert.notEqual(colors[0], colors[1]);
  const disk = JSON.parse(readFileSync(join(dir, 'store.json'), 'utf8'));
  assert.ok(disk.projects.some((p) => p.id === a));
});

test('FIRM_LEADS is on unless turned off, and a typo is refused', () => {
  for (const unset of [undefined, '', '  ']) assert.equal(parseFirmLeads(unset), true);
  for (const on of ['true', 'on', 'YES', '1']) assert.equal(parseFirmLeads(on), true);
  for (const off of ['false', 'off', 'No', '0']) assert.equal(parseFirmLeads(off), false);
  assert.throws(() => parseFirmLeads('maybe'), /FIRM_LEADS must be true or false/);
});

test('the setting reaches the schedule', async () => {
  const firm = createApp({ dataFile: join(dir, 'firm-on.json'), password: '', saving: true, firmLeads: true });
  const standard = createApp({ dataFile: join(dir, 'firm-off.json'), password: '', saving: true, firmLeads: false });
  for (const [app, expected] of [[firm, true], [standard, false]]) {
    const projectId = app.store.createProject({ name: 'P' });
    const a = app.store.createTask(projectId, { name: 'A', start: '2026-06-01', duration: 5 });
    const b = app.store.createTask(projectId, { name: 'B', start: '2026-05-25', duration: 5, deps: [{ taskId: a, type: 'SF', lag: -2 }] });
    const state = app.store.snapshot();
    assert.equal(state.firmLeads, expected);
    const c = taskIn(state, b).computed;
    assert.equal(c.links[0].firm, expected);
    assert.deepEqual(c.conflicts.length > 0, expected);
    await app.close();
  }
});

test('negative lag travels through the API for every dependency type', async () => {
  const p = await makeProject('Negative lag');
  const a = await makeTask(p, 'A', { start: '2026-01-14', duration: 5 });
  const expected = { FS: '2026-01-19', SS: '2026-01-12', FF: '2026-01-14', SF: '2026-01-07' };
  for (const [type, start] of Object.entries(expected)) {
    const b = await makeTask(p, type, { start: '2024-06-03', duration: 3, deps: [{ taskId: a, type, lag: -2 }] });
    let state = (await api('GET', '/api/state')).json;
    assert.deepEqual(taskIn(state, b).deps, [{ taskId: a, type, lag: -2 }]);
    assert.equal(taskIn(state, b).computed.start, start, type);

    const res = await patch(`/api/tasks/${b}`, { deps: [{ taskId: a, type, lag: 1.5 }] });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /Lag/);
    state = (await api('GET', '/api/state')).json;
    assert.equal(taskIn(state, b).deps[0].lag, -2);
  }
});

test('rejects invalid input with a readable message', async () => {
  const p = await makeProject('Validation');
  assert.equal((await post('/api/projects', { name: '  ' })).status, 400);
  assert.equal((await post(`/api/projects/${p}/tasks`, { name: 'x', start: '2026-13-45' })).status, 400);
  assert.equal((await post(`/api/projects/${p}/tasks`, { name: 'x', status: 'nope' })).status, 400);
  const t = await makeTask(p, 'task');
  const res = await patch(`/api/tasks/${t}`, { progress: 400 });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /Progress/);
  assert.equal((await api('GET', '/api/tasks/none')).status, 404);
  assert.equal((await patch('/api/tasks/none', { name: 'x' })).status, 404);
});

test('task edits write history with who, what, from and to', async () => {
  const p = await makeProject('History');
  const t = await makeTask(p, 'Write spec', { actor: 'Ana' });
  await patch(`/api/tasks/${t}`, { pocName: 'Ana', actor: 'Ana' });
  await patch(`/api/tasks/${t}`, { pocName: 'Ben', actor: 'Ana' });
  const { json } = await post(`/api/tasks/${t}/updates`, { note: 'Draft shared', actor: 'Ben' });
  const history = taskIn(json, t).history;
  assert.equal(history[0].type, 'create');
  assert.deepEqual(
    history[2].changes.map((c) => [c.label, c.from, c.to]),
    [['Current POC', 'Ana', 'Ben']],
  );
  assert.equal(history[2].author, 'Ana');
  assert.equal(history.at(-1).type, 'update');
  assert.equal(history.at(-1).note, 'Draft shared');
  assert.equal(history.at(-1).author, 'Ben');
  assert.equal((await post(`/api/tasks/${t}/updates`, { note: '   ' })).status, 400);
});

test('an edit that changes nothing adds no history', async () => {
  const p = await makeProject('Quiet');
  const t = await makeTask(p, 'Same');
  const { json } = await patch(`/api/tasks/${t}`, { name: 'Same' });
  assert.equal(taskIn(json, t).history.length, 1);
});

test('status and percent complete stay consistent', async () => {
  const p = await makeProject('Status');
  const t = await makeTask(p, 'Work');
  let { json } = await patch(`/api/tasks/${t}`, { progress: 30 });
  assert.equal(taskIn(json, t).status, 'in_progress');
  ({ json } = await patch(`/api/tasks/${t}`, { progress: 100 }));
  assert.equal(taskIn(json, t).status, 'complete');
  ({ json } = await patch(`/api/tasks/${t}`, { status: 'in_progress' }));
  assert.equal(taskIn(json, t).progress, 90);
  ({ json } = await patch(`/api/tasks/${t}`, { status: 'not_started' }));
  assert.equal(taskIn(json, t).progress, 0);
  ({ json } = await patch(`/api/tasks/${t}`, { status: 'complete' }));
  assert.equal(taskIn(json, t).progress, 100);
});

test('setting a finish date converts to working-day duration', async () => {
  const p = await makeProject('Finish');
  const t = await makeTask(p, 'Work', { start: '2026-03-02' });
  const { json } = await patch(`/api/tasks/${t}`, { end: '2026-03-13' });
  assert.equal(taskIn(json, t).duration, 10);
  assert.equal(taskIn(json, t).computed.end, '2026-03-13');
  assert.equal((await patch(`/api/tasks/${t}`, { end: '2026-02-01' })).status, 400);
});

test('completing a pushed task pins it where it was scheduled', async () => {
  const p = await makeProject('Pin');
  const a = await makeTask(p, 'A', { start: '2026-03-02', duration: 10 });
  const b = await makeTask(p, 'B', { start: '2026-03-02', deps: [{ taskId: a }] });
  const { json } = await patch(`/api/tasks/${b}`, { status: 'complete' });
  assert.equal(taskIn(json, b).start, '2026-03-16');
  const after = await patch(`/api/tasks/${a}`, { duration: 2 });
  assert.equal(taskIn(after.json, b).computed.start, '2026-03-16');
});

test('cross-project slip is recorded on the downstream task history', async () => {
  const upstream = await makeProject('Upstream');
  const downstream = await makeProject('Downstream');
  const a = await makeTask(upstream, 'API', { start: '2026-03-02', duration: 5 });
  const b = await makeTask(downstream, 'Client', { start: '2026-03-02', deps: [{ taskId: a }] });
  const { json } = await patch(`/api/tasks/${a}`, { duration: 10, actor: 'Ana' });
  const task = taskIn(json, b);
  assert.equal(task.computed.start, '2026-03-16');
  const last = task.history.at(-1);
  assert.equal(last.type, 'schedule');
  assert.match(last.note, /"API" in Upstream/);
  assert.deepEqual(last.changes.find((c) => c.field === 'schedStart').to, '2026-03-16');
  assert.ok(json.crossLinks.some((l) => l.fromTaskId === a && l.toTaskId === b && l.state === 'driving'));
});

test('dependency loops are refused and nothing changes, even across projects', async () => {
  const p1 = await makeProject('Loop 1');
  const p2 = await makeProject('Loop 2');
  const a = await makeTask(p1, 'A');
  const b = await makeTask(p2, 'B', { deps: [{ taskId: a }] });
  const res = await patch(`/api/tasks/${a}`, { deps: [{ taskId: b }], notes: 'should not stick' });
  assert.equal(res.status, 409);
  assert.match(res.json.error, /loop/);
  const { json } = await api('GET', '/api/state');
  assert.equal(taskIn(json, a).deps.length, 0);
  assert.equal(taskIn(json, a).notes, '');
  assert.equal((await patch(`/api/tasks/${a}`, { deps: [{ taskId: a }] })).status, 400);
  assert.equal((await patch(`/api/tasks/${a}`, { deps: [{ taskId: 'missing' }] })).status, 400);
});

test('indent, outdent and reorder', async () => {
  const p = await makeProject('Outline');
  const a = await makeTask(p, 'A');
  const b = await makeTask(p, 'B');
  const c = await makeTask(p, 'C');
  let { json } = await post(`/api/tasks/${b}/move`, { direction: 'indent' });
  assert.equal(taskIn(json, b).parentId, a);
  assert.equal(taskIn(json, a).computed.isSummary, true);
  ({ json } = await post(`/api/tasks/${c}/move`, { direction: 'up' }));
  assert.equal(taskIn(json, c).computed.wbs, '1');
  ({ json } = await post(`/api/tasks/${b}/move`, { direction: 'outdent' }));
  assert.equal(taskIn(json, b).parentId, null);
  assert.equal(taskIn(json, b).computed.wbs, '3');
  assert.equal((await post(`/api/tasks/${a}/move`, { direction: 'sideways' })).status, 400);
});

test('deleting a task or project removes links and notes it in history', async () => {
  const p1 = await makeProject('Delete 1');
  const p2 = await makeProject('Delete 2');
  const a = await makeTask(p1, 'A');
  const s = await makeTask(p1, 'Summary');
  const child = await makeTask(p1, 'Child', { parentId: s });
  const b = await makeTask(p2, 'B', { deps: [{ taskId: a }, { taskId: child }] });
  let { json } = await api('DELETE', `/api/tasks/${s}`);
  assert.equal(taskIn(json, child), undefined);
  assert.equal(taskIn(json, b).deps.length, 1);
  ({ json } = await api('DELETE', `/api/projects/${p1}`));
  assert.equal(taskIn(json, b).deps.length, 0);
  assert.ok(taskIn(json, b).history.some((e) => /Delete 1/.test(e.note ?? '')));
  assert.ok(taskIn(json, b).history.every((e) => e.author));
});

test('baseline captures scheduled dates and can be cleared', async () => {
  const p = await makeProject('Baseline');
  const t = await makeTask(p, 'Work', { start: '2026-03-02', duration: 5 });
  let { json } = await post(`/api/projects/${p}/baseline`, {});
  assert.deepEqual(json.projects.find((x) => x.id === p).baseline.tasks[t], { start: '2026-03-02', end: '2026-03-06' });
  ({ json } = await api('DELETE', `/api/projects/${p}/baseline`));
  assert.equal(json.projects.find((x) => x.id === p).baseline, null);
});

test('export then replace-import restores everything exactly', async () => {
  const p1 = await makeProject('Round trip 1');
  const p2 = await makeProject('Round trip 2');
  const a = await makeTask(p1, 'A', { start: '2026-03-02', pocName: 'Ana' });
  const b = await makeTask(p2, 'B', { start: '2026-03-02', deps: [{ taskId: a, type: 'SS', lag: 2 }] });
  await post(`/api/tasks/${a}/updates`, { note: 'Progress note', actor: 'Ana' });
  const before = (await api('GET', '/api/export')).json;
  assert.equal(before.format, 'project-tracker-export');

  await api('DELETE', `/api/projects/${p1}`);
  await api('DELETE', `/api/projects/${p2}`);
  const res = await post('/api/import', { mode: 'replace', data: before });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const after = (await api('GET', '/api/export')).json;
  assert.deepEqual(after.projects, before.projects);
  assert.equal(taskIn(res.json, b).deps[0].taskId, a);
  assert.ok(readdirSync(join(dir, 'backups')).length >= 1);
});

test('merge import updates matching projects, keeps others, and re-ids colliding tasks', async () => {
  const keep = await makeProject('Keep me');
  const kept = await makeTask(keep, 'Kept');
  const file = {
    format: 'project-tracker-export',
    schemaVersion: 1,
    projects: [
      {
        id: 'importedproject',
        name: 'Imported',
        tasks: [
          { id: kept, name: 'Collides', start: '2026-03-02', duration: 3 },
          { id: 'second', name: 'Second', start: '2026-03-02', duration: 1, deps: [{ taskId: kept }, { taskId: 'gone' }] },
        ],
      },
    ],
  };
  const { json, status } = await post('/api/import', { mode: 'merge', data: file });
  assert.equal(status, 200, JSON.stringify(json));
  assert.equal(json.importResult.added, 1);
  assert.equal(json.importResult.droppedLinks, 1);
  const imported = json.projects.find((p) => p.id === 'importedproject');
  assert.notEqual(imported.tasks[0].id, kept);
  assert.equal(imported.tasks[1].deps[0].taskId, imported.tasks[0].id);
  assert.equal(taskIn(json, kept).name, 'Kept');

  file.projects[0].name = 'Imported again';
  file.projects[0].tasks = file.projects[0].tasks.slice(0, 1);
  const second = await post('/api/import', { mode: 'merge', data: file });
  assert.equal(second.json.importResult.replaced, 1);
  assert.equal(second.json.projects.filter((p) => p.id === 'importedproject').length, 1);
  assert.equal(second.json.projects.find((p) => p.id === 'importedproject').name, 'Imported again');
});

test('bad import files are refused and leave data untouched', async () => {
  const before = (await api('GET', '/api/export')).json.projects;
  const cases = [
    { data: { hello: 'world' }, mode: 'merge' },
    { data: { format: 'other', projects: [] }, mode: 'merge' },
    { data: { format: 'project-tracker-export', schemaVersion: 999, projects: [] }, mode: 'replace' },
    { data: { format: 'project-tracker-export', projects: [{ id: 'x', name: 'x', tasks: [{ id: 't', name: 't', start: 'soon' }] }] }, mode: 'replace' },
    { data: { format: 'project-tracker-export', projects: [] }, mode: 'overwrite' },
    {
      data: {
        format: 'project-tracker-export',
        projects: [
          {
            id: 'x',
            name: 'x',
            tasks: [
              { id: 'a', name: 'a', start: '2026-01-01', deps: [{ taskId: 'b' }] },
              { id: 'b', name: 'b', start: '2026-01-01', deps: [{ taskId: 'a' }] },
            ],
          },
        ],
      },
      mode: 'replace',
    },
    {
      data: {
        format: 'project-tracker-export',
        projects: [{ id: 'x', name: 'x', tasks: [{ id: 'a', name: 'a', start: '2026-01-01', parentId: 'b' }, { id: 'b', name: 'b', start: '2026-01-01', parentId: 'a' }] }],
      },
      mode: 'replace',
    },
  ];
  for (const body of cases) {
    const res = await post('/api/import', body);
    assert.ok(res.status === 400 || res.status === 409, `${JSON.stringify(body)} -> ${res.status}`);
    assert.ok(res.json.error);
  }
  assert.deepEqual((await api('GET', '/api/export')).json.projects, before);
});

test('with saving off nothing is written, and changes end with the server', async () => {
  const folder = join(dir, 'unsaved');
  const file = join(folder, 'store.json');
  const first = createApp({ dataFile: file, password: '', saving: false });
  const id = first.store.createProject({ name: 'Temporary' });
  first.store.createTask(id, { name: 'Gone soon' });
  const exported = first.store.exportAll();
  first.store.importAll(exported, 'replace');
  assert.equal(first.store.snapshot().saving, false);
  assert.equal(first.store.snapshot().projects[0].tasks[0].name, 'Gone soon');
  assert.equal(existsSync(folder), false);
  await first.close();
  const second = createApp({ dataFile: file, password: '', saving: false });
  assert.equal(second.store.snapshot().projects.length, 0);
  await second.close();
});

test('with saving off existing data loads and its file is left alone', async () => {
  const file = join(dir, 'kept.json');
  const saved = createApp({ dataFile: file, password: '', saving: true });
  assert.equal(saved.store.snapshot().saving, true);
  saved.store.createProject({ name: 'Kept' });
  await saved.close();
  const before = readFileSync(file, 'utf8');
  const unsaved = createApp({ dataFile: file, password: '', saving: false });
  assert.equal(unsaved.store.snapshot().projects[0].name, 'Kept');
  unsaved.store.createProject({ name: 'Not kept' });
  assert.equal(unsaved.store.snapshot().projects.length, 2);
  await unsaved.close();
  assert.equal(readFileSync(file, 'utf8'), before);
});

test('with saving off the server refuses changes but still offers its file', async () => {
  const file = join(dir, 'refusing.json');
  const saved = createApp({ dataFile: file, password: '', saving: true });
  saved.store.createProject({ name: 'On file' });
  await saved.close();
  const before = readFileSync(file, 'utf8');

  const off = createApp({ dataFile: file, password: '', saving: false });
  await new Promise((done) => off.server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${off.server.address().port}`;
  try {
    const send = (method, path) => fetch(url + path, { method, headers, body: JSON.stringify({ name: 'Nope', mode: 'merge' }) });
    assert.equal((await send('POST', '/api/projects')).status, 409);
    assert.equal((await send('POST', '/api/import')).status, 409);
    assert.equal((await send('POST', '/api/sample')).status, 409);
    const state = await (await fetch(`${url}/api/state`)).json();
    assert.equal(state.saving, false);
    assert.equal(state.projects[0].name, 'On file');
    assert.equal((await (await fetch(`${url}/api/export`)).json()).projects[0].name, 'On file');
    assert.equal(off.store.snapshot().projects.length, 1);
    assert.equal(readFileSync(file, 'utf8'), before);
    assert.equal((await fetch(`${url}/shared/store-core.js`)).status, 200);
  } finally {
    await off.close();
  }
});

test('SAVE_DATA accepts on and off words and refuses anything else', () => {
  for (const value of ['true', 'TRUE', 'on', 'yes', '1', ' true ']) assert.equal(parseSaveData(value), true, value);
  for (const value of [undefined, '', 'false', 'False', 'off', 'no', '0']) assert.equal(parseSaveData(value), false, value);
  for (const value of ['flase', 'disabled', '2']) assert.throws(() => parseSaveData(value), /SAVE_DATA/);
});

test('data survives a restart', async () => {
  const file = join(dir, 'restart.json');
  const first = createApp({ dataFile: file, password: '', saving: true });
  const id = first.store.createProject({ name: 'Durable' });
  first.store.createTask(id, { name: 'Still here', pocName: 'Ana' });
  await first.close();
  const second = createApp({ dataFile: file, password: '', saving: true });
  const project = second.store.snapshot().projects[0];
  assert.equal(project.name, 'Durable');
  assert.equal(project.tasks[0].pocName, 'Ana');
  assert.ok(project.tasks[0].computed.start);
  await second.close();
});

test('sample data loads and every cross-project link resolves', async () => {
  const { json, status } = await post('/api/sample', {});
  assert.equal(status, 200, JSON.stringify(json));
  assert.ok(json.projects.some((p) => p.name === 'Platform Migration'));
  assert.ok(json.crossLinks.length >= 3);
});

test('malformed bodies and wrong content types are refused', async () => {
  const res = await fetch(`${base}/api/projects`, { method: 'POST', headers, body: '{bad' });
  assert.equal(res.status, 400);
  const text = await fetch(`${base}/api/projects`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(text.status, 415);
});

test('cross-site writes are refused', async () => {
  const res = await fetch(`${base}/api/projects`, {
    method: 'POST',
    headers: { ...headers, Origin: 'https://evil.example' },
    body: JSON.stringify({ name: 'nope' }),
  });
  assert.equal(res.status, 403);
});

test('static files are served and paths cannot escape the public folder', async () => {
  const home = await fetch(`${base}/`);
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-type'), /html/);
  assert.ok(home.headers.get('content-security-policy'));
  for (const path of ['/%2e%2e/package.json', '/..%2fpackage.json', '/.%2e/src/server.js']) {
    assert.equal((await fetch(base + path)).status, 404, path);
  }
  assert.equal(existsSync(join(dir, 'store.json')), true);
});

test('live-update stream announces new revisions', async () => {
  const controller = new AbortController();
  const res = await fetch(`${base}/api/events`, { signal: controller.signal });
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const reader = res.body.getReader();
  await reader.read(); // connected comment
  await makeProject('Live');
  const { value } = await reader.read();
  assert.match(Buffer.from(value).toString(), /data: \d+/);
  controller.abort();
});

test('password protection, and requests addressed to a network address', async () => {
  const locked = createApp({ dataFile: join(dir, 'locked.json'), password: 's3cret' });
  await new Promise((done) => locked.server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${locked.server.address().port}/api/state`;
  try {
    assert.equal((await fetch(url)).status, 401);
    const wrong = Buffer.from('me:nope').toString('base64');
    assert.equal((await fetch(url, { headers: { Authorization: `Basic ${wrong}` } })).status, 401);
    const right = Buffer.from('me:s3cret').toString('base64');
    assert.equal((await fetch(url, { headers: { Authorization: `Basic ${right}` } })).status, 200);
  } finally {
    await locked.close();
  }
  const { request } = await import('node:http');
  // Phones reach the server through the computer's network address.
  const status = await new Promise((done, fail) => {
    request({ host: '127.0.0.1', port: new URL(base).port, path: '/api/state', headers: { Host: '192.168.1.20:3000' } }, (res) => {
      res.resume();
      done(res.statusCode);
    }).on('error', fail).end();
  });
  assert.equal(status, 200);
});
