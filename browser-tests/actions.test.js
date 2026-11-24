// Action items in real Chrome: added from their own page, edited in the task panel with
// history and updates, and kept off the charts. Both storage modes.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  click, CONCURRENCY, launchBrowser, openApp, pressText, project, savedProjects, soon, task, type,
} from './helpers.js';

const projects = () => [{
  ...project('proj', [task('build')]),
  actions: [
    { id: 'chase', name: 'Chase the vendor', pocName: 'Bo', status: 'in_progress', progress: 20, history: [] },
    { id: 'done1', name: 'Book the room', status: 'complete', progress: 100, history: [] },
  ],
}];
const savedAction = async (page, id) => (await savedProjects(page)).flatMap((p) => p.actions ?? []).find((a) => a.id === id);
const rowNames = (page) => page.$$eval('tr[data-action-id]', (rows) => rows.map((r) => r.querySelector('td').textContent));

for (const [mode, saving] of [['browser storage', undefined], ['server storage', true]]) {
  describe(`action items, ${mode}`, { concurrency: CONCURRENCY }, () => {
    let browser;
    before(async () => { browser = await launchBrowser(); });
    after(() => browser?.close());

    const scenario = (name, body) => test(name, async () => {
      const app = await openApp(browser, { saving, projects: projects(), hash: '#/p/proj/actions' });
      let problems;
      try {
        await body(app.page);
      } finally {
        problems = await app.close();
      }
      assert.deepEqual(problems, []);
    });

    scenario('adds one, edits it in the panel, and posts an update to its history', async (page) => {
      await click(page, '#quick-add-action');
      await type(page, 'Ask legal');
      await page.keyboard.press('Enter');
      await soon(async () => assert.ok((await rowNames(page)).includes('Ask legal')));
      // The box keeps focus for the next one.
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'quick-add-action');

      await pressText(page, 'tr[data-action-id]', 'Ask legal');
      await page.waitForSelector('.drawer');
      assert.match(await page.$eval('.drawer-head', (el) => el.textContent), /Action item/);
      // No dates, links or schedule in this panel.
      for (const name of ['start', 'end', 'duration', 'trackBy']) assert.equal(await page.$(`.drawer [name=${name}]`), null, name);
      assert.doesNotMatch(await page.$eval('.drawer', (el) => el.textContent), /Depends on|Critical|float/);

      await click(page, '.drawer [name=pocName]');
      await type(page, 'Di');
      await page.keyboard.press('Tab');
      await page.select('.drawer [name=status]', 'blocked');
      await click(page, '.drawer textarea[aria-label="Post an update"]');
      await type(page, 'Waiting on the contract');
      await pressText(page, '.drawer button', 'Post update');

      const id = (await savedProjects(page))[0].actions.find((a) => a.name === 'Ask legal').id;
      await soon(async () => {
        const saved = await savedAction(page, id);
        assert.equal(saved.pocName, 'Di');
        assert.equal(saved.status, 'blocked');
        // Filling it in straight after adding it is part of adding it.
        assert.deepEqual(saved.history.map((e) => e.type), ['create', 'update']);
        assert.deepEqual(saved.history[0].changes.map((c) => c.field).sort(), ['pocName', 'status']);
      });
      await soon(async () => {
        const feed = await page.$eval('.drawer .feed', (el) => el.textContent);
        assert.match(feed, /Waiting on the contract/);
        assert.match(feed, /Current POC/);
        assert.match(feed, /Blocked/);
      });
      // The list shows the newest update.
      await soon(async () => assert.match(await page.$eval(`tr[data-action-id="${id}"]`, (el) => el.textContent), /Waiting on the contract/));

      // Esc closes the panel.
      await page.keyboard.press('Escape');
      await soon(async () => assert.equal(await page.$('.drawer'), null));
    });

    scenario('completed ones can be hidden, and stay off the charts', async (page) => {
      assert.deepEqual(await rowNames(page), ['Chase the vendor', 'Book the room']);
      await click(page, '[name=showDone]');
      await soon(async () => assert.deepEqual(await rowNames(page), ['Chase the vendor']));
      await click(page, '[name=showDone]');
      await soon(async () => assert.equal((await rowNames(page)).length, 2));

      await page.evaluate(() => { location.hash = '#/p/proj/gantt'; });
      await page.waitForSelector('[data-task=build]');
      assert.doesNotMatch(await page.$eval('.main', (el) => el.textContent), /Chase the vendor|Book the room/);
      // The project's progress counts tasks only.
      assert.match(await page.$eval('.topbar', (el) => el.textContent), /0% complete/);
    });

    scenario('moving from an action item to a task swaps the panel, and delete removes it', async (page) => {
      await pressText(page, 'tr[data-action-id]', 'Chase the vendor');
      await page.waitForSelector('.drawer [name=pocName]');
      assert.equal(await page.$eval('.drawer [name=pocName]', (el) => el.value), 'Bo');
      await page.evaluate(() => { location.hash = '#/p/proj/tasks'; });
      await pressText(page, 'tr.clickable', 'build');
      await soon(async () => assert.match(await page.$eval('.drawer', (el) => el.getAttribute('aria-label')), /^Task: build/));

      await page.evaluate(() => { location.hash = '#/p/proj/actions'; });
      await pressText(page, 'tr[data-action-id]', 'Chase the vendor');
      await soon(async () => assert.match(await page.$eval('.drawer', (el) => el.getAttribute('aria-label')), /^Action item/));
      await pressText(page, '.drawer button', 'Delete action item');
      await pressText(page, 'dialog[open] button', 'Delete action item');
      await soon(async () => assert.equal(await savedAction(page, 'chase'), undefined));
      await soon(async () => assert.deepEqual(await rowNames(page), ['Book the room']));
      assert.equal(await page.$('.drawer'), null);
    });
  });
}
