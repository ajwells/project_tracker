// Gantt layout: turns rows and links into drawing primitives split by region, so
// the screen can pin the header and labels while exports draw them all at once.

import { fmtDate, fromN, plural, toN, ymd } from '../util.js';
import { mix } from './core.js';
import { axisBands, unitForScale, ZOOMS } from './scale.js';

const ROW = 30;
const HEAD = 46;
const INDENT = 14;

/**
 * rows: { key, task, label, wbs, depth, kind: task|summary|milestone|project|external,
 *         start, end, progress, color, poc, critical, baseline, external, tip, drag, collapsible }
 * links: { from, to, type, cross, critical }   // from/to are row keys
 */
export function layoutGantt({
  rows, links, pal, text, width, zoom = 'fit', labelWidth = 300, showPoc = true, showWbs = true,
  showCritical = true, showBaseline = false, today, title, subtitle, legend = false, range, selectedTask = null,
}) {
  const dated = rows.filter((r) => r.start);
  let minN = Math.min(...dated.flatMap((r) => [toN(r.start), r.baseline ? toN(r.baseline.start) : Infinity]));
  let maxN = Math.max(...dated.flatMap((r) => [toN(r.end), r.baseline ? toN(r.baseline.end) : -Infinity]));
  if (!dated.length) {
    minN = toN(today);
    maxN = minN + 30;
  }
  if (range) {
    minN = Math.min(minN, toN(range.start));
    maxN = Math.max(maxN, toN(range.end));
  }
  const todayN = toN(today);
  const span = maxN - minN + 1;
  const pad = Math.max(2, Math.round(span * 0.03));
  const startN = minN - pad;
  const roughPpd = zoom === 'fit' ? Math.max(0.3, (width - labelWidth) / (span + pad * 2)) : ZOOMS[zoom].ppd;
  const endN = maxN + pad + Math.ceil(64 / roughPpd);
  const days = endN - startN + 1;

  const fitPpd = Math.max(0.3, (width - labelWidth) / days);
  const ppd = zoom === 'fit' ? Math.min(fitPpd, 40) : ZOOMS[zoom].ppd;
  const chartW = zoom === 'fit' ? Math.max(width - labelWidth, days * ppd) : Math.max(days * ppd, width - labelWidth);
  const totalW = labelWidth + chartW;
  const X = (n) => labelWidth + (n - startN) * ppd;
  const unit = unitForScale(ppd);

  const titleH = title ? (subtitle ? 58 : 40) : 0;
  const top = titleH;
  const rowsTop = top + HEAD;
  const bodyRows = rows.length;
  const rowsBottom = rowsTop + bodyRows * ROW;
  const legendH = legend ? 32 : 0;
  const totalH = rowsBottom + legendH;

  const regions = { top: [], corner: [], head: [], labels: [], body: [], foot: [] };
  const rowIndex = new Map(rows.map((r, i) => [r.key, i]));
  const rowY = (i) => rowsTop + i * ROW;

  // ---- title ----
  if (title) {
    regions.top.push({ t: 'text', x: 0, y: 16, s: title, size: 20, weight: 700, fill: pal.ink, name: 'Chart title' });
    if (subtitle) regions.top.push({ t: 'text', x: 0, y: 40, s: subtitle, size: 13, fill: pal.ink3, name: 'Chart subtitle' });
  }

  // ---- header ----
  regions.corner.push({ t: 'rect', x: 0, y: top, w: labelWidth, h: HEAD, fill: pal.surface2, name: 'Header background' });
  regions.corner.push({ t: 'text', x: 10, y: top + HEAD - 14, s: 'Task', size: 12, weight: 600, fill: pal.ink2 });
  if (showPoc) regions.corner.push({ t: 'text', x: labelWidth - 10, y: top + HEAD - 14, s: 'POC', size: 12, weight: 600, fill: pal.ink2, anchor: 'end' });
  regions.head.push({ t: 'rect', x: labelWidth, y: top, w: chartW, h: HEAD, fill: pal.surface2, name: 'Timescale background' });

  const { top: topBand, bottom: bottomBand } = axisBands(startN, endN, unit);
  for (const cell of topBand) {
    const x = X(cell.from);
    const w = (cell.to - cell.from) * ppd;
    if (cell.from !== startN) regions.head.push({ t: 'line', x1: x, y1: top, x2: x, y2: top + HEAD, stroke: pal.gridStrong });
    const label = text.truncate(cell.label, w - 8, 12, 600);
    if (label) regions.head.push({ t: 'text', x: x + 6, y: top + 13, s: label, size: 12, weight: 600, fill: pal.ink });
  }
  for (const cell of bottomBand) {
    const x = X(cell.from);
    const w = (cell.to - cell.from) * ppd;
    regions.body.push({ t: 'line', x1: x, y1: rowsTop, x2: x, y2: rowsBottom, stroke: pal.grid, skipPptx: unit === 'day' });
    if (w >= text.width(cell.label, 11) + 2) {
      regions.head.push({ t: 'text', x: x + w / 2, y: top + 33, s: cell.label, size: 11, fill: pal.ink2, anchor: 'middle' });
    }
  }
  regions.head.push({ t: 'line', x1: labelWidth, y1: top + HEAD, x2: totalW, y2: top + HEAD, stroke: pal.gridStrong });
  regions.corner.push({ t: 'line', x1: 0, y1: top + HEAD, x2: labelWidth, y2: top + HEAD, stroke: pal.gridStrong });

  // ---- weekend shading ----
  if (unit === 'day' || unit === 'week') {
    for (let n = startN; n <= endN; n++) {
      const { dow } = ymd(n);
      if (dow === 6 && n + 1 <= endN) {
        regions.body.unshift({ t: 'rect', x: X(n), y: rowsTop, w: 2 * ppd, h: rowsBottom - rowsTop, fill: pal.weekend, skipPptx: true });
      } else if (dow === 0 && n === startN) {
        regions.body.unshift({ t: 'rect', x: X(n), y: rowsTop, w: ppd, h: rowsBottom - rowsTop, fill: pal.weekend, skipPptx: true });
      }
    }
  }

  // ---- labels and row lines ----
  regions.labels.unshift({ t: 'rect', x: 0, y: rowsTop, w: labelWidth, h: rowsBottom - rowsTop, fill: pal.surface, name: 'Label background' });
  for (let i = 0; i <= bodyRows; i++) {
    const y = rowY(i);
    regions.body.push({ t: 'line', x1: labelWidth, y1: y, x2: totalW, y2: y, stroke: pal.grid, skipPptx: i === 0 });
    regions.labels.push({ t: 'line', x1: 0, y1: y, x2: labelWidth, y2: y, stroke: pal.grid, skipPptx: i === 0 });
  }
  regions.labels.push({ t: 'line', x1: labelWidth - 0.5, y1: rowsTop, x2: labelWidth - 0.5, y2: rowsBottom, stroke: pal.gridStrong });
  regions.corner.push({ t: 'line', x1: labelWidth - 0.5, y1: top, x2: labelWidth - 0.5, y2: top + HEAD, stroke: pal.gridStrong });

  // Tinted rows for projects, so the portfolio view reads as groups.
  rows.forEach((row, i) => {
    if (row.kind === 'project') {
      regions.body.unshift({ t: 'rect', x: labelWidth, y: rowY(i), w: chartW, h: ROW, fill: pal.surface2, skipPptx: false, name: 'Group row' });
    }
  });

  const pocW = showPoc ? Math.min(100, labelWidth * 0.3) : 0;
  rows.forEach((row, i) => {
    const y = rowY(i);
    const cy = y + ROW / 2;
    if (selectedTask && row.task === selectedTask) {
      regions.labels.push({ t: 'rect', x: 0, y, w: labelWidth, h: ROW, fill: pal.selectedBand, selected: 'band' });
      regions.body.push({ t: 'rect', x: labelWidth, y, w: totalW - labelWidth, h: ROW, fill: pal.selectedBand, selected: 'band' });
    }
    if (row.kind === 'project') regions.labels.push({ t: 'rect', x: 0, y, w: labelWidth, h: ROW, fill: pal.surface2 });
    const heavy = row.kind === 'summary' || row.kind === 'project';
    let x = 10 + row.depth * INDENT;
    if (row.collapsible) {
      const open = !row.collapsed;
      regions.labels.push({ t: 'text', x, y: cy, s: open ? '▾' : '▸', size: 11, fill: pal.ink3, task: `toggle:${row.key}`, skipPptx: !!row.exporting });
      x += 13;
    }
    if (row.kind === 'project') {
      regions.labels.push({ t: 'rect', x, y: cy - 5, w: 10, h: 10, r: 3, fill: row.color });
      x += 15;
    }
    if (showWbs && row.wbs) {
      regions.labels.push({ t: 'text', x, y: cy, s: row.wbs, size: 11, fill: pal.ink3 });
      x += Math.max(14, text.width(row.wbs, 11)) + 6;
    }
    const nameMax = labelWidth - x - (showPoc ? pocW + 12 : 8);
    regions.labels.push({
      t: 'text', x, y: cy, s: text.truncate(row.label, nameMax, 12.5, heavy ? 600 : 400), size: 12.5,
      weight: heavy ? 600 : 400, fill: row.external ? pal.ink2 : pal.ink, italic: !!row.external, tip: row.tip,
      task: row.task, w: nameMax, name: row.label,
    });
    if (showPoc && row.poc) {
      regions.labels.push({ t: 'text', x: labelWidth - 10, y: cy, s: text.truncate(row.poc, pocW, 11.5), size: 11.5, fill: pal.ink2, anchor: 'end' });
    }
  });

  // ---- baseline ----
  if (showBaseline) {
    rows.forEach((row, i) => {
      if (!row.baseline) return;
      const x = X(toN(row.baseline.start));
      const w = Math.max(3, (toN(row.baseline.end) - toN(row.baseline.start) + 1) * ppd);
      regions.body.push({ t: 'rect', x, y: rowY(i) + ROW - 7, w, h: 3, r: 1, fill: pal.baseline, tip: `Baseline: ${fmtDate(row.baseline.start)} – ${fmtDate(row.baseline.end)}`, name: `Baseline: ${row.label}` });
    });
  }

  // ---- bars ----
  const geometry = new Map();
  const rings = []; // drawn last, so the arrows don't cross them
  rows.forEach((row, i) => {
    if (!row.start) return;
    const y = rowY(i);
    const x = X(toN(row.start));
    const w = Math.max(3, (toN(row.end) - toN(row.start) + 1) * ppd);
    const barY = y + (showBaseline ? 5 : 7);
    const barH = showBaseline ? 14 : 16;
    const isCritical = showCritical && row.critical;
    const base = { tip: row.tip, task: row.task };
    const isSelected = selectedTask && row.task === selectedTask;
    if (isSelected && row.kind !== 'milestone') {
      rings.push({ t: 'rect', x: x - 3, y: barY - 3, w: w + 6, h: barH + 6, r: 6, stroke: pal.selected, strokeWidth: 2, ...base, selected: 'ring' });
    }

    if (row.kind === 'milestone') {
      const cx = X(toN(row.end)) + ppd / 2;
      const cy = barY + barH / 2;
      if (isSelected) rings.push({ t: 'diamond', cx, cy, r: 11, fill: 'none', stroke: pal.selected, strokeWidth: 2, ...base, selected: 'ring' });
      geometry.set(row.key, { left: cx - 7, right: cx + 7, cy });
      regions.body.push({
        t: 'diamond', cx, cy, r: 7, fill: row.progress >= 100 ? pal.ink2 : row.color,
        stroke: isCritical ? pal.critical : pal.surface, strokeWidth: isCritical ? 2 : 1, ...base, name: `Milestone: ${row.label}`,
      });
      const room = totalW - (cx + 19);
      const label = text.truncate(fmtDate(row.end), room, 11);
      if (label) regions.body.push({ t: 'text', x: cx + 19, y: cy, s: label, size: 11, fill: pal.ink2 });
      return;
    }
    geometry.set(row.key, { left: x, right: x + w, cy: barY + barH / 2 });
    if (row.kind === 'summary') {
      regions.body.push({ t: 'rect', x, y: barY + 3, w, h: 9, r: 2, fill: pal.summary, ...base, name: `Summary: ${row.label}` });
      return;
    }
    if (row.kind === 'project') {
      regions.body.push({ t: 'rect', x, y: barY, w, h: barH, r: 4, fill: mix(row.color, pal.surface, 0.68), ...base, name: `Project: ${row.label}` });
      if (row.progress > 0) regions.body.push({ t: 'rect', x, y: barY, w: Math.max(4, w * row.progress / 100), h: barH, r: 4, fill: row.color, ...base, name: `Progress: ${row.label}` });
      return;
    }
    if (row.kind === 'external') {
      regions.body.push({ t: 'rect', x, y: barY, w, h: barH, r: 4, fill: mix(row.color, pal.surface, 0.86), stroke: row.color, strokeWidth: 1.2, dash: '4 3', ...base, name: `External: ${row.label}` });
      return;
    }
    regions.body.push({
      t: 'rect', x, y: barY, w, h: barH, r: 4, fill: mix(row.color, pal.surface, 0.68),
      stroke: isCritical ? pal.critical : undefined, strokeWidth: isCritical ? 1.5 : undefined,
      ...base, drag: row.drag, name: row.label,
    });
    if (row.progress > 0) {
      regions.body.push({
        t: 'rect', x, y: barY, w: Math.max(4, w * row.progress / 100), h: barH, r: 4,
        fill: row.color, stroke: isCritical ? pal.critical : undefined, strokeWidth: isCritical ? 1.5 : undefined,
        ...base, drag: row.drag, name: `Progress: ${row.label}`,
      });
    }
  });

  // ---- dependency arrows ----
  const routes = [];
  for (const link of links) {
    const a = geometry.get(link.from);
    const b = geometry.get(link.to);
    if (!a || !b) continue;
    const fromRight = link.type === 'FS' || link.type === 'FF';
    const toLeft = link.type === 'FS' || link.type === 'SS';
    const x1 = fromRight ? a.right : a.left;
    const x2 = toLeft ? b.left : b.right;
    const y1 = a.cy;
    const y2 = b.cy;
    const out = fromRight ? 7 : -7;
    const inn = toLeft ? -7 : 7;
    const exitX = x1 + out;
    const enterX = x2 + inn;
    let points;
    if (rowIndex.get(link.from) === rowIndex.get(link.to)) continue;
    const clear = toLeft ? exitX <= x2 - 3 : exitX >= x2 + 3;
    if (clear && fromRight === toLeft) {
      points = [[x1, y1], [exitX, y1], [exitX, y2], [x2, y2]];
    } else if (fromRight !== toLeft) {
      // Same-side exits (FF, SS) wrap around on the outer side of both bars.
      const edge = fromRight ? Math.max(x1, x2) + 8 : Math.min(x1, x2) - 8;
      points = [[x1, y1], [edge, y1], [edge, y2], [x2, y2]];
    } else {
      const down = y2 > y1 ? 1 : -1;
      const midY = rowY(rowIndex.get(link.to)) + (down > 0 ? 0 : ROW);
      points = [[x1, y1], [exitX, y1], [exitX, midY], [enterX, midY], [enterX, y2], [x2, y2]];
    }
    const isCritical = showCritical && link.critical;
    routes.push({
      t: 'route', points, arrow: true, width: isCritical ? 1.5 : 1.1,
      stroke: isCritical ? pal.critical : link.cross ? pal.cross : pal.link,
      dash: link.cross ? '4 3' : undefined,
    });
  }
  regions.body.push(...routes, ...rings);

  // ---- today ----
  if (todayN >= startN && todayN <= endN) {
    const x = X(todayN) + ppd / 2;
    regions.body.push({ t: 'line', x1: x, y1: rowsTop, x2: x, y2: rowsBottom, stroke: pal.today, width: 1.2, dash: '3 3' });
    regions.head.push({ t: 'rect', x: x - 20, y: top + HEAD - 15, w: 40, h: 14, r: 3, fill: pal.today });
    regions.head.push({ t: 'text', x, y: top + HEAD - 8, s: 'Today', size: 10, weight: 600, fill: pal.surface, anchor: 'middle' });
  }

  // ---- legend (exports only; the screen uses an HTML legend) ----
  if (legend) {
    const y = rowsBottom + 18;
    let x = 0;
    const sample = rows.find((r) => r.kind === 'task' || r.kind === 'project')?.color ?? pal.ink2;
    const addText = (s) => {
      regions.foot.push({ t: 'text', x, y, s, size: 11, fill: pal.ink2 });
      x += text.width(s, 11) + 18;
    };
    regions.foot.push({ t: 'rect', x, y: y - 4, w: 11, h: 8, r: 2, fill: sample });
    regions.foot.push({ t: 'rect', x: x + 11, y: y - 4, w: 11, h: 8, r: 2, fill: mix(sample, pal.surface, 0.68) });
    x += 27;
    addText('Done / remaining');
    if (showCritical) {
      regions.foot.push({ t: 'rect', x, y: y - 4, w: 18, h: 8, r: 2, fill: pal.surface, stroke: pal.critical, strokeWidth: 1.5 });
      x += 23;
      addText('Critical path');
    }
    regions.foot.push({ t: 'diamond', cx: x + 5, cy: y, r: 5, fill: sample });
    x += 15;
    addText('Milestone');
    if (links.some((l) => l.cross)) {
      regions.foot.push({ t: 'line', x1: x, y1: y, x2: x + 18, y2: y, stroke: pal.cross, width: 1.2, dash: '4 3' });
      x += 23;
      addText('Cross-project link');
    }
    if (showBaseline) {
      regions.foot.push({ t: 'rect', x, y: y - 1.5, w: 18, h: 3, r: 1, fill: pal.baseline });
      x += 23;
      addText('Baseline');
    }
    regions.foot.push({ t: 'line', x1: x + 4, y1: y - 7, x2: x + 4, y2: y + 7, stroke: pal.today, width: 1.2, dash: '3 3' });
    x += 13;
    addText('Today');
  }

  return {
    width: totalW,
    height: totalH,
    regions,
    geometry: { labelWidth, top, head: HEAD, rowsTop, rowH: ROW, ppd, startN, totalW, totalH, rowsBottom },
    xToDate: (px) => fromN(Math.floor(startN + (px - labelWidth) / ppd)),
  };
}

export const allPrimitives = (layout) => {
  const { top, body, labels, corner, head, foot } = layout.regions;
  return [...top, ...body, ...labels, ...head, ...corner, ...foot];
};

// ---- row builders -----------------------------------------------------------

function tipFor(task, projectName) {
  const c = task.computed;
  const when = c.start === c.end ? fmtDate(c.start, true) : `${fmtDate(c.start)} – ${fmtDate(c.end, true)}`;
  const lines = [task.name];
  if (projectName) lines.push(projectName);
  lines.push(`${when}${task.milestone ? '' : ` · ${plural(c.duration, 'day')}`}`);
  lines.push(`${c.progress}% complete${task.pocName ? ` · POC: ${task.pocName}` : ''}`);
  if (c.critical) lines.push('On the critical path');
  else if (c.float > 0 && c.status !== 'complete') lines.push(`${plural(c.float, 'day')} of float`);
  return lines.join('\n');
}

const rowKind = (task) => (task.computed.isSummary ? 'summary' : task.milestone ? 'milestone' : 'task');

function taskRow(task, project, colorFn, extra = {}) {
  const c = task.computed;
  return {
    key: task.id,
    task: task.id,
    label: task.name,
    wbs: c.wbs,
    depth: c.depth,
    kind: rowKind(task),
    start: c.start,
    end: c.end,
    progress: c.progress,
    color: colorFn(project.color),
    poc: task.pocName,
    critical: c.critical,
    baseline: project.baseline?.tasks?.[task.id],
    drag: !c.isSummary && !task.milestone && c.status !== 'complete',
    tip: tipFor(task),
    ...extra,
  };
}

// Tasks in outline order, skipping anything under a collapsed summary.
export function orderedTasks(project, collapsed = new Set()) {
  const childrenOf = new Map();
  for (const task of project.tasks) {
    const key = task.parentId || '';
    if (!childrenOf.has(key)) childrenOf.set(key, []);
    childrenOf.get(key).push(task);
  }
  const out = [];
  const walk = (key) => {
    for (const task of childrenOf.get(key) ?? []) {
      out.push(task);
      if (!collapsed.has(task.id)) walk(task.id);
    }
  };
  walk('');
  return out;
}

export function projectRows(project, state, colorFn, collapsed = new Set()) {
  const visible = orderedTasks(project, collapsed);
  const shown = new Set(visible.map((t) => t.id));
  const rows = visible.map((task) => taskRow(task, project, colorFn, {
    collapsible: task.computed.isSummary,
    collapsed: collapsed.has(task.id),
  }));

  const taskIndex = new Map();
  const projectOf = new Map();
  for (const p of state.projects) {
    for (const t of p.tasks) {
      taskIndex.set(t.id, t);
      projectOf.set(t.id, p);
    }
  }

  const links = [];
  const externals = new Map();
  const addExternal = (task, direction) => {
    if (externals.has(task.id)) return;
    const owner = projectOf.get(task.id);
    externals.set(task.id, {
      ...taskRow(task, owner, colorFn),
      kind: 'external',
      external: true,
      wbs: '',
      depth: 0,
      drag: false,
      baseline: null,
      label: `${owner.name} › ${task.name}`,
      tip: `${direction}\n${tipFor(task, owner.name)}`,
    });
  };

  for (const task of project.tasks) {
    if (!shown.has(task.id)) continue;
    for (const dep of task.deps) {
      const pred = taskIndex.get(dep.taskId);
      if (!pred) continue;
      const cross = projectOf.get(pred.id).id !== project.id;
      if (cross) addExternal(pred, 'This project depends on it');
      if (cross || shown.has(pred.id)) {
        links.push({ from: pred.id, to: task.id, type: dep.type, cross, critical: pred.computed.critical && task.computed.critical });
      }
    }
  }
  for (const other of state.projects) {
    if (other.id === project.id) continue;
    for (const task of other.tasks) {
      for (const dep of task.deps) {
        if (!shown.has(dep.taskId)) continue;
        addExternal(task, 'Depends on this project');
        links.push({ from: dep.taskId, to: task.id, type: dep.type, cross: true, critical: false });
      }
    }
  }
  return { rows: [...rows, ...externals.values()], links };
}

// One group per project: the rollup bar, then anything worth seeing at this level.
export function portfolioRows(state, colorFn, { detail = 'key', collapsed = new Set() } = {}) {
  const rows = [];
  const links = [];
  const crossIds = new Set(state.crossLinks.flatMap((l) => [l.fromTaskId, l.toTaskId]));
  const shown = new Set();
  for (const project of state.projects) {
    const s = project.summary;
    const isCollapsed = collapsed.has(project.id);
    rows.push({
      key: `project:${project.id}`,
      task: `project:${project.id}`,
      label: project.name,
      depth: 0,
      kind: 'project',
      start: s.start,
      end: s.end,
      progress: s.progress,
      color: colorFn(project.color),
      poc: project.owner,
      collapsible: true,
      collapsed: isCollapsed,
      tip: `${project.name}\n${s.start ? `${fmtDate(s.start)} – ${fmtDate(s.end, true)}` : 'No dates yet'}\n${s.progress}% complete · ${plural(s.taskCount, 'task')}`,
    });
    if (isCollapsed) continue;
    for (const task of orderedTasks(project)) {
      const keep = detail === 'all'
        ? true
        : !task.computed.isSummary && (task.milestone || crossIds.has(task.id) || task.onTimeline);
      if (!keep) continue;
      shown.add(task.id);
      rows.push(taskRow(task, project, colorFn, { wbs: '', depth: 1, drag: false, baseline: null, tip: tipFor(task, project.name) }));
    }
  }
  for (const project of state.projects) {
    for (const task of project.tasks) {
      if (!shown.has(task.id)) continue;
      for (const dep of task.deps) {
        if (!shown.has(dep.taskId)) continue;
        const cross = !project.tasks.some((t) => t.id === dep.taskId);
        if (detail === 'all' || cross) links.push({ from: dep.taskId, to: task.id, type: dep.type, cross, critical: false });
      }
    }
  }
  return { rows, links };
}
