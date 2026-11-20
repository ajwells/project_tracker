// A date change that would move other tasks waits for Apply or Cancel, in the panel and
// when dragging on the Gantt, in both storage modes. One that moves nothing saves at once.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  click, CONCURRENCY, launchBrowser, openApp, openTask, pause, pressText, project, savedTask, soon, task, type, value,
} from './helpers.js';

const projects = () => [
  project('proj', [
    task('pred', { start: '2026-12-07', duration: 5 }),
    task('succ', { startSet: false, deps: [{ taskId: 'pred', type: 'FS', lag: 0 }] }),
    task('last', { startSet: false, deps: [{ taskId: 'succ', type: 'FS', lag: 0 }] }),
    task('free', { start: '2026-12-07', duration: 5 }),
    task('fixed', { trackBy: 'dates', start: '2026-12-14', finish: '2026-12-16', deps: [{ taskId: 'pred', type: 'FS', lag: 0 }] }),
    task('gate', { start: '2026-12-07', duration: 5 }),
    task('pinned', { trackBy: 'dates', start: '2026-12-14', finish: '2026-12-16', deps: [{ taskId: 'gate', type: 'FS', lag: 0 }] }),
  ]),
  project('away', [task('elsewhere', { startSet: false, deps: [{ taskId: 'pred', type: 'FS', lag: 0 }] })]),
];

const setDate = (page, name, date) => page.$eval(`.drawer-body [name=${name}]`, (el, d) => {
  el.value = d;
  el.dispatchEvent(new Event('change', { bubbles: true }));
}, date);
const card = (page) => page.$eval('.held-edit', (el) => el.textContent);
const hasCard = async (page) => !!(await page.$('.held-edit'));
const ghosts = (page) => page.$$eval('[data-ghost]', (els) => els.map((el) => el.getAttribute('data-ghost')).sort());
const dragBar = async (page, id, by) => {
  const bar = await page.$eval(`[data-drag=true][data-task=${id}]`, (el) => {
    const b = el.getBoundingClientRect();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  });
  await page.mouse.move(bar.x, bar.y);
  await page.mouse.down();
  await page.mouse.move(bar.x + by, bar.y, { steps: 6 });
};

for (const [mode, saving] of [['browser storage', undefined], ['server storage', true]]) {
  describe(`date changes that move other tasks, ${mode}`, { concurrency: CONCURRENCY }, () => {
    let browser;
    before(async () => { browser = await launchBrowser(); });
    after(() => browser?.close());

    const scenario = (name, hash, body) => test(name, async () => {
      const app = await openApp(browser, { saving, projects: projects(), hash, viewport: { width: 1280, height: 1100 } });
      let problems;
      try {
        await body(app.page);
      } finally {
        problems = await app.close();
      }
      assert.deepEqual(problems, []);
    });
    const TASKS = '#/p/proj/tasks';
    const GANTT = '#/p/proj/gantt';

    scenario('a picked date waits and lists what would move, and Apply saves it', TASKS, async (page) => {
      await openTask(page, 'pred');
      const succ = (await savedTask(page, 'succ')).schedStart;
      await setDate(page, 'start', '2026-12-14');
      await page.waitForSelector('.held-edit');
      const text = await card(page);
      assert.match(text, /moves 3 other tasks/);
      assert.match(text, /Nothing is saved yet/);
      assert.match(text, /succ/);
      assert.match(text, /last/);
      assert.match(text, /elsewhere \(away\)/);
      assert.match(text, /7 calendar days later/);
      assert.match(text, /proj finish/);
      assert.match(text, /away finish/);
      // A long list scrolls, so the most serious news comes first.
      assert.match(await page.$eval('.held-edit-list li', (li) => li.textContent), /New conflict: fixed/);
      assert.equal((await savedTask(page, 'pred')).start, '2026-12-07');
      assert.equal(await value(page, '.drawer [name=start]'), '2026-12-14');

      await pressText(page, '.held-edit button', 'Apply');
      await soon(async () => {
        assert.equal((await savedTask(page, 'pred')).start, '2026-12-14');
        assert.notEqual((await savedTask(page, 'succ')).schedStart, succ);
        assert.equal(await hasCard(page), false);
      });
      const starts = (await savedTask(page, 'pred')).history.flatMap((h) => h.changes ?? []).filter((c) => c.field === 'start');
      assert.deepEqual(starts.map((c) => c.to), ['2026-12-14']);
    });

    scenario('a typed date waits too, and Cancel puts it back with nothing saved', TASKS, async (page) => {
      await openTask(page, 'pred');
      const before = (await savedTask(page, 'pred')).history.length;
      await page.focus('.drawer [name=start]');
      await type(page, '12142026');
      await page.keyboard.press('Tab');
      await page.waitForSelector('.held-edit');
      assert.equal(await value(page, '.drawer [name=start]'), '2026-12-14');
      await pressText(page, '.held-edit button', 'Cancel');
      await soon(async () => {
        assert.equal(await hasCard(page), false);
        assert.equal(await value(page, '.drawer [name=start]'), '2026-12-07');
      });
      const saved = await savedTask(page, 'pred');
      assert.equal(saved.start, '2026-12-07');
      assert.equal(saved.history.length, before);
    });

    scenario('Esc cancels a waiting date and keeps the panel open, even with the field focused', TASKS, async (page) => {
      await openTask(page, 'pred');
      await page.focus('.drawer [name=start]');
      await type(page, '12142026');
      await page.keyboard.press('Enter');
      await page.waitForSelector('.held-edit');
      await page.keyboard.press('Escape');
      await soon(async () => {
        assert.equal(await hasCard(page), false);
        assert.equal(await value(page, '.drawer [name=start]'), '2026-12-07');
      });
      assert.ok(await page.$('.drawer'));
      assert.equal((await savedTask(page, 'pred')).start, '2026-12-07');
      await page.keyboard.press('Escape');
      await soon(async () => assert.equal(await page.$('.drawer'), null));
    });

    scenario('changing the date again updates the list, and going back clears it', TASKS, async (page) => {
      await openTask(page, 'pred');
      await setDate(page, 'start', '2026-12-14');
      await page.waitForSelector('.held-edit');
      await setDate(page, 'start', '2026-12-21');
      await soon(async () => assert.match(await card(page), /14 calendar days later/));
      await setDate(page, 'start', '2026-12-07');
      await soon(async () => assert.equal(await hasCard(page), false));
      assert.equal((await savedTask(page, 'pred')).start, '2026-12-07');
    });

    scenario('going back to the date it had leaves a task still following its links', TASKS, async (page) => {
      await openTask(page, 'succ');
      const original = await value(page, '.drawer [name=start]');
      await setDate(page, 'start', '2026-12-28');
      await page.waitForSelector('.held-edit');
      await setDate(page, 'start', original);
      await soon(async () => assert.equal(await hasCard(page), false));
      await pause(100);
      assert.equal((await savedTask(page, 'succ')).startSet, false);
    });

    scenario('a conflict with no task moving waits too, and says so', TASKS, async (page) => {
      await openTask(page, 'gate');
      await setDate(page, 'start', '2026-12-14');
      await page.waitForSelector('.held-edit');
      const text = await card(page);
      assert.match(text, /causes a conflict/);
      assert.match(text, /New conflict: pinned/);
      assert.match(text, /Breaks its link to "gate"/);
      assert.equal((await savedTask(page, 'gate')).start, '2026-12-07');
    });

    scenario('a date links or the calendar won\'t allow says where the task lands', TASKS, async (page) => {
      await openTask(page, 'pred');
      await setDate(page, 'start', '2026-12-12'); // a Saturday
      await page.waitForSelector('.held-edit');
      assert.match(await card(page), /Dec 12 isn't available, so this task lands on Dec 14/);
    });

    scenario('a date that moves nothing else saves at once', TASKS, async (page) => {
      await openTask(page, 'free');
      await setDate(page, 'start', '2026-12-21');
      await soon(async () => assert.equal((await savedTask(page, 'free')).start, '2026-12-21'));
      assert.equal(await hasCard(page), false);
    });

    scenario('closing the panel drops a waiting date', TASKS, async (page) => {
      await openTask(page, 'pred');
      await setDate(page, 'start', '2026-12-14');
      await page.waitForSelector('.held-edit');
      await page.$eval('.drawer .btn.ghost.icon', (b) => b.click());
      await soon(async () => assert.equal(await page.$('.drawer'), null));
      await openTask(page, 'pred');
      assert.equal(await hasCard(page), false);
      assert.equal(await value(page, '.drawer [name=start]'), '2026-12-07');
      assert.equal((await savedTask(page, 'pred')).start, '2026-12-07');
    });

    scenario('another edit while a date waits saves, and leaves the date waiting', TASKS, async (page) => {
      await openTask(page, 'pred');
      await setDate(page, 'start', '2026-12-14');
      await page.waitForSelector('.held-edit');
      await click(page, '.drawer [name=pocName]');
      await type(page, 'Ana');
      await click(page, '.drawer [name=notes]');
      await soon(async () => assert.equal((await savedTask(page, 'pred')).pocName, 'Ana'));
      assert.equal(await hasCard(page), true);
      assert.equal((await savedTask(page, 'pred')).start, '2026-12-07');
      assert.equal(await value(page, '.drawer [name=start]'), '2026-12-14');
    });

    scenario('dragging shows where other tasks would go, and releasing waits for Apply', GANTT, async (page) => {
      await page.waitForSelector('[data-drag=true]');
      await pause(150);
      await dragBar(page, 'pred', 120);
      assert.deepEqual(await ghosts(page), ['elsewhere', 'last', 'succ']);
      assert.match(await page.$eval('#tooltip', (el) => el.textContent), /Moves 3 other tasks/);
      await page.mouse.up();
      await page.waitForSelector('.held-edit');
      assert.match(await card(page), /moves 3 other tasks/);
      assert.deepEqual(await ghosts(page), ['elsewhere', 'last', 'pred', 'succ']);
      assert.equal((await savedTask(page, 'pred')).start, '2026-12-07');

      await pressText(page, '.held-edit button', 'Apply');
      await soon(async () => {
        assert.ok((await savedTask(page, 'pred')).start > '2026-12-07');
        assert.deepEqual(await ghosts(page), []);
      });
    });

    scenario('dragging the right edge previews the new finish', GANTT, async (page) => {
      await page.waitForSelector('[data-drag=true]');
      await pause(150);
      const edge = await page.$eval('[data-drag=true][data-task=pred]', (el) => {
        const b = el.getBoundingClientRect();
        return { x: b.right - 3, y: b.y + b.height / 2 };
      });
      await page.mouse.move(edge.x, edge.y);
      await page.mouse.down();
      await page.mouse.move(edge.x + 100, edge.y, { steps: 6 });
      await page.mouse.up();
      await page.waitForSelector('.held-edit');
      assert.match(await card(page), /Finish: Dec 11 → /);
      assert.equal((await savedTask(page, 'pred')).duration, 5);
      await pressText(page, '.held-edit button', 'Apply');
      await soon(async () => assert.ok((await savedTask(page, 'pred')).duration > 5));
    });

    scenario('Cancel after a drag leaves the plan and takes the outlines away', GANTT, async (page) => {
      await page.waitForSelector('[data-drag=true]');
      await pause(150);
      await dragBar(page, 'pred', 120);
      await page.mouse.up();
      await page.waitForSelector('.held-edit');
      await pressText(page, '.held-edit button', 'Cancel');
      await soon(async () => assert.deepEqual(await ghosts(page), []));
      assert.equal((await savedTask(page, 'pred')).start, '2026-12-07');
    });

    scenario('Esc during a drag abandons it, without opening the task', GANTT, async (page) => {
      await page.waitForSelector('[data-drag=true]');
      await pause(150);
      await dragBar(page, 'pred', 60);
      await page.keyboard.press('Escape');
      assert.deepEqual(await ghosts(page), []);
      await page.mouse.up(); // still on the bar, so the browser reports a click
      await pause(100);
      assert.equal(await page.$('.drawer'), null);
      assert.equal((await savedTask(page, 'pred')).start, '2026-12-07');
    });

    scenario('dragging a task that moves nothing else saves on release', GANTT, async (page) => {
      await page.waitForSelector('[data-drag=true]');
      await pause(150);
      await dragBar(page, 'free', 120);
      assert.deepEqual(await ghosts(page), []);
      await page.mouse.up();
      await soon(async () => assert.ok((await savedTask(page, 'free')).start > '2026-12-07'));
      assert.equal(await hasCard(page), false);
    });
  });
}
