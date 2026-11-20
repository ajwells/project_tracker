// Works out what an edit to a task would do, without saving it. It runs the real edit on
// a throwaway store, so the preview can't disagree with what saving does.

import { toDayNumber } from './scheduler.js';
import { StoreCore } from './store-core.js';

const dayShift = (from, to) => toDayNumber(to) - toDayNumber(from);

// `data` is a snapshot, as the app holds in ctx.data. Throws whatever the edit would be
// refused with, such as a finish before the start.
export function previewTaskEdit(data, taskId, fields) {
  const probe = new StoreCore({ saving: false, firmLeads: data.firmLeads });
  probe.state = { revision: data.revision, projects: data.projects };
  const before = probe.snapshot();
  probe.updateTask(taskId, fields);
  const after = probe.snapshot();

  const tasksBefore = new Map(before.projects.flatMap((p) => p.tasks.map((t) => [t.id, t])));
  const names = new Map(after.projects.flatMap((p) => p.tasks.map((t) => [t.id, t.name])));
  const owner = after.projects.find((p) => p.tasks.some((t) => t.id === taskId));

  const moved = [];
  const conflicts = [];
  let self = null;
  for (const project of after.projects) {
    for (const task of project.tasks) {
      const was = tasksBefore.get(task.id).computed;
      const now = task.computed;
      const entry = {
        id: task.id,
        name: task.name,
        projectName: project.id === owner.id ? null : project.name,
        milestone: !!task.milestone,
        fromStart: was.start,
        fromEnd: was.end,
        start: now.start,
        end: now.end,
        duration: now.duration,
        // Calendar days, the only measure that means the same for every task.
        shift: was.start !== now.start ? dayShift(was.start, now.start) : dayShift(was.end, now.end),
      };
      if (task.id === taskId) self = entry;
      else if (!now.isSummary && (was.start !== now.start || was.end !== now.end)) moved.push(entry);

      const added = now.conflicts.filter((id) => !was.conflicts.includes(id));
      if (added.length && !now.isSummary) {
        conflicts.push({ id: task.id, name: task.name, projectName: entry.projectName, with: added.map((id) => names.get(id)) });
      }
    }
  }
  moved.sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));

  const finishes = after.projects
    .map((p) => ({ id: p.id, name: p.name, from: before.projects.find((q) => q.id === p.id).summary.end, to: p.summary.end }))
    .filter((f) => f.from !== f.to);

  const linkKey = (l) => `${l.fromTaskId}>${l.toTaskId}`;
  const buffersBefore = new Map(before.crossLinks.map((l) => [linkKey(l), l.buffer]));
  const buffers = after.crossLinks
    .filter((l) => buffersBefore.get(linkKey(l)) !== l.buffer)
    .map((l) => ({ from: names.get(l.fromTaskId), to: names.get(l.toTaskId), was: buffersBefore.get(linkKey(l)), now: l.buffer, unit: l.unit }));

  return {
    self,
    moved,
    conflicts,
    finishes,
    buffers,
    // Other tasks are affected, so the edit should wait for a decision.
    affectsOthers: moved.length > 0 || conflicts.some((c) => c.id !== taskId),
  };
}
