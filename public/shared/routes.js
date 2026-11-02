// The API's change requests, shared so the server and the browser's own store
// behave the same way. The server adds transport, such as reading bodies.

import { HttpError } from './store-core.js';
import { buildSample } from './sample.js';

export function applyChange(store, method, pathname, body) {
  const parts = pathname.split('/').filter(Boolean).slice(1); // drop "api"
  const actor = body.actor;
  const ok = () => ({ status: 200, body: store.snapshot() });

  if (method === 'POST' && pathname === '/api/projects') {
    const id = store.createProject(body);
    return { status: 201, body: { ...store.snapshot(), createdId: id } };
  }
  if (method === 'POST' && pathname === '/api/import') {
    const result = store.importAll(body.data, body.mode);
    return { status: 200, body: { ...store.snapshot(), importResult: result } };
  }
  if (method === 'POST' && pathname === '/api/sample') {
    const result = store.importAll(buildSample(store.snapshot().today), 'merge');
    return { status: 200, body: { ...store.snapshot(), importResult: result } };
  }
  if (parts[0] === 'projects' && parts[1]) {
    const id = parts[1];
    if (parts.length === 2 && method === 'PATCH') {
      store.updateProject(id, body);
      return ok();
    }
    if (parts.length === 2 && method === 'DELETE') {
      store.deleteProject(id, actor);
      return ok();
    }
    if (parts[2] === 'tasks' && parts.length === 3 && method === 'POST') {
      const taskId = store.createTask(id, body);
      return { status: 201, body: { ...store.snapshot(), createdId: taskId } };
    }
    if (parts[2] === 'baseline' && parts.length === 3) {
      if (method === 'POST') store.setBaseline(id, true);
      else if (method === 'DELETE') store.setBaseline(id, false);
      else throw new HttpError(405, 'Method not allowed.');
      return ok();
    }
  }
  if (parts[0] === 'tasks' && parts[1]) {
    const id = parts[1];
    if (parts.length === 2 && method === 'PATCH') {
      store.updateTask(id, body);
      return ok();
    }
    if (parts.length === 2 && method === 'DELETE') {
      store.deleteTask(id, actor);
      return ok();
    }
    if (parts[2] === 'updates' && parts.length === 3 && method === 'POST') {
      store.addUpdate(id, body);
      return ok();
    }
    if (parts[2] === 'move' && parts.length === 3 && method === 'POST') {
      store.moveTask(id, body.direction, actor);
      return ok();
    }
  }
  throw new HttpError(404, 'Not found.');
}
