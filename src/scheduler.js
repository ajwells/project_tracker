// Pure scheduling engine. Runs a forward and backward pass over every task in
// every project at once, so a cross-project dependency behaves like any other.
//
// A task's stored `start` is the date its owner asked for ("start no earlier
// than"). The scheduled dates are derived from it: predecessors can push a task
// later, and it returns to the requested date when they move back.

const DAY_MS = 86400000;
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidDate(iso) {
  if (typeof iso !== 'string') return false;
  const m = ISO_RE.exec(iso);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

export function toDayNumber(iso) {
  const m = ISO_RE.exec(iso);
  return Date.UTC(+m[1], +m[2] - 1, +m[3]) / DAY_MS;
}

export function toIso(dayNumber) {
  return new Date(dayNumber * DAY_MS).toISOString().slice(0, 10);
}

export function makeCalendar(calendar = {}) {
  const holidays = new Set((calendar.holidays || []).filter(isValidDate).map(toDayNumber));
  const workWeekends = !!calendar.workWeekends;
  const isWork = (n) => {
    if (holidays.has(n)) return false;
    if (workWeekends) return true;
    const dow = (((n + 4) % 7) + 7) % 7; // day 0 was a Thursday
    return dow !== 0 && dow !== 6;
  };
  const next = (n) => {
    let d = n;
    for (let i = 0; i < 4000 && !isWork(d); i++) d++;
    return d;
  };
  const prev = (n) => {
    let d = n;
    for (let i = 0; i < 4000 && !isWork(d); i++) d--;
    return d;
  };
  // Moves k working days from n. k = 0 snaps forward to a working day.
  const add = (n, k) => {
    if (k === 0) return next(n);
    let d = n;
    let left = Math.abs(k);
    const step = k > 0 ? 1 : -1;
    while (left > 0) {
      d += step;
      if (isWork(d)) left--;
    }
    return d;
  };
  // Working days in the inclusive range [a, b].
  const count = (a, b) => {
    let c = 0;
    for (let d = a; d <= b; d++) if (isWork(d)) c++;
    return c;
  };
  // Signed working-day distance from a to b; 0 when they are the same day.
  const diff = (a, b) => {
    if (a === b) return 0;
    return a < b ? count(a + 1, b) : -count(b + 1, a);
  };
  return { isWork, next, prev, add, count, diff };
}

const spanOf = (task) => (task.milestone ? 0 : Math.max(1, task.duration | 0) - 1);

// Earliest start the successor can take given one dependency.
function requiredStart(dep, pred, succ, cal) {
  const lag = dep.lag | 0;
  const span = spanOf(succ);
  switch (dep.type) {
    case 'SS':
      return cal.add(cal.next(pred.start), lag);
    case 'FF':
      return cal.add(cal.add(cal.next(pred.end), lag), -span);
    case 'SF':
      return cal.add(cal.add(pred.start, lag - 1), -span);
    case 'FS':
    default:
      // A milestone sits at the end of the day it lands on, so it can share the
      // predecessor's last day; a real task starts on the next working day.
      return cal.add(pred.end, succ.milestone ? lag : 1 + lag);
  }
}

// Latest finish the predecessor can take given a successor's late dates.
function latestFinish(dep, predTask, succTask, succLate, predCal, succCal) {
  const lag = dep.lag | 0;
  const lateStart = succCal.add(succLate, -spanOf(succTask));
  const predSpan = spanOf(predTask);
  switch (dep.type) {
    case 'SS':
      return predCal.add(predCal.prev(succCal.add(lateStart, -lag)), predSpan);
    case 'FF':
      return predCal.prev(succCal.add(succLate, -lag));
    case 'SF':
      return predCal.add(predCal.prev(succCal.add(succLate, 1 - lag)), predSpan);
    case 'FS':
    default:
      return predCal.prev(succCal.add(lateStart, succTask.milestone ? -lag : -1 - lag));
  }
}

/**
 * Computes the schedule for all projects.
 * Returns { tasks: Map<id, computed>, projects: Map<id, rollup>, crossLinks, cycle }.
 * `cycle` is a non-empty array of task ids when the dependency graph has a loop,
 * in which case nothing else is populated.
 */
export function computeSchedule(projects, todayIso) {
  const today = toDayNumber(todayIso);
  const byId = new Map();
  const children = new Map();
  const calendars = new Map();

  for (const project of projects) {
    calendars.set(project.id, makeCalendar(project.calendar));
    for (const task of project.tasks) byId.set(task.id, { task, project });
  }
  for (const project of projects) {
    for (const task of project.tasks) {
      if (task.parentId && byId.has(task.parentId)) {
        if (!children.has(task.parentId)) children.set(task.parentId, []);
        children.get(task.parentId).push(task.id);
      }
    }
  }

  const isSummary = (id) => children.has(id);
  const parentOf = (id) => {
    const p = byId.get(id).task.parentId;
    return p && byId.has(p) ? p : null;
  };
  const leavesOf = (id) => {
    if (!isSummary(id)) return [id];
    return children.get(id).flatMap(leavesOf);
  };

  // A leaf inherits the dependencies of every summary above it.
  const effectiveDeps = new Map();
  for (const [id, { task }] of byId) {
    if (isSummary(id)) continue;
    const deps = [...(task.deps || [])];
    const seen = new Set([id]);
    for (let p = parentOf(id); p && !seen.has(p); p = parentOf(p)) {
      seen.add(p);
      deps.push(...(byId.get(p).task.deps || []));
    }
    effectiveDeps.set(id, deps.filter((d) => byId.has(d.taskId)));
  }

  // Topological order over: predecessor -> leaf, child -> parent.
  const outgoing = new Map([...byId.keys()].map((id) => [id, []]));
  const indegree = new Map([...byId.keys()].map((id) => [id, 0]));
  const addEdge = (a, b) => {
    outgoing.get(a).push(b);
    indegree.set(b, indegree.get(b) + 1);
  };
  for (const [leaf, deps] of effectiveDeps) for (const dep of deps) addEdge(dep.taskId, leaf);
  for (const [parent, kids] of children) for (const kid of kids) addEdge(kid, parent);

  const queue = [...byId.keys()].filter((id) => indegree.get(id) === 0);
  const order = [];
  while (queue.length) {
    const id = queue.pop();
    order.push(id);
    for (const next of outgoing.get(id)) {
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) queue.push(next);
    }
  }
  if (order.length !== byId.size) {
    return {
      cycle: [...byId.keys()].filter((id) => indegree.get(id) > 0),
      tasks: new Map(),
      projects: new Map(),
      crossLinks: [],
    };
  }

  // Forward pass.
  const dates = new Map();
  for (const id of order) {
    const { task, project } = byId.get(id);
    if (isSummary(id)) {
      const kids = children.get(id).map((k) => dates.get(k));
      dates.set(id, {
        start: Math.min(...kids.map((k) => k.start)),
        end: Math.max(...kids.map((k) => k.end)),
      });
      continue;
    }
    const cal = calendars.get(project.id);
    const span = spanOf(task);
    const requested = cal.next(toDayNumber(task.start));
    const pinned = task.manual || task.status === 'complete';
    let start = requested;
    let driverId = null;
    const conflicts = [];
    for (const dep of effectiveDeps.get(id)) {
      const required = requiredStart(dep, dates.get(dep.taskId), task, cal);
      if (pinned) {
        if (required > start && task.status !== 'complete') conflicts.push(dep.taskId);
      } else if (required > start) {
        start = required;
        driverId = dep.taskId;
      }
    }
    dates.set(id, { start, end: cal.add(start, span), requested, driverId, conflicts, pinned });
  }

  // Backward pass for float and the critical path.
  const projectEnd = new Map();
  for (const [id, { project }] of byId) {
    if (isSummary(id)) continue;
    const end = dates.get(id).end;
    if (!projectEnd.has(project.id) || end > projectEnd.get(project.id)) projectEnd.set(project.id, end);
  }
  const late = new Map();
  for (const [id, { project }] of byId) if (!isSummary(id)) late.set(id, projectEnd.get(project.id));
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i];
    if (isSummary(id)) continue;
    const { task, project } = byId.get(id);
    if (dates.get(id).pinned) continue; // pinned tasks ignore their predecessors
    const succCal = calendars.get(project.id);
    for (const dep of effectiveDeps.get(id)) {
      const startBased = dep.type === 'SS' || dep.type === 'SF';
      const predDates = dates.get(dep.taskId);
      const predLeaves = leavesOf(dep.taskId).filter((l) => !startBased || dates.get(l).start === predDates.start);
      for (const leaf of predLeaves) {
        const pred = byId.get(leaf);
        const limit = latestFinish(dep, pred.task, task, late.get(id), calendars.get(pred.project.id), succCal);
        if (limit < late.get(leaf)) late.set(leaf, limit);
      }
    }
  }

  // Assemble per-task results.
  const computed = new Map();
  for (const id of order) {
    const { task, project } = byId.get(id);
    const cal = calendars.get(project.id);
    const d = dates.get(id);
    if (isSummary(id)) {
      const leaves = leavesOf(id).map((l) => computed.get(l));
      const weight = (t) => Math.max(1, t.duration);
      const total = leaves.reduce((sum, t) => sum + weight(t), 0);
      const done = leaves.reduce((sum, t) => sum + weight(t) * t.progress, 0);
      const statuses = leaves.map((t) => t.status);
      let status = 'not_started';
      if (statuses.every((s) => s === 'complete')) status = 'complete';
      else if (statuses.includes('blocked')) status = 'blocked';
      else if (statuses.some((s) => s === 'in_progress' || s === 'complete')) status = 'in_progress';
      const openFloats = leaves.filter((t) => t.status !== 'complete').map((t) => t.float);
      computed.set(id, {
        id,
        projectId: project.id,
        start: toIso(d.start),
        end: toIso(d.end),
        duration: cal.count(d.start, d.end),
        isSummary: true,
        status,
        progress: Math.round(done / total),
        float: openFloats.length ? Math.min(...openFloats) : 0,
        critical: leaves.some((t) => t.critical),
        driverId: null,
        delay: 0,
        conflicts: [],
        health: healthOf({ status, start: d.start, end: d.end, conflicts: [] }, today),
      });
      continue;
    }
    const lateFinish = late.get(id);
    const float = lateFinish >= d.end ? cal.count(d.end, lateFinish) - 1 : -(cal.count(lateFinish, d.end) - 1);
    const status = task.status;
    computed.set(id, {
      id,
      projectId: project.id,
      start: toIso(d.start),
      end: toIso(d.end),
      duration: task.milestone ? 0 : Math.max(1, task.duration | 0),
      isSummary: false,
      status,
      progress: task.progress,
      float,
      critical: float <= 0 && status !== 'complete',
      driverId: d.driverId,
      delay: Math.max(0, cal.diff(d.requested, d.start)),
      conflicts: d.conflicts,
      health: healthOf({ status, start: d.start, end: d.end, conflicts: d.conflicts }, today),
    });
  }

  // Outline numbers, in each project's own order.
  for (const project of projects) {
    const walk = (parentId, prefix) => {
      project.tasks
        .filter((t) => (t.parentId || null) === parentId)
        .forEach((t, i) => {
          const wbs = prefix ? `${prefix}.${i + 1}` : String(i + 1);
          computed.get(t.id).wbs = wbs;
          computed.get(t.id).depth = prefix ? prefix.split('.').length : 0;
          walk(t.id, wbs);
        });
    };
    walk(null, '');
  }

  // Project rollups.
  const rollups = new Map();
  for (const project of projects) {
    const leaves = project.tasks.filter((t) => !isSummary(t.id)).map((t) => computed.get(t.id));
    const summary = {
      taskCount: leaves.length,
      openCount: leaves.filter((t) => t.status !== 'complete').length,
      lateCount: leaves.filter((t) => t.health === 'late').length,
      atRiskCount: leaves.filter((t) => t.health === 'at_risk').length,
      start: null,
      end: null,
      progress: 0,
      upstream: 0,
      downstream: 0,
    };
    if (leaves.length) {
      summary.start = leaves.map((t) => t.start).sort()[0];
      summary.end = leaves.map((t) => t.end).sort().at(-1);
      const total = leaves.reduce((sum, t) => sum + Math.max(1, t.duration), 0);
      summary.progress = Math.round(leaves.reduce((sum, t) => sum + Math.max(1, t.duration) * t.progress, 0) / total);
    }
    rollups.set(project.id, summary);
  }

  // Cross-project links, with how much room each one has.
  const crossLinks = [];
  for (const [id, { task, project }] of byId) {
    for (const dep of task.deps || []) {
      const pred = byId.get(dep.taskId);
      if (!pred || pred.project.id === project.id) continue;
      const cal = calendars.get(project.id);
      const predDates = dates.get(dep.taskId);
      const succDates = dates.get(id);
      const buffer = cal.diff(requiredStart(dep, predDates, task, cal), succDates.start);
      rollups.get(project.id).upstream++;
      rollups.get(pred.project.id).downstream++;
      crossLinks.push({
        fromProjectId: pred.project.id,
        fromTaskId: dep.taskId,
        toProjectId: project.id,
        toTaskId: id,
        type: dep.type,
        lag: dep.lag | 0,
        buffer,
        state: buffer < 0 ? 'conflict' : buffer === 0 ? 'driving' : 'buffer',
      });
    }
  }

  return { tasks: computed, projects: rollups, crossLinks, cycle: null };
}

function healthOf({ status, start, end, conflicts }, today) {
  if (status === 'complete') return 'complete';
  if (end < today) return 'late';
  if (status === 'blocked' || conflicts.length || (status === 'not_started' && start < today)) return 'at_risk';
  return 'on_track';
}
