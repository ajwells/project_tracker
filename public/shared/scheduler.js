// Pure scheduling engine. Runs a forward and backward pass over every task in
// every project at once, so a cross-project dependency behaves like any other.
//
// How a task gets its dates:
//   - Tracked by duration, start not set by hand (startSet === false): follows its
//     links, earlier or later. With no links it stays on its stored start.
//   - Tracked by duration, start set by hand: that date is "start no earlier than".
//     Links can push the task later, and it returns when they move back.
//   - Tracked by dates: the stored start and finish hold, and the duration is
//     whatever they span. A link they break is reported as a conflict.
// A missing startSet means set by hand, so data saved before it existed keeps its dates.
//
// Firm leads differ from the standard meaning of these links. By the standard, every
// link only sets the earliest date. Here a negative SS or SF is a rule both ways: "A
// finishes 30 days before B starts" also means A can't finish later than that. A still
// moves with B, but finishing late is a conflict, and A has no more float than B. The
// FIRM_LEADS setting turns this off.
//
// Days count on a clock. A duration or a lag counts working days by default, on the
// project's calendar. Counting calendar days instead uses a clock with no days off:
//   - A task with a calendar duration runs through weekends and holidays, and can start
//     or finish on one.
//   - A calendar lag lands wherever it lands. A task with a working duration then moves
//     to a working day: forward, or back for a firm lead, which must stay ahead of its rule.

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

const EVERY_DAY = makeCalendar({ workWeekends: true });

// What a task's duration counts on. A milestone has no duration, so it keeps to working days.
export const durationClock = (task, cal) => (task.durationUnit === 'calendar' && !task.milestone ? EVERY_DAY : cal);
const lagClock = (dep, cal) => (dep.lagUnit === 'calendar' ? EVERY_DAY : cal);

const spanOf = (task) => (task.milestone ? 0 : Math.max(1, task.duration | 0) - 1);

export const isFirmLead = (dep) => (dep.type === 'SS' || dep.type === 'SF') && (dep.lag | 0) < 0;

export const tracksDates = (task) => task.trackBy === 'dates' && !task.milestone && isValidDate(task.finish);

// The days a task tracked by dates spans. At least one, even over a weekend.
export function datesDuration(task, cal) {
  return Math.max(1, durationClock(task, cal).count(toDayNumber(task.start), toDayNumber(task.finish)));
}

// Earliest start the successor can take given one dependency, or for a firm lead the
// start it must keep to. `succ` is { milestone, span, clock }.
function requiredStart(dep, pred, succ, cal, firm = false) {
  const lag = dep.lag | 0;
  const { span, clock } = succ;
  const days = lagClock(dep, cal);
  const land = (day) => (firm ? clock.prev(day) : clock.next(day));
  const startFor = (finish) => clock.add(land(finish), -span);
  switch (dep.type) {
    case 'SS':
      return land(days.add(days.next(pred.start), lag));
    case 'FF':
      return startFor(days.add(days.next(pred.end), lag));
    case 'SF':
      return startFor(days.add(pred.start, lag - 1));
    case 'FS':
    default:
      // A milestone sits at the end of the day it lands on, so it can share the
      // predecessor's last day; a real task starts on the next working day.
      return land(days.add(pred.end, succ.milestone ? lag : 1 + lag));
  }
}

// Latest finish the predecessor can take given a successor's late dates. Working back
// can land off by a little when the days off differ on each clock, so the guess is walked
// against the forward rule itself, to the last day on which the successor would still fit.
// `pred` is { span, clock }.
function latestFinish(dep, pred, succ, succLate, cal, firm) {
  const lag = dep.lag | 0;
  const { span, clock } = pred;
  const days = lagClock(dep, cal);
  const lateStart = succ.clock.add(succLate, -succ.span);
  const guess = () => {
    switch (dep.type) {
      case 'SS':
        return clock.add(clock.prev(days.add(lateStart, -lag)), span);
      case 'FF':
        return clock.prev(days.add(succLate, -lag));
      case 'SF':
        return clock.add(clock.prev(days.add(succLate, 1 - lag)), span);
      case 'FS':
      default:
        return clock.prev(days.add(lateStart, succ.milestone ? -lag : -1 - lag));
    }
  };
  const fits = (end) => requiredStart(dep, { start: clock.add(end, -span), end }, succ, cal, firm) <= lateStart;
  let finish = guess();
  for (let i = 0; i < 4000 && !fits(finish); i++) finish = clock.add(finish, -1);
  for (let i = 0; i < 4000 && fits(clock.add(finish, 1)); i++) finish = clock.add(finish, 1);
  return finish;
}

/**
 * Computes the schedule for all projects.
 * Returns { tasks: Map<id, computed>, projects: Map<id, rollup>, crossLinks, cycle }.
 * `cycle` is a non-empty array of task ids when the dependency graph has a loop,
 * in which case nothing else is populated.
 */
export function computeSchedule(projects, todayIso, { firmLeads = true } = {}) {
  const today = toDayNumber(todayIso);
  const isFirm = (dep) => firmLeads && isFirmLead(dep);
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
    const byDates = tracksDates(task);
    const clock = durationClock(task, cal);
    const requested = clock.next(toDayNumber(task.start));
    const span = byDates ? datesDuration(task, cal) - 1 : spanOf(task);
    const pinned = task.manual || task.status === 'complete' || byDates;
    const deps = effectiveDeps.get(id);
    const followsLinks = !pinned && task.startSet === false && deps.length > 0;
    const shape = { milestone: !!task.milestone, span, clock };
    let start = followsLinks ? -Infinity : requested;
    let driverId = null;
    let linkStart = null;
    const conflicts = [];
    for (const dep of deps) {
      const required = requiredStart(dep, dates.get(dep.taskId), shape, cal, isFirm(dep));
      if (linkStart === null || required > linkStart) linkStart = required;
      if (pinned) {
        if (required > start && task.status !== 'complete') conflicts.push(dep.taskId);
      } else if (required > start) {
        start = required;
        driverId = dep.taskId;
      }
    }
    dates.set(id, { start, end: clock.add(start, span), requested, driverId, conflicts, pinned, followsLinks, linkStart, shape });
  }

  // Backward pass for float and the critical path.
  const projectEnd = new Map();
  for (const [id, { project }] of byId) {
    if (isSummary(id)) continue;
    const end = dates.get(id).end;
    if (!projectEnd.has(project.id) || end > projectEnd.get(project.id)) projectEnd.set(project.id, end);
  }
  const late = new Map();
  for (const [id, { project }] of byId) if (!isSummary(id)) late.set(id, dates.get(id).shape.clock.prev(projectEnd.get(project.id)));
  const backwardPass = () => { for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i];
    if (isSummary(id)) continue;
    const { project } = byId.get(id);
    if (dates.get(id).pinned) continue; // pinned tasks ignore their predecessors
    const succCal = calendars.get(project.id);
    for (const dep of effectiveDeps.get(id)) {
      const startBased = dep.type === 'SS' || dep.type === 'SF';
      const predLeaves = leavesOf(dep.taskId);
      for (const leaf of predLeaves) {
        const predShape = dates.get(leaf).shape;
        const limit = latestFinish(dep, predShape, dates.get(id).shape, late.get(id), succCal, isFirm(dep));
        if (startBased) {
          // A summary starts with its first subtask, so while another subtask holds
          // the summary's start early enough, this one can't affect the link.
          const others = predLeaves.filter((l) => l !== leaf).map((l) => dates.get(l).start);
          if (others.length && Math.min(...others) <= predShape.clock.add(limit, -predShape.span)) continue;
        }
        if (limit < late.get(leaf)) late.set(leaf, limit);
      }
    }
  } };

  // A task on a firm lead can slip only as far as its predecessor can, since it must
  // stay ahead of wherever the predecessor ends up. Says whether anything tightened.
  const firmLinks = [...byId.keys()].flatMap((id) => (byId.get(id).task.deps || [])
    .filter((dep) => isFirm(dep) && byId.has(dep.taskId))
    .map((dep) => ({ id, dep })));
  const holdFirmLeads = () => {
    let tightened = false;
    for (const { id, dep } of firmLinks) {
      const predLeaves = leavesOf(dep.taskId);
      const predLate = {
        start: Math.min(...predLeaves.map((l) => dates.get(l).shape.clock.add(late.get(l), -dates.get(l).shape.span))),
        end: Math.max(...predLeaves.map((l) => late.get(l))),
      };
      const cal = calendars.get(byId.get(id).project.id);
      const leaves = leavesOf(id).filter((l) => byId.get(l).task.status !== 'complete');
      for (const leaf of leaves) {
        const d = dates.get(leaf);
        const latestStart = requiredStart(dep, predLate, d.shape, cal, true);
        // A summary starts with its first subtask, so another one may be holding the rule.
        const others = leaves.filter((l) => l !== leaf).map((l) => dates.get(l).start);
        if (dep.type === 'SS' && others.length && Math.min(...others) <= latestStart) continue;
        const limit = Math.max(d.shape.clock.add(latestStart, d.shape.span), d.end);
        if (limit < late.get(leaf)) {
          late.set(leaf, limit);
          tightened = true;
        }
      }
    }
    return tightened;
  };
  // Tightening a task can tighten what leads to it, so repeat until nothing changes.
  for (let pass = 0; pass <= byId.size; pass++) {
    backwardPass();
    if (!holdFirmLeads()) break;
  }

  // Working days can't measure a task that runs through days off, so a calendar duration
  // or lag means a link's buffer is in calendar days.
  const bufferClock = (dep, id) => {
    const cal = calendars.get(byId.get(id).project.id);
    const calendarDays = dep.lagUnit === 'calendar' || leavesOf(id).some((leaf) => dates.get(leaf).shape.clock === EVERY_DAY);
    return calendarDays ? EVERY_DAY : cal;
  };
  const bufferUnit = (dep, id) => (bufferClock(dep, id) === EVERY_DAY ? { unit: 'calendar' } : {});

  // Days a task sits past what a link needs. Negative means earlier than it
  // allows. A link on a summary applies to each subtask, so the tightest one counts,
  // except that a firm SF is about the finish of the whole summary: its last subtask.
  const linkBuffer = (dep, id) => {
    const cal = calendars.get(byId.get(id).project.id);
    const clock = bufferClock(dep, id);
    const buffers = leavesOf(id).map((leaf) => {
      const d = dates.get(leaf);
      return clock.diff(requiredStart(dep, dates.get(dep.taskId), d.shape, cal, isFirm(dep)), d.start);
    });
    return isFirm(dep) && dep.type === 'SF' ? Math.max(...buffers) : Math.min(...buffers);
  };
  const linksOf = (task) => (task.deps || [])
    .filter((dep) => byId.has(dep.taskId))
    .map((dep) => ({ taskId: dep.taskId, buffer: linkBuffer(dep, task.id), firm: isFirm(dep), ...bufferUnit(dep, task.id) }));

  // Later than a firm lead allows is a conflict, whatever put the task there.
  for (const { id, dep } of firmLinks) {
    if (byId.get(id).task.status === 'complete' || linkBuffer(dep, id) <= 0) continue;
    const d = dates.get(id);
    d.conflicts = [...(d.conflicts ?? []), dep.taskId];
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
        duration: Math.max(1, cal.count(d.start, d.end)),
        isSummary: true,
        status,
        progress: Math.round(done / total),
        float: openFloats.length ? Math.min(...openFloats) : 0,
        critical: leaves.some((t) => t.critical),
        driverId: null,
        delay: 0,
        links: linksOf(task),
        conflicts: d.conflicts ?? [],
        health: healthOf({ status, start: d.start, end: d.end, conflicts: d.conflicts ?? [] }, today),
      });
      continue;
    }
    const lateFinish = late.get(id);
    const { clock } = d.shape;
    const float = lateFinish >= d.end ? clock.count(d.end, lateFinish) - 1 : -(clock.count(lateFinish, d.end) - 1);
    const status = task.status;
    computed.set(id, {
      id,
      projectId: project.id,
      start: toIso(d.start),
      end: toIso(d.end),
      duration: task.milestone ? 0 : d.shape.span + 1,
      isSummary: false,
      status,
      progress: task.progress,
      float,
      critical: float <= 0 && status !== 'complete',
      driverId: d.driverId,
      // How far links pushed a date someone set. A task following its links has no such date.
      delay: d.followsLinks ? 0 : Math.max(0, clock.diff(d.requested, d.start)),
      followsLinks: d.followsLinks,
      linkStart: d.linkStart === null ? null : toIso(d.linkStart),
      links: linksOf(task),
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
      const buffer = linkBuffer(dep, id);
      rollups.get(project.id).upstream++;
      rollups.get(pred.project.id).downstream++;
      crossLinks.push({
        fromProjectId: pred.project.id,
        fromTaskId: dep.taskId,
        toProjectId: project.id,
        toTaskId: id,
        type: dep.type,
        lag: dep.lag | 0,
        ...(dep.lagUnit === 'calendar' ? { lagUnit: 'calendar' } : {}),
        ...bufferUnit(dep, id),
        buffer,
        firm: isFirm(dep),
        state: buffer < 0 || (isFirm(dep) && buffer > 0) ? 'conflict' : buffer === 0 ? 'driving' : 'buffer',
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
