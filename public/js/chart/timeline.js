// Timeline layout: a presentation-style view. A date band runs across the middle,
// milestones stand above it, and phases and key tasks hang below in tidy lanes.

import { firstOfMonthN, fmtDate, monthName, toN, ymd } from '../util.js';
import { inkOn } from './core.js';

const BAND_H = 30;
const BAR_H = 26;
const LANE_GAP = 6;
const STEM_LEVEL = 40;

/**
 * groups: [{ label, color, items: [{ key, task, label, start, end, milestone, color, tip }] }]
 */
export function layoutTimeline({ groups, pal, text, width, today, title, subtitle, legend }) {
  const margin = 20;
  const items = groups.flatMap((g) => g.items);
  const todayN = toN(today);
  let minN = Math.min(...items.map((i) => toN(i.start)));
  let maxN = Math.max(...items.map((i) => toN(i.end)));
  if (!items.length) {
    minN = todayN;
    maxN = todayN + 60;
  }
  // Snap to whole months so the band starts and ends cleanly.
  const s = ymd(minN);
  const e = ymd(maxN);
  const startN = firstOfMonthN(s.y, s.m);
  const endN = firstOfMonthN(e.y, e.m + 1) - 1;
  const days = endN - startN + 1;
  const usable = width - margin * 2;
  const X = (n) => margin + ((n - startN) / days) * usable;
  const multi = groups.length > 1;

  const prims = { top: [], above: [], band: [], below: [], foot: [] };
  const titleH = title ? (subtitle ? 62 : 44) : 8;
  if (title) {
    prims.top.push({ t: 'text', x: margin, y: 18, s: title, size: 20, weight: 700, fill: pal.ink, name: 'Chart title' });
    if (subtitle) prims.top.push({ t: 'text', x: margin, y: 42, s: subtitle, size: 13, fill: pal.ink3, name: 'Chart subtitle' });
  }

  // ---- place milestone labels above the band, staggering to avoid overlap ----
  const milestones = items
    .filter((i) => i.milestone)
    .sort((a, b) => toN(a.end) - toN(b.end));
  const levels = [];
  const placed = milestones.map((m) => {
    const cx = X(toN(m.end) + 0.5);
    const dateLabel = fmtDate(m.end);
    const name = text.truncate(m.label, 170, 12.5, 600);
    const w = Math.max(text.width(name, 12.5, 600), text.width(dateLabel, 11)) + 10;
    let left = cx - w / 2;
    left = Math.max(margin, Math.min(left, width - margin - w));
    let level = levels.findIndex((end) => left >= end + 8);
    if (level === -1) {
      level = levels.length;
      levels.push(0);
    }
    levels[level] = left + w;
    return { m, cx, name, dateLabel, left, w, level };
  });
  const aboveH = placed.length ? 18 + levels.length * STEM_LEVEL : 8;
  const bandY = titleH + aboveH;
  const bandCy = bandY + BAND_H / 2;

  for (const p of placed) {
    const labelCy = bandY - 18 - p.level * STEM_LEVEL - 16;
    const anchorX = Math.max(p.left + p.w / 2, Math.min(p.cx, p.left + p.w / 2));
    prims.above.push({ t: 'line', x1: p.cx, y1: labelCy + 16, x2: p.cx, y2: bandY, stroke: pal.gridStrong, width: 1 });
    prims.above.push({ t: 'text', x: anchorX, y: labelCy - 7, s: p.name, size: 12.5, weight: 600, fill: pal.ink, anchor: 'middle', tip: p.m.tip, task: p.m.task, name: p.m.label });
    prims.above.push({ t: 'text', x: anchorX, y: labelCy + 8, s: p.dateLabel, size: 11, fill: pal.ink2, anchor: 'middle', tip: p.m.tip, task: p.m.task });
  }

  // ---- the date band ----
  prims.band.push({ t: 'rect', x: margin, y: bandY, w: usable, h: BAND_H, r: 6, fill: pal.summary, name: 'Date band' });
  const bandInk = inkOn(pal.summary);
  const monthCells = [];
  for (let c = { y: s.y, m: s.m }; firstOfMonthN(c.y, c.m) <= endN; c = c.m === 11 ? { y: c.y + 1, m: 0 } : { y: c.y, m: c.m + 1 }) {
    monthCells.push({ ...c, from: firstOfMonthN(c.y, c.m), to: firstOfMonthN(c.y, c.m + 1) });
  }
  const monthW = usable / Math.max(1, monthCells.length);
  const showAll = monthW >= 44;
  monthCells.forEach((cell) => {
    const x = X(cell.from);
    const w = X(cell.to) - x;
    if (cell.from !== startN) {
      prims.band.push({ t: 'line', x1: x, y1: bandY + 6, x2: x, y2: bandY + BAND_H - 6, stroke: bandInk, width: 0.6 });
    }
    const isQuarterStart = cell.m % 3 === 0;
    if (showAll || (monthW >= 15 && isQuarterStart) || (cell.m === 0)) {
      const withYear = cell.m === 0 || cell.from === startN;
      const label = withYear && monthW >= 44 ? `${monthName(cell.m)} '${String(cell.y).slice(2)}` : showAll ? monthName(cell.m) : `${monthName(cell.m)} '${String(cell.y).slice(2)}`;
      const room = showAll ? w : w * 3;
      if (text.width(label, 11.5, 600) < room - 4) {
        prims.band.push({ t: 'text', x: showAll ? x + w / 2 : x + 4, y: bandCy, s: label, size: 11.5, weight: 600, fill: bandInk, anchor: showAll ? 'middle' : 'start' });
      }
    }
  });
  for (const p of placed) {
    prims.band.push({ t: 'diamond', cx: p.cx, cy: bandY, r: 7.5, fill: p.m.color, stroke: pal.surface, strokeWidth: 1.5, tip: p.m.tip, task: p.m.task, name: `Milestone: ${p.m.label}` });
  }

  // ---- bars below the band, packed into lanes ----
  let y = bandY + BAND_H + 14;
  const barsTop = y;
  groups.forEach((group) => {
    const bars = group.items
      .filter((i) => !i.milestone)
      .sort((a, b) => toN(a.start) - toN(b.start) || toN(a.end) - toN(b.end));
    if (multi) {
      prims.below.push({ t: 'rect', x: margin, y: y + 3, w: 10, h: 10, r: 3, fill: group.color });
      prims.below.push({ t: 'text', x: margin + 15, y: y + 8, s: group.label, size: 12.5, weight: 600, fill: pal.ink, name: group.label });
      y += 20;
    }
    if (!bars.length && multi) {
      prims.below.push({ t: 'text', x: margin + 15, y: y + 6, s: group.items.length ? 'Milestones shown above' : 'Nothing to show', size: 11.5, fill: pal.ink3 });
      y += 18;
    }
    const lanes = [];
    for (const bar of bars) {
      const x = X(toN(bar.start));
      const w = Math.max(6, X(toN(bar.end) + 1) - x);
      const dates = bar.start === bar.end ? fmtDate(bar.start) : `${fmtDate(bar.start)} – ${fmtDate(bar.end)}`;
      const full = `${bar.label} · ${dates}`;
      const inside = text.width(full, 12, 500) + 16 <= w ? full : text.width(bar.label, 12, 500) + 16 <= w ? bar.label : null;
      let outside = null;
      let reach = x + w;
      if (!inside) {
        const room = width - margin - (x + w) - 6;
        const wanted = text.truncate(full, Math.max(0, Math.min(room, 300)), 12);
        if (wanted && wanted !== '…') {
          outside = wanted;
          reach = x + w + 6 + text.width(outside, 12);
        } else {
          // No room on the right; put the label on the left of the bar.
          const roomLeft = x - margin - 6;
          const left = text.truncate(full, Math.max(0, Math.min(roomLeft, 300)), 12);
          if (left && left !== '…') bar.leftLabel = left;
        }
      }
      const leftEdge = bar.leftLabel ? x - 6 - text.width(bar.leftLabel, 12) : x;
      let lane = lanes.findIndex((end) => leftEdge >= end + 8);
      if (lane === -1) {
        lane = lanes.length;
        lanes.push(0);
      }
      lanes[lane] = reach;
      const barY = y + lane * (BAR_H + LANE_GAP);
      prims.below.push({ t: 'rect', x, y: barY, w, h: BAR_H, r: 5, fill: bar.color, tip: bar.tip, task: bar.task, name: bar.label });
      if (bar.progress > 0 && bar.progress < 100) {
        prims.below.push({ t: 'rect', x: x + 4, y: barY + BAR_H - 6, w: Math.max(2, (w - 8) * bar.progress / 100), h: 3, r: 1.5, fill: inkOn(bar.color), tip: bar.tip, task: bar.task, name: `Progress: ${bar.label}` });
      }
      if (inside) {
        prims.below.push({ t: 'text', x: x + 8, y: barY + BAR_H / 2 - 2, s: inside, size: 12, weight: 500, fill: inkOn(bar.color), tip: bar.tip, task: bar.task, w: w - 10 });
      } else if (outside) {
        prims.below.push({ t: 'text', x: x + w + 6, y: barY + BAR_H / 2, s: outside, size: 12, fill: pal.ink, tip: bar.tip, task: bar.task });
      } else if (bar.leftLabel) {
        prims.below.push({ t: 'text', x: x - 6, y: barY + BAR_H / 2, s: bar.leftLabel, size: 12, fill: pal.ink, anchor: 'end', tip: bar.tip, task: bar.task });
      }
    }
    y += lanes.length * (BAR_H + LANE_GAP);
    if (multi) y += 8;
  });
  const bottom = Math.max(y, barsTop) + 6;

  // ---- today ----
  if (todayN >= startN && todayN <= endN) {
    const x = X(todayN + 0.5);
    prims.foot.push({ t: 'line', x1: x, y1: bandY - 6, x2: x, y2: bottom, stroke: pal.today, width: 1.2, dash: '3 3' });
    prims.foot.push({ t: 'rect', x: x - 20, y: bottom - 2, w: 40, h: 15, r: 3, fill: pal.today, name: 'Today marker' });
    prims.foot.push({ t: 'text', x, y: bottom + 5.5, s: 'Today', size: 10, weight: 600, fill: pal.surface, anchor: 'middle' });
  }

  let height = bottom + 20;

  if (legend && multi) {
    let x = margin;
    const ly = height + 6;
    for (const group of groups) {
      prims.foot.push({ t: 'rect', x, y: ly - 5, w: 10, h: 10, r: 3, fill: group.color });
      const label = group.label;
      prims.foot.push({ t: 'text', x: x + 14, y: ly, s: label, size: 11, fill: pal.ink2 });
      x += 14 + text.width(label, 11) + 18;
    }
    height += 20;
  }

  return {
    width,
    height,
    primitives: [...prims.top, ...prims.above, ...prims.below, ...prims.foot, ...prims.band],
    count: items.length,
  };
}

// ---- item selection ---------------------------------------------------------

function itemFrom(task, color, projectName) {
  const c = task.computed;
  const range = c.start === c.end ? fmtDate(c.start, true) : `${fmtDate(c.start)} – ${fmtDate(c.end, true)}`;
  return {
    key: task.id,
    task: task.id,
    label: task.name,
    start: c.start,
    end: c.end,
    milestone: !!task.milestone,
    color,
    progress: c.progress,
    tip: [task.name, projectName, range, `${c.progress}% complete${task.pocName ? ` · POC: ${task.pocName}` : ''}`].filter(Boolean).join('\n'),
  };
}

// "key" shows milestones, top-level phases and tasks flagged for the timeline.
export function selectTasks(project, scope) {
  if (scope === 'all') return project.tasks.filter((t) => !t.computed.isSummary);
  const flagged = project.tasks.filter(
    (t) => t.milestone || t.onTimeline || (t.computed.isSummary && t.computed.depth === 0),
  );
  return flagged.length ? flagged : project.tasks;
}

export function projectGroups(project, scope, colorFn) {
  const color = colorFn(project.color);
  return [{ label: project.name, color, items: selectTasks(project, scope).map((t) => itemFrom(t, color)) }];
}

export function portfolioGroups(state, scope, colorFn) {
  return state.projects
    .filter((p) => p.tasks.length)
    .map((project) => {
      const color = colorFn(project.color);
      return { label: project.name, color, items: selectTasks(project, scope).map((t) => itemFrom(t, color, project.name)) };
    });
}
