// The task panel: details, current POC, dependencies and the full history.

import { api, ctx } from '../ctx.js';
import { confirmDialog, DEP_TYPES, dayWord, describeDep, describeLinkBuffer, FIRM_NOTE, fmtDate, fmtWhen, h, healthPill, icon, LAG_HELP, morph, parseLag, plural, selectOnFocus, STATUS, statusPill, toast } from '../util.js';
import { orderedTasks } from '../chart/gantt.js';
import { openNameDialog } from './dialogs.js';
import { dropEdit, heldEdit, proposeEdit } from '../held-edit.js';

let renderedFor = null;
let listening = false;
// What's chosen in the "add a predecessor" controls, which survive updates to the panel.
let adding = { projectId: null, taskId: '' };

export function renderDrawer(host) {
  // Leaving a field puts back anything that wasn't saved, such as a refused value.
  if (!listening) {
    listening = true;
    host.addEventListener('focusout', () => setTimeout(() => renderDrawer(host), 0));
    renderDrawerHost = host;
  }
  heldEdit(); // drops a waiting date if its task has been closed, on any page
  const found = ctx.taskId ? ctx.findTask(ctx.taskId) : null;
  const action = found || !ctx.taskId ? null : ctx.findAction(ctx.taskId);
  const sameTask = renderedFor === ctx.taskId;
  renderedFor = found || action ? ctx.taskId : null;
  if (!found && !action) {
    adding = { projectId: null, taskId: '' };
    host.replaceChildren();
    return;
  }
  if (!sameTask) adding = { projectId: null, taskId: '' };
  const next = found ? buildDrawer(found) : buildActionDrawer(action);
  // Updating in place keeps focus, scroll position and any click in progress.
  if (sameTask && host.firstElementChild) morph(host.firstElementChild, next);
  else host.replaceChildren(next);
  // A change waiting for a decision has to be seen, on a short screen too.
  const card = host.querySelector('.held-edit');
  if (card && !shownCard) card.scrollIntoView({ block: 'nearest' });
  shownCard = !!card;
}

let renderDrawerHost = null;
let shownCard = false;
const redraw = () => renderDrawer(renderDrawerHost);

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
  const byDates = task.trackBy === 'dates' && !task.milestone && !summary;
  const holdsLinksBack = !summary && !done && !byDates && !task.manual && task.startSet !== false && c.linkStart && c.linkStart < c.start;

  const input = (name, value, type = 'text', extra = {}) => h('input', {
    type,
    value: value ?? '',
    name,
    onchange: (event) => {
      const v = event.target.value;
      if (type === 'number' && v === '') {
        event.target.value = value ?? '';
        toast('Enter a whole number.', 'error');
        return;
      }
      patch({ [name]: type === 'number' ? Number(v) : v });
    },
    ...extra,
  });

  // Browsers report a change after each part of a date typed with the keyboard, so
  // the year 0202 on the way to 2026. Typed dates save on Enter, on Tab (which can
  // stop at the calendar icon, still inside the field) and on leaving the field.
  // A date picked from the calendar saves right away.
  // A date that would affect other tasks waits for Apply or Cancel instead.
  const held = heldEdit();
  const actualDates = { start: c.start, end: c.end };
  const proposeDate = (el, name) => {
    const fields = { ...held?.fields, [name]: el.value };
    for (const key of Object.keys(fields)) if (fields[key] === actualDates[key]) delete fields[key];
    el.rendered = el.value; // so the panel can put it back if this is cancelled
    if (!Object.keys(fields).length) {
      dropEdit();
      ctx.render();
    } else if (proposeEdit(task.id, fields)) {
      ctx.render();
    } else {
      patch(fields);
    }
  };
  const dateInput = (name, actual, disabled) => {
    const value = held?.fields[name] ?? held?.preview.self[name] ?? actual;
    const commit = (el) => {
      el.typing = false;
      if (!el.value || el.value === value) return;
      if (!/^(19|[2-9]\d)\d\d-/.test(el.value)) {
        el.value = value;
        toast('Enter a date with a four-digit year.', 'error');
        return;
      }
      proposeDate(el, name);
    };
    return h('input', {
      type: 'date', name, value, disabled, required: true,
      onkeydown: (e) => {
        if (e.key === 'Enter' || (e.key === 'Tab' && e.target.typing)) commit(e.target);
        else if (/^\d$/.test(e.key) || ['Backspace', 'Delete', 'ArrowUp', 'ArrowDown'].includes(e.key)) e.target.typing = true;
      },
      onchange: (e) => {
        if (!e.target.typing) commit(e.target);
      },
      onblur: (e) => {
        if (e.target.typing) commit(e.target);
      },
    });
  };

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
          e.target.closest('label').querySelector('.num').textContent = `${e.target.value}%`;
        },
        onchange: (e) => patch({ progress: Number(e.target.value) }),
      })),
    summary || task.milestone ? null : field('Track by', h('select', { name: 'trackBy', onchange: (e) => patch({ trackBy: e.target.value }) },
      h('option', { value: 'duration', selected: !byDates }, 'Duration (dates fill in)'),
      h('option', { value: 'dates', selected: byDates }, 'Dates (duration fills in)')), 'full'),
    field(task.milestone ? 'Date' : 'Start', dateInput('start', c.start, summary)),
    task.milestone ? null : field('Finish', dateInput('end', c.end, summary || !byDates)),
    task.milestone ? null : field(summary ? 'Working days' : 'Duration', input('duration', held?.preview.self.duration ?? c.duration, 'number', { min: 1, max: 3650, disabled: summary || byDates })),
    summary || task.milestone ? null : field('Counted in', h('select', { name: 'durationUnit', onchange: (e) => patch({ durationUnit: e.target.value }) },
      h('option', { value: 'working', selected: task.durationUnit !== 'calendar' }, 'Working days'),
      h('option', { value: 'calendar', selected: task.durationUnit === 'calendar' }, 'Calendar days'))),
    held ? heldEditCard(held, task) : null,
    h('datalist', { id: 'poc-names' }, ctx.pocNames().map((n) => h('option', { value: n }))));

  const notices = [];
  if (summary) notices.push(h('div', { class: 'callout' }, 'Dates, status and progress roll up from the subtasks.'));
  if (c.followsLinks && c.driverId) {
    const driver = ctx.findTask(c.driverId);
    if (driver) notices.push(h('div', { class: 'callout' }, `Start comes from "${driver.task.name}". Enter a start date to hold this task instead.`));
  }
  if (holdsLinksBack) {
    notices.push(h('div', { class: 'callout warn' },
      `The start date set on this task (${fmtDate(c.start)}) is keeping it later than its links need. They allow ${fmtDate(c.linkStart)}. `,
      h('button', { class: 'btn', type: 'button', onclick: () => patch({ startSet: false }) }, 'Follow links')));
  }
  if (c.delay > 0 && c.driverId) {
    const driver = ctx.findTask(c.driverId);
    if (driver) {
      const where = driver.project.id === project.id ? '' : ` in ${driver.project.name}`;
      notices.push(h('div', { class: 'callout warn' }, `▲ Pushed ${plural(c.delay, dayWord(task.durationUnit))} past the set start (${fmtDate(task.start)}) by "${driver.task.name}"${where}.`));
    }
  }
  const firmBroken = new Set((c.links ?? []).filter((l) => l.firm && l.buffer > 0).map((l) => l.taskId));
  const namesOf = (ids) => ids.map((id) => ctx.findTask(id)?.task.name).filter(Boolean).map((n) => `"${n}"`).join(', ');
  if (firmBroken.size) notices.push(h('div', { class: 'callout bad' }, `! This task is later than its firm link to ${namesOf([...firmBroken])} allows.`));
  const heldConflicts = c.conflicts.filter((id) => !firmBroken.has(id));
  if (heldConflicts.length) {
    const names = namesOf(heldConflicts);
    notices.push(h('div', { class: 'callout bad' }, `! This date conflicts with ${names}. ${byDates ? 'It is tracked by dates' : 'It is manually scheduled'}, so it did not move.`));
  }
  // The other side of a conflict: a task set by hand or by dates that this one is too late for.
  const waiting = ctx.data.projects.flatMap((p) => p.tasks).filter((t) => (t.computed.conflicts ?? []).includes(task.id)
    && !t.computed.links?.find((l) => l.taskId === task.id)?.firm);
  if (waiting.length && !done) {
    const behind = c.float < 0 ? ` It needs to finish ${plural(-c.float, dayWord(task.durationUnit))} earlier.` : '';
    notices.push(h('div', { class: 'callout bad' }, `! This task is too late for ${namesOf(waiting.map((t) => t.id))}, which won't move for it.${behind}`));
  }
  if (done && !summary) notices.push(h('div', { class: 'callout' }, 'Completed tasks stay put when their predecessors move.'));

  const dayName = task.durationUnit === 'calendar' ? 'calendar day' : 'day';
  const scheduleLine = h('div', { class: 'row wrap' },
    healthPill(c.health),
    c.critical ? h('span', { class: 'pill bad' }, '! Critical path') : null,
    c.float < 0 && !done ? h('span', { class: 'pill bad' }, `${plural(-c.float, dayName)} behind`) : null,
    !c.critical && !done && c.float > 0 ? h('span', { class: 'pill' }, `${plural(c.float, dayName)} of float`) : null);

  const options = h('div', { class: 'stack', style: { gap: '8px' } },
    summary ? null : h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: task.milestone, onchange: (e) => patch({ milestone: e.target.checked }) }),
      h('span', {}, 'Milestone', h('small', {}, 'A key date with no duration.'))),
    summary || byDates ? null : h('label', { class: 'check' },
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
      dependenciesSection(project, task),
      historySection(task, `/api/tasks/${task.id}`, project),
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

const shiftWords = (days) => `${plural(Math.abs(days), 'calendar day')} ${days > 0 ? 'later' : 'earlier'}`;

function datesMoved(entry) {
  const from = entry.fromStart !== entry.start ? entry.fromStart : entry.fromEnd;
  const to = entry.fromStart !== entry.start ? entry.start : entry.end;
  const which = entry.fromStart === entry.start ? 'Finish: ' : '';
  return `${which}${fmtDate(from)} → ${fmtDate(to)} · ${shiftWords(entry.shift)}`;
}

function heldEditCard({ fields, preview }, task) {
  const { self, moved, conflicts, finishes, buffers } = preview;
  const others = conflicts.filter((c) => c.id !== task.id);
  const title = moved.length
    ? `This change moves ${plural(moved.length, 'other task')}`
    : others.length ? 'This change causes a conflict' : 'This change no longer affects other tasks';
  const inProject = (entry) => (entry.projectName ? `${entry.name} (${entry.projectName})` : entry.name);

  // A button clicked with the keyboard is about to disappear, so give focus somewhere to go.
  const refocus = (event) => {
    if (!event.detail) document.querySelector(`.drawer [name=${Object.keys(fields)[0]}]`)?.focus();
  };
  const row = (name, detail, cls) => h('li', { class: cls }, h('b', {}, name), h('span', {}, detail));
  const landed = fields.start && self.start !== fields.start ? fields.start : null;

  return h('div', { class: 'held-edit', role: 'status' },
    h('h4', {}, `${title}. Nothing is saved yet.`),
    h('ul', { class: 'held-edit-list' },
      conflicts.map((entry) => row(`New conflict: ${inProject(entry)}`, `Breaks its link to ${entry.with.map((n) => `"${n}"`).join(', ')}.`, 'bad')),
      finishes.map((f) => row(finishes.length > 1 ? `${f.name} finish` : 'Project finish', `${fmtDate(f.from)} → ${fmtDate(f.to)}`)),
      self.fromStart !== self.start || self.fromEnd !== self.end ? row('This task', datesMoved(self)) : null,
      landed ? row('Date entered', `${fmtDate(landed)} isn't available, so this task lands on ${fmtDate(self.start)}, because of its links or calendar.`) : null,
      moved.map((entry) => h('li', { 'data-moved': entry.id }, h('b', {}, inProject(entry)), h('span', {}, datesMoved(entry)))),
      buffers.map((b) => row(`Buffer: ${b.from} → ${b.to}`, `${plural(b.was, dayWord(b.unit))} → ${plural(b.now, dayWord(b.unit))}`))),
    h('div', { class: 'held-edit-actions' },
      h('button', {
        class: 'btn', type: 'button', 'data-action': 'cancel-edit',
        onclick: (event) => {
          dropEdit();
          ctx.render();
          refocus(event);
        },
      }, 'Cancel'),
      h('button', {
        class: 'btn primary', type: 'button', 'data-action': 'apply-edit',
        onclick: async (event) => {
          dropEdit();
          await api('PATCH', `/api/tasks/${task.id}`, fields);
          refocus(event);
        },
      }, 'Apply')));
}

// A save sends a task's whole list of links, so one built before the last save finished
// would undo it. Edits wait their turn and apply to the list as saved. Until then, the
// panel shows them on top of it. An edit may be applied more than once, so must allow that.
const linkEdits = [];
let linkSaves = Promise.resolve();
const withLinkEdits = (task) => linkEdits.filter((e) => e.taskId === task.id).reduce((deps, e) => e.apply(deps), task.deps);

function editLinks(taskId, apply) {
  const entry = { taskId, apply };
  linkEdits.push(entry);
  linkSaves = linkSaves.then(async () => {
    const found = ctx.findTask(taskId);
    const saved = found ? await api('PATCH', `/api/tasks/${taskId}`, { deps: apply(found.task.deps) }) : null;
    linkEdits.splice(linkEdits.indexOf(entry), 1);
    // A refused edit was still showing when the refusal redrew the panel.
    if (!saved) ctx.render();
  });
}

function dependenciesSection(project, task) {
  const links = withLinkEdits(task);
  const rows = links.map((dep) => {
    const found = ctx.findTask(dep.taskId);
    if (!found) return null;
    const cross = found.project.id !== project.id;
    const change = (fields) => editLinks(task.id, (deps) => deps.map((d) => (d.taskId === dep.taskId ? { ...d, ...fields } : d)));
    const link = task.computed.links.find((l) => l.taskId === dep.taskId);
    const buffer = link?.buffer ?? 0;
    const firm = ctx.isFirm(dep);
    const standing = task.computed.status === 'complete' ? null : describeLinkBuffer(buffer, task.name, firm, link?.unit);
    return h('div', { class: 'dep-row' },
      h('div', { class: 'dep-name' },
        h('button', {
          class: 'nav-item', type: 'button',
          style: { padding: 0, minHeight: 0, background: 'none', color: 'var(--ink)', display: 'block', overflowWrap: 'anywhere' },
          onclick: () => ctx.openTask(found.task.id),
        }, found.task.name),
        h('small', {}, `${cross ? `${found.project.name} · ` : ''}${dep.type === 'SS' || dep.type === 'SF' ? `starts ${fmtDate(found.task.computed.start)}` : `finishes ${fmtDate(found.task.computed.end)}`}`)),
      h('select', { 'aria-label': 'Dependency type', title: DEP_TYPES[dep.type], onchange: (e) => change({ type: e.target.value }) },
        Object.keys(DEP_TYPES).map((t) => h('option', { value: t, selected: dep.type === t, title: DEP_TYPES[t] }, t))),
      h('input', {
        type: 'number', 'aria-label': 'Lag in days', title: 'Lag in days (negative overlaps)', value: dep.lag, onfocus: selectOnFocus,
        onchange: (e) => {
          const lag = parseLag(e.target.value, e.target.validity.badInput);
          if (lag === null) {
            e.target.value = dep.lag;
            toast(LAG_HELP, 'error');
            return;
          }
          change({ lag });
        },
      }),
      h('select', { 'aria-label': 'Lag counted in', title: 'Lag counts working days or calendar days', onchange: (e) => change({ lagUnit: e.target.value }) },
        h('option', { value: 'working', selected: dep.lagUnit !== 'calendar' }, 'Working'),
        h('option', { value: 'calendar', selected: dep.lagUnit === 'calendar' }, 'Calendar')),
      h('button', { class: 'btn ghost icon', type: 'button', 'aria-label': `Remove ${found.task.name}`, onclick: () => editLinks(task.id, (deps) => deps.filter((d) => d.taskId !== dep.taskId)) }, icon('x')),
      h('p', { class: 'dep-plain' }, describeDep(dep, task, found.task, firm)),
      standing ? h('p', { class: `dep-standing ${buffer < 0 || firm ? 'bad' : ''}` }, standing) : null,
      firm ? h('p', { class: 'dep-standing' }, FIRM_NOTE) : null);
  });

  // Add a predecessor from this project or any other.
  const source = ctx.project(adding.projectId) ?? project;
  const taken = new Set(links.map((d) => d.taskId));
  const options = orderedTasks(source).filter((t) => t.id !== task.id && !taken.has(t.id));
  const chosen = options.some((t) => t.id === adding.taskId) ? adding.taskId : '';
  const projectSelect = h('select', {
    'aria-label': 'Predecessor project',
    onchange: (e) => {
      adding = { projectId: e.target.value, taskId: '' };
      redraw();
    },
  }, ctx.data.projects.map((p) => h('option', { value: p.id, selected: p.id === source.id }, p.id === project.id ? `${p.name} (this project)` : p.name)));
  const taskSelect = h('select', {
    'aria-label': 'Predecessor task',
    onchange: (e) => {
      adding.taskId = e.target.value;
    },
  },
  h('option', { value: '', selected: !chosen }, options.length ? 'Choose a task…' : 'No tasks available'),
  options.map((t) => h('option', { value: t.id, selected: t.id === chosen }, `${t.computed.wbs}  ${t.name}`)));

  const successors = ctx.data.projects.flatMap((p) => p.tasks
    .filter((t) => t.deps.some((d) => d.taskId === task.id))
    .map((t) => ({ project: p, task: t, dep: t.deps.find((d) => d.taskId === task.id) })));

  return h('section', { class: 'drawer-section' },
    h('h3', {}, 'Depends on'),
    rows.length ? h('div', {}, rows) : h('p', { class: 'small muted' }, 'No predecessors.'),
    h('div', { class: 'dep-add' },
      projectSelect,
      taskSelect,
      h('button', {
        class: 'btn', type: 'button',
        onclick: () => {
          const taskId = adding.taskId;
          if (!taskId) return;
          adding.taskId = '';
          editLinks(task.id, (deps) => (deps.some((d) => d.taskId === taskId) ? deps : [...deps, { taskId, type: 'FS', lag: 0 }]));
          redraw();
        },
      }, 'Add')),
    h('h3', { style: { marginTop: '6px' } }, 'Waiting on this task'),
    successors.length
      ? h('div', { class: 'stack', style: { gap: '4px' } }, successors.map((s) => h('div', {}, h('button', {
        class: 'nav-item', type: 'button', style: { minHeight: 0, padding: '3px 0', background: 'none', alignItems: 'baseline' },
        onclick: () => ctx.openTask(s.task.id),
      },
      h('span', { style: { color: 'var(--ink)', overflowWrap: 'anywhere' } }, s.task.name),
      h('span', { class: 'small muted nowrap' }, s.project.id === project.id ? `starts ${fmtDate(s.task.computed.start)}` : `${s.project.name} · ${fmtDate(s.task.computed.start)}`)),
      h('p', { class: 'dep-plain' }, describeDep(s.dep, s.task, task, ctx.isFirm(s.dep))))))
      : h('p', { class: 'small muted' }, 'Nothing depends on this yet.'));
}

// An action item: a task's who, what and history, with no dates, links or outline.
function buildActionDrawer({ project, action }) {
  const path = `/api/actions/${action.id}`;
  const patch = (fields) => api('PATCH', path, fields);
  const field = (label, control, cls = '') => h('label', { class: `field ${cls}` }, label, control);
  const input = (name, value, extra = {}) => h('input', {
    type: 'text', name, value: value ?? '', onchange: (e) => patch({ [name]: e.target.value }), ...extra,
  });
  const close = () => {
    ctx.taskId = null;
    ctx.render();
  };

  const details = h('div', { class: 'field-grid' },
    field('Name', input('name', action.name), 'full'),
    field('Current POC', input('pocName', action.pocName, { list: 'poc-names', placeholder: 'Who to ask', autocomplete: 'off' })),
    field('POC contact', input('pocContact', action.pocContact, { placeholder: 'Email or phone', autocomplete: 'off' })),
    field('Status', h('select', { name: 'status', onchange: (e) => patch({ status: e.target.value }) },
      Object.entries(STATUS).map(([key, s]) => h('option', { value: key, selected: action.status === key }, s.label)))),
    h('label', { class: 'field' }, h('span', { class: 'row', style: { justifyContent: 'space-between' } }, 'Progress', h('span', { class: 'num' }, `${action.progress}%`)),
      h('input', {
        type: 'range', name: 'progress', min: 0, max: 100, step: 5, value: action.progress,
        oninput: (e) => {
          e.target.closest('label').querySelector('.num').textContent = `${e.target.value}%`;
        },
        onchange: (e) => patch({ progress: Number(e.target.value) }),
      })),
    h('datalist', { id: 'poc-names' }, ctx.pocNames().map((n) => h('option', { value: n }))));

  const notes = field('Notes', h('textarea', { name: 'notes', rows: 3, onchange: (e) => patch({ notes: e.target.value }) }, action.notes));

  return h('aside', { class: 'drawer', role: 'dialog', 'aria-label': `Action item: ${action.name}` },
    h('div', { class: 'drawer-head' },
      h('div', { class: 'grow' },
        h('div', { class: 'small muted truncate' }, `${project.name} · Action item`),
        h('h2', { style: { fontSize: '16px', overflowWrap: 'anywhere' } }, action.name)),
      h('button', { class: 'btn ghost icon', 'aria-label': 'Close action item', onclick: close }, icon('x'))),
    h('div', { class: 'drawer-body' },
      h('div', { class: 'row wrap' }, statusPill(action.status)),
      h('section', { class: 'drawer-section' }, h('h3', {}, 'Details'), details, notes),
      historySection(action, path, project),
      h('div', {}, h('button', {
        class: 'btn danger', type: 'button',
        onclick: async () => {
          const ok = await confirmDialog({
            title: 'Delete this action item?',
            message: `"${action.name}" will be deleted along with its history. This can't be undone.`,
            confirmLabel: 'Delete action item',
            danger: true,
          });
          if (!ok) return;
          ctx.taskId = null;
          await api('DELETE', path);
        },
      }, icon('trash'), 'Delete action item'))));
}

function historySection(task, path, project) {
  const box = h('textarea', {
    placeholder: 'Post an update: progress, risks, decisions…',
    'aria-label': 'Post an update',
    rows: 2,
    oninput: (e) => ctx.composer.set(task.id, e.target.value),
  }, ctx.composer.get(task.id) ?? '');

  const post = async () => {
    const note = (ctx.composer.get(task.id) ?? '').trim();
    if (!note) return;
    document.activeElement?.blur();
    const saved = await api('POST', `${path}/updates`, { note });
    if (saved) {
      ctx.composer.delete(task.id);
      ctx.render();
    }
  };

  // Quick edits are stored as one entry holding each step. Normally the entry shows
  // where things ended up, and "Show every change" lists the steps instead.
  const every = ctx.historyDetail;
  const newestFirst = [...task.history].reverse();
  const merged = newestFirst.some((e) => e.steps);
  const shown = every
    ? newestFirst.flatMap((e) => (e.steps ? stepsOf(e).reverse() : [e]))
    : newestFirst.filter((e) => e.type === 'create' || e.note || e.changes?.length);
  const items = shown.map((entry) => feedItem(entry, every));

  return h('section', { class: 'drawer-section' },
    h('h3', {}, `History (${shown.length})`),
    project?.planning ? h('p', { class: 'small muted', 'data-planning-note': 'true' },
      'This project is still being planned, so changes are kept in the "created" entry below. Setting a baseline, or turning off "Still planning" in project settings, starts listing them.') : null,
    box,
    h('div', { class: 'row', style: { justifyContent: 'space-between' } },
      h('button', { class: 'btn ghost small', type: 'button', style: { paddingLeft: 0 }, onclick: openNameDialog }, `Posting as ${ctx.actor || 'Anonymous'}`),
      h('button', { class: 'btn primary', type: 'button', onclick: post }, 'Post update')),
    merged ? h('label', { class: 'check small', style: { alignItems: 'center' } },
      h('input', {
        type: 'checkbox', name: 'historyDetail', checked: every, style: { marginTop: 0 },
        onchange: (e) => {
          ctx.historyDetail = e.target.checked;
          ctx.render();
        },
      }), 'Show every change') : null,
    task.history.length ? h('div', { class: 'feed-sides small muted' }, h('span', {}, 'Updates'), h('span', {}, 'Changes')) : null,
    h('div', { class: 'feed' }, items));
}

// A merged entry's steps, as entries of their own.
const stepsOf = (entry) => entry.steps.map((step, i) => ({ ...step, id: `${entry.id}:${i}`, author: step.author ?? entry.author }));

const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
const clock = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

function feedItem(entry, every) {
  const steps = !every && entry.steps ? entry.steps.length : 0;
  const open = steps && ctx.openSteps.has(entry.id);
  // Until when, unless that's the same minute it started.
  const sameMinute = entry.lastAt && fmtWhen(entry.lastAt) === fmtWhen(entry.at);
  const until = steps && entry.lastAt && !sameMinute ? ` – ${sameDay(entry.at, entry.lastAt) ? clock(entry.lastAt) : fmtWhen(entry.lastAt)}` : '';
  // A task set up straight after it was made shows what it was set to.
  const setup = entry.type === 'create';
  return h('div', { class: `feed-item ${entry.type}`, 'data-entry': entry.id },
    h('div', { class: 'feed-meta' }, h('b', {}, entry.author || 'Unknown'), ` · ${fmtWhen(entry.at)}${until}`,
      steps ? h('button', {
        class: 'btn ghost small feed-steps', type: 'button', 'aria-expanded': String(!!open),
        onclick: () => {
          if (open) ctx.openSteps.delete(entry.id);
          else ctx.openSteps.add(entry.id);
          ctx.render();
        },
      }, plural(steps + (entry.stepsDropped ?? 0), 'edit')) : null),
    entry.note ? h('div', { class: 'feed-note' }, entry.note) : null,
    !open && steps && !entry.changes?.length && !setup ? h('div', { class: 'feed-change' }, 'Everything was put back as it was') : null,
    (entry.changes ?? []).map((change) => changeLine(change, { setup })),
    open ? h('div', { class: 'feed-step-list' },
      entry.stepsDropped ? h('div', { class: 'feed-change muted' }, `${plural(entry.stepsDropped, 'earlier edit')} not kept`) : null,
      stepsOf(entry).map((step) => h('div', { class: 'feed-step' },
        h('div', { class: 'feed-meta' }, step.author !== entry.author ? h('b', {}, step.author) : null,
          `${step.author !== entry.author ? ' · ' : ''}${sameDay(step.at, entry.at) ? clock(step.at) : fmtWhen(step.at)}`),
        step.note ? h('div', { class: 'feed-change' }, step.note) : null,
        (step.changes ?? []).map((change) => changeLine(change))))) : null);
}

const blank = (value) => (value === '' || value === null || value === undefined ? 'none' : value);

function changeLine(change, { setup = false } = {}) {
  const show = (value) => {
    if (typeof value === 'boolean') return value ? 'yes' : 'no';
    if (change.field === 'status') return STATUS[value]?.label ?? value;
    if (change.field === 'progress') return `${value}%`;
    if (change.field === 'duration') return `${value}d`;
    if (['start', 'finish', 'schedStart', 'schedEnd'].includes(change.field) && value) return fmtDate(String(value), true);
    return blank(value);
  };
  if (change.field === 'notes') return h('div', { class: 'feed-change' }, setup ? 'Notes added' : 'Notes updated');
  if (setup) return h('div', { class: 'feed-change' }, `${change.label}: `, show(change.to));
  return h('div', { class: 'feed-change' }, `${change.label}: `, h('s', {}, show(change.from)), ' → ', show(change.to));
}
