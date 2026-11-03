// Entering lags, following links and tracking by duration or dates, through the
// real page, in both storage modes.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  click, CONCURRENCY, launchBrowser, openApp, openTask, pause, pressText, project, savedProjects, savedTask, soon,
  task, toastText, type, value,
} from './helpers.js';

const LAG = '.dep-row input[type=number]';

const projects = () => [
  project('proj', [
    task('pred', { start: '2026-11-11', duration: 5 }),
    task('succ', { startSet: false, deps: [{ taskId: 'pred', type: 'FS', lag: 0 }] }),
    task('oldtask', { start: '2027-03-01', deps: [{ taskId: 'pred', type: 'FS', lag: 0 }] }), // no startSet, as older data has
    task('ms', { start: '2026-12-01', milestone: true, duration: 0 }),
  ]),
  project('other', [task('far')]),
];

const setDate = (page, name, date) => page.$eval(`.drawer-body [name=${name}]`, (el, d) => {
  el.value = d;
  el.dispatchEvent(new Event('change', { bubbles: true }));
}, date);
const disabled = (page, name) => page.$eval(`.drawer-body [name=${name}]`, (el) => el.disabled);
const panelText = (page) => page.$eval('.drawer-body', (d) => d.textContent);

for (const [mode, saving] of [['browser storage', undefined], ['server storage', true]]) {
  describe(`scheduling, ${mode}`, { concurrency: CONCURRENCY }, () => {
    let browser;
    before(async () => { browser = await launchBrowser(); });
    after(() => browser?.close());

    const scenario = (name, body) => test(name, async () => {
      const app = await openApp(browser, { saving, projects: projects(), hash: '#/p/proj/tasks', viewport: { width: 1280, height: 950 } });
      let problems;
      try {
        await body({ page: app.page, saved: (id = 'succ') => savedTask(app.page, id) });
      } finally {
        problems = await app.close();
      }
      assert.deepEqual(problems, []);
    });

    for (const [how, options] of [
      ['a quick click', { at: 0.3, delay: 40 }],
      ['a slow click', { at: 0.3, delay: 150 }],
      ['a double click', { at: 0.3, count: 2, delay: 40 }],
      ['a triple click', { at: 0.3, count: 3, delay: 40 }],
    ]) {
      for (const lag of [-2, 2]) {
        scenario(`typing ${lag} after ${how} saves ${lag}`, async ({ page, saved }) => {
          await openTask(page, 'succ');
          await click(page, LAG, options);
          await type(page, String(lag));
          await page.keyboard.press('Tab');
          await soon(async () => assert.equal((await saved()).deps[0].lag, lag));
        });
      }
    }

    for (const typed of ['-', 'e', '1.5']) {
      scenario(`typing "${typed}" over a lag keeps the lag and says why`, async ({ page, saved }) => {
        await openTask(page, 'succ');
        await click(page, LAG, { at: 0.3 });
        await type(page, '4');
        await page.keyboard.press('Tab');
        await soon(async () => assert.equal((await saved()).deps[0].lag, 4));
        await click(page, LAG, { at: 0.3 });
        await type(page, typed);
        await page.keyboard.press('Tab');
        await soon(async () => {
          assert.equal(await value(page, LAG), '4');
          assert.match(await toastText(page), /whole number/);
        });
        assert.equal((await saved()).deps[0].lag, 4);
      });
    }

    scenario('a task with no set start follows its link, even to earlier than its stored date', async ({ page, saved }) => {
      await openTask(page, 'succ');
      assert.match(await panelText(page), /Start comes from "pred"/);
      assert.equal(await value(page, '.drawer [name=start]'), '2026-11-18');
      await page.select('.dep-row select', 'SS');
      await soon(async () => assert.equal((await saved()).deps[0].type, 'SS'));
      await click(page, LAG, { at: 0.3 });
      await type(page, '-3');
      await page.keyboard.press('Tab');
      await soon(async () => {
        assert.equal((await saved()).schedStart, '2026-11-06');
        assert.equal(await value(page, '.drawer [name=start]'), '2026-11-06');
      });
    });

    scenario('a task saved before start dates were tracked keeps its date until Follow links', async ({ page, saved }) => {
      await openTask(page, 'oldtask');
      assert.equal((await saved('oldtask')).start, '2027-03-01');
      assert.match(await panelText(page), /keeping it later than its links need/);
      await pressText(page, '.drawer-body button', 'Follow links');
      await soon(async () => {
        assert.equal((await saved('oldtask')).schedStart, '2026-11-18');
        assert.doesNotMatch(await panelText(page), /keeping it later/);
      });
    });

    scenario('Track by switches which fields are entered and which fill in', async ({ page, saved }) => {
      await openTask(page, 'succ');
      assert.deepEqual([await disabled(page, 'end'), await disabled(page, 'duration')], [true, false]);

      await page.select('.drawer-body [name=trackBy]', 'dates');
      await soon(async () => {
        const s = await saved();
        assert.deepEqual([s.trackBy, s.start, s.finish], ['dates', '2026-11-18', '2026-11-20']);
        assert.deepEqual([await disabled(page, 'end'), await disabled(page, 'duration')], [false, true]);
      });
      assert.equal(await page.$('.drawer-body [name=manual]'), null);

      await setDate(page, 'end', '2026-12-01');
      await soon(async () => {
        assert.equal((await saved()).duration, 10);
        assert.equal(await value(page, '.drawer-body [name=duration]'), '10');
      });

      await setDate(page, 'end', '2026-11-01');
      await soon(async () => {
        assert.match(await toastText(page), /before the start/);
        assert.equal(await value(page, '.drawer-body [name=end]'), '2026-12-01');
      });
      assert.equal((await saved()).finish, '2026-12-01');

      await page.select('.drawer-body [name=trackBy]', 'duration');
      await soon(async () => {
        const s = await saved();
        assert.deepEqual([s.trackBy, s.duration, s.startSet], ['duration', 10, false]);
        assert.equal(await disabled(page, 'end'), true);
      });
    });

    scenario('a milestone offers no Track by', async ({ page, saved }) => {
      await openTask(page, 'ms');
      assert.equal(await page.$('.drawer-body [name=trackBy]'), null);
    });

    scenario('dragging the bar of a task tracked by dates moves both dates', async ({ page, saved }) => {
      await openTask(page, 'pred');
      await page.select('.drawer-body [name=trackBy]', 'dates');
      await soon(async () => assert.equal((await saved('pred')).trackBy, 'dates'));
      await page.$eval('.drawer .btn.ghost.icon', (b) => b.click());
      await page.evaluate(() => { location.hash = '#/p/proj/gantt'; });
      await page.waitForSelector('[data-drag=true]');
      await pause(200);
      const start = await saved('pred');
      const bar = await page.$eval('[data-drag=true]', (el) => {
        const b = el.getBoundingClientRect();
        return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
      });
      await page.mouse.move(bar.x, bar.y);
      await page.mouse.down();
      await page.mouse.move(bar.x + 120, bar.y, { steps: 6 });
      await page.mouse.up();
      const span = ({ start: from, finish }) => (Date.parse(finish) - Date.parse(from)) / 86400000;
      await soon(async () => {
        const moved = await saved('pred');
        assert.ok(moved.start > start.start, `${start.start} to ${moved.start}`);
        assert.equal(span(moved), span(start));
      });
    });

    scenario('the cross-project dialog takes a negative lag after one click', async ({ page, saved }) => {
      await page.evaluate(() => { location.hash = '#/p/proj/links'; });
      await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => /add/i.test(b.textContent) && /link/i.test(b.textContent)));
      await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => /add/i.test(b.textContent) && /link/i.test(b.textContent)).click());
      await click(page, 'dialog input[type=number]', { at: 0.3 });
      await type(page, '-2');
      await pressText(page, 'dialog button', 'Add link');
      await soon(async () => {
        const links = (await savedProjects(page)).flatMap((p) => p.tasks).flatMap((t) => t.deps).filter((d) => d.taskId === 'far');
        assert.deepEqual(links.map((d) => d.lag), [-2]);
      });
    });

    scenario('the cross-project dialog refuses text that is not a number, and stays open', async ({ page, saved }) => {
      await page.evaluate(() => { location.hash = '#/p/proj/links'; });
      await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => /add/i.test(b.textContent) && /link/i.test(b.textContent)));
      await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => /add/i.test(b.textContent) && /link/i.test(b.textContent)).click());
      await click(page, 'dialog input[type=number]', { at: 0.3 });
      await type(page, '-');
      await pressText(page, 'dialog button', 'Add link');
      await soon(async () => assert.match(await toastText(page), /Lag/));
      assert.ok(await page.$('dialog[open] input[type=number]'));
      const links = (await savedProjects(page)).flatMap((p) => p.tasks).flatMap((t) => t.deps);
      assert.ok(!links.some((d) => d.taskId === 'far'));
    });
  });
}
