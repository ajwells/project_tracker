import { api, ctx } from '../ctx.js';
import { depSuffix, fmtDate, h, healthPill, icon, statusPill, STATUS } from '../util.js';
import { currentMode, projectColor } from '../chart/core.js';
import { orderedTasks } from '../chart/gantt.js';

export function predecessorChips(task, project) {
  return task.deps.map((dep) => {
    const found = ctx.findTask(dep.taskId);
    if (!found) return null;
    const cross = found.project.id !== project.id;
    const suffix = dep.type === 'FS' && !dep.lag ? '' : ` ${depSuffix(dep)}`;
    const label = cross ? `${found.project.name} › ${found.task.computed.wbs}${suffix}` : `${found.task.computed.wbs}${suffix}`;
    return h('span', { class: `dep-chip ${cross ? 'cross' : ''}`, title: `${found.project.name}: ${found.task.name}` }, label);
  });
}

export function renderTasks(view, project) {
  view.classList.add('fill');
  const { filters } = ctx;
  const color = projectColor(project.color, currentMode());

  const matches = (task) => {
    if (filters.search && !`${task.name} ${task.pocName}`.toLowerCase().includes(filters.search.toLowerCase())) return false;
    if (filters.poc && task.pocName !== filters.poc) return false;
    if (filters.status && task.computed.status !== filters.status) return false;
    return true;
  };
  const filtering = !!(filters.search || filters.poc || filters.status);
  const tasks = filtering ? orderedTasks(project).filter(matches) : orderedTasks(project, ctx.collapsed);
  const pocs = [...new Set(project.tasks.map((t) => t.pocName).filter(Boolean))].sort();

  const search = h('input', {
    type: 'search', id: 'task-search', placeholder: 'Search tasks or POCs', 'aria-label': 'Search tasks', value: filters.search,
    oninput: (event) => {
      filters.search = event.target.value;
      ctx.render();
    },
  });
  const toolbar = h('div', { class: 'toolbar' },
    search,
    h('select', {
      'aria-label': 'Filter by POC',
      onchange: (event) => {
        filters.poc = event.target.value;
        ctx.render();
      },
    }, h('option', { value: '' }, 'All POCs'), pocs.map((p) => h('option', { value: p, selected: filters.poc === p }, p))),
    h('select', {
      'aria-label': 'Filter by status',
      onchange: (event) => {
        filters.status = event.target.value;
        ctx.render();
      },
    }, h('option', { value: '' }, 'All statuses'), Object.entries(STATUS).map(([k, s]) => h('option', { value: k, selected: filters.status === k }, s.label))));

  const addForm = h('form', {
    class: 'add-row',
    onsubmit: async (event) => {
      event.preventDefault();
      const input = event.target.elements.name;
      const name = input.value.trim();
      if (!name) return;
      const milestone = event.target.elements.milestone.checked;
      input.value = '';
      ctx.focusAfter = '#quick-add';
      const saved = await api('POST', `/api/projects/${project.id}/tasks`, { name, milestone });
      if (!saved) {
        document.getElementById('quick-add').value = name;
        return;
      }
      // New tasks go last in the list, so bring the end of the list into view to show it.
      for (const el of document.querySelectorAll('.view, .table-wrap')) el.scrollTop = el.scrollHeight;
    },
  },
  h('input', { type: 'text', id: 'quick-add', name: 'name', placeholder: 'Add a task and press Enter', 'aria-label': 'New task name', autocomplete: 'off' }),
  h('label', { class: 'check', style: { alignItems: 'center' } }, h('input', { type: 'checkbox', name: 'milestone', style: { marginTop: 0 } }), 'Milestone'),
  h('button', { class: 'btn primary', type: 'submit' }, icon('plus'), 'Add'));

  if (!project.tasks.length) {
    view.append(addForm, h('div', { class: 'empty' },
      h('h2', {}, 'No tasks yet'),
      h('p', {}, 'Add your first task above. Open any task to set its dates, POC and dependencies.')));
    return;
  }

  const rows = tasks.map((task) => {
    const c = task.computed;
    const chevron = c.isSummary && !filtering
      ? h('button', {
        class: 'chev', 'aria-label': ctx.collapsed.has(task.id) ? 'Expand' : 'Collapse', 'aria-expanded': String(!ctx.collapsed.has(task.id)),
        onclick: (event) => {
          event.stopPropagation();
          if (ctx.collapsed.has(task.id)) ctx.collapsed.delete(task.id);
          else ctx.collapsed.add(task.id);
          ctx.render();
        },
      }, chevronIcon())
      : h('span', { class: 'chev-spacer' });
    return h('tr', {
      class: `clickable ${c.isSummary ? 'summary-row' : ''} ${ctx.taskId === task.id ? 'selected' : ''}`,
      tabindex: 0,
      onclick: () => ctx.openTask(task.id),
      onkeydown: (event) => {
        if (event.key === 'Enter' && event.target === event.currentTarget) ctx.openTask(task.id);
      },
    },
    h('td', { class: 'wbs hide-card' }, c.wbs),
    h('td', { class: 'span-all' },
      h('div', { class: 'task-name', style: { '--depth': filtering ? 0 : c.depth } },
        chevron,
        task.milestone ? h('span', { class: 'ms-mark', title: 'Milestone' }) : null,
        h('span', {}, task.name))),
    h('td', { 'data-label': 'POC' }, task.pocName || h('span', { class: 'muted' }, c.isSummary ? '—' : 'Unassigned')),
    h('td', { 'data-label': 'Status' }, statusPill(c.status)),
    h('td', { 'data-label': 'Health' }, healthPill(c.health)),
    h('td', { class: 'nowrap num', 'data-label': 'Start' }, fmtDate(c.start)),
    h('td', { class: 'nowrap num', 'data-label': 'Finish' }, fmtDate(c.end)),
    h('td', { class: 'num hide-card', style: { textAlign: 'right' } }, task.milestone ? '—' : `${c.duration}d`),
    h('td', { 'data-label': 'Progress' },
      h('div', { class: 'mini-progress' },
        h('div', { class: 'progress' }, h('i', { style: { width: `${c.progress}%`, background: color } })),
        h('span', {}, `${c.progress}%`))),
    h('td', { 'data-label': task.deps.length ? 'Depends on' : '', class: task.deps.length ? 'span-all' : 'hide-card' }, predecessorChips(task, project)));
  });

  view.append(
    toolbar,
    h('div', { class: 'table-wrap cards grow', 'data-scroll-key': `tasks:${project.id}` },
      h('table', { class: 'grid' },
        h('thead', {}, h('tr', {}, ['#', 'Task', 'Current POC', 'Status', 'Health', 'Start', 'Finish', 'Days', 'Progress', 'Depends on'].map((t) => h('th', {}, t)))),
        h('tbody', {}, rows.length ? rows : h('tr', {}, h('td', { colspan: 10, class: 'muted span-all' }, 'No tasks match these filters.'))))),
    addForm,
  );
}

function chevronIcon() {
  const svg = icon('chevron');
  svg.removeAttribute('class');
  return svg;
}
