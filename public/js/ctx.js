// Shared app state and server access, used by every view.

import { toast } from './util.js';

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

function applySnapshot(snapshot) {
  if (ctx.data && snapshot.revision < ctx.data.revision) return;
  ctx.data = snapshot;
}

export async function refresh() {
  const res = await fetch('/api/state');
  if (!res.ok) throw new Error('Could not load your projects.');
  applySnapshot(await res.json());
  ctx.render();
}

// Sends a change. Failures show a toast and resolve to null, so callers can
// just check the result; the view re-renders from server truth either way.
export async function api(method, path, body = {}) {
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
  events.onmessage = (event) => {
    if (ctx.data && Number(event.data) > ctx.data.revision) refresh().catch(() => {});
  };
}
