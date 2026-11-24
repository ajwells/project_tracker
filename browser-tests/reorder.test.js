// Dragging milestones along the Gantt chart, and dragging tasks up and down the Gantt
// chart's names and the Tasks tab to reorder them, in both storage modes.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONCURRENCY, launchBrowser, openApp, pause, project, savedProjects, savedTask, soon, task,
} from './helpers.js';

const projects = () => [
  project('proj', [
    task('a', { start: '2026-12-07', duration: 5 }),
    task('b', { start: '2026-12-07', duration: 5 }),
    task('sum', { start: '2026-12-07', duration: 5 }),
    task('kid1', { parentId: 'sum', start: '2026-12-07', duration: 5 }),
    task('kid2', { parentId: 'sum', start: '2026-12-07', duration: 5 }),
    task('c', { start: '2026-12-07', duration: 5 }),
    task('ms', { start: '2026-12-09', duration: 0, milestone: true }),
    task('gate', { start: '2026-12-09', duration: 0, milestone: true }),
    task('after-gate', { startSet: false, deps: [{ taskId: 'gate', type: 'FS', lag: 0 }] }),
  ]),
];

// The saved outline, as "name" or "parent>name", in order.
const outline = async (page) => {
  const { tasks } = (await savedProjects(page)).find((p) => p.id === 'proj');
  const out = [];
  const walk = (parent) => {
    for (const t of tasks.filter((x) => (x.parentId || null) === parent)) {
      out.push(parent ? `${parent}>${t.id}` : t.id);
      walk(t.id);
    }
  };
  walk(null);
  return out;
};
const START = ['a', 'b', 'sum', 'sum>kid1', 'sum>kid2', 'c', 'ms', 'gate', 'after-gate'];

// Middle of a row, and its height, on the Gantt's names or the Tasks tab.
const ganttRow = (page, id) => page.$eval(`.pane-labels text[data-task="${id}"]`, (el) => {
  const b = el.getBoundingClientRect();
  return { x: b.x + 4, y: b.y + b.height / 2 };
});
const tableRow = (page, id) => page.$eval(`tr[data-task-row="${id}"]`, (el) => {
  const b = el.getBoundingClientRect();
  return { x: b.x + b.width * 0.4, y: b.y + b.height / 2, h: b.height };
});
// Presses at `from`, moves like a hand would to `to`, and lets go unless told not to.
const drag = async (page, from, to, { release = true } = {}) => {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x, from.y + (to.y > from.y ? 3 : -3), { steps: 2 });
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await pause(80);
  if (release) await page.mouse.up();
};
const panelOpen = async (page) => !!(await page.$('.drawer'));

for (const [mode, saving] of [['browser storage', undefined], ['server storage', true]]) {
  describe(`dragging milestones and reordering tasks, ${mode}`, { concurrency: CONCURRENCY }, () => {
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

    // ---- milestones on the Gantt ----

    scenario('a milestone can be dragged to a later date, and saves on release', GANTT, async (page) => {
      const diamond = await page.waitForSelector('polygon[data-drag=true][data-task=ms]');
      const box = await diamond.boundingBox();
      await drag(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 }, { x: box.x + box.width / 2 + 120, y: box.y + box.height / 2 });
      await soon(async () => assert.ok((await savedTask(page, 'ms')).start > '2026-12-09'));
      assert.equal((await savedTask(page, 'ms')).duration, 0);
      assert.equal(await panelOpen(page), false, 'the release is not a click');
    });

    scenario('dragging a milestone shows its new date, and no resize at its edge', GANTT, async (page) => {
      const diamond = await page.waitForSelector('polygon[data-drag=true][data-task=ms]');
      const box = await diamond.boundingBox();
      const right = { x: box.x + box.width - 1, y: box.y + box.height / 2 };
      await page.mouse.move(right.x, right.y);
      assert.equal(await diamond.evaluate((el) => el.style.cursor), 'grab');
      await drag(page, right, { x: right.x + 120, y: right.y }, { release: false });
      assert.match(await page.$eval('body', (el) => el.textContent), /Date: /);
      await page.keyboard.press('Escape');
      await page.mouse.up();
      await pause(150);
      assert.equal((await savedTask(page, 'ms')).start, '2026-12-09');
      assert.equal(await panelOpen(page), false);
    });

    scenario('dragging a milestone that others follow waits for Apply', GANTT, async (page) => {
      const diamond = await page.waitForSelector('polygon[data-drag=true][data-task=gate]');
      const box = await diamond.boundingBox();
      await drag(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 }, { x: box.x + box.width / 2 + 120, y: box.y + box.height / 2 });
      await page.waitForSelector('.held-edit');
      assert.match(await page.$eval('.held-edit', (el) => el.textContent), /after-gate/);
      assert.equal((await savedTask(page, 'gate')).start, '2026-12-09');
      await page.evaluate(() => [...document.querySelectorAll('.held-edit button')].find((b) => b.textContent.includes('Apply')).click());
      await soon(async () => assert.ok((await savedTask(page, 'gate')).start > '2026-12-09'));
    });

    // ---- reordering on the Gantt ----

    scenario('dragging a name on the Gantt up puts the task above the row it is dropped on', GANTT, async (page) => {
      await page.waitForSelector('.pane-labels text[data-task=c]');
      const from = await ganttRow(page, 'c');
      const a = await ganttRow(page, 'a');
      const b = await ganttRow(page, 'b');
      const rowH = b.y - a.y;
      await drag(page, from, { x: from.x, y: a.y - rowH * 0.3 }, { release: false });
      assert.ok(await page.$('[data-drop-line]'), 'shows where it will go');
      await page.mouse.up();
      await soon(async () => assert.deepEqual(await outline(page), ['c', 'a', 'b', 'sum', 'sum>kid1', 'sum>kid2', 'ms', 'gate', 'after-gate']));
      assert.equal(await page.$('[data-drop-line]'), null);
      assert.equal(await panelOpen(page), false, 'the release is not a click');
    });

    scenario('dropping on the bottom half of an open summary puts the task first inside it', GANTT, async (page) => {
      await page.waitForSelector('.pane-labels text[data-task=a]');
      const from = await ganttRow(page, 'a');
      const sum = await ganttRow(page, 'sum');
      const kid1 = await ganttRow(page, 'kid1');
      await drag(page, from, { x: from.x, y: sum.y + (kid1.y - sum.y) * 0.3 });
      await soon(async () => assert.deepEqual(await outline(page), ['b', 'sum', 'sum>a', 'sum>kid1', 'sum>kid2', 'c', 'ms', 'gate', 'after-gate']));
    });

    scenario('a summary dragged on the Gantt takes its subtasks, and a plain click still opens a task', GANTT, async (page) => {
      await page.waitForSelector('.pane-labels text[data-task=sum]');
      const from = await ganttRow(page, 'sum');
      const a = await ganttRow(page, 'a');
      const b = await ganttRow(page, 'b');
      await drag(page, from, { x: from.x, y: a.y - (b.y - a.y) * 0.3 });
      await soon(async () => assert.deepEqual(await outline(page), ['sum', 'sum>kid1', 'sum>kid2', 'a', 'b', 'c', 'ms', 'gate', 'after-gate']));
      const c = await ganttRow(page, 'c');
      await page.mouse.click(c.x, c.y, { delay: 70 });
      await page.waitForSelector('.drawer');
    });

    // Busy or background pages can run timers late, which once let the guard against the
    // release's click outlive it and swallow the next real click.
    scenario('a click straight after a drag opens the task, even when timers run late', GANTT, async (page) => {
      await page.waitForSelector('.pane-labels text[data-task=c]');
      await page.evaluate(() => {
        const later = window.setTimeout;
        window.setTimeout = (fn, ms, ...args) => later(fn, Math.max(ms || 0, 1500), ...args);
      });
      const a = await ganttRow(page, 'a');
      const b = await ganttRow(page, 'b');
      const from = await ganttRow(page, 'c');
      await drag(page, from, { x: from.x, y: a.y - (b.y - a.y) * 0.3 });
      await pause(150);
      await page.mouse.click(b.x, b.y, { delay: 70 });
      await page.waitForSelector('.drawer', { timeout: 3000 });
      await soon(async () => assert.deepEqual(await outline(page), ['c', 'a', 'b', 'sum', 'sum>kid1', 'sum>kid2', 'ms', 'gate', 'after-gate']));
    });

    scenario('dropping a summary onto its own subtasks, or Esc, changes nothing', GANTT, async (page) => {
      await page.waitForSelector('.pane-labels text[data-task=sum]');
      const from = await ganttRow(page, 'sum');
      const kid2 = await ganttRow(page, 'kid2');
      await drag(page, from, kid2, { release: false });
      assert.equal(await page.$('[data-drop-line]'), null, 'no line over its own subtasks');
      await page.mouse.up();
      const a = await ganttRow(page, 'a');
      await drag(page, await ganttRow(page, 'c'), a, { release: false });
      assert.ok(await page.$('[data-drop-line]'));
      await page.keyboard.press('Escape');
      assert.equal(await page.$('[data-drop-line]'), null);
      await page.mouse.up();
      await pause(200);
      assert.deepEqual(await outline(page), START);
      assert.equal(await panelOpen(page), false);
    });

    // ---- reordering on the Tasks tab ----

    scenario('dragging a row down the Tasks tab puts it below the row it is dropped on', TASKS, async (page) => {
      await page.waitForSelector('tr[data-task-row=a]');
      const from = await tableRow(page, 'a');
      const c = await tableRow(page, 'c');
      await drag(page, from, { x: from.x, y: c.y + c.h * 0.3 }, { release: false });
      assert.equal(await page.$eval('.drop-line', (el) => el.hidden), false);
      await page.mouse.up();
      await soon(async () => assert.deepEqual(await outline(page), ['b', 'sum', 'sum>kid1', 'sum>kid2', 'c', 'a', 'ms', 'gate', 'after-gate']));
      assert.equal(await panelOpen(page), false, 'the release is not a click');
    });

    scenario('a subtask dragged above a top-level row leaves its summary', TASKS, async (page) => {
      await page.waitForSelector('tr[data-task-row=kid2]');
      const from = await tableRow(page, 'kid2');
      const c = await tableRow(page, 'c');
      await drag(page, from, { x: from.x, y: c.y - c.h * 0.3 });
      await soon(async () => assert.deepEqual(await outline(page), ['a', 'b', 'sum', 'sum>kid1', 'kid2', 'c', 'ms', 'gate', 'after-gate']));
      const history = (await savedTask(page, 'kid2')).history.at(-1);
      assert.match(JSON.stringify(history), /parent/);
    });

    scenario('rows keep their order while the list is filtered, and clicking still opens a task', TASKS, async (page) => {
      await page.waitForSelector('#task-search');
      await page.type('#task-search', 'kid');
      await page.waitForFunction(() => !document.querySelector('tr[data-task-row=a]'));
      const from = await tableRow(page, 'kid2');
      const kid1 = await tableRow(page, 'kid1');
      await drag(page, from, { x: from.x, y: kid1.y - kid1.h * 0.3 });
      await pause(200);
      assert.deepEqual(await outline(page), START);
      const row = await tableRow(page, 'kid1');
      await page.mouse.click(row.x, row.y, { delay: 70 });
      await page.waitForSelector('.drawer');
    });
  });
}
