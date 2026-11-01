// Time-axis calculations shared by the Gantt chart and the timeline.

import { firstOfMonthN, monthName, ymd } from '../util.js';

export const ZOOMS = {
  day: { label: 'Day', ppd: 26 },
  week: { label: 'Week', ppd: 9 },
  month: { label: 'Month', ppd: 3.2 },
  quarter: { label: 'Quarter', ppd: 1.1 },
};

export const unitForScale = (ppd) => (ppd >= 16 ? 'day' : ppd >= 4.5 ? 'week' : ppd >= 1.5 ? 'month' : 'quarter');

function nextMonth(y, m, step = 1) {
  const total = y * 12 + m + step;
  return { y: Math.floor(total / 12), m: total % 12 };
}

// Top band: months or years. Bottom band: days, weeks, months or quarters.
export function axisBands(startN, endN, unit) {
  const top = [];
  const bottom = [];
  const s = ymd(startN);

  if (unit === 'day' || unit === 'week') {
    for (let { y, m } = s; firstOfMonthN(y, m) <= endN; { y, m } = nextMonth(y, m)) {
      const next = nextMonth(y, m);
      top.push({
        from: Math.max(startN, firstOfMonthN(y, m)),
        to: Math.min(endN + 1, firstOfMonthN(next.y, next.m)),
        label: `${monthName(m)} ${y}`,
      });
    }
  } else {
    for (let y = s.y; firstOfMonthN(y, 0) <= endN; y++) {
      top.push({ from: Math.max(startN, firstOfMonthN(y, 0)), to: Math.min(endN + 1, firstOfMonthN(y + 1, 0)), label: String(y) });
    }
  }

  if (unit === 'day') {
    for (let n = startN; n <= endN; n++) bottom.push({ from: n, to: n + 1, label: String(ymd(n).d) });
  } else if (unit === 'week') {
    const dow = ymd(startN).dow;
    let n = startN - ((dow + 6) % 7);
    for (; n <= endN; n += 7) {
      bottom.push({ from: Math.max(n, startN), to: Math.min(n + 7, endN + 1), label: String(ymd(n).d), major: true });
    }
  } else if (unit === 'month') {
    for (let { y, m } = s; firstOfMonthN(y, m) <= endN; { y, m } = nextMonth(y, m)) {
      const next = nextMonth(y, m);
      bottom.push({ from: Math.max(startN, firstOfMonthN(y, m)), to: Math.min(endN + 1, firstOfMonthN(next.y, next.m)), label: monthName(m) });
    }
  } else {
    let { y, m } = { y: s.y, m: s.m - (s.m % 3) };
    for (; firstOfMonthN(y, m) <= endN; { y, m } = nextMonth(y, m, 3)) {
      const next = nextMonth(y, m, 3);
      bottom.push({ from: Math.max(startN, firstOfMonthN(y, m)), to: Math.min(endN + 1, firstOfMonthN(next.y, next.m)), label: `Q${m / 3 + 1}` });
    }
  }
  return { top, bottom };
}
