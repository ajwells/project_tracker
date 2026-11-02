// Small shared helpers. All text goes through DOM text nodes, never innerHTML,
// because task and project names can come from imported files.

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'class') el.className = value;
    else if (key === 'style' && typeof value === 'object') {
      for (const [prop, v] of Object.entries(value)) {
        if (prop.startsWith('--')) el.style.setProperty(prop, v);
        else el.style[prop] = v;
      }
    }
    else if (key === 'value' || key === 'checked' || key === 'disabled' || key === 'selected') el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONS = {
  menu: 'M4 6h16M4 12h16M4 18h16',
  plus: 'M12 5v14M5 12h14',
  x: 'M6 6l12 12M18 6L6 18',
  chevron: 'M9 6l6 6-6 6',
  settings: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4',
  grid: 'M4 5h16v14H4zM4 10h16M10 10v9',
  up: 'M12 19V5M6 11l6-6 6 6',
  down: 'M12 5v14M6 13l6 6 6-6',
  left: 'M19 12H5M11 6l-6 6 6 6',
  right: 'M5 12h14M13 6l6 6-6 6',
  alert: 'M12 4L2.5 20h19zM12 10v5M12 18v.01',
  download: 'M12 4v11M7 11l5 5 5-5M5 20h14',
  upload: 'M12 16V5M7 9l5-5 5 5M5 20h14',
  image: 'M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4',
  sun: 'M12 8a4 4 0 100 8 4 4 0 000-8zM12 2v2M12 20v2M4 12H2M22 12h-2M5.6 5.6L7 7M17 17l1.4 1.4M18.4 5.6L17 7M7 17l-1.4 1.4',
  user: 'M12 12a4 4 0 100-8 4 4 0 000 8zM5 20c1-4 4-6 7-6s6 2 7 6',
  trash: 'M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13',
  sample: 'M12 3v3M5 7l2 2M19 7l-2 2M8 14a4 4 0 118 0c0 2-2 3-2 5h-4c0-2-2-3-2-5z',
};

export function icon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'icon-svg');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', ICONS[name]);
  svg.append(path);
  return svg;
}

// ---- dates ------------------------------------------------------------------

const DAY_MS = 86400000;
export const toN = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / DAY_MS;
};
export const fromN = (n) => new Date(n * DAY_MS).toISOString().slice(0, 10);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const monthName = (m) => MONTHS[m];
export function ymd(n) {
  const d = new Date(n * DAY_MS);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), dow: d.getUTCDay() };
}
export const firstOfMonthN = (y, m) => Date.UTC(y, m, 1) / DAY_MS;

export function fmtDate(iso, withYear = false) {
  if (!iso) return '—';
  const { y, m, d } = ymd(toN(iso));
  return withYear ? `${MONTHS[m]} ${d}, ${y}` : `${MONTHS[m]} ${d}`;
}

export function fmtRange(start, end) {
  if (!start) return 'No dates yet';
  if (start === end) return fmtDate(start, true);
  const sameYear = start.slice(0, 4) === end.slice(0, 4);
  return `${fmtDate(start, !sameYear)} – ${fmtDate(end, true)}`;
}

export function fmtWhen(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

// ---- labels -----------------------------------------------------------------

export const STATUS = {
  not_started: { label: 'Not started', mark: '○', cls: '' },
  in_progress: { label: 'In progress', mark: '◐', cls: 'info' },
  blocked: { label: 'Blocked', mark: '■', cls: 'warn' },
  complete: { label: 'Complete', mark: '✓', cls: 'good' },
};
export const HEALTH = {
  late: { label: 'Late', mark: '!', cls: 'bad' },
  at_risk: { label: 'At risk', mark: '▲', cls: 'warn' },
  on_track: { label: 'On track', mark: '●', cls: 'good' },
  complete: { label: 'Complete', mark: '✓', cls: 'good' },
};
export const DEP_TYPES = {
  FS: 'Finish → Start',
  SS: 'Start → Start',
  FF: 'Finish → Finish',
  SF: 'Start → Finish',
};
export const depSuffix = (dep) => `${dep.type}${dep.lag ? (dep.lag > 0 ? `+${dep.lag}d` : `${dep.lag}d`) : ''}`;

export const statusPill = (status) => h('span', { class: `pill ${STATUS[status].cls}` }, STATUS[status].mark, ' ', STATUS[status].label);
export const healthPill = (health) => h('span', { class: `pill ${HEALTH[health].cls}` }, HEALTH[health].mark, ' ', HEALTH[health].label);

// ---- feedback ---------------------------------------------------------------

export function toast(message, kind = '') {
  const el = h('div', { class: `toast ${kind}` }, message);
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 6000 : 3200);
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export const safeFilename = (name) => name.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'chart';

// Opens a modal built from a <form>; resolves when it closes.
export function openDialog({ title, body, footer, wide = false, onClose }) {
  const close = () => dialog.close();
  const form = h('div', { class: 'dialog-form' },
    h('div', { class: 'dialog-head' },
      h('h2', {}, title),
      h('button', { class: 'btn ghost icon', type: 'button', 'aria-label': 'Close', onclick: close }, icon('x'))),
    h('div', { class: 'dialog-body' }, body),
    footer ? h('div', { class: 'dialog-foot' }, footer) : null);
  const dialog = h('dialog', { class: wide ? 'wide' : '' }, form);
  dialog.addEventListener('close', () => {
    dialog.remove();
    onClose?.();
  });
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) close();
  });
  document.body.append(dialog);
  dialog.showModal();
  return { dialog, close };
}

export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    let answer = false;
    const { close } = openDialog({
      title,
      body: h('p', {}, message),
      footer: [
        h('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Cancel'),
        h('button', {
          class: `btn ${danger ? 'danger' : 'primary'}`,
          type: 'button',
          onclick: () => {
            answer = true;
            close();
          },
        }, confirmLabel),
      ],
      onClose: () => resolve(answer),
    });
  });
}

// ---- hover tooltip for chart marks ------------------------------------------

export function showTip(text, x, y) {
  const tip = document.getElementById('tooltip');
  tip.textContent = text;
  tip.hidden = false;
  const box = tip.getBoundingClientRect();
  tip.style.left = `${Math.max(8, Math.min(x + 14, innerWidth - box.width - 8))}px`;
  tip.style.top = `${y + 18 + box.height > innerHeight ? y - box.height - 12 : y + 18}px`;
}
export const hideTip = () => {
  document.getElementById('tooltip').hidden = true;
};

export function attachTips(root) {
  root.addEventListener('pointermove', (event) => {
    if (event.pointerType === 'touch') return;
    const target = event.target.closest?.('[data-tip]');
    if (target) showTip(target.getAttribute('data-tip'), event.clientX, event.clientY);
    else hideTip();
  });
  root.addEventListener('pointerleave', hideTip);
}
