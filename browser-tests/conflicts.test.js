// A broken link into a task that won't move shows on the Gantt chart and the timeline,
// on both tasks, and a toolbar box turns the marks off for screen and exports alike.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CONCURRENCY, launchBrowser, openApp, pressText, project, soon, task } from './helpers.js';

// "late" runs Jan 18 to 20 and "fixed" is set by hand to start Jan 20, so the link is broken.
const projects = () => [
  project('proj', [
    task('late', { start: '2027-01-18', duration: 3, manual: true, onTimeline: true }),
    task('fixed', { start: '2027-01-20', duration: 5, manual: true, onTimeline: true, deps: [{ taskId: 'late', type: 'FS', lag: 0 }] }),
    task('fine', { start: '2027-01-04', duration: 3, onTimeline: true }),
    task('after', { startSet: false, deps: [{ taskId: 'fine', type: 'FS', lag: 0 }] }),
  ]),
];

const marks = (page, root) => page.$$eval(`${root} [data-conflict]`, (nodes) => nodes.map((n) => ({
  kind: n.tagName.toLowerCase(), task: n.getAttribute('data-task'), text: n.textContent,
})));
const tipOf = (page, root, id) => page.$eval(`${root} rect[data-task="${id}"]:not([data-conflict])`, (n) => n.getAttribute('data-tip'));
const legend = (page) => page.$$eval('.legend', (nodes) => nodes.map((n) => n.textContent).join(' '));

describe('conflict marks on the charts', { concurrency: CONCURRENCY }, () => {
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

  scenario('the Gantt chart marks the task, its name and the broken link', '#/p/proj/gantt', async (page) => {
    await page.waitForSelector('.pane-body');
    await soon(async () => {
      const body = await marks(page, '.pane-body');
      // One badge (circle and "!") on the fixed task, and one broken arrow.
      assert.deepEqual(body.filter((m) => m.kind === 'rect').map((m) => m.task), ['fixed']);
      assert.equal(body.filter((m) => m.kind === 'g').length, 1);
      assert.deepEqual((await marks(page, '.pane-labels')).map((m) => [m.task, m.text]), [['fixed', '!']]);
    });
    assert.match(await legend(page), /Conflict/);
    assert.match(await tipOf(page, '.pane-body', 'fixed'), /! Conflicts with "late", which finishes too late for it/);
    assert.match(await tipOf(page, '.pane-body', 'late'), /! Too late for "fixed"/);
    assert.match(await tipOf(page, '.pane-body', 'late'), /1 day behind/);
    assert.doesNotMatch(await tipOf(page, '.pane-body', 'fine'), /!/);
  });

  scenario('the Conflicts box takes the marks off the Gantt chart and puts them back', '#/p/proj/gantt', async (page) => {
    await soon(async () => assert.ok((await marks(page, '.pane-body')).length > 0));
    await pressText(page, '.toolbar label.check', 'Conflicts');
    await soon(async () => {
      assert.deepEqual(await marks(page, '.pane-body'), []);
      assert.deepEqual(await marks(page, '.pane-labels'), []);
    });
    assert.doesNotMatch(await legend(page), /Conflict/);
    await pressText(page, '.toolbar label.check', 'Conflicts');
    await soon(async () => assert.ok((await marks(page, '.pane-body')).length > 0));
  });

  scenario('the timeline marks both tasks, having no arrows, and its box turns that off', '#/p/proj/timeline', async (page) => {
    await page.waitForSelector('.chart-card svg');
    await soon(async () => assert.deepEqual(
      [...new Set((await marks(page, '.chart-card')).map((m) => m.task))].sort(), ['fixed', 'late'],
    ));
    assert.match(await legend(page), /Conflict/);
    assert.match(await tipOf(page, '.chart-card', 'fixed'), /! Conflicts with "late"/);
    assert.match(await tipOf(page, '.chart-card', 'late'), /! Too late for "fixed"/);
    await pressText(page, '.toolbar label.check', 'Conflicts');
    await soon(async () => assert.deepEqual(await marks(page, '.chart-card'), []));
    assert.doesNotMatch(await legend(page), /Conflict/);
  });

  scenario('the panel of the task that is too late says so, and how far', '#/p/proj/gantt', async (page) => {
    await page.waitForSelector('.pane-labels');
    await page.$eval('.pane-labels text[data-task="late"]:not([data-conflict])', (n) => n.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await page.waitForSelector('.drawer');
    await soon(async () => {
      const text = await page.$eval('.drawer', (d) => d.textContent);
      assert.match(text, /This task is too late for "fixed", which won't move for it\. It needs to finish 1 working day earlier\./);
      assert.match(text, /1 day behind/);
    });
  });
});
