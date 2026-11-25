// The single-file build (npm run build:static) opened straight from disk, with no
// server: it starts, keeps projects in the browser, draws charts and builds exports,
// and never asks for anything over the network.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { click, launchBrowser, newPage, openTask, pause, pressText, soon, tempFolder, type } from './helpers.js';

describe('the single-file build, opened from disk', () => {
  let browser;
  let temp;
  let url;
  before(async () => {
    temp = tempFolder();
    const file = join(temp.folder, 'project-tracker.html');
    execFileSync(process.execPath, ['scripts/build-static.js', file]);
    url = pathToFileURL(file).href;
    browser = await launchBrowser();
  });
  after(async () => {
    await browser?.close();
    temp?.remove();
  });

  const scenario = (name, body) => test(name, async () => {
    const page = await newPage(browser);
    const requests = [];
    page.on('request', (r) => requests.push(r.url()));
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.sidebar .brand');
      await body(page);
    } finally {
      await page.closeAll();
    }
    assert.deepEqual(page.problems, []);
    assert.deepEqual(requests.filter((r) => !/^(file|blob|data):/.test(r)), [], 'nothing goes over the network');
  });

  scenario('starts with no server, saying projects stay in this browser', async (page) => {
    assert.equal(await page.evaluate(() => window.PROJECT_TRACKER_STATIC), true);
    assert.match(await page.$eval('.save-banner', (el) => el.textContent), /Saved only in this browser/);
    assert.equal(await page.$eval('.save-banner', (el) => el.hidden), false);
    assert.equal(await page.evaluate(() => typeof window.PptxGenJS), 'function', 'the PowerPoint library loaded');
  });

  scenario('a project and its tasks are kept, and come back after a reload', async (page) => {
    await page.$eval('.sidebar [aria-label="New project"]', (b) => b.click());
    await page.waitForSelector('dialog input[type=text]');
    await page.type('dialog input[type=text]', 'Offline plan');
    await page.click('[data-action=save-project]');
    await page.waitForFunction(() => document.querySelector('.main')?.textContent.includes('No tasks yet'));
    await pause(200);
    await click(page, '#quick-add');
    await type(page, 'Survey site');
    await page.keyboard.press('Enter');
    await openTask(page, 'Survey site');
    await click(page, '.drawer [name=pocName]');
    await type(page, 'Dee');
    await page.keyboard.press('Tab');
    await soon(async () => {
      const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('tracker.store')));
      assert.equal(saved.projects[0].tasks[0].pocName, 'Dee');
    });

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.sidebar .brand');
    await soon(async () => assert.match(await page.$eval('.sidebar', (el) => el.textContent), /Offline plan/));
    await pressText(page, '.sidebar a, .sidebar button', 'Offline plan');
    await soon(async () => assert.match(await page.$eval('.main', (el) => el.textContent), /Survey site/));
  });

  scenario('sample projects load, and the Gantt chart and its export work', async (page) => {
    await pressText(page, 'button', 'Load sample projects');
    await soon(async () => assert.ok((await page.$$eval('.sidebar .nav-item', (els) => els.length)) > 2));
    const first = await page.$eval('.sidebar a[href^="#/p/"]', (a) => a.getAttribute('href'));
    await page.evaluate((hash) => { location.hash = hash.replace(/\/[^/]*$/, '') + '/gantt'; }, first.replace(/(#\/p\/[^/]+).*/, '$1/x'));
    await page.waitForSelector('.pane-body rect[data-drag=true]');
    await page.click('[data-action=export]');
    await page.waitForFunction(() => document.querySelector('.export-preview img')?.src.startsWith('blob:'));
    await page.waitForFunction(() => document.querySelector('.export-preview img').naturalWidth > 0);
  });
});
