// Validation, history and import, shared by the server and the browser. Every
// mutation runs on a draft copy and only commits if the resulting dependency
// graph has no loops and the change can be stored, so a rejected edit leaves
// nothing behind. Subclasses decide where the data is kept.

import { computeSchedule, datesDuration, durationClock, isValidDate, makeCalendar, toDayNumber, toIso, tracksDates } from './scheduler.js';

export const EXPORT_FORMAT = 'project-tracker-export';
export const SCHEMA_VERSION = 1;

export const STATUSES = ['not_started', 'in_progress', 'blocked', 'complete'];
export const DEP_TYPES = ['FS', 'SS', 'FF', 'SF'];
export const TRACK_BY = ['duration', 'dates'];
export const DAY_UNITS = ['working', 'calendar'];
export const COLORS = ['blue', 'orange', 'aqua', 'yellow', 'magenta', 'green', 'violet', 'red'];
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_DURATION = 3650;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const bad = (message) => new HttpError(400, message);
const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');
const todayIso = () => {
  const now = new Date();
  return toIso(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / 86400000);
};

function cleanString(value, label, { max = 200, required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw bad(`${label} is required.`);
    return '';
  }
  if (typeof value !== 'string') throw bad(`${label} must be text.`);
  const trimmed = value.trim();
  if (required && !trimmed) throw bad(`${label} is required.`);
  if (trimmed.length > max) throw bad(`${label} must be ${max} characters or fewer.`);
  return trimmed;
}

function cleanInt(value, label, min, max) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (!Number.isInteger(n) || n < min || n > max) throw bad(`${label} must be a whole number from ${min} to ${max}.`);
  return n;
}

function cleanDate(value, label) {
  if (!isValidDate(value)) throw bad(`${label} must be a date in YYYY-MM-DD format.`);
  return value;
}

function cleanDeps(value) {
  if (!Array.isArray(value)) throw bad('Dependencies must be a list.');
  const seen = new Set();
  const deps = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || !ID_RE.test(raw.taskId)) throw bad('A dependency is missing its task.');
    if (seen.has(raw.taskId)) continue;
    seen.add(raw.taskId);
    const type = raw.type ?? 'FS';
    if (!DEP_TYPES.includes(type)) throw bad(`Unknown dependency type "${type}".`);
    const lag = cleanInt(raw.lag ?? 0, 'Lag', -MAX_DURATION, MAX_DURATION);
    // Working days are the default, so only the exception is stored.
    deps.push({ taskId: raw.taskId, type, lag, ...(cleanDayUnit(raw.lagUnit ?? 'working') === 'calendar' ? { lagUnit: 'calendar' } : {}) });
  }
  return deps;
}

function cleanDayUnit(value) {
  if (!DAY_UNITS.includes(value)) throw bad('Days are counted as working days or calendar days.');
  return value;
}

function cleanTrackBy(value) {
  if (!TRACK_BY.includes(value)) throw bad('A task is tracked by duration or by dates.');
  return value;
}

const MILESTONE_DATES = "A milestone has one date, so it can't be tracked by dates.";

function trackByDates(task, start, finish, cal) {
  if (finish < start) throw bad('Finish cannot be before the start.');
  task.trackBy = 'dates';
  task.start = start;
  task.finish = finish;
  task.startSet = true;
  task.duration = Math.min(MAX_DURATION, datesDuration(task, cal));
}

function cleanCalendar(value) {
  if (!value || typeof value !== 'object') return { workWeekends: false, holidays: [] };
  const holidays = Array.isArray(value.holidays) ? value.holidays : [];
  if (holidays.length > 1000) throw bad('A calendar can hold at most 1000 holidays.');
  const clean = [...new Set(holidays.map((d) => cleanDate(d, 'Holiday')))].sort();
  const calendar = { workWeekends: !!value.workWeekends, holidays: clean };
  // A calendar with no working days could never schedule anything.
  const cal = makeCalendar(calendar);
  let found = false;
  const from = toDayNumber(todayIso());
  for (let i = 0; i < 366 && !found; i++) found = cal.isWork(from + i);
  if (!found) throw bad('The calendar must leave some working days.');
  return calendar;
}

const FIELD_LABELS = {
  name: 'Name',
  notes: 'Notes',
  trackBy: 'Tracked by',
  startRule: 'Start date',
  start: 'Start',
  finish: 'Finish',
  duration: 'Duration',
  durationUnit: 'Duration counts',
  status: 'Status',
  progress: 'Progress',
  pocName: 'Current POC',
  pocContact: 'POC contact',
  milestone: 'Milestone',
  manual: 'Manually scheduled',
  onTimeline: 'Shown on timeline',
  parent: 'Parent task',
  deps: 'Predecessors',
};

export const emptyState = () => ({ schemaVersion: SCHEMA_VERSION, revision: 0, projects: [] });

export class StoreCore {
  // `saving` says whether the server keeps the data, which the app reports to its users.
  constructor({ saving = true, firmLeads = true } = {}) {
    this.saving = saving;
    this.firmLeads = firmLeads;
    this.serverId = newId();
    this.listeners = new Set();
    this.state = emptyState();
  }

  // Stores this.state. Throwing rejects the change.
  persist() {}

  // Runs before an import overwrites anything.
  beforeImport() {}

  // ---- reads --------------------------------------------------------------

  snapshot() {
    const schedule = this.#schedule(this.state.projects);
    return {
      revision: this.state.revision,
      serverId: this.serverId,
      saving: this.saving,
      firmLeads: this.firmLeads,
      today: todayIso(),
      crossLinks: schedule.crossLinks,
      projects: this.state.projects.map((project) => ({
        ...project,
        summary: schedule.projects.get(project.id),
        tasks: project.tasks.map((task) => ({ ...task, computed: schedule.tasks.get(task.id) })),
      })),
    };
  }

  exportAll() {
    return {
      format: EXPORT_FORMAT,
      schemaVersion: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      projects: this.state.projects,
    };
  }

  // ---- project mutations --------------------------------------------------

  createProject(input) {
    return this.#transact((draft) => {
      const used = new Set(draft.projects.map((p) => p.color));
      const project = {
        id: newId(),
        name: cleanString(input.name, 'Project name', { required: true }),
        description: cleanString(input.description, 'Description', { max: 2000 }),
        owner: cleanString(input.owner, 'Owner', { max: 100 }),
        color: COLORS.includes(input.color)
          ? input.color
          : COLORS.find((c) => !used.has(c)) ?? COLORS[draft.projects.length % COLORS.length],
        calendar: cleanCalendar(input.calendar),
        defaultDayUnit: cleanDayUnit(input.defaultDayUnit ?? 'working'),
        baseline: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tasks: [],
      };
      draft.projects.push(project);
      return project.id;
    });
  }

  updateProject(id, input) {
    return this.#transact((draft) => {
      const project = findProject(draft, id);
      if (input.name !== undefined) project.name = cleanString(input.name, 'Project name', { required: true });
      if (input.description !== undefined) project.description = cleanString(input.description, 'Description', { max: 2000 });
      if (input.owner !== undefined) project.owner = cleanString(input.owner, 'Owner', { max: 100 });
      if (input.color !== undefined) {
        if (!COLORS.includes(input.color)) throw bad('Unknown project color.');
        project.color = input.color;
      }
      if (input.calendar !== undefined) project.calendar = cleanCalendar(input.calendar);
      // Only new tasks and links use this, so changing it moves nothing.
      if (input.defaultDayUnit !== undefined) project.defaultDayUnit = cleanDayUnit(input.defaultDayUnit);
      project.updatedAt = new Date().toISOString();
      return id;
    }, { actor: cleanActor(input.actor), cause: 'the project calendar' });
  }

  deleteProject(id, rawActor) {
    const actor = cleanActor(rawActor);
    return this.#transact((draft) => {
      const project = findProject(draft, id);
      const removed = new Set(project.tasks.map((t) => t.id));
      draft.projects = draft.projects.filter((p) => p.id !== id);
      for (const other of draft.projects) {
        for (const task of other.tasks) dropDeps(task, removed, `project "${project.name}" was deleted`, actor);
      }
      return id;
    }, { actor, cause: 'a deleted project' });
  }

  setBaseline(id, enabled) {
    return this.#transact((draft) => {
      const project = findProject(draft, id);
      if (!enabled) {
        project.baseline = null;
        return id;
      }
      const schedule = this.#schedule(draft.projects);
      project.baseline = {
        at: new Date().toISOString(),
        tasks: Object.fromEntries(
          project.tasks.map((t) => {
            const c = schedule.tasks.get(t.id);
            return [t.id, { start: c.start, end: c.end }];
          }),
        ),
      };
      return id;
    });
  }

  // ---- task mutations -----------------------------------------------------

  createTask(projectId, input) {
    const actor = cleanActor(input.actor);
    return this.#transact((draft) => {
      const project = findProject(draft, projectId);
      const task = {
        id: newId(),
        name: cleanString(input.name, 'Task name', { required: true }),
        notes: '',
        parentId: null,
        start: todayIso(),
        startSet: input.start !== undefined,
        trackBy: 'duration',
        finish: null,
        duration: 5,
        durationUnit: project.defaultDayUnit ?? 'working',
        milestone: false,
        manual: false,
        onTimeline: false,
        status: 'not_started',
        progress: 0,
        pocName: '',
        pocContact: '',
        deps: [],
        schedStart: null,
        schedEnd: null,
        history: [],
      };
      if (input.parentId) {
        const parent = project.tasks.find((t) => t.id === input.parentId);
        if (!parent) throw bad('Parent task not found in this project.');
        if (parent.milestone) throw bad('A milestone cannot have subtasks.');
        task.parentId = parent.id;
        task.start = parent.start;
      }
      applyFields(task, withLinkDefaults(input, task, project));
      normalizeStatus(task, input, 'not_started');
      if (input.milestone) task.duration = 0;
      if (input.trackBy !== undefined && cleanTrackBy(input.trackBy) === 'dates') {
        if (task.milestone) throw bad(MILESTONE_DATES);
        const cal = makeCalendar(project.calendar);
        const clock = durationClock(task, cal);
        const end = input.end === undefined ? toIso(clock.add(clock.next(toDayNumber(task.start)), Math.max(1, task.duration) - 1)) : cleanDate(input.end, 'Finish');
        trackByDates(task, task.start, end, cal);
      }
      assertDepsExist(draft, task);
      project.tasks.push(task);
      project.updatedAt = new Date().toISOString();
      addHistory(task, { type: 'create', author: actor, note: 'Task created' });
      return task.id;
    }, { actor, cause: 'a new task' });
  }

  updateTask(taskId, input) {
    const actor = cleanActor(input.actor);
    return this.#transact((draft) => {
      const { project, task } = findTask(draft, taskId);
      const isSummary = project.tasks.some((t) => t.parentId === task.id);
      const before = historyView(draft, task);
      const prevStatus = task.status;
      const patch = { ...input };
      if (isSummary) {
        // Summary dates, status and progress roll up from their subtasks.
        for (const field of ['start', 'duration', 'durationUnit', 'end', 'status', 'progress', 'milestone', 'manual', 'trackBy', 'startSet']) delete patch[field];
      }
      if (patch.milestone && project.tasks.some((t) => t.parentId === task.id)) {
        throw bad('A task with subtasks cannot become a milestone.');
      }
      const cal = makeCalendar(project.calendar);
      const wantsDates = patch.trackBy === undefined ? task.trackBy === 'dates' : cleanTrackBy(patch.trackBy) === 'dates';
      const willBeMilestone = patch.milestone ?? task.milestone;
      if (patch.trackBy === 'dates' && willBeMilestone) throw bad(MILESTONE_DATES);
      if (wantsDates && patch.duration !== undefined && !willBeMilestone) {
        throw bad('This task is tracked by dates, so its duration fills in. Change its dates, or track it by duration.');
      }
      // Where the task sits now, for anything about to hold it in place.
      const here = { start: task.schedStart ?? task.start, end: task.schedEnd ?? task.finish ?? task.start };
      if (patch.manual === true && !task.manual && patch.start === undefined) task.start = here.start;
      applyFields(task, withLinkDefaults(patch, task, project));
      if (patch.start !== undefined || patch.manual === true) task.startSet = true;
      if (patch.startSet === false) task.startSet = false;
      if (wantsDates && !willBeMilestone) {
        const start = patch.start ?? (task.trackBy === 'dates' ? task.start : here.start);
        const finish = patch.end === undefined ? task.finish ?? here.end : cleanDate(patch.end, 'Finish');
        trackByDates(task, start, finish, cal);
      } else if (task.trackBy === 'dates') {
        // Leaving dates: the current span is already the duration, and dates fill in again.
        task.trackBy = 'duration';
        task.finish = null;
        if (patch.start === undefined) task.startSet = false;
      }
      if (patch.end !== undefined && !wantsDates) {
        const end = cleanDate(patch.end, 'Finish');
        const schedule = this.#schedule(draft.projects);
        if (schedule.cycle) throw cycleError(draft, schedule.cycle);
        const start = toDayNumber(schedule.tasks.get(task.id).start);
        if (toDayNumber(end) < start) throw bad('Finish cannot be before the scheduled start.');
        if (!task.milestone) task.duration = Math.min(MAX_DURATION, Math.max(1, durationClock(task, cal).count(start, toDayNumber(end))));
      }
      if (patch.milestone === true) task.duration = 0;
      if (patch.milestone === false && task.duration === 0) task.duration = 1;
      if (!isSummary) normalizeStatus(task, patch, prevStatus);
      if (task.status === 'complete' && prevStatus !== 'complete' && task.schedStart && patch.start === undefined) {
        // Finished work stops moving: pin it where it was actually scheduled.
        task.start = task.schedStart;
      }
      assertDepsExist(draft, task);
      const changes = diffViews(before, historyView(draft, task));
      if (changes.length) addHistory(task, { type: 'edit', author: actor, changes });
      project.updatedAt = new Date().toISOString();
      return task.id;
    }, {
      actor,
      cause: taskId,
      skipScheduleFor: input.start !== undefined || input.end !== undefined || input.duration !== undefined || input.durationUnit !== undefined ? taskId : null,
    });
  }

  addUpdate(taskId, input) {
    const actor = cleanActor(input.actor);
    return this.#transact((draft) => {
      const { project, task } = findTask(draft, taskId);
      const note = cleanString(input.note, 'Update', { max: 5000, required: true });
      addHistory(task, { type: 'update', author: actor, note });
      project.updatedAt = new Date().toISOString();
      return task.id;
    }, { actor });
  }

  moveTask(taskId, direction, rawActor) {
    const actor = cleanActor(rawActor);
    return this.#transact((draft) => {
      const { project, task } = findTask(draft, taskId);
      const siblings = project.tasks.filter((t) => (t.parentId || null) === (task.parentId || null));
      const position = siblings.indexOf(task);
      const swap = (other) => {
        const a = project.tasks.indexOf(task);
        const b = project.tasks.indexOf(other);
        [project.tasks[a], project.tasks[b]] = [project.tasks[b], project.tasks[a]];
      };
      const before = historyView(draft, task);
      if (direction === 'up') {
        if (position > 0) swap(siblings[position - 1]);
      } else if (direction === 'down') {
        if (position < siblings.length - 1) swap(siblings[position + 1]);
      } else if (direction === 'indent') {
        const parent = siblings[position - 1];
        if (!parent) throw bad('There is no task above to indent under.');
        if (parent.milestone) throw bad('A milestone cannot have subtasks.');
        task.parentId = parent.id;
      } else if (direction === 'outdent') {
        if (!task.parentId) throw bad('This task is already at the top level.');
        const parent = project.tasks.find((t) => t.id === task.parentId);
        task.parentId = parent.parentId || null;
        project.tasks.splice(project.tasks.indexOf(task), 1);
        project.tasks.splice(project.tasks.indexOf(parent) + 1, 0, task);
      } else {
        throw bad('Unknown move.');
      }
      const changes = diffViews(before, historyView(draft, task));
      if (changes.length) addHistory(task, { type: 'edit', author: actor, changes });
      project.updatedAt = new Date().toISOString();
      return task.id;
    }, { actor, cause: taskId });
  }

  deleteTask(taskId, rawActor) {
    const actor = cleanActor(rawActor);
    return this.#transact((draft) => {
      const { project, task } = findTask(draft, taskId);
      // Deleting a summary deletes its subtasks.
      const removed = new Set([task.id]);
      for (let grew = true; grew; ) {
        grew = false;
        for (const t of project.tasks) {
          if (t.parentId && removed.has(t.parentId) && !removed.has(t.id)) {
            removed.add(t.id);
            grew = true;
          }
        }
      }
      project.tasks = project.tasks.filter((t) => !removed.has(t.id));
      for (const other of draft.projects) {
        for (const t of other.tasks) dropDeps(t, removed, `"${task.name}" was deleted`, actor);
      }
      project.updatedAt = new Date().toISOString();
      return taskId;
    }, { actor, cause: 'a deleted task' });
  }

  // ---- import -------------------------------------------------------------

  importAll(payload, mode) {
    if (mode !== 'merge' && mode !== 'replace') throw bad('Import mode must be "merge" or "replace".');
    const parsed = parseImport(payload);
    this.beforeImport();
    let dropped = 0;
    let added = 0;
    let replaced = 0;
    this.#transact((draft) => {
      const keep = mode === 'replace' ? [] : draft.projects;
      const incomingProjectIds = new Set(parsed.map((p) => p.id));
      const survivors = keep.filter((p) => !incomingProjectIds.has(p.id));
      added = parsed.filter((p) => !keep.some((k) => k.id === p.id)).length;
      replaced = parsed.length - added;

      // A task id that is already used by a project staying in the store gets a
      // fresh id, so importing can never silently cross-wire two tasks.
      const taken = new Set(survivors.flatMap((p) => p.tasks.map((t) => t.id)));
      const remap = new Map();
      for (const project of parsed) {
        for (const task of project.tasks) if (taken.has(task.id)) remap.set(task.id, newId());
      }
      for (const project of parsed) {
        if (project.baseline) {
          project.baseline.tasks = Object.fromEntries(
            Object.entries(project.baseline.tasks).map(([id, value]) => [remap.get(id) ?? id, value]),
          );
        }
        for (const task of project.tasks) {
          task.id = remap.get(task.id) ?? task.id;
          if (task.parentId) task.parentId = remap.get(task.parentId) ?? task.parentId;
          task.deps = task.deps.map((d) => ({ ...d, taskId: remap.get(d.taskId) ?? d.taskId }));
        }
      }

      draft.projects = [...survivors, ...parsed];
      const known = new Set(draft.projects.flatMap((p) => p.tasks.map((t) => t.id)));
      for (const project of draft.projects) {
        for (const task of project.tasks) {
          const before = task.deps.length;
          task.deps = task.deps.filter((d) => known.has(d.taskId));
          dropped += before - task.deps.length;
        }
      }
    }, { skipHistory: true });
    return { added, replaced, droppedLinks: dropped, total: this.state.projects.length };
  }

  // ---- internals ----------------------------------------------------------

  #schedule(projects) {
    return computeSchedule(projects, todayIso(), { firmLeads: this.firmLeads });
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  #transact(mutate, { actor = 'System', cause = null, skipScheduleFor = null, skipHistory = false } = {}) {
    const draft = structuredClone(this.state);
    const result = mutate(draft);
    const schedule = this.#schedule(draft.projects);
    if (schedule.cycle) throw cycleError(draft, schedule.cycle);

    let causeLabel = cause;
    if (cause) {
      for (const project of draft.projects) {
        const task = project.tasks.find((t) => t.id === cause);
        if (task) causeLabel = `"${task.name}" in ${project.name}`;
      }
    }
    for (const project of draft.projects) {
      for (const task of project.tasks) {
        const c = schedule.tasks.get(task.id);
        const moved = task.schedStart && (task.schedStart !== c.start || task.schedEnd !== c.end);
        if (moved && !skipHistory && !c.isSummary && task.id !== skipScheduleFor) {
          const changes = [];
          if (task.schedStart !== c.start) changes.push({ field: 'schedStart', label: 'Scheduled start', from: task.schedStart, to: c.start });
          if (task.schedEnd !== c.end) changes.push({ field: 'schedEnd', label: 'Scheduled finish', from: task.schedEnd, to: c.end });
          addHistory(task, {
            type: 'schedule',
            author: actor,
            note: causeLabel ? `Rescheduled after a change to ${causeLabel}` : 'Rescheduled',
            changes,
          });
        }
        task.schedStart = c.start;
        task.schedEnd = c.end;
        if (c.isSummary) continue;
        // A calendar change can alter what a pair of dates spans.
        if (tracksDates(task)) task.duration = c.duration;
        // So a task keeps its place if its links are later removed.
        if (task.startSet === false) task.start = c.start;
      }
    }
    draft.revision = this.state.revision + 1;
    const previous = this.state;
    this.state = draft;
    try {
      this.persist();
    } catch (error) {
      this.state = previous;
      throw error;
    }
    for (const listener of this.listeners) listener(draft.revision);
    return result;
  }
}

// ---- helpers ----------------------------------------------------------------

function cleanActor(value) {
  if (typeof value !== 'string') return 'Anonymous';
  return value.trim().slice(0, 100) || 'Anonymous';
}

function findProject(draft, id) {
  const project = draft.projects.find((p) => p.id === id);
  if (!project) throw new HttpError(404, 'Project not found.');
  return project;
}

function findTask(draft, id) {
  for (const project of draft.projects) {
    const task = project.tasks.find((t) => t.id === id);
    if (task) return { project, task };
  }
  throw new HttpError(404, 'Task not found.');
}

// A link that doesn't say which days it counts keeps what it had, or if it's new takes
// the project's default.
function withLinkDefaults(input, task, project) {
  if (!Array.isArray(input.deps)) return input;
  const deps = input.deps.map((dep) => {
    if (dep?.lagUnit !== undefined) return dep;
    const existing = task.deps.find((d) => d.taskId === dep?.taskId);
    return { ...dep, lagUnit: existing ? existing.lagUnit ?? 'working' : project.defaultDayUnit ?? 'working' };
  });
  return { ...input, deps };
}

function applyFields(task, input) {
  if (input.name !== undefined) task.name = cleanString(input.name, 'Task name', { required: true });
  if (input.notes !== undefined) task.notes = cleanString(input.notes, 'Notes', { max: 10000 });
  if (input.start !== undefined) task.start = cleanDate(input.start, 'Start');
  if (input.duration !== undefined) task.duration = cleanInt(input.duration, 'Duration', 0, MAX_DURATION);
  if (input.durationUnit !== undefined) task.durationUnit = cleanDayUnit(input.durationUnit);
  if (input.progress !== undefined) task.progress = cleanInt(input.progress, 'Progress', 0, 100);
  if (input.status !== undefined) {
    if (!STATUSES.includes(input.status)) throw bad('Unknown status.');
    task.status = input.status;
  }
  if (input.pocName !== undefined) task.pocName = cleanString(input.pocName, 'POC name', { max: 100 });
  if (input.pocContact !== undefined) task.pocContact = cleanString(input.pocContact, 'POC contact', { max: 200 });
  if (input.milestone !== undefined) task.milestone = !!input.milestone;
  if (input.manual !== undefined) task.manual = !!input.manual;
  if (input.onTimeline !== undefined) task.onTimeline = !!input.onTimeline;
  if (input.deps !== undefined) {
    const deps = cleanDeps(input.deps);
    if (deps.some((d) => d.taskId === task.id)) throw bad('A task cannot depend on itself.');
    task.deps = deps;
  }
}

// Keeps status and percent complete telling the same story.
function normalizeStatus(task, input, prevStatus) {
  if (task.milestone && input.progress !== undefined && input.status === undefined) {
    task.status = task.progress >= 100 ? 'complete' : prevStatus === 'complete' ? 'in_progress' : prevStatus;
  }
  if (input.status !== undefined) {
    if (task.status === 'complete') task.progress = 100;
    else if (task.status === 'not_started' && input.progress === undefined) task.progress = 0;
    else if (prevStatus === 'complete' && input.progress === undefined) task.progress = 90;
  } else if (input.progress !== undefined) {
    if (task.progress >= 100) task.status = 'complete';
    else if (prevStatus === 'complete') task.status = task.progress > 0 ? 'in_progress' : 'not_started';
    else if (task.progress > 0 && prevStatus === 'not_started') task.status = 'in_progress';
  }
  if (task.status === 'complete') task.progress = 100;
}

function assertDepsExist(draft, task) {
  const known = new Set(draft.projects.flatMap((p) => p.tasks.map((t) => t.id)));
  for (const dep of task.deps) if (!known.has(dep.taskId)) throw bad('A dependency points to a task that does not exist.');
}

function dropDeps(task, removed, reason, actor) {
  const gone = task.deps.filter((d) => removed.has(d.taskId));
  if (!gone.length) return;
  task.deps = task.deps.filter((d) => !removed.has(d.taskId));
  addHistory(task, {
    type: 'edit',
    author: actor,
    note: `${gone.length === 1 ? 'A predecessor was' : `${gone.length} predecessors were`} removed because ${reason}`,
  });
}

function addHistory(task, entry) {
  task.history.push({ id: newId(), at: new Date().toISOString(), ...entry });
}

function taskLabel(draft, id, fromProjectId) {
  for (const project of draft.projects) {
    const task = project.tasks.find((t) => t.id === id);
    if (task) return project.id === fromProjectId ? task.name : `${project.name} › ${task.name}`;
  }
  return 'Removed task';
}

// Human-readable field values, frozen into history so entries still make sense
// after tasks they mention are renamed or deleted.
function historyView(draft, task) {
  const { project } = findTask(draft, task.id);
  return {
    name: task.name,
    notes: task.notes,
    trackBy: task.trackBy === 'dates' ? 'Dates' : 'Duration',
    startRule: task.startSet === false ? 'Follows links' : 'Set by hand',
    start: task.start,
    finish: task.trackBy === 'dates' ? task.finish : '',
    duration: task.milestone ? 0 : task.duration,
    durationUnit: task.durationUnit === 'calendar' ? 'Calendar days' : 'Working days',
    status: task.status,
    progress: task.progress,
    pocName: task.pocName,
    pocContact: task.pocContact,
    milestone: task.milestone,
    manual: task.manual,
    onTimeline: task.onTimeline,
    parent: task.parentId ? taskLabel(draft, task.parentId, project.id) : '',
    deps: task.deps
      .map((d) => `${taskLabel(draft, d.taskId, project.id)} (${depLabel(d)})`)
      .join(', '),
  };
}

const depLabel = (d) => {
  const days = d.lagUnit === 'calendar' ? 'cd' : 'd';
  if (!d.lag) return d.lagUnit === 'calendar' ? `${d.type}+0${days}` : d.type;
  return `${d.type}${d.lag > 0 ? '+' : ''}${d.lag}${days}`;
};

function diffViews(before, after) {
  const changes = [];
  for (const field of Object.keys(FIELD_LABELS)) {
    if (before[field] !== after[field]) {
      changes.push({ field, label: FIELD_LABELS[field], from: before[field], to: after[field] });
    }
  }
  return changes;
}

function cycleError(draft, ids) {
  const names = ids.slice(0, 4).map((id) => `"${taskLabel(draft, id)}"`);
  const more = ids.length > 4 ? ` and ${ids.length - 4} more` : '';
  return new HttpError(409, `That would create a dependency loop involving ${names.join(', ')}${more}.`);
}

// Validates an export file field by field and builds new objects, so nothing
// unexpected in a file ends up in the store.
function parseImport(payload) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.projects)) {
    throw bad('This file is not a Project Tracker export: it has no project list.');
  }
  if (payload.format !== EXPORT_FORMAT) throw bad('This file is not a Project Tracker export.');
  if (payload.schemaVersion > SCHEMA_VERSION) {
    throw bad('This export came from a newer version of Project Tracker. Update the app and try again.');
  }
  const projectIds = new Set();
  const taskIds = new Set();
  return payload.projects.map((raw, index) => {
    const where = `Project ${index + 1}`;
    if (!raw || typeof raw !== 'object') throw bad(`${where} is not valid.`);
    if (!ID_RE.test(raw.id)) throw bad(`${where} has an invalid id.`);
    if (projectIds.has(raw.id)) throw bad(`${where} repeats project id ${raw.id}.`);
    projectIds.add(raw.id);
    if (!Array.isArray(raw.tasks)) throw bad(`${where} has no task list.`);
    const tasks = raw.tasks.map((t, i) => parseImportedTask(t, `${where}, task ${i + 1}`, taskIds));
    const own = new Set(tasks.map((t) => t.id));
    for (const task of tasks) {
      if (task.parentId && !own.has(task.parentId)) task.parentId = null;
    }
    assertNoParentLoop(tasks, where);
    for (const task of tasks) {
      if (task.milestone && tasks.some((t) => t.parentId === task.id)) task.milestone = false;
    }
    return {
      id: raw.id,
      name: cleanString(raw.name, `${where} name`, { required: true }),
      description: cleanString(raw.description, `${where} description`, { max: 2000 }),
      owner: cleanString(raw.owner, `${where} owner`, { max: 100 }),
      color: COLORS.includes(raw.color) ? raw.color : COLORS[index % COLORS.length],
      calendar: cleanCalendar(raw.calendar),
      defaultDayUnit: cleanDayUnit(raw.defaultDayUnit ?? 'working'),
      baseline: parseBaseline(raw.baseline, own),
      createdAt: isoTimestamp(raw.createdAt),
      updatedAt: isoTimestamp(raw.updatedAt),
      tasks,
    };
  });
}

function parseImportedTask(raw, where, taskIds) {
  if (!raw || typeof raw !== 'object') throw bad(`${where} is not valid.`);
  if (!ID_RE.test(raw.id)) throw bad(`${where} has an invalid id.`);
  if (taskIds.has(raw.id)) throw bad(`${where} repeats task id ${raw.id}.`);
  taskIds.add(raw.id);
  if (!STATUSES.includes(raw.status ?? 'not_started')) throw bad(`${where} has an unknown status.`);
  const milestone = !!raw.milestone;
  const trackBy = milestone ? 'duration' : cleanTrackBy(raw.trackBy ?? 'duration');
  const finish = trackBy === 'dates' ? cleanDate(raw.finish, `${where} finish`) : null;
  if (finish && finish < raw.start) throw bad(`${where} finishes before it starts.`);
  return {
    id: raw.id,
    name: cleanString(raw.name, `${where} name`, { required: true }),
    notes: cleanString(raw.notes, `${where} notes`, { max: 10000 }),
    parentId: ID_RE.test(raw.parentId) ? raw.parentId : null,
    start: cleanDate(raw.start, `${where} start`),
    startSet: trackBy === 'dates' || raw.startSet !== false,
    trackBy,
    finish,
    duration: milestone ? 0 : cleanInt(raw.duration ?? 1, `${where} duration`, 0, MAX_DURATION),
    durationUnit: cleanDayUnit(raw.durationUnit ?? 'working'),
    milestone,
    manual: !!raw.manual,
    onTimeline: !!raw.onTimeline,
    status: raw.status ?? 'not_started',
    progress: cleanInt(raw.progress ?? 0, `${where} progress`, 0, 100),
    pocName: cleanString(raw.pocName, `${where} POC name`, { max: 100 }),
    pocContact: cleanString(raw.pocContact, `${where} POC contact`, { max: 200 }),
    deps: cleanDeps(raw.deps ?? []),
    schedStart: isValidDate(raw.schedStart) ? raw.schedStart : null,
    schedEnd: isValidDate(raw.schedEnd) ? raw.schedEnd : null,
    history: parseHistory(raw.history),
  };
}

function parseHistory(history) {
  if (!Array.isArray(history)) return [];
  const text = (v) => (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v : '');
  return history
    .filter((e) => e && typeof e === 'object')
    .map((e) => ({
      id: ID_RE.test(e.id) ? e.id : newId(),
      at: isoTimestamp(e.at),
      type: ['create', 'edit', 'update', 'schedule'].includes(e.type) ? e.type : 'edit',
      author: cleanActor(e.author),
      ...(typeof e.note === 'string' ? { note: e.note.slice(0, 5000) } : {}),
      ...(Array.isArray(e.changes)
        ? {
            changes: e.changes
              .filter((c) => c && typeof c === 'object')
              .map((c) => ({
                field: String(c.field ?? '').slice(0, 40),
                label: String(c.label ?? '').slice(0, 80),
                from: text(c.from),
                to: text(c.to),
              })),
          }
        : {}),
    }));
}

function parseBaseline(baseline, ownIds) {
  if (!baseline || typeof baseline !== 'object' || !baseline.tasks || typeof baseline.tasks !== 'object') return null;
  const entries = Object.entries(baseline.tasks)
    .filter(([id, v]) => ownIds.has(id) && v && isValidDate(v.start) && isValidDate(v.end))
    .map(([id, v]) => [id, { start: v.start, end: v.end }]);
  return { at: isoTimestamp(baseline.at), tasks: Object.fromEntries(entries) };
}

function isoTimestamp(value) {
  const d = typeof value === 'string' ? new Date(value) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : new Date().toISOString();
}

function assertNoParentLoop(tasks, where) {
  const parent = new Map(tasks.map((t) => [t.id, t.parentId]));
  for (const task of tasks) {
    const seen = new Set();
    for (let id = task.id; id; id = parent.get(id)) {
      if (seen.has(id)) throw bad(`${where} has a task that is its own ancestor.`);
      seen.add(id);
    }
  }
}
