// The Action items page: things to chase that have no dates, so they stay off the
// schedule, the charts and the project's progress. Each opens in the task panel.

import { api, ctx } from '../ctx.js';
import { fmtWhen, h, icon, plural, statusPill, STATUS } from '../util.js';
import { currentMode, projectColor } from '../chart/core.js';

// The newest posted update, which is usually what someone opening the list wants.
const latestUpdate = (action) => [...action.history].reverse().find((e) => e.type === 'update');
const lastActivity = (action) => action.history.at(-1)?.at ?? action.createdAt;

export function renderActions(view, project) {
  view.classList.add('fill');
  const filters = ctx.actionFilters;
  const color = projectColor(project.color, currentMode());
  const all = project.actions;
  const doneCount = all.filter((a) => a.status === 'complete').length;

  const matches = (action) => {
    if (filters.search && !`${action.name} ${action.pocName} ${action.notes}`.toLowerCase().includes(filters.search.toLowerCase())) return false;
    if (filters.poc && action.pocName !== filters.poc) return false;
    if (filters.status && action.status !== filters.status) return false;
    if (!filters.showDone && !filters.status && action.status === 'complete') return false;
    return true;
  };
  const shown = all.filter(matches);
  const pocs = [...new Set(all.map((a) => a.pocName).filter(Boolean))].sort();
  const redraw = () => ctx.render();

  const toolbar = h('div', { class: 'toolbar' },
    h('input', {
      type: 'search', id: 'action-search', placeholder: 'Search action items', 'aria-label': 'Search action items', value: filters.search,
      oninput: (event) => {
        filters.search = event.target.value;
        redraw();
      },
    }),
    h('select', {
      'aria-label': 'Filter by POC',
      onchange: (event) => {
        filters.poc = event.target.value;
        redraw();
      },
    }, h('option', { value: '' }, 'All POCs'), pocs.map((p) => h('option', { value: p, selected: filters.poc === p }, p))),
    h('select', {
      'aria-label': 'Filter by status',
      onchange: (event) => {
        filters.status = event.target.value;
        redraw();
      },
    }, h('option', { value: '' }, 'All statuses'), Object.entries(STATUS).map(([k, s]) => h('option', { value: k, selected: filters.status === k }, s.label))),
    doneCount ? h('label', { class: 'check', style: { alignItems: 'center' } },
      h('input', {
        type: 'checkbox', name: 'showDone', checked: filters.showDone, style: { marginTop: 0 },
        onchange: (event) => {
          filters.showDone = event.target.checked;
          redraw();
        },
      }), `Show completed (${doneCount})`) : null);

  const addForm = h('form', {
    class: 'add-row',
    onsubmit: async (event) => {
      event.preventDefault();
      const input = event.target.elements.name;
      const name = input.value.trim();
      if (!name) return;
      input.value = '';
      ctx.focusAfter = '#quick-add-action';
      const saved = await api('POST', `/api/projects/${project.id}/actions`, { name });
      if (!saved) {
        document.getElementById('quick-add-action').value = name;
        return;
      }
      for (const el of document.querySelectorAll('.view, .table-wrap')) el.scrollTop = el.scrollHeight;
    },
  },
  h('input', { type: 'text', id: 'quick-add-action', name: 'name', placeholder: 'Add an action item and press Enter', 'aria-label': 'New action item name', autocomplete: 'off' }),
  h('button', { class: 'btn primary', type: 'submit' }, icon('plus'), 'Add'));

  if (!all.length) {
    view.append(addForm, h('div', { class: 'empty' },
      h('h2', {}, 'No action items yet'),
      h('p', {}, 'Action items are things to follow up on that have no dates. They stay off the Gantt chart and timeline, and don\'t count toward the project\'s progress. Open one to set its POC, status and progress, and to post updates.')));
    return;
  }

  const rows = shown.map((action) => {
    const update = latestUpdate(action);
    return h('tr', {
      class: `clickable ${ctx.taskId === action.id ? 'selected' : ''}`,
      tabindex: 0,
      'data-action-id': action.id,
      onclick: () => ctx.openTask(action.id),
      onkeydown: (event) => {
        if (event.key === 'Enter' && event.target === event.currentTarget) ctx.openTask(action.id);
      },
    },
    h('td', { class: 'span-all' }, h('div', { class: 'task-name' }, h('span', {}, action.name))),
    h('td', { 'data-label': 'POC' }, action.pocName || h('span', { class: 'muted' }, 'Unassigned')),
    h('td', { 'data-label': 'Status' }, statusPill(action.status)),
    h('td', { 'data-label': 'Progress' },
      h('div', { class: 'mini-progress' },
        h('div', { class: 'progress' }, h('i', { style: { width: `${action.progress}%`, background: color } })),
        h('span', {}, `${action.progress}%`))),
    h('td', { 'data-label': 'Latest update', class: update ? 'action-update' : 'hide-card' },
      update ? h('span', { title: `${update.author} · ${fmtWhen(update.at)}` }, update.note) : h('span', { class: 'muted' }, 'None yet')),
    h('td', { class: 'nowrap', 'data-label': 'Last activity' }, fmtWhen(lastActivity(action))));
  });

  const hidden = all.length - shown.length;
  view.append(
    toolbar,
    h('div', { class: 'table-wrap cards grow', 'data-scroll-key': `actions:${project.id}` },
      h('table', { class: 'grid' },
        h('thead', {}, h('tr', {}, ['Action item', 'Current POC', 'Status', 'Progress', 'Latest update', 'Last activity'].map((t) => h('th', {}, t)))),
        h('tbody', {}, rows.length ? rows : h('tr', {}, h('td', { colspan: 6, class: 'muted span-all' },
          hidden && !filters.search && !filters.poc && !filters.status ? `All ${plural(hidden, 'action item')} are complete.` : 'No action items match these filters.'))))),
    addForm,
  );
}
