// The task panel: details, current POC, dependencies and the full history.

import { api, ctx } from '../ctx.js';
import { confirmDialog, DEP_TYPES, fmtDate, fmtWhen, h, healthPill, icon, plural, STATUS } from '../util.js';
import { orderedTasks } from '../chart/gantt.js';
import { openNameDialog } from './dialogs.js';

let renderedFor = null;
let deferred = false;

export function renderDrawer(host) {
  const active = document.activeElement;
  const typing = active && host.contains(active) && active.matches('input, textarea, select');
  const sameTask = renderedFor === ctx.taskId;
  // Never redraw under someone mid-edit; catch up when they leave the field.
  if (typing && sameTask && ctx.findTask(ctx.taskId)) {
    if (!deferred) {
      deferred = true;
      active.addEventListener('blur', () => {
        deferred = false;
        setTimeout(() => renderDrawer(host), 0);
      }, { once: true });
    }
    return;
  }

  const found = ctx.taskId ? ctx.findTask(ctx.taskId) : null;
  const scroller = host.querySelector('.drawer-body');
  const scrollTop = scroller && sameTask ? scroller.scrollTop : 0;
  renderedFor = found ? ctx.taskId : null;
  if (!found) {
    host.replaceChildren();
    return;
  }
  host.replaceChildren(buildDrawer(found));
  const next = host.querySelector('.drawer-body');
  if (next) next.scrollTop = scrollTop;
}

function buildDrawer({ project, task }) {
  const c = task.computed;
  const patch = (fields) => api('PATCH', `/api/tasks/${task.id}`, fields);
  const close = () => {
    ctx.taskId = null;
    ctx.render();
  };

  const field = (label, control, cls = '') => h('label', { class: `field ${cls}` }, label, control);
  const summary = c.isSummary;
  const done = c.status === 'complete';

  const input = (name, value, type = 'text', extra = {}) => h('input', {
    type,
    value: value ?? '',
    name,
    onchange: (event) => {
      const v = event.target.value;
      patch({ [name]: type === 'number' ? Number(v) : v });
    },
    ...extra,
  });

  const progressLabel = h('span', { class: 'num' }, `${c.progress}%`);
  const details = h('div', { class: 'field-grid' },
    field('Name', input('name', task.name), 'full'),
    field('Current POC', input('pocName', task.pocName, 'text', { list: 'poc-names', placeholder: 'Who to ask', autocomplete: 'off' })),
    field('POC contact', input('pocContact', task.pocContact, 'text', { placeholder: 'Email or phone', autocomplete: 'off' })),
    field('Status', h('select', { name: 'status', disabled: summary, onchange: (e) => patch({ status: e.target.value }) },
      Object.entries(STATUS).map(([key, s]) => h('option', { value: key, selected: c.status === key }, s.label)))),
    h('label', { class: 'field' }, h('span', { class: 'row', style: { justifyContent: 'space-between' } }, 'Progress', progressLabel),
      h('input', {
        type: 'range', min: 0, max: 100, step: 5, value: c.progress, disabled: summary,
        oninput: (e) => {
          progressLabel.textContent = `${e.target.value}%`;
        },
        onchange: (e) => patch({ progress: Number(e.target.value) }),
      })),
    field(task.milestone ? 'Date' : 'Start', input('start', c.start, 'date', { disabled: summary, required: true })),
    task.milestone ? null : field('Finish', h('input', {
      type: 'date', name: 'end', value: c.end, disabled: summary, required: true,
      onchange: (e) => e.target.value && patch({ end: e.target.value }),
    })),
    task.milestone ? null : field('Working days', input('duration', c.duration, 'number', { min: 1, max: 3650, disabled: summary })),
    h('datalist', { id: 'poc-names' }, ctx.pocNames().map((n) => h('option', { value: n }))));

  const notices = [];
  if (summary) notices.push(h('div', { class: 'callout' }, 'Dates, status and progress roll up from the subtasks.'));
  if (c.delay > 0 && c.driverId) {
    const driver = ctx.findTask(c.driverId);
    if (driver) {
      const where = driver.project.id === project.id ? '' : ` in ${driver.project.name}`;
      notices.push(h('div', { class: 'callout warn' }, `▲ Pushed ${plural(c.delay, 'working day')} past the requested start (${fmtDate(task.start)}) by "${driver.task.name}"${where}.`));
    }
  }
  if (c.conflicts.length) {
    const names = c.conflicts.map((id) => ctx.findTask(id)?.task.name).filter(Boolean).map((n) => `"${n}"`).join(', ');
    notices.push(h('div', { class: 'callout bad' }, `! This date conflicts with ${names}. It is manually scheduled, so it did not move.`));
  }
  if (done && !summary) notices.push(h('div', { class: 'callout' }, 'Completed tasks stay put when their predecessors move.'));

  const scheduleLine = h('div', { class: 'row wrap' },
    healthPill(c.health),
    c.critical ? h('span', { class: 'pill bad' }, '! Critical path') : null,
    !c.critical && !done && c.float > 0 ? h('span', { class: 'pill' }, `${plural(c.float, 'day')} of float`) : null);

  const options = h('div', { class: 'stack', style: { gap: '8px' } },
    summary ? null : h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: task.milestone, onchange: (e) => patch({ milestone: e.target.checked }) }),
      h('span', {}, 'Milestone', h('small', {}, 'A key date with no duration.'))),
    summary ? null : h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: task.manual, onchange: (e) => patch({ manual: e.target.checked }) }),
      h('span', {}, 'Manually scheduled', h('small', {}, 'Keep these dates even if predecessors move.'))),
    h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: task.onTimeline, onchange: (e) => patch({ onTimeline: e.target.checked }) }),
      h('span', {}, 'Show on timeline', h('small', {}, 'Include this in the "Key items" timeline.'))));

  const notes = field('Notes', h('textarea', { name: 'notes', rows: 3, onchange: (e) => patch({ notes: e.target.value }) }, task.notes));

  const outline = h('div', { class: 'row wrap' },
    h('span', { class: 'small muted' }, `Outline ${c.wbs}`),
    [['up', 'up', 'Move up'], ['down', 'down', 'Move down'], ['outdent', 'left', 'Outdent'], ['indent', 'right', 'Indent under the task above']].map(([direction, ic, label]) => h('button', {
      class: 'btn icon', type: 'button', 'aria-label': label, title: label,
      onclick: () => api('POST', `/api/tasks/${task.id}/move`, { direction }),
    }, icon(ic))),
    task.milestone ? null : h('button', {
      class: 'btn', type: 'button',
      onclick: async () => {
        const result = await api('POST', `/api/projects/${project.id}/tasks`, { name: 'New subtask', parentId: task.id });
        if (result) ctx.openTask(result.createdId);
      },
    }, icon('plus'), 'Subtask'));

  return h('aside', { class: 'drawer', role: 'dialog', 'aria-label': `Task: ${task.name}` },
    h('div', { class: 'drawer-head' },
      h('div', { class: 'grow' },
        h('div', { class: 'small muted truncate' }, project.name),
        h('h2', { style: { fontSize: '16px', overflowWrap: 'anywhere' } }, task.name)),
      h('button', { class: 'btn ghost icon', 'aria-label': 'Close task', onclick: close }, icon('x'))),
    h('div', { class: 'drawer-body' },
      scheduleLine,
      notices.length ? h('div', { class: 'stack', style: { gap: '6px' } }, notices) : null,
      h('section', { class: 'drawer-section' }, h('h3', {}, 'Details'), details, notes, options, outline),
      dependenciesSection(project, task, patch),
      historySection(task),
      h('div', {}, h('button', {
        class: 'btn danger', type: 'button',
        onclick: async () => {
          const childCount = project.tasks.filter((t) => t.parentId === task.id).length;
          const ok = await confirmDialog({
            title: 'Delete this task?',
            message: `"${task.name}"${childCount ? ` and its subtasks` : ''} will be deleted along with its history, and any links to it will be removed. This can't be undone.`,
            confirmLabel: 'Delete task',
            danger: true,
          });
          if (!ok) return;
          ctx.taskId = null;
          await api('DELETE', `/api/tasks/${task.id}`);
        },
      }, icon('trash'), 'Delete task'))));
}

function dependenciesSection(project, task, patch) {
  const setDeps = (deps) => patch({ deps });
  const rows = task.deps.map((dep, index) => {
    const found = ctx.findTask(dep.taskId);
    if (!found) return null;
    const cross = found.project.id !== project.id;
    const change = (fields) => setDeps(task.deps.map((d, i) => (i === index ? { ...d, ...fields } : d)));
    return h('div', { class: 'dep-row' },
      h('div', { class: 'dep-name' },
        h('button', {
          class: 'nav-item', type: 'button',
          style: { padding: 0, minHeight: 0, background: 'none', color: 'var(--ink)', display: 'block', overflowWrap: 'anywhere' },
          onclick: () => ctx.openTask(found.task.id),
        }, found.task.name),
        h('small', {}, `${cross ? `${found.project.name} · ` : ''}finishes ${fmtDate(found.task.computed.end)}`)),
      h('select', { 'aria-label': 'Dependency type', title: DEP_TYPES[dep.type], onchange: (e) => change({ type: e.target.value }) },
        Object.keys(DEP_TYPES).map((t) => h('option', { value: t, selected: dep.type === t, title: DEP_TYPES[t] }, t))),
      h('input', { type: 'number', 'aria-label': 'Lag in working days', title: 'Lag in working days (negative overlaps)', value: dep.lag, onchange: (e) => change({ lag: Number(e.target.value) || 0 }) }),
      h('button', { class: 'btn ghost icon', type: 'button', 'aria-label': `Remove ${found.task.name}`, onclick: () => setDeps(task.deps.filter((_, i) => i !== index)) }, icon('x')));
  });

  // Add a predecessor from this project or any other.
  const projectSelect = h('select', { 'aria-label': 'Predecessor project', onchange: () => fillTasks() },
    ctx.data.projects.map((p) => h('option', { value: p.id, selected: p.id === project.id }, p.id === project.id ? `${p.name} (this project)` : p.name)));
  const taskSelect = h('select', { 'aria-label': 'Predecessor task' });
  const fillTasks = () => {
    const source = ctx.project(projectSelect.value);
    const taken = new Set(task.deps.map((d) => d.taskId));
    const options = orderedTasks(source).filter((t) => t.id !== task.id && !taken.has(t.id));
    taskSelect.replaceChildren(
      h('option', { value: '' }, options.length ? 'Choose a task…' : 'No tasks available'),
      ...options.map((t) => h('option', { value: t.id }, `${t.computed.wbs}  ${t.name}`)),
    );
  };
  fillTasks();

  const successors = ctx.data.projects.flatMap((p) => p.tasks
    .filter((t) => t.deps.some((d) => d.taskId === task.id))
    .map((t) => ({ project: p, task: t })));

  return h('section', { class: 'drawer-section' },
    h('h3', {}, 'Depends on'),
    rows.length ? h('div', {}, rows) : h('p', { class: 'small muted' }, 'No predecessors.'),
    h('div', { class: 'dep-add' },
      projectSelect,
      taskSelect,
      h('button', {
        class: 'btn', type: 'button',
        onclick: () => {
          if (!taskSelect.value) return;
          setDeps([...task.deps, { taskId: taskSelect.value, type: 'FS', lag: 0 }]);
        },
      }, 'Add')),
    h('h3', { style: { marginTop: '6px' } }, 'Waiting on this task'),
    successors.length
      ? h('div', { class: 'stack', style: { gap: '4px' } }, successors.map((s) => h('button', {
        class: 'nav-item', type: 'button', style: { minHeight: 0, padding: '3px 0', background: 'none', alignItems: 'baseline' },
        onclick: () => ctx.openTask(s.task.id),
      },
      h('span', { style: { color: 'var(--ink)', overflowWrap: 'anywhere' } }, s.task.name),
      h('span', { class: 'small muted nowrap' }, s.project.id === project.id ? `starts ${fmtDate(s.task.computed.start)}` : `${s.project.name} · ${fmtDate(s.task.computed.start)}`))))
      : h('p', { class: 'small muted' }, 'Nothing depends on this yet.'));
}

function historySection(task) {
  const box = h('textarea', {
    placeholder: 'Post an update: progress, risks, decisions…',
    'aria-label': 'Post an update',
    rows: 2,
    oninput: (e) => ctx.composer.set(task.id, e.target.value),
  }, ctx.composer.get(task.id) ?? '');

  const post = async () => {
    const note = box.value.trim();
    if (!note) return;
    box.blur();
    const saved = await api('POST', `/api/tasks/${task.id}/updates`, { note });
    if (saved) {
      ctx.composer.delete(task.id);
      ctx.render();
    }
  };

  const items = [...task.history].reverse().map((entry) => h('div', { class: `feed-item ${entry.type}` },
    h('div', { class: 'feed-meta' }, h('b', {}, entry.author || 'Unknown'), ` · ${fmtWhen(entry.at)}`),
    entry.note ? h('div', { class: 'feed-note' }, entry.note) : null,
    (entry.changes ?? []).map((change) => changeLine(change))));

  return h('section', { class: 'drawer-section' },
    h('h3', {}, `History (${task.history.length})`),
    box,
    h('div', { class: 'row', style: { justifyContent: 'space-between' } },
      h('button', { class: 'btn ghost small', type: 'button', style: { paddingLeft: 0 }, onclick: openNameDialog }, `Posting as ${ctx.actor || 'Anonymous'}`),
      h('button', { class: 'btn primary', type: 'button', onclick: post }, 'Post update')),
    h('div', { class: 'feed' }, items));
}

const blank = (value) => (value === '' || value === null || value === undefined ? 'none' : value);

function changeLine(change) {
  const show = (value) => {
    if (typeof value === 'boolean') return value ? 'yes' : 'no';
    if (change.field === 'status') return STATUS[value]?.label ?? value;
    if (change.field === 'progress') return `${value}%`;
    if (change.field === 'duration') return `${value}d`;
    if (['start', 'schedStart', 'schedEnd'].includes(change.field) && value) return fmtDate(String(value), true);
    return blank(value);
  };
  if (change.field === 'notes') return h('div', { class: 'feed-change' }, 'Notes updated');
  return h('div', { class: 'feed-change' }, `${change.label}: `, h('s', {}, show(change.from)), ' → ', show(change.to));
}
