// Charts are laid out once as a flat list of drawing primitives, then drawn by
// whichever renderer is needed: SVG on screen, PNG and SVG files, or native
// PowerPoint shapes. That keeps every format looking the same.
//
// Primitives (coordinates in px):
//   rect     { x, y, w, h, fill, stroke, strokeWidth, dash, r, tip, task, drag, name, skipPptx }
//   text     { x, y, s, size, weight, fill, anchor, italic, tip, task, name }   y is the vertical centre
//   line     { x1, y1, x2, y2, stroke, width, dash, skipPptx }
//   route    { points: [[x, y], ...], stroke, width, dash, arrow }
//   diamond  { cx, cy, r, fill, stroke, strokeWidth, tip, task, name }

export const PROJECT_COLORS = {
  blue: { light: '#2a78d6', dark: '#3987e5' },
  orange: { light: '#eb6834', dark: '#d95926' },
  aqua: { light: '#1baf7a', dark: '#199e70' },
  yellow: { light: '#eda100', dark: '#c98500' },
  magenta: { light: '#e87ba4', dark: '#d55181' },
  green: { light: '#008300', dark: '#008300' },
  violet: { light: '#6250d6', dark: '#9085e9' },
  red: { light: '#e34948', dark: '#e66767' },
};

export const PALETTES = {
  light: {
    mode: 'light',
    surface: '#ffffff',
    surface2: '#f4f4f1',
    weekend: '#f6f6f3',
    grid: '#e9e9e4',
    gridStrong: '#d8d8d1',
    ink: '#1c1c1a',
    ink2: '#55544f',
    ink3: '#7b7a73',
    summary: '#3d3d39',
    critical: '#c22f2e',
    link: '#8a897f',
    cross: '#1f66c4',
    baseline: '#b4b3aa',
    today: '#1c1c1a',
    track: '#eeeeea',
  },
  dark: {
    mode: 'dark',
    surface: '#1f1f1d',
    surface2: '#282826',
    weekend: '#242422',
    grid: '#2e2e2b',
    gridStrong: '#40403b',
    ink: '#f0efec',
    ink2: '#c3c2b7',
    ink3: '#96958c',
    summary: '#c3c2b7',
    critical: '#f08584',
    link: '#7d7c74',
    cross: '#6ea8f0',
    baseline: '#6b6a62',
    today: '#f0efec',
    track: '#33332f',
  },
};

export const projectColor = (name, mode = 'light') => (PROJECT_COLORS[name] ?? PROJECT_COLORS.blue)[mode];

export function currentMode() {
  const forced = document.documentElement.dataset.theme;
  if (forced) return forced;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

const hexToRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
export function mix(a, b, amount) {
  const [ra, ga, ba] = hexToRgb(a);
  const [rb, gb, bb] = hexToRgb(b);
  const c = (x, y) => Math.round(x + (y - x) * amount).toString(16).padStart(2, '0');
  return `#${c(ra, rb)}${c(ga, gb)}${c(ba, bb)}`;
}

// Picks readable text for a filled mark.
export function inkOn(fill) {
  const [r, g, b] = hexToRgb(fill).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 0.32 ? '#1c1c1a' : '#ffffff';
}

// ---- text measurement -------------------------------------------------------

export const SCREEN_FONT = '"Segoe UI Variable Text", "Segoe UI", -apple-system, BlinkMacSystemFont, "Helvetica Neue", Roboto, Arial, sans-serif';
// Exports use Arial so text fits the same way on any machine that opens them.
export const EXPORT_FONT = 'Arial, Helvetica, sans-serif';

const measureContext = document.createElement('canvas').getContext('2d');
export function makeText(font) {
  const width = (text, size, weight = 400) => {
    measureContext.font = `${weight} ${size}px ${font}`;
    return measureContext.measureText(text).width;
  };
  const truncate = (text, maxWidth, size, weight = 400) => {
    if (width(text, size, weight) <= maxWidth) return text;
    let low = 0;
    let high = text.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (width(`${text.slice(0, mid).trimEnd()}…`, size, weight) <= maxWidth) low = mid;
      else high = mid - 1;
    }
    return low ? `${text.slice(0, low).trimEnd()}…` : '';
  };
  return { font, width, truncate };
}

// ---- SVG renderer -----------------------------------------------------------

const SVG_NS = 'http://www.w3.org/2000/svg';

function el(name, attrs) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== undefined && value !== null && value !== false) node.setAttribute(key, value);
  }
  return node;
}

function drawPrimitive(p, font) {
  const shared = { 'data-task': p.task, 'data-tip': p.tip, 'data-drag': p.drag ? 'true' : undefined };
  switch (p.t) {
    case 'rect':
      return el('rect', {
        x: p.x, y: p.y, width: Math.max(0, p.w), height: Math.max(0, p.h), rx: p.r || undefined,
        fill: p.fill ?? 'none', stroke: p.stroke, 'stroke-width': p.strokeWidth, 'stroke-dasharray': p.dash, ...shared,
      });
    case 'text': {
      const node = el('text', {
        x: p.x, y: p.y, 'dominant-baseline': 'central', 'text-anchor': p.anchor ?? 'start',
        'font-family': font, 'font-size': p.size, 'font-weight': p.weight ?? 400, 'font-style': p.italic ? 'italic' : undefined,
        fill: p.fill, ...shared,
      });
      node.textContent = p.s;
      return node;
    }
    case 'line':
      return el('line', {
        x1: p.x1, y1: p.y1, x2: p.x2, y2: p.y2, stroke: p.stroke, 'stroke-width': p.width ?? 1, 'stroke-dasharray': p.dash,
      });
    case 'diamond': {
      const { cx, cy, r } = p;
      return el('polygon', {
        points: `${cx},${cy - r} ${cx + r},${cy} ${cx},${cy + r} ${cx - r},${cy}`,
        fill: p.fill, stroke: p.stroke, 'stroke-width': p.strokeWidth, ...shared,
      });
    }
    case 'route': {
      const group = el('g', {});
      group.append(el('polyline', {
        points: p.points.map((pt) => pt.join(',')).join(' '), fill: 'none', stroke: p.stroke,
        'stroke-width': p.width ?? 1.2, 'stroke-dasharray': p.dash, 'stroke-linejoin': 'round',
      }));
      if (p.arrow) {
        const [ax, ay] = p.points.at(-2);
        const [bx, by] = p.points.at(-1);
        const angle = Math.atan2(by - ay, bx - ax);
        const size = 5.5;
        const wing = (offset) => `${bx - size * Math.cos(angle + offset)},${by - size * Math.sin(angle + offset)}`;
        group.append(el('polygon', { points: `${bx},${by} ${wing(0.5)} ${wing(-0.5)}`, fill: p.stroke }));
      }
      return group;
    }
    default:
      return null;
  }
}

// Draws primitives into a standalone SVG cropped to `view` (defaults to everything).
export function renderSvg(prims, { width, height, font = SCREEN_FONT, view, background, label }) {
  const v = view ?? { x: 0, y: 0, w: width, h: height };
  const svg = el('svg', {
    xmlns: SVG_NS, width: v.w, height: v.h, viewBox: `${v.x} ${v.y} ${v.w} ${v.h}`, role: 'img', 'aria-label': label,
  });
  if (background) svg.append(el('rect', { x: v.x, y: v.y, width: v.w, height: v.h, fill: background }));
  for (const p of prims) {
    const node = drawPrimitive(p, font);
    if (node) svg.append(node);
  }
  return svg;
}

// ---- image export -----------------------------------------------------------

export function svgToString(svg) {
  const clone = svg.cloneNode(true);
  for (const node of clone.querySelectorAll('[data-tip],[data-task],[data-drag]')) {
    node.removeAttribute('data-tip');
    node.removeAttribute('data-task');
    node.removeAttribute('data-drag');
  }
  return new XMLSerializer().serializeToString(clone);
}

export function svgToPngBlob(svgString, width, height, scale = 2) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' }));
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not create the image.'))), 'image/png');
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not create the image.'));
    };
    image.src = url;
  });
}

// ---- PowerPoint renderer ----------------------------------------------------

const hex = (color) => color.replace('#', '').toUpperCase();

// Draws primitives as native, editable shapes. `s` is inches per px.
export function renderPptx(pptx, slide, prims, { originX, originY, s, fontFace = 'Arial' }) {
  const X = (v) => originX + v * s;
  const Y = (v) => originY + v * s;
  const L = (v) => v * s;
  const pt = (px) => Math.max(5, Math.round(px * s * 72 * 2) / 2);
  const lineOf = (color, width, dash) => (color
    ? { color: hex(color), width: Math.max(0.25, (width ?? 1) * s * 72), dashType: dash ? 'dash' : 'solid' }
    : undefined);

  const drawLine = (x1, y1, x2, y2, stroke, width, dash, arrow) => {
    slide.addShape(pptx.ShapeType.line, {
      x: X(Math.min(x1, x2)),
      y: Y(Math.min(y1, y2)),
      w: L(Math.abs(x2 - x1)),
      h: L(Math.abs(y2 - y1)),
      flipH: x2 < x1,
      flipV: y2 < y1,
      line: { ...lineOf(stroke, width, dash), ...(arrow ? { endArrowType: 'triangle' } : {}) },
    });
  };

  for (const p of prims) {
    if (p.skipPptx) continue;
    switch (p.t) {
      case 'rect': {
        if (p.w <= 0 || p.h <= 0) break;
        const rounded = p.r && p.r > 0;
        slide.addShape(rounded ? pptx.ShapeType.roundRect : pptx.ShapeType.rect, {
          x: X(p.x), y: Y(p.y), w: L(p.w), h: L(p.h),
          ...(rounded ? { rectRadius: L(Math.min(p.r, p.h / 2, p.w / 2)) } : {}),
          ...(p.fill ? { fill: { color: hex(p.fill) } } : { fill: { color: 'FFFFFF', transparency: 100 } }),
          line: lineOf(p.stroke, p.strokeWidth, p.dash) ?? { type: 'none' },
          ...(p.name ? { objectName: p.name } : {}),
        });
        break;
      }
      case 'text': {
        const size = pt(p.size);
        const anchor = p.anchor ?? 'start';
        // Boxes are generous and don't wrap, so a font swap can't reflow the chart.
        const boxW = Math.max(L(p.w ?? 0), (p.s.length * p.size * 0.62 + 12) * s);
        const boxH = L(p.size * 1.6);
        const left = anchor === 'middle' ? X(p.x) - boxW / 2 : anchor === 'end' ? X(p.x) - boxW : X(p.x);
        slide.addText(p.s, {
          x: left, y: Y(p.y) - boxH / 2, w: boxW, h: boxH,
          fontFace, fontSize: size, color: hex(p.fill), bold: (p.weight ?? 400) >= 600, italic: !!p.italic,
          align: anchor === 'middle' ? 'center' : anchor === 'end' ? 'right' : 'left',
          valign: 'middle', margin: 0, wrap: false, fit: 'none',
          ...(p.name ? { objectName: p.name } : {}),
        });
        break;
      }
      case 'line':
        drawLine(p.x1, p.y1, p.x2, p.y2, p.stroke, p.width, p.dash, false);
        break;
      case 'route':
        p.points.slice(1).forEach((point, i) => {
          const last = i === p.points.length - 2;
          drawLine(p.points[i][0], p.points[i][1], point[0], point[1], p.stroke, p.width ?? 1.2, p.dash, last && p.arrow);
        });
        break;
      case 'diamond':
        slide.addShape(pptx.ShapeType.diamond, {
          x: X(p.cx - p.r), y: Y(p.cy - p.r), w: L(p.r * 2), h: L(p.r * 2),
          fill: { color: hex(p.fill) },
          line: lineOf(p.stroke, p.strokeWidth) ?? { type: 'none' },
          ...(p.name ? { objectName: p.name } : {}),
        });
        break;
      default:
    }
  }
}
