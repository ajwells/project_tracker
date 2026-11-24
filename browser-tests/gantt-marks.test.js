// Holidays shaded on a project's Gantt chart, and each link's lead or lag labeled where
// its arrow reaches the waiting task. Toolbar boxes turn each off, for exports too.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CONCURRENCY, launchBrowser, openApp, pressText, project, soon, task } from './helpers.js';

const projects = () => {
  const plan = project('proj', [
    task('pour', { start: '2026-12-07', duration: 4 }),
    task('frame', { startSet: false, duration: 5, deps: [{ taskId: 'pour', type: 'FS', lag: 7, lagUnit: 'calendar' }] }),
    task('order', { startSet: false, duration: 3, deps: [{ taskId: 'frame', type: 'SS', lag: -2 }] }),
    task('inspect', { startSet: false, duration: 2, deps: [{ taskId: 'frame', type: 'FF', lag: 3 }] }),
    task('plain', { startSet: false, duration: 2, deps: [{ taskId: 'inspect', type: 'FS', lag: 0 }] }),
  ]);
  plan.calendar = { holidays: ['2026-12-24', '2026-12-25', '2026-12-31', '2027-06-01'] };
  // Tasks waiting on several others, each link with its own lead or lag.
  const many = project('many', [
    task('design', { start: '2026-12-07', duration: 4 }),
    task('procure', { start: '2026-12-08', duration: 3 }),
    task('permits', { start: '2026-12-07', duration: 2 }),
    task('build', { startSet: false, duration: 5, deps: [{ taskId: 'design', type: 'FS', lag: 2 }, { taskId: 'procure', type: 'FS', lag: -1 }, { taskId: 'permits', type: 'FS', lag: 5, lagUnit: 'calendar' }] }),
    task('test', { startSet: false, duration: 3, deps: [{ taskId: 'build', type: 'SS', lag: 2 }, { taskId: 'design', type: 'FF', lag: 4 }] }),
    task('ship', { startSet: false, duration: 2, deps: [{ taskId: 'build', type: 'FS', lag: 1 }, { taskId: 'test', type: 'FS', lag: 1 }] }),
  ]);
  // Milestones show their date to the right, where a label could land.
  const gates = project('gates', [
    task('gate', { start: '2026-12-09', duration: 0, milestone: true }),
    task('prep', { start: '2026-12-07', duration: 3 }),
    task('work', { startSet: false, duration: 5, deps: [{ taskId: 'gate', type: 'FS', lag: 2 }, { taskId: 'prep', type: 'FS', lag: -1 }] }),
    task('sign', { startSet: false, duration: 0, milestone: true, deps: [{ taskId: 'work', type: 'FF', lag: 3 }] }),
  ]);
  return [plan, project('other', [task('solo', { start: '2026-12-07', duration: 3 })]), many, gates];
};

const holidayBands = (page) => page.$$eval('.pane-body rect[data-tip^="Holiday"]', (els) => els.map((el) => el.getAttribute('data-tip')));
const lagLabels = (page) => page.$$eval('.pane-body text', (els) => els.map((el) => el.textContent).filter((s) => /^[+−]\d+c?d$/.test(s)).sort());
const legend = (page) => page.$eval('.legend', (el) => el.textContent);
// The export preview's SVG, caught as the page makes it, since the page may not fetch blobs.
const exported = async (page) => {
  await page.evaluate(() => {
    window.__made = [];
    const make = URL.createObjectURL;
    URL.createObjectURL = (blob) => {
      window.__made.push(blob);
      return make(blob);
    };
  });
  await page.click('[data-action=export]');
  await page.waitForFunction(() => window.__made.some((b) => b.type.startsWith('image/svg')));
  const svg = await page.evaluate(() => window.__made.findLast((b) => b.type.startsWith('image/svg')).text());
  await page.keyboard.press('Escape');
  await soon(async () => assert.equal(await page.$('dialog[open]'), null));
  return svg;
};

describe('holidays and lead/lag on the Gantt chart', { concurrency: CONCURRENCY }, () => {
  let browser;
  before(async () => { browser = await launchBrowser(); });
  after(() => browser?.close());

  const scenario = (name, hash, body) => test(name, async () => {
    const app = await openApp(browser, { projects: projects(), hash, viewport: { width: 1400, height: 900 } });
    let problems;
    try {
      await body(app.page);
    } finally {
      problems = await app.close();
    }
    assert.deepEqual(problems, []);
  });

  scenario('holidays in view are shaded, days in a row as one band, with a legend entry', '#/p/proj/gantt', async (page) => {
    await page.waitForSelector('.pane-body');
    await soon(async () => assert.deepEqual(await holidayBands(page), ['Holidays: Dec 24 – Dec 25, 2026', 'Holiday: Dec 31, 2026']));
    assert.equal((await page.$$('.pane-head rect[data-tip^="Holiday"]')).length, 2, 'marked in the header too');
    assert.match(await legend(page), /Holiday/);
    // Exports drop tooltips, so look for the band's light-theme color.
    assert.match(await exported(page), /fill="#fcefd8"/);

    await pressText(page, '.toolbar label.check', 'Holidays');
    await soon(async () => assert.deepEqual(await holidayBands(page), []));
    assert.doesNotMatch(await legend(page), /Holiday/);
    assert.doesNotMatch(await exported(page), /fill="#fcefd8"/);
  });

  scenario('a project without holidays, and the portfolio chart, show none and offer no box', '#/p/other/gantt', async (page) => {
    await page.waitForSelector('.pane-body');
    assert.deepEqual(await holidayBands(page), []);
    assert.doesNotMatch(await page.$eval('.toolbar', (el) => el.textContent), /Holidays/);
    await page.evaluate(() => { location.hash = '#/portfolio/gantt'; });
    await page.waitForSelector('.pane-body');
    await pressText(page, '.seg button', 'All tasks');
    await soon(async () => assert.ok(await page.$('.pane-body rect[data-task=pour]')));
    assert.deepEqual(await holidayBands(page), []);
  });

  scenario('each link with a lead or lag is labeled, in its own units, and the box turns them off', '#/p/proj/gantt', async (page) => {
    await page.waitForSelector('.pane-body');
    await soon(async () => assert.deepEqual(await lagLabels(page), ['+3d', '+7cd', '−2d']));
    assert.match(await exported(page), />\+7cd</);

    await pressText(page, '.toolbar label.check', 'Lead/lag');
    await soon(async () => assert.deepEqual(await lagLabels(page), []));
    assert.doesNotMatch(await exported(page), />\+7cd</);
    await pressText(page, '.toolbar label.check', 'Lead/lag');
    await soon(async () => assert.equal((await lagLabels(page)).length, 3));
  });

  for (const zoom of ['Fit', 'Day', 'Week']) {
    scenario(`with several links into one task, every label shows and none overlap (${zoom})`, '#/p/many/gantt', async (page) => {
      await page.waitForSelector('.pane-body');
      await pressText(page, '.seg button', zoom);
      await soon(async () => assert.deepEqual(await lagLabels(page), ['+1d', '+1d', '+2d', '+2d', '+4d', '+5cd', '−1d']));
      const boxes = await page.$$eval('.pane-body rect', (els) => els
        .filter((el) => /^[+−]\d+c?d$/.test(el.nextElementSibling?.textContent ?? ''))
        .map((el) => el.getBBox()).map(({ x, y, width, height }) => ({ x, y, width, height })));
      assert.equal(boxes.length, 7);
      const overlaps = boxes.flatMap((a, i) => boxes.slice(i + 1).filter((b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height));
      assert.deepEqual(overlaps, []);
      // Arrows into Build share their end, so each label sits where its own arrow leaves,
      // just past the end of its predecessor and in its row, so it's plain whose it is.
      const near = await page.evaluate(() => {
        const box = (el) => el.getBBox();
        const label = (s) => [...document.querySelectorAll('.pane-body text')].find((el) => el.textContent === s);
        const bar = (id) => box(document.querySelector(`.pane-body rect[data-task="${id}"][data-drag]`));
        return Object.fromEntries([['−1d', 'procure'], ['+5cd', 'permits']].map(([s, id]) => {
          const l = box(label(s));
          const b = bar(id);
          return [s, { after: l.x - (b.x + b.width), rowOffset: Math.abs(l.y + l.height / 2 - (b.y + b.height / 2)) }];
        }));
      });
      for (const [s, { after, rowOffset }] of Object.entries(near)) {
        assert.ok(after >= 0 && after <= 14, `${s} is ${after}px past its predecessor`);
        assert.ok(rowOffset <= 15, `${s} is ${rowOffset}px off its predecessor's row`);
      }
    });
  }

  for (const zoom of ['Fit', 'Day']) {
    scenario(`a label beside a milestone starts after its date (${zoom})`, '#/p/gates/gantt', async (page) => {
      await page.waitForSelector('.pane-body');
      await pressText(page, '.seg button', zoom);
      await soon(async () => assert.deepEqual(await lagLabels(page), ['+2d', '+3d', '−1d']));
      const gaps = await page.evaluate(() => {
        const box = (el) => el.getBBox();
        const texts = [...document.querySelectorAll('.pane-body text')];
        const label = (s) => box(texts.find((el) => el.textContent === s).previousElementSibling);
        // The date drawn after each milestone's diamond.
        const date = (id) => {
          const diamond = box(document.querySelector(`.pane-body polygon[data-task="${id}"]`));
          return box(texts.find((el) => /^[A-Z][a-z]{2} \d+$/.test(el.textContent) && Math.abs(box(el).y + box(el).height / 2 - (diamond.y + diamond.height / 2)) < 2));
        };
        const leaving = label('+2d'); // where its arrow leaves "gate"
        const arriving = label('+3d'); // where its FF arrow reaches "sign"
        return { leaving: leaving.x - (date('gate').x + date('gate').width), arriving: arriving.x - (date('sign').x + date('sign').width) };
      });
      assert.ok(gaps.leaving >= 2, `"+2d" starts ${gaps.leaving}px after gate's date`);
      assert.ok(gaps.arriving >= 2, `"+3d" starts ${gaps.arriving}px after sign's date`);
    });
  }

  scenario('a label sits beside the end of its arrow, clear of the task it points at', '#/p/proj/gantt', async (page) => {
    await page.waitForSelector('.pane-body');
    const boxes = await page.evaluate(() => {
      const box = (el) => {
        const { x, y, width, height } = el.getBBox();
        return { x, y, width, height };
      };
      const label = (s) => [...document.querySelectorAll('.pane-body text')].find((el) => el.textContent === s);
      const bar = (id) => document.querySelector(`.pane-body rect[data-task="${id}"][data-drag]`);
      return { lead: box(label('−2d')), order: box(bar('order')), lag: box(label('+3d')), inspect: box(bar('inspect')) };
    });
    // Into a start: to the left of the bar. Into a finish (FF): to the right.
    assert.ok(boxes.lead.x + boxes.lead.width <= boxes.order.x, JSON.stringify(boxes));
    assert.ok(boxes.lag.x >= boxes.inspect.x + boxes.inspect.width, JSON.stringify(boxes));
    // In the waiting task's row, above the arrow's middle.
    assert.ok(boxes.lead.y < boxes.order.y + boxes.order.height / 2 && boxes.lead.y + boxes.lead.height > boxes.order.y - 15);
  });
});
