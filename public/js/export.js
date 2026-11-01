// The "Copy for PowerPoint" dialog. Three ways into a deck: paste a sharp image,
// download an SVG, or download a .pptx made of native shapes that stay editable.
// Exports always use the light palette so they look right on a white slide.

import { downloadBlob, h, icon, openDialog, safeFilename, toast } from './util.js';
import { EXPORT_FONT, makeText, PALETTES, projectColor, renderPptx, renderSvg, svgToPngBlob, svgToString } from './chart/core.js';
import { allPrimitives, layoutGantt } from './chart/gantt.js';
import { layoutTimeline } from './chart/timeline.js';

const pal = PALETTES.light;
const exportColor = (name) => projectColor(name, 'light');
const text = makeText(EXPORT_FONT);

// Wide enough that fonts land at a readable size when the chart fills a 16:9 slide.
const EXPORT_WIDTH = 1280;
const SLIDE_W = 13.333;
const SLIDE_H = 7.5;
const ROWS_PER_SLIDE = 19;

function ganttLayout(spec, options, rows = spec.build(exportColor).rows, links = spec.build(exportColor).links, range = undefined) {
  return layoutGantt({
    rows: rows.map((r) => ({ ...r, exporting: true, collapsible: false })),
    links,
    pal,
    text,
    width: EXPORT_WIDTH,
    zoom: 'fit',
    labelWidth: 340,
    showPoc: options.poc,
    showWbs: true,
    showCritical: spec.showCritical,
    showBaseline: spec.showBaseline,
    today: spec.today,
    title: options.title ? spec.title : null,
    subtitle: options.title ? spec.subtitle : null,
    legend: options.legend,
    range,
  });
}

function buildImage(spec, options) {
  // A little padding keeps the image from touching the slide's other content.
  const draw = (prims, width, height, pad) => {
    const view = { x: -pad, y: -pad, w: width + pad * 2, h: height + pad * 2 };
    return { svg: renderSvg(prims, { width, height, view, font: EXPORT_FONT, background: pal.surface }), width: view.w, height: view.h };
  };
  if (spec.kind === 'gantt') {
    const layout = ganttLayout(spec, options);
    return draw(allPrimitives(layout), layout.width, layout.height, 14);
  }
  const layout = layoutTimeline({
    groups: spec.build(exportColor),
    pal,
    text,
    width: EXPORT_WIDTH,
    today: spec.today,
    title: options.title ? spec.title : null,
    subtitle: options.title ? spec.subtitle : null,
    legend: options.legend,
  });
  return draw(layout.primitives, layout.width, layout.height, 0);
}

async function buildPptx(spec, options) {
  const PptxGenJS = window.PptxGenJS;
  if (!PptxGenJS) throw new Error('The PowerPoint library did not load. Reload the page and try again.');
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.title = spec.title;

  const margin = 0.4;
  const place = (prims, width, height, slide, topOffset) => {
    const room = { w: SLIDE_W - margin * 2, h: SLIDE_H - topOffset - margin };
    const s = Math.min(room.w / width, room.h / height);
    renderPptx(pptx, slide, prims, {
      originX: margin + (room.w - width * s) / 2,
      originY: topOffset,
      s,
      fontFace: 'Arial',
    });
  };

  // The heading is a real text box on the slide, so it can be edited or moved.
  const addHeading = (slide, page, pages) => {
    if (!options.title) return margin;
    const suffix = pages > 1 ? ` (${page} of ${pages})` : '';
    slide.addText(`${spec.title}${suffix}`, { x: margin, y: 0.25, w: SLIDE_W - margin * 2, h: 0.5, fontFace: 'Arial', fontSize: 24, bold: true, color: '1C1C1A', margin: 0 });
    if (spec.subtitle) slide.addText(spec.subtitle, { x: margin, y: 0.72, w: SLIDE_W - margin * 2, h: 0.3, fontFace: 'Arial', fontSize: 12, color: '7B7A73', margin: 0 });
    return 1.1;
  };
  const noTitle = { ...options, title: false };

  if (spec.kind === 'gantt') {
    const { rows, links } = spec.build(exportColor);
    // Long plans continue across slides, with one shared time scale per slide.
    const chunks = [];
    for (let i = 0; i < rows.length; i += ROWS_PER_SLIDE) chunks.push(rows.slice(i, i + ROWS_PER_SLIDE));
    if (!chunks.length) chunks.push([]);
    chunks.forEach((chunk, index) => {
      const keys = new Set(chunk.map((r) => r.key));
      const visibleLinks = links.filter((l) => keys.has(l.from) && keys.has(l.to));
      const layout = ganttLayout(spec, noTitle, chunk, visibleLinks, fullRange(rows));
      const slide = pptx.addSlide();
      const top = addHeading(slide, index + 1, chunks.length);
      place(allPrimitives(layout), layout.width, layout.height, slide, top);
    });
  } else {
    const layout = layoutTimeline({ groups: spec.build(exportColor), pal, text, width: EXPORT_WIDTH, today: spec.today, legend: options.legend });
    const slide = pptx.addSlide();
    const top = addHeading(slide, 1, 1);
    place(layout.primitives, layout.width, layout.height, slide, top);
  }
  return pptx.write({ outputType: 'blob' });
}

// Every slide of a paginated chart shares one date range, so they line up.
function fullRange(rows) {
  const dated = rows.filter((r) => r.start);
  if (!dated.length) return undefined;
  return {
    start: dated.flatMap((r) => [r.start, r.baseline?.start ?? r.start]).sort()[0],
    end: dated.flatMap((r) => [r.end, r.baseline?.end ?? r.end]).sort().at(-1),
  };
}

export function openExportDialog(spec) {
  const options = { title: true, legend: spec.kind === 'gantt' || spec.multi, poc: spec.kind === 'gantt' };
  const preview = h('img', { alt: `${spec.title} preview` });
  const previewBox = h('div', { class: 'export-preview' }, preview);
  let previewUrl = null;

  const current = () => {
    const { svg, width, height } = buildImage(spec, options);
    return { svgString: svgToString(svg), width, height };
  };
  const refresh = () => {
    const { svgString } = current();
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' }));
    preview.src = previewUrl;
  };

  const toggle = (key, label) => h('label', { class: 'check' },
    h('input', {
      type: 'checkbox',
      checked: options[key],
      onchange: (event) => {
        options[key] = event.target.checked;
        refresh();
      },
    }),
    label);

  const filename = safeFilename(spec.title.toLowerCase().includes(spec.kind) ? spec.title : `${spec.title} ${spec.kind}`);
  const canCopy = !!(navigator.clipboard && window.ClipboardItem);

  const copyImage = async () => {
    const { svgString, width, height } = current();
    try {
      // Passing a promise keeps the click's permission alive in Safari.
      const blob = svgToPngBlob(svgString, width, height, 2);
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      toast('Copied. Paste it into your slide.');
    } catch {
      toast('Your browser blocked the copy, so the image was downloaded instead.', 'error');
      downloadBlob(await svgToPngBlob(svgString, width, height, 2), `${filename}.png`);
    }
  };

  const guard = (fn) => async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await fn();
    } catch (error) {
      toast(error.message || 'The export failed.', 'error');
    } finally {
      button.disabled = false;
    }
  };

  const copyHelp = canCopy
    ? 'Copy image pastes straight into a slide. The PowerPoint file uses native shapes you can recolor and edit.'
    : 'Copying images needs a secure connection (HTTPS or localhost), which this address isn\'t. Download the PNG or PowerPoint file instead.';

  openDialog({
    title: `Export ${spec.kind === 'gantt' ? 'Gantt chart' : 'timeline'}`,
    wide: true,
    body: [
      h('div', { class: 'row wrap', style: { gap: '16px' } },
        toggle('title', 'Title'),
        toggle('legend', 'Legend'),
        spec.kind === 'gantt' ? toggle('poc', 'POC column') : null),
      previewBox,
      h('p', { class: 'small muted' }, copyHelp),
    ],
    footer: [
      h('button', {
        class: 'btn left', type: 'button',
        onclick: guard(async () => {
          const { svgString } = current();
          downloadBlob(new Blob([svgString], { type: 'image/svg+xml' }), `${filename}.svg`);
        }),
      }, icon('download'), 'SVG'),
      h('button', {
        class: 'btn', type: 'button',
        onclick: guard(async () => {
          const { svgString, width, height } = current();
          downloadBlob(await svgToPngBlob(svgString, width, height, 2), `${filename}.png`);
        }),
      }, icon('download'), 'PNG'),
      h('button', {
        class: 'btn', type: 'button', 'data-action': 'pptx',
        onclick: guard(async () => {
          downloadBlob(await buildPptx(spec, options), `${filename}.pptx`);
          toast('PowerPoint file downloaded.');
        }),
      }, icon('download'), 'PowerPoint'),
      canCopy ? h('button', { class: 'btn primary', type: 'button', 'data-action': 'copy', onclick: guard(copyImage) }, icon('image'), 'Copy image') : null,
    ],
    onClose: () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    },
  });
  refresh();
}
