// On-screen Gantt and timeline views. The header and label column stay pinned
// while the chart scrolls, by drawing each region as its own SVG.

import { api, ctx } from '../ctx.js';
import { fmtDate, fmtRange, fromN, h, hideTip, icon, plural, showTip, toN } from '../util.js';
import { currentMode, makeText, PALETTES, projectColor, renderSvg, SCREEN_FONT, mix } from '../chart/core.js';
import { layoutGantt, portfolioRows, projectRows } from '../chart/gantt.js';
import { layoutTimeline, portfolioGroups, projectGroups } from '../chart/timeline.js';
import { openExportDialog } from '../export.js';
import { heldEdit, previewEdit, proposeEdit } from '../held-edit.js';

const seg = (options, value, onChange, label) => h('div', { class: 'seg', role: 'group', 'aria-label': label },
  options.map(([key, text]) => h('button', {
    type: 'button',
    'aria-pressed': String(value === key),
    onclick: () => onChange(key),
  }, text)));

const checkbox = (label, checked, onChange) => h('label', { class: 'check', style: { alignItems: 'center' } },
  h('input', { type: 'checkbox', checked, style: { marginTop: 0 }, onchange: (event) => onChange(event.target.checked) }), label);

function subtitleFor(project) {
  const s = project ? project.summary : portfolioSpan();
  const parts = [fmtRange(s.start, s.end)];
  if (project) parts.push(`${s.progress}% complete`);
  parts.push(`As of ${fmtDate(ctx.data.today, true)}`);
  return parts.join('  ·  ');
}

function portfolioSpan() {
  const dated = ctx.data.projects.filter((p) => p.summary.start);
  return {
    start: dated.map((p) => p.summary.start).sort()[0] ?? null,
    end: dated.map((p) => p.summary.end).sort().at(-1) ?? null,
  };
}

function ganttLegend(pal, color, showCritical, showBaseline, hasCross) {
  return h('div', { class: 'legend' },
    h('span', {}, h('i', { style: { background: `linear-gradient(90deg, ${color} 50%, ${mix(color, pal.surface, 0.68)} 50%)` } }), 'Done / remaining'),
    showCritical ? h('span', {}, h('i', { style: { border: `1.5px solid ${pal.critical}` } }), 'Critical path') : null,
    h('span', {}, h('i', { class: 'ms', style: { background: color } }), 'Milestone'),
    hasCross ? h('span', {}, h('i', { style: { height: 0, borderTop: `1.5px dashed ${pal.cross}`, borderRadius: 0 } }), 'Cross-project link') : null,
    showBaseline ? h('span', {}, h('i', { style: { height: '3px', background: pal.baseline } }), 'Baseline') : null,
    h('span', {}, h('i', { style: { width: 0, height: '12px', borderLeft: `1.5px dashed ${pal.today}`, borderRadius: 0 } }), 'Today'));
}

// ---- Gantt ------------------------------------------------------------------

export function renderGanttView(view, project) {
  view.classList.add('fill');
  const mode = currentMode();
  const pal = PALETTES[mode];
  const options = ctx.gantt;
  const mobile = ctx.isMobile();
  const zoom = options.zoom ?? (mobile ? 'week' : 'fit');
  const colorFn = (name) => projectColor(name, mode);
  const hasBaseline = !!project?.baseline;
  const showBaseline = hasBaseline && options.baseline;
  const showCritical = options.critical && !!project;

  const build = (fn, collapsed) => (project
    ? projectRows(project, ctx.data, fn, collapsed)
    : portfolioRows(ctx.data, fn, { detail: options.detail, collapsed }));
  const { rows, links } = build(colorFn, ctx.collapsed);
  const held = heldEdit();

  const toolbar = h('div', { class: 'toolbar' },
    seg([['fit', 'Fit'], ['day', 'Day'], ['week', 'Week'], ['month', 'Month'], ['quarter', 'Quarter']], zoom, (z) => {
      options.zoom = z;
      ctx.render();
    }, 'Zoom'),
    project ? checkbox('Critical path', options.critical, (v) => {
      options.critical = v;
      ctx.render();
    }) : seg([['key', 'Key items'], ['all', 'All tasks']], options.detail, (d) => {
      options.detail = d;
      ctx.render();
    }, 'Detail'),
    hasBaseline ? checkbox('Baseline', options.baseline, (v) => {
      options.baseline = v;
      ctx.render();
    }) : null,
    h('span', { class: 'spacer' }),
    project ? h('button', {
      class: 'btn',
      title: hasBaseline ? 'Replace the saved baseline with the current schedule' : 'Save the current schedule to compare against later',
      onclick: async () => {
        const done = await api('POST', `/api/projects/${project.id}/baseline`);
        if (done) {
          options.baseline = true;
          ctx.render();
        }
      },
    }, hasBaseline ? 'Update baseline' : 'Set baseline') : null,
    h('button', {
      class: 'btn primary',
      'data-action': 'export',
      disabled: !rows.length,
      onclick: () => openExportDialog({
        kind: 'gantt',
        title: project ? project.name : 'Portfolio plan',
        subtitle: subtitleFor(project),
        today: ctx.data.today,
        showCritical,
        showBaseline,
        multi: !project,
        build: (fn) => build(fn, ctx.collapsed),
      }),
    }, icon('image'), 'Copy for PowerPoint'));

  if (!rows.length) {
    view.append(toolbar, h('div', { class: 'empty' }, h('h2', {}, 'Nothing to chart yet'), h('p', {}, 'Add tasks to see them on the Gantt chart.')));
    return;
  }

  const scroller = h('div', { class: 'chart-scroll', 'data-scroll-key': `gantt:${project?.id ?? 'all'}:${zoom}` });
  const legendColor = project ? colorFn(project.color) : colorFn('blue');
  view.append(toolbar, ganttLegend(pal, legendColor, showCritical, showBaseline, links.some((l) => l.cross)), scroller);

  const layout = layoutGantt({
    rows,
    links,
    pal,
    text: makeText(SCREEN_FONT),
    width: scroller.clientWidth || 800,
    zoom,
    labelWidth: mobile ? 160 : 340,
    showPoc: !mobile,
    showWbs: !mobile,
    showCritical,
    showBaseline,
    today: ctx.data.today,
    selectedTask: ctx.taskId, // on screen only: exports draw their own charts
    range: heldRange(held),
  });
  mountGantt(scroller, layout, pal, rows, held);
  scroller.addEventListener('firstshow', () => {
    if (zoom === 'fit') return;
    const { startN, ppd } = layout.geometry;
    scroller.scrollLeft = Math.max(0, (toN(ctx.data.today) - startN) * ppd - 60);
  });
}

// Room on the chart for everywhere a waiting change would put its tasks.
function heldRange(held) {
  if (!held) return undefined;
  const moves = [held.preview.self, ...held.preview.moved];
  return { start: moves.map((m) => m.start).sort()[0], end: moves.map((m) => m.end).sort().at(-1) };
}

// Dashed outlines of where tasks would go. These sit on top of the chart's drawing rather
// than in it, so they can never reach an export.
function drawGhosts(body, moves, g, rows, pal) {
  const NS = 'http://www.w3.org/2000/svg';
  const layer = document.createElementNS(NS, 'g');
  layer.setAttribute('pointer-events', 'none');
  for (const move of moves) {
    const index = rows.findIndex((r) => r.key === move.id);
    if (index < 0) continue;
    const cy = g.rowsTop + index * g.rowH + g.rowH / 2;
    const left = g.labelWidth + (toN(move.start) - g.startN) * g.ppd;
    const width = Math.max(3, (toN(move.end) - toN(move.start) + 1) * g.ppd);
    let shape;
    if (move.milestone) {
      const cx = left + g.ppd / 2;
      shape = document.createElementNS(NS, 'polygon');
      shape.setAttribute('points', `${cx},${cy - 8} ${cx + 8},${cy} ${cx},${cy + 8} ${cx - 8},${cy}`);
    } else {
      shape = document.createElementNS(NS, 'rect');
      shape.setAttribute('x', left);
      shape.setAttribute('y', cy - 8);
      shape.setAttribute('width', width);
      shape.setAttribute('height', 16);
      shape.setAttribute('rx', 4);
    }
    shape.setAttribute('fill', pal.selected);
    shape.setAttribute('fill-opacity', 0.14);
    shape.setAttribute('stroke', pal.selected);
    shape.setAttribute('stroke-width', 1.5);
    shape.setAttribute('stroke-dasharray', '4 3');
    shape.setAttribute('data-ghost', move.id);
    layer.append(shape);
  }
  body.append(layer);
  return layer;
}

function mountGantt(scroller, layout, pal, rows, held) {
  const { regions, geometry: g, width, height } = layout;
  const chartW = width - g.labelWidth;
  const bodyH = g.rowsBottom - g.rowsTop;
  const pane = (prims, viewBox, cls) => {
    const svg = renderSvg(prims, { width, height, view: viewBox, background: pal.surface, label: cls === 'pane-body' ? 'Gantt chart' : undefined });
    svg.setAttribute('class', cls);
    return svg;
  };
  const corner = pane(regions.corner, { x: 0, y: g.top, w: g.labelWidth, h: g.head }, 'pane-corner');
  const head = pane(regions.head, { x: g.labelWidth, y: g.top, w: chartW, h: g.head }, 'pane-head');
  const labels = pane(regions.labels, { x: 0, y: g.rowsTop, w: g.labelWidth, h: bodyH }, 'pane-labels');
  const body = pane(regions.body, { x: g.labelWidth, y: g.rowsTop, w: chartW, h: bodyH }, 'pane-body');
  const grid = h('div', { class: 'gantt-grid', style: { gridTemplateColumns: `${g.labelWidth}px ${chartW}px` } }, corner, head, labels, body);
  scroller.append(grid);
  const heldGhosts = held ? drawGhosts(body, [held.preview.self, ...held.preview.moved], g, rows, pal) : null;

  let dragged = false;
  grid.addEventListener('click', (event) => {
    if (dragged) {
      dragged = false;
      return;
    }
    const key = event.target.closest?.('[data-task]')?.getAttribute('data-task');
    if (!key) return;
    if (key.startsWith('toggle:')) {
      const raw = key.slice(7);
      const id = raw.startsWith('project:') ? raw.slice(8) : raw;
      if (ctx.collapsed.has(id)) ctx.collapsed.delete(id);
      else ctx.collapsed.add(id);
      ctx.render();
    } else if (key.startsWith('project:')) {
      ctx.go(`#/p/${key.slice(8)}/gantt`);
    } else {
      ctx.openTask(key);
    }
  });

  // Drag a bar to move it, or its right edge to change the finish. Mouse only:
  // on touch screens a swipe has to scroll the chart.
  const EDGE = 8;
  const pointX = (event) => event.clientX - body.getBoundingClientRect().left + g.labelWidth;
  const barInfo = (target) => {
    const found = ctx.findTask(target.getAttribute('data-task'));
    if (!found) return null;
    const { computed: c } = found.task;
    const left = g.labelWidth + (toN(c.start) - g.startN) * g.ppd;
    const right = g.labelWidth + (toN(c.end) + 1 - g.startN) * g.ppd;
    return { task: found.task, left, right };
  };

  body.addEventListener('pointermove', (event) => {
    if (event.pointerType !== 'mouse' || event.buttons) return;
    const target = event.target.closest?.('[data-drag=true]');
    if (!target) return;
    const info = barInfo(target);
    if (info) target.style.cursor = info.right - pointX(event) <= EDGE ? 'ew-resize' : 'grab';
  });

  body.addEventListener('pointerdown', (event) => {
    if (event.pointerType !== 'mouse' || event.button !== 0) return;
    const target = event.target.closest?.('[data-drag=true]');
    if (!target) return;
    const info = barInfo(target);
    if (!info) return;
    event.preventDefault();
    const startX = pointX(event);
    const resize = info.right - startX <= EDGE;
    const barBox = target.getBBox();
    const ghost = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    ghost.setAttribute('y', barBox.y);
    ghost.setAttribute('height', barBox.height);
    ghost.setAttribute('rx', 4);
    ghost.setAttribute('fill', 'none');
    ghost.setAttribute('stroke', pal.ink);
    ghost.setAttribute('stroke-width', 1.5);
    ghost.setAttribute('stroke-dasharray', '4 3');
    ghost.setAttribute('pointer-events', 'none');
    let delta = 0;
    let moved = false;
    const c = info.task.computed;
    // Moving a task tracked by dates moves both of them.
    const fieldsFor = (days) => {
      if (resize) return { end: fromN(toN(c.end) + days) };
      const fields = { start: fromN(toN(c.start) + days) };
      if (info.task.trackBy === 'dates') fields.end = fromN(toN(c.end) + days);
      return fields;
    };
    let previewedDelta = 0;
    let knockOn = '';
    let liveGhosts = null;
    const showKnockOn = () => {
      if (delta === previewedDelta) return;
      previewedDelta = delta;
      liveGhosts?.remove();
      liveGhosts = null;
      const preview = delta ? previewEdit(info.task.id, fieldsFor(delta)) : null;
      const others = preview?.moved ?? [];
      const conflicts = (preview?.conflicts ?? []).filter((x) => x.id !== info.task.id).length;
      if (others.length) liveGhosts = drawGhosts(body, others, g, rows, pal);
      const lines = [];
      if (others.length) lines.push(`Moves ${plural(others.length, 'other task')}`);
      if (conflicts) lines.push(`Causes ${plural(conflicts, 'conflict')}`);
      knockOn = lines.length ? `\n${lines.join('\n')}` : '';
    };

    const update = (moveEvent) => {
      const dx = pointX(moveEvent) - startX;
      if (!moved && Math.abs(dx) < 4) return;
      if (!moved) {
        moved = true;
        body.append(ghost);
        document.body.style.cursor = resize ? 'ew-resize' : 'grabbing';
      }
      delta = Math.round(dx / g.ppd);
      if (resize) {
        const minDelta = toN(c.start) - toN(c.end);
        delta = Math.max(delta, minDelta);
      }
      showKnockOn();
      heldGhosts?.remove();
      const shift = delta * g.ppd;
      ghost.setAttribute('x', resize ? info.left : info.left + shift);
      ghost.setAttribute('width', resize ? info.right + shift - info.left : info.right - info.left);
      const label = resize
        ? `Finish: ${fmtDate(fromN(toN(c.end) + delta), true)}`
        : `Start: ${fmtDate(fromN(toN(c.start) + delta), true)}`;
      showTip(`${label}${knockOn}`, moveEvent.clientX, moveEvent.clientY);
    };
    const finish = async () => {
      removeEventListener('pointermove', update);
      removeEventListener('pointerup', finish);
      removeEventListener('pointercancel', cancel);
      removeEventListener('keydown', escape, true);
      document.body.style.cursor = '';
      ghost.remove();
      liveGhosts?.remove();
      hideTip();
      // Puts back the outlines of a change still waiting, which the drag took off.
      if ((!moved || !delta) && heldGhosts && !heldGhosts.isConnected) body.append(heldGhosts);
      if (!moved) return;
      dragged = true;
      setTimeout(() => {
        dragged = false;
      }, 0);
      if (!delta) return;
      const fields = fieldsFor(delta);
      if (proposeEdit(info.task.id, fields)) ctx.openTask(info.task.id);
      else await api('PATCH', `/api/tasks/${info.task.id}`, fields);
    };
    const cancel = () => {
      moved = false;
      finish();
    };
    // Esc abandons the drag. The release that follows mustn't count as a click on the bar.
    const escape = (keyEvent) => {
      if (keyEvent.key !== 'Escape') return;
      keyEvent.stopPropagation();
      if (moved) {
        dragged = true;
        addEventListener('pointerup', () => setTimeout(() => {
          dragged = false;
        }, 0), { once: true });
      }
      cancel();
    };
    addEventListener('pointermove', update);
    addEventListener('pointerup', finish);
    addEventListener('pointercancel', cancel);
    addEventListener('keydown', escape, true);
  });
}

// ---- Timeline ---------------------------------------------------------------

export function renderTimelineView(view, project) {
  const mode = currentMode();
  const pal = PALETTES[mode];
  const colorFn = (name) => projectColor(name, mode);
  const scope = ctx.timelineScope;
  const build = (fn) => (project ? projectGroups(project, scope, fn) : portfolioGroups(ctx.data, scope, fn));
  const groups = build(colorFn);
  const hasItems = groups.some((g) => g.items.length);

  const toolbar = h('div', { class: 'toolbar', style: { marginBottom: '10px' } },
    seg([['key', 'Key items'], ['all', 'All tasks']], scope, (s) => {
      ctx.timelineScope = s;
      ctx.render();
    }, 'Timeline scope'),
    h('span', { class: 'small muted', style: { flexBasis: ctx.isMobile() ? '100%' : 'auto' } }, 'Key items are milestones, top-level phases and tasks marked "Show on timeline".'),
    h('span', { class: 'spacer' }),
    h('button', {
      class: 'btn primary',
      'data-action': 'export',
      disabled: !hasItems,
      onclick: () => openExportDialog({
        kind: 'timeline',
        title: project ? `${project.name} timeline` : 'Portfolio timeline',
        subtitle: subtitleFor(project),
        today: ctx.data.today,
        multi: !project,
        build,
      }),
    }, icon('image'), 'Copy for PowerPoint'));

  if (!hasItems) {
    view.append(toolbar, h('div', { class: 'empty' }, h('h2', {}, 'Nothing to show yet'), h('p', {}, 'Add tasks or milestones to build the timeline.')));
    return;
  }

  const card = h('div', { class: 'card chart-card', 'data-scroll-key': `timeline:${project?.id ?? 'all'}`, style: { overflowX: 'auto' } });
  view.append(toolbar, card);
  const width = Math.max(card.clientWidth - 10, 760);
  const layout = layoutTimeline({
    groups, pal, text: makeText(SCREEN_FONT), width, today: ctx.data.today, legend: !project, selectedTask: ctx.taskId,
  });
  const svg = renderSvg(layout.primitives, { width: layout.width, height: layout.height, background: pal.surface, label: 'Timeline' });
  svg.style.maxWidth = 'none';
  card.append(svg);
  card.addEventListener('click', (event) => {
    const id = event.target.closest?.('[data-task]')?.getAttribute('data-task');
    if (id) ctx.openTask(id);
  });
}
