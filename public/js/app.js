import { api, ctx, exportFromBrowser, listenForChanges, refresh } from './ctx.js';
import { attachTips, fmtRange, h, hideTip, icon, plural, toast } from './util.js';
import { currentMode, projectColor } from './chart/core.js';
import { renderTasks } from './views/tasks.js';
import { renderGanttView, renderTimelineView } from './views/charts.js';
import { renderLinks } from './views/links.js';
import { renderOverview } from './views/overview.js';
import { renderDrawer } from './views/drawer.js';
import { openImportDialog, openNameDialog, openProjectDialog } from './views/dialogs.js';

const PROJECT_TABS = [['tasks', 'Tasks'], ['gantt', 'Gantt'], ['timeline', 'Timeline'], ['links', 'Links']];
const PORTFOLIO_TABS = [['overview', 'Overview'], ['gantt', 'Gantt'], ['timeline', 'Timeline'], ['links', 'Links']];

const app = document.getElementById('app');
const sidebar = h('aside', { class: 'sidebar', 'aria-label': 'Projects' });
const main = h('main', { class: 'main' });
const drawerHost = h('div');
const scrim = h('div', { class: 'scrim', onclick: () => shell.classList.remove('nav-open') });
const shell = h('div', { class: 'shell' }, sidebar, scrim, main);
const saveBanner = h('div', { class: 'save-banner', role: 'alert' },
  icon('alert'),
  h('span', {}, h('strong', {}, 'Not saved on the server.'), ' Your projects are only in this browser, and clearing its data deletes them. ',
    h('a', { href: '/api/export', download: true, onclick: exportFromBrowser }, 'Export all projects'), ' as a backup.'));
saveBanner.hidden = true;
app.append(saveBanner, shell, drawerHost);
attachTips(document.body);

// ---- theme ------------------------------------------------------------------

function applyTheme() {
  const theme = ctx.storage.get('tracker.theme');
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}
applyTheme();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => ctx.render());

function cycleTheme() {
  const next = currentMode() === 'dark' ? 'light' : 'dark';
  ctx.storage.set('tracker.theme', next);
  applyTheme();
  ctx.render();
}

// ---- routing ----------------------------------------------------------------

function parseRoute() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'p' && parts[1]) return { projectId: parts[1], tab: parts[2] || 'tasks' };
  if (parts[0] === 'portfolio') return { projectId: null, tab: parts[1] || 'overview' };
  return { projectId: null, tab: 'overview' };
}

addEventListener('hashchange', () => {
  ctx.taskId = null;
  shell.classList.remove('nav-open');
  hideTip();
  ctx.render();
});

// ---- sidebar ----------------------------------------------------------------

function renderSidebar(route) {
  const mode = currentMode();
  const { projects } = ctx.data;
  sidebar.replaceChildren(
    h('div', { class: 'brand' }, h('img', { src: '/favicon.svg', alt: '' }), 'Project Tracker'),
    h('a', { class: 'nav-item', href: '#/', 'aria-current': !route.projectId ? 'page' : null }, icon('grid'), 'All projects'),
    h('div', { class: 'nav-label' }, 'Projects',
      h('button', { class: 'btn ghost icon', style: { minHeight: '26px', minWidth: '26px', padding: '2px' }, 'aria-label': 'New project', title: 'New project', onclick: () => openProjectDialog() }, icon('plus'))),
    ...projects.map((p) => h('a', {
      class: 'nav-item',
      href: `#/p/${p.id}/${route.projectId ? route.tab : 'tasks'}`,
      'aria-current': route.projectId === p.id ? 'page' : null,
    },
    h('span', { class: 'dot', style: { background: projectColor(p.color, mode) } }),
    h('span', { class: 'truncate' }, p.name),
    p.summary.lateCount ? h('span', { class: 'count', title: `${plural(p.summary.lateCount, 'late task')}` }, p.summary.lateCount) : null)),
    h('div', { class: 'side-foot' },
      h('button', { class: 'nav-item', onclick: openImportDialog }, icon('upload'), 'Import projects'),
      h('a', { class: 'nav-item', href: '/api/export', download: true, onclick: exportFromBrowser }, icon('download'), 'Export all projects'),
      h('button', { class: 'nav-item', onclick: openNameDialog }, icon('user'), h('span', { class: 'truncate' }, ctx.actor || 'Set your name')),
      h('button', { class: 'nav-item', onclick: cycleTheme }, icon('sun'), mode === 'dark' ? 'Light mode' : 'Dark mode')),
  );
}

// ---- main area --------------------------------------------------------------

const scrollMemory = new Map();

function rememberScroll() {
  for (const el of main.querySelectorAll('[data-scroll-key]')) {
    scrollMemory.set(el.dataset.scrollKey, [el.scrollLeft, el.scrollTop]);
  }
}
function restoreScroll() {
  for (const el of main.querySelectorAll('[data-scroll-key]')) {
    const saved = scrollMemory.get(el.dataset.scrollKey);
    if (saved) [el.scrollLeft, el.scrollTop] = saved;
    else el.dispatchEvent(new CustomEvent('firstshow'));
  }
}

function header(title, subtitle, actions, leadingColor) {
  return h('header', { class: 'topbar' },
    h('button', { class: 'btn ghost icon menu-btn', 'aria-label': 'Open menu', onclick: () => shell.classList.add('nav-open') }, icon('menu')),
    h('div', { class: 'title' },
      h('h1', { class: 'row' }, leadingColor ? h('span', { class: 'dot', style: { background: leadingColor } }) : null, h('span', { class: 'truncate' }, title)),
      subtitle ? h('div', { class: 'subtitle truncate' }, subtitle) : null),
    actions);
}

function tabs(items, active, hrefFor) {
  return h('nav', { class: 'tabs', 'aria-label': 'Views' },
    items.map(([key, label]) => h('a', { class: 'tab', href: hrefFor(key), 'aria-current': key === active ? 'page' : null }, label)));
}

function renderEmpty(view) {
  view.append(h('div', { class: 'empty' },
    h('h2', {}, 'Plan your first project'),
    h('p', {}, 'Track tasks and dependencies, see them on a Gantt chart or timeline, and copy either one straight into PowerPoint.'),
    h('div', { class: 'row wrap', style: { justifyContent: 'center' } },
      h('button', { class: 'btn primary', onclick: () => openProjectDialog() }, icon('plus'), 'New project'),
      h('button', { class: 'btn', onclick: loadSample }, 'Load sample projects'),
      h('button', { class: 'btn', onclick: openImportDialog }, icon('upload'), 'Import'))));
}

async function loadSample() {
  const result = await api('POST', '/api/sample');
  if (result) toast('Sample projects loaded. Delete them any time from each project\'s settings.');
}

function renderMain(route) {
  rememberScroll();
  const mode = currentMode();
  // Keyed so a redraw keeps the reader's place on this page.
  const view = h('div', { class: 'view', 'data-scroll-key': `view:${route.projectId ?? 'all'}:${route.tab}` });
  const project = route.projectId ? ctx.project(route.projectId) : null;

  if (route.projectId && !project) {
    main.replaceChildren(header('Project not found', null), view);
    view.append(h('div', { class: 'empty' }, h('p', {}, 'This project no longer exists.'), h('a', { class: 'btn', href: '#/' }, 'Back to all projects')));
    return;
  }

  if (project) {
    const s = project.summary;
    const subtitle = [fmtRange(s.start, s.end), `${s.progress}% complete`, project.owner ? `Owner: ${project.owner}` : null].filter(Boolean).join(' · ');
    main.replaceChildren(
      header(project.name, subtitle,
        h('button', { class: 'btn ghost icon', 'aria-label': 'Project settings', title: 'Project settings', onclick: () => openProjectDialog(project) }, icon('settings')),
        projectColor(project.color, mode)),
      tabs(PROJECT_TABS, route.tab, (k) => `#/p/${project.id}/${k}`),
      view,
    );
    if (route.tab === 'gantt') renderGanttView(view, project);
    else if (route.tab === 'timeline') renderTimelineView(view, project);
    else if (route.tab === 'links') renderLinks(view, project);
    else renderTasks(view, project);
  } else if (!ctx.data.projects.length) {
    main.replaceChildren(header('Project Tracker', null), view);
    renderEmpty(view);
  } else {
    main.replaceChildren(
      header('All projects', plural(ctx.data.projects.length, 'project')),
      tabs(PORTFOLIO_TABS, route.tab, (k) => `#/portfolio/${k}`),
      view,
    );
    if (route.tab === 'gantt') renderGanttView(view, null);
    else if (route.tab === 'timeline') renderTimelineView(view, null);
    else if (route.tab === 'links') renderLinks(view, null);
    else renderOverview(view);
  }
  restoreScroll();
}

// A save that lands between pressing and releasing the mouse would replace what's
// being clicked, and the click would be lost. So drawing waits for the release.
let pressed = false;
let drawWaiting = false;
addEventListener('pointerdown', () => {
  pressed = true;
}, true);
const released = () => {
  pressed = false;
  if (!drawWaiting) return;
  drawWaiting = false;
  setTimeout(() => ctx.render(), 0); // after the click that follows the release
};
addEventListener('pointerup', released, true);
addEventListener('pointercancel', released, true);
addEventListener('blur', (event) => {
  if (event.target === window) released(); // the release may happen in another window
});

let revealedTask = null;

ctx.render = () => {
  if (!ctx.data) return;
  if (pressed) {
    drawWaiting = true;
    return;
  }
  const route = parseRoute();
  ctx.route = route;
  hideTip();
  saveBanner.hidden = ctx.data.saving !== false;
  // Before drawing, because charts size themselves to the room they have.
  app.classList.toggle('has-drawer', !!(ctx.taskId && ctx.findTask(ctx.taskId)));
  const active = document.activeElement;
  const typing = active?.id && main.contains(active) && active.matches('input')
    ? { id: active.id, value: active.value, from: active.selectionStart, to: active.selectionEnd }
    : null;
  renderSidebar(route);
  renderMain(route);
  // When the selection changes, make sure it can be seen, as the panel narrows the chart.
  if (ctx.taskId !== revealedTask) {
    revealedTask = ctx.taskId;
    main.querySelector('[data-selected=ring]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  renderDrawer(drawerHost);
  if (typing) {
    const again = document.getElementById(typing.id);
    if (again) {
      again.value = typing.value;
      again.focus();
      if (typing.from !== null) again.setSelectionRange(typing.from, typing.to);
    }
  }
  if (ctx.focusAfter) {
    document.querySelector(ctx.focusAfter)?.focus();
    ctx.focusAfter = null;
  }
};

// Charts size themselves to the window.
let resizeTimer;
let lastWidth = innerWidth;
addEventListener('resize', () => {
  if (innerWidth === lastWidth) return; // mobile browsers fire this when toolbars hide
  lastWidth = innerWidth;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => ctx.render(), 120);
});

addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && ctx.taskId && !document.querySelector('dialog[open]')) {
    ctx.taskId = null;
    ctx.render();
  }
});

refresh()
  .then(listenForChanges)
  .catch(() => {
    app.replaceChildren(h('div', { class: 'boot-error' },
      h('h2', {}, 'Could not load your projects'),
      h('p', { class: 'muted' }, 'Check that the server is running, then reload this page.')));
  });
