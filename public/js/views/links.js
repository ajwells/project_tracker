// Cross-project dependencies: what a project is waiting on, who is waiting on it,
// and how much room each link has before it moves someone else's dates.

import { ctx } from '../ctx.js';
import { depSuffix, describeDep, fmtDate, h, icon, plural } from '../util.js';
import { currentMode, projectColor } from '../chart/core.js';
import { openLinkDialog } from './dialogs.js';

function linkPill(link) {
  if (link.state === 'conflict') return h('span', { class: 'pill bad', title: 'The dependency is being violated by a manually scheduled or pinned task.' }, '! ', 'Conflict');
  if (link.state === 'driving') return h('span', { class: 'pill warn', title: 'Any slip upstream moves the downstream task.' }, '▲ ', 'No buffer');
  return h('span', { class: 'pill good' }, '● ', `${plural(link.buffer, 'day')} buffer`);
}

function taskCell(project, task, dateLabel, date, mode) {
  return h('button', {
    class: 'nav-item',
    style: { padding: '2px 0', minHeight: 0, height: 'auto', alignItems: 'flex-start', background: 'none' },
    onclick: () => ctx.openTask(task.id),
  },
  h('span', { class: 'dot', style: { background: projectColor(project.color, mode), marginTop: '5px' } }),
  h('span', { style: { minWidth: 0 } },
    h('span', { style: { display: 'block', color: 'var(--ink)' } }, task.name),
    h('span', { class: 'small muted' }, `${project.name} · ${dateLabel} ${fmtDate(date)}${task.pocName ? ` · ${task.pocName}` : ''}`)));
}

function linkTable(links, mode, scrollKey) {
  return h('div', { class: 'table-wrap cards', 'data-scroll-key': scrollKey },
    h('table', { class: 'grid' },
      h('thead', {}, h('tr', {}, ['Depends on (upstream)', 'Waiting task (downstream)', 'Type', 'Health'].map((t) => h('th', {}, t)))),
      h('tbody', {}, links.map((link) => {
        const from = ctx.findTask(link.fromTaskId);
        const to = ctx.findTask(link.toTaskId);
        return h('tr', {},
          h('td', { class: 'span-all', 'data-label': 'Depends on' }, taskCell(from.project, from.task, 'finishes', from.task.computed.end, mode)),
          h('td', { class: 'span-all', 'data-label': 'Waiting task' }, taskCell(to.project, to.task, 'starts', to.task.computed.start, mode)),
          h('td', { 'data-label': 'Type' }, h('span', { class: 'nowrap' }, depSuffix(link)), h('p', { class: 'dep-plain' }, describeDep(link, to.task, from.task, link.firm))),
          h('td', { 'data-label': 'Health' }, linkPill(link)));
      }))));
}

export function renderLinks(view, project) {
  const mode = currentMode();
  const all = ctx.data.crossLinks;
  const addButton = (ctx.data.projects.length > 1 && (!project || project.tasks.length))
    ? h('button', { class: 'btn primary', onclick: () => openLinkDialog(project) }, icon('plus'), 'Add cross-project link')
    : null;

  const emptyState = () => h('div', { class: 'empty' },
    h('h2', {}, 'No cross-project links yet'),
    h('p', {}, ctx.data.projects.length > 1
      ? 'Link a task to work in another project. If that work slips, this schedule moves with it and the change is recorded in the task history.'
      : 'Create a second project to link work across projects.'),
    addButton);

  if (!project) {
    if (!all.length) return view.append(emptyState());
    return view.append(
      h('div', { class: 'section-title' }, h('h2', {}, plural(all.length, 'cross-project link')), addButton),
      linkTable(all, mode, 'links:all'),
    );
  }

  const upstream = all.filter((l) => l.toProjectId === project.id);
  const downstream = all.filter((l) => l.fromProjectId === project.id);
  if (!upstream.length && !downstream.length) return view.append(emptyState());

  view.append(
    h('div', { class: 'section-title' },
      h('div', {},
        h('h2', {}, `This project is waiting on ${plural(upstream.length, 'task')}`),
        h('p', { class: 'small muted' }, 'If these slip, your dates can move.')),
      addButton),
    upstream.length ? linkTable(upstream, mode, `links:up:${project.id}`) : h('p', { class: 'muted' }, 'Nothing here depends on another project.'),
    h('div', { class: 'section-title' },
      h('div', {},
        h('h2', {}, `Other projects are waiting on ${plural(downstream.length, 'task')} here`),
        h('p', { class: 'small muted' }, 'If you slip, these teams are affected.'))),
    downstream.length ? linkTable(downstream, mode, `links:down:${project.id}`) : h('p', { class: 'muted' }, 'No other project depends on this one.'),
  );
}
