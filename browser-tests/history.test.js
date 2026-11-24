// The task panel's history: quick edits shown as one entry with their steps on request,
// "Show every change", and a project still being planned keeping changes in "created".

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  click, CONCURRENCY, launchBrowser, openApp, openTask, pause, pressText, project, savedProjects, savedTask, selectAll, soon, task, type,
} from './helpers.js';

const projects = () => [project('proj', [task('build', { start: '2026-12-07', duration: 5 })])];

const setPoc = async (page, name) => {
  await click(page, '.drawer [name=pocName]');
  await selectAll(page);
  if (name) await type(page, name);
  else await page.keyboard.press('Backspace');
  await page.keyboard.press('Tab');
  await pause(150);
};
const heading = (page) => page.$eval('.drawer .drawer-section:last-of-type h3', (el) => el.textContent);
const feed = (page) => page.$eval('.drawer .feed', (el) => el.textContent);
const entries = (page) => page.$$eval('.drawer .feed > .feed-item', (els) => els.length);

for (const [mode, saving] of [['browser storage', undefined], ['server storage', true]]) {
  describe(`history in the task panel, ${mode}`, { concurrency: CONCURRENCY }, () => {
    let browser;
    before(async () => { browser = await launchBrowser(); });
    after(() => browser?.close());

    const scenario = (name, body) => test(name, async () => {
      const app = await openApp(browser, { saving, projects: projects(), hash: '#/p/proj/tasks' });
      let problems;
      try {
        await body(app.page);
      } finally {
        problems = await app.close();
      }
      assert.deepEqual(problems, []);
    });

    scenario('quick edits show as one entry, which opens to show each step', async (page) => {
      await openTask(page, 'build');
      await setPoc(page, 'Bo');
      await setPoc(page, 'Cy');
      await soon(async () => assert.equal((await savedTask(page, 'build')).history.length, 1));
      await soon(async () => assert.match(await feed(page), /Current POC: none → Cy/));
      assert.equal(await heading(page), 'History (1)');
      assert.equal(await entries(page), 1);
      assert.doesNotMatch(await feed(page), /Bo/);

      await pressText(page, '.drawer .feed-steps', '2 edits');
      await soon(async () => assert.equal(await page.$$eval('.drawer .feed-step', (els) => els.length), 2));
      assert.match(await feed(page), /none → Bo/);
      assert.match(await feed(page), /Bo → Cy/);
      await pressText(page, '.drawer .feed-steps', '2 edits');
      await soon(async () => assert.equal(await page.$('.drawer .feed-step'), null));
    });

    scenario('"Show every change" lists the steps, including ones put back', async (page) => {
      await openTask(page, 'build');
      await setPoc(page, 'Bo');
      await setPoc(page, '');
      await soon(async () => assert.equal((await savedTask(page, 'build')).history[0]?.steps?.length, 2));
      // Nothing ended up changed, so there's nothing to list.
      await soon(async () => assert.equal(await heading(page), 'History (0)'));
      await click(page, '.drawer [name=historyDetail]');
      await soon(async () => assert.equal(await entries(page), 2));
      assert.equal(await heading(page), 'History (2)');
      assert.match(await feed(page), /none → Bo/);
      assert.match(await feed(page), /Bo → none/);
      await click(page, '.drawer [name=historyDetail]');
      await soon(async () => assert.equal(await entries(page), 0));
    });

    scenario('a new project starts in planning: changes stay in "Task created" until it is turned off', async (page) => {
      await page.$eval('.sidebar [aria-label="New project"]', (b) => b.click());
      await page.waitForSelector('dialog [name=planning]');
      assert.equal(await page.$eval('dialog [name=planning]', (el) => el.checked), true);
      await page.type('dialog input[type=text]', 'Fresh');
      await page.click('[data-action=save-project]');
      await page.waitForFunction(() => document.querySelector('.main')?.textContent.includes('No tasks yet'));
      await pause(200);
      await click(page, '#quick-add');
      await type(page, 'Design');
      await page.keyboard.press('Enter');
      await openTask(page, 'Design');
      await setPoc(page, 'Bo');
      // A posted update ends a run of quick edits, but not planning.
      await click(page, '.drawer textarea[aria-label="Post an update"]');
      await type(page, 'Scoped');
      await pressText(page, '.drawer button', 'Post update');
      await pause(300);
      await page.select('.drawer [name=status]', 'in_progress');
      const fresh = async () => (await savedProjects(page)).find((p) => p.name === 'Fresh');
      await soon(async () => assert.equal((await fresh()).tasks[0].status, 'in_progress'));
      assert.deepEqual((await fresh()).tasks[0].history.map((e) => e.type), ['create', 'update']);
      await soon(async () => assert.match(await feed(page), /Task created.*Current POC: Bo/s));
      assert.ok(await page.$('.drawer [data-planning-note]'));
      assert.doesNotMatch(await feed(page), /none →/, 'set-up values show what they were set to');

      await page.click('[aria-label="Project settings"]');
      await page.waitForSelector('dialog [name=planning]');
      await page.$eval('dialog [name=planning]', (el) => el.click());
      await page.click('dialog [data-action=save-project]');
      await soon(async () => assert.equal('planning' in (await fresh()), false));
      await soon(async () => assert.equal(await page.$('.drawer [data-planning-note]'), null));
    });
  });
}
