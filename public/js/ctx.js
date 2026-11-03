// Shared app state and server access, used by every view.

import { downloadBlob, toast } from './util.js';
import { LocalStore, STORAGE_KEY } from './local-store.js';
import { applyChange } from '../shared/routes.js';
import { isFirmLead } from '../shared/scheduler.js';
import { HttpError } from '../shared/store-core.js';

const storage = {
  get(key, fallback = null) {
    try {
      return localStorage.getItem(key) ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      // Private browsing can block storage; preferences just won't persist.
    }
  },
};

export const ctx = {
  data: null,
  route: { projectId: null, tab: 'overview' },
  taskId: null,
  collapsed: new Set(),
  filters: { search: '', poc: '', status: '' },
  gantt: { zoom: null, critical: true, baseline: false, detail: 'key' },
  timelineScope: 'key',
  composer: new Map(), // unsent update text, by task id
  focusAfter: null,
  storage,
  render: () => {},
  renderDrawer: () => {},

  get actor() {
    return storage.get('tracker.name', '');
  },
  set actor(name) {
    storage.set('tracker.name', name || null);
  },

  project(id) {
    return ctx.data.projects.find((p) => p.id === id);
  },
  findTask(id) {
    for (const project of ctx.data.projects) {
      const task = project.tasks.find((t) => t.id === id);
      if (task) return { project, task };
    }
    return null;
  },
  pocNames() {
    const names = new Set();
    for (const project of ctx.data.projects) {
      if (project.owner) names.add(project.owner);
      for (const task of project.tasks) if (task.pocName) names.add(task.pocName);
    }
    return [...names].sort((a, b) => a.localeCompare(b));
  },
  isFirm: (dep) => !!ctx.data?.firmLeads && isFirmLead(dep),
  isMobile: () => innerWidth <= 860,

  go(hash) {
    if (location.hash === hash) ctx.render();
    else location.hash = hash;
  },
  openTask(id) {
    ctx.taskId = id;
    ctx.render();
  },
};

// Set when the server isn't saving data, so projects are kept in this browser.
let local = null;

function applySnapshot(snapshot) {
  // A server restarted with another data file can have a lower revision.
  if (ctx.data && snapshot.serverId === ctx.data.serverId && snapshot.revision < ctx.data.revision) return;
  ctx.data = snapshot;
}

async function openLocalStore(serverState) {
  const store = new LocalStore({ firmLeads: serverState.firmLeads });
  if (store.damaged) toast('The projects stored in this browser could not be read, so they were set aside.', 'error');
  // A browser's first visit starts from whatever the server already has on file.
  if (!store.hasSavedCopy() && !store.damaged && serverState.projects.length) {
    try {
      const res = await fetch('/api/export');
      if (res.ok) store.importAll(await res.json(), 'replace');
    } catch {
      toast('Could not copy the server\'s projects into this browser.', 'error');
    }
  }
  return store;
}

export async function refresh() {
  const res = await fetch('/api/state');
  if (!res.ok) throw new Error('Could not load your projects.');
  const snapshot = await res.json();
  const useLocal = snapshot.saving === false;
  // The server restarted with the other SAVE_DATA setting, so start over in that mode.
  if (ctx.data && useLocal !== !!local) {
    location.reload();
    return;
  }
  if (useLocal) {
    local ??= await openLocalStore(snapshot);
    local.firmLeads = snapshot.firmLeads;
    local.load();
    ctx.data = local.snapshot();
  } else {
    applySnapshot(snapshot);
  }
  ctx.render();
}

// Downloads the export from this browser's copy. The server has none to offer.
export function exportFromBrowser(event) {
  if (!local) return;
  event.preventDefault();
  local.load();
  const stamp = new Date().toISOString().slice(0, 10);
  downloadBlob(new Blob([JSON.stringify(local.exportAll(), null, 2)], { type: 'application/json' }), `project-tracker-export-${stamp}.json`);
}

function applyLocally(method, path, body) {
  try {
    local.load();
    const result = applyChange(local, method, path, JSON.parse(JSON.stringify({ ...body, actor: ctx.actor || undefined })));
    ctx.data = result.body;
    ctx.render();
    return result.body;
  } catch (error) {
    if (!(error instanceof HttpError)) console.error(error);
    toast(error instanceof HttpError ? error.message : 'That change could not be saved.', 'error');
    ctx.render();
    return null;
  }
}

// Sends a change. Failures show a toast and resolve to null, so callers can
// just check the result; the view re-renders from server truth either way.
export async function api(method, path, body = {}) {
  if (local) return applyLocally(method, path, body);
  try {
    const res = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, actor: ctx.actor || undefined }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast(json.error || 'That change could not be saved.', 'error');
      ctx.render();
      return null;
    }
    applySnapshot(json);
    ctx.render();
    return json;
  } catch {
    toast('Could not reach the server. Your change was not saved.', 'error');
    ctx.render();
    return null;
  }
}

// Picks up changes made in another tab or on another device.
export function listenForChanges() {
  const events = new EventSource('/api/events');
  let connected = false;
  // Reconnecting means the server may have restarted, so reload what it holds now.
  events.onopen = () => {
    if (connected) refresh().catch(() => {});
    connected = true;
  };
  events.onmessage = (event) => {
    if (!local && ctx.data && Number(event.data) > ctx.data.revision) refresh().catch(() => {});
  };
  // Another tab changed this browser's copy. A null key means storage was cleared.
  addEventListener('storage', (event) => {
    if (!local || (event.key !== STORAGE_KEY && event.key !== null)) return;
    local.load();
    ctx.data = local.snapshot();
    ctx.render();
  });
}
