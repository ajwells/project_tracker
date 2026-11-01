import { ctx } from '../ctx.js';
import { fmtDate, fmtRange, h, healthPill, icon, plural } from '../util.js';
import { currentMode, projectColor } from '../chart/core.js';
import { openProjectDialog } from './dialogs.js';

export function renderOverview(view) {
  const mode = currentMode();
  const { projects, crossLinks } = ctx.data;
  const sum = (key) => projects.reduce((total, p) => total + p.summary[key], 0);
  const tile = (value, label) => h('div', { class: 'card tile' }, h('div', { class: 'v' }, value), h('div', { class: 'k' }, label));

  view.append(h('div', { class: 'tiles' },
    tile(projects.length, plural(projects.length, 'project').replace(/^\d+ /, 'Active ')),
    tile(sum('openCount'), 'Open tasks'),
    tile(sum('lateCount'), 'Late'),
    tile(sum('atRiskCount'), 'At risk'),
    tile(crossLinks.length, 'Cross-project links')));

  view.append(h('div', { class: 'section-title' },
    h('h2', {}, 'Projects'),
    h('button', { class: 'btn', onclick: () => openProjectDialog() }, icon('plus'), 'New project')));

  view.append(h('div', { class: 'project-grid' }, projects.map((project) => {
    const s = project.summary;
    const color = projectColor(project.color, mode);
    const nextMilestone = project.tasks
      .filter((t) => t.milestone && t.computed.status !== 'complete')
      .sort((a, b) => a.computed.start.localeCompare(b.computed.start))[0];
    const state = s.lateCount
      ? h('span', { class: 'pill bad' }, `! ${s.lateCount} late`)
      : s.atRiskCount
        ? h('span', { class: 'pill warn' }, `▲ ${s.atRiskCount} at risk`)
        : s.taskCount
          ? h('span', { class: 'pill good' }, '● On track')
          : h('span', { class: 'pill' }, 'No tasks');
    return h('a', { class: 'card project-card', href: `#/p/${project.id}/tasks` },
      h('div', { class: 'row', style: { justifyContent: 'space-between' } },
        h('h2', { class: 'grow' }, h('span', { class: 'dot', style: { background: color } }), h('span', { class: 'truncate' }, project.name)),
        state),
      h('div', { class: 'progress', role: 'img', 'aria-label': `${s.progress}% complete` }, h('i', { style: { width: `${s.progress}%`, background: color } })),
      h('div', { class: 'kv' },
        h('span', {}, `${s.progress}% complete`),
        h('span', {}, fmtRange(s.start, s.end))),
      h('div', { class: 'kv' },
        project.owner ? h('span', {}, `Owner: ${project.owner}`) : null,
        h('span', {}, plural(s.taskCount, 'task')),
        s.upstream || s.downstream ? h('span', {}, `${s.upstream} upstream · ${s.downstream} downstream`) : null),
      nextMilestone ? h('div', { class: 'kv' }, h('span', {}, `Next: ${nextMilestone.name} (${fmtDate(nextMilestone.computed.start)})`)) : null);
  })));

  const attention = projects
    .flatMap((project) => project.tasks
      .filter((t) => !t.computed.isSummary && (t.computed.health === 'late' || t.computed.health === 'at_risk'))
      .map((task) => ({ project, task })))
    .sort((a, b) => (a.task.computed.health === b.task.computed.health
      ? a.task.computed.end.localeCompare(b.task.computed.end)
      : a.task.computed.health === 'late' ? -1 : 1));

  view.append(h('div', { class: 'section-title' }, h('h2', {}, 'Needs attention')));
  if (!attention.length) {
    view.append(h('p', { class: 'muted' }, 'Nothing is late or at risk.'));
    return;
  }
  view.append(h('div', { class: 'table-wrap cards', 'data-scroll-key': 'attention' },
    h('table', { class: 'grid' },
      h('thead', {}, h('tr', {}, ['Task', 'Project', 'Current POC', 'Finish', 'Health'].map((t) => h('th', {}, t)))),
      h('tbody', {}, attention.slice(0, 25).map(({ project, task }) => h('tr', { class: 'clickable', tabindex: 0, onclick: () => ctx.openTask(task.id) },
        h('td', { class: 'span-all' }, task.name),
        h('td', { 'data-label': 'Project' }, h('span', { class: 'row' }, h('span', { class: 'dot', style: { background: projectColor(project.color, mode) } }), project.name)),
        h('td', { 'data-label': 'POC' }, task.pocName || h('span', { class: 'muted' }, 'Unassigned')),
        h('td', { 'data-label': 'Finish', class: 'nowrap' }, fmtDate(task.computed.end)),
        h('td', { 'data-label': 'Health' }, healthPill(task.computed.health))))))));
}
