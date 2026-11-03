// Editing a task in the panel, the way a person does, in both storage modes. Saving
// must never swallow a click, undo an earlier change or leave other fields out of date.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  click, CONCURRENCY, launchBrowser, openApp, openTask, pause, pressText, project, savedTask, selectAll, soon,
  task, toastText, type, value,
} from './helpers.js';

const projects = () => [project('proj', [
  task('pred', { start: '2026-11-11', duration: 5 }),
  task('other', { start: '2026-11-11', duration: 5 }),
  task('succ', { startSet: false, deps: [{ taskId: 'pred', type: 'FS', lag: 0 }] }),
])];

const focused = (page) => page.evaluate(() => document.activeElement?.name || document.activeElement?.tagName);
const checkbox = (page, label) => page.evaluateHandle((text) => [...document.querySelectorAll('.drawer label.check')]
  .find((l) => l.textContent.includes(text)).querySelector('input'), label);

for (const [mode, saving] of [['browser storage', undefined], ['server storage', true]]) {
  describe(`editing a task, ${mode}`, { concurrency: CONCURRENCY }, () => {
    let browser;
    before(async () => { browser = await launchBrowser(); });
    after(() => browser?.close());

    const scenario = (name, body) => test(name, async () => {
      const app = await openApp(browser, { saving, projects: projects(), hash: '#/p/proj/tasks', viewport: { width: 1280, height: 1100 } });
      let problems;
      try {
        await openTask(app.page, 'succ');
        await body({ page: app.page, saved: () => savedTask(app.page, 'succ') });
      } finally {
        problems = await app.close();
      }
      assert.deepEqual(problems, []);
    });

    scenario('clicking from one field into the next lands there, and both save', async ({ page, saved }) => {
      await click(page, '.drawer [name=name]');
      await selectAll(page);
      await type(page, 'Renamed');
      await click(page, '.drawer [name=pocName]');
      assert.equal(await focused(page), 'pocName');
      await type(page, 'Ana');
      await click(page, '.drawer [name=notes]');
      await soon(async () => {
        const s = await saved();
        assert.equal(s.name, 'Renamed');
        assert.equal(s.pocName, 'Ana');
      });
    });

    scenario('one click on a checkbox works right after typing', async ({ page, saved }) => {
      await click(page, '.drawer [name=name]');
      await type(page, 'X');
      await click(page, await checkbox(page, 'Show on timeline'));
      await soon(async () => assert.equal((await saved()).onTimeline, true));
    });

    scenario('changing a link type and then its lag keeps both', async ({ page, saved }) => {
      await page.focus('.dep-row select');
      await page.keyboard.type('S'); // picks SS with the select focused
      await page.keyboard.press('Tab');
      await pause(60);
      await type(page, '-2');
      await page.keyboard.press('Tab');
      await soon(async () => {
        const [link] = (await saved()).deps;
        assert.deepEqual([link.type, link.lag], ['SS', -2]);
      });
    });

    scenario('pressing Enter updates the fields that depend on it', async ({ page, saved }) => {
      await click(page, '.drawer [name=duration]');
      await selectAll(page);
      await type(page, '7');
      await page.keyboard.press('Enter');
      await soon(async () => {
        assert.equal((await saved()).duration, 7);
        assert.equal(await value(page, '.drawer [name=end]'), (await saved()).schedEnd);
      });
    });

    scenario('choosing a status updates the panel without another click', async ({ page, saved }) => {
      await page.focus('.drawer [name=status]');
      await page.keyboard.type('C');
      await soon(async () => assert.match(await page.$eval('.drawer-body', (d) => d.textContent), /Completed tasks stay put/));
    });

    scenario('a date typed with the keyboard saves once', async ({ page, saved }) => {
      await page.focus('.drawer [name=start]');
      await type(page, '12012026');
      await page.keyboard.press('Tab');
      const starts = async () => (await saved()).history.flatMap((h) => h.changes ?? []).filter((c) => c.field === 'start').map((c) => c.to);
      await soon(async () => assert.deepEqual(await starts(), ['2026-12-01']));
      await click(page, '.drawer [name=notes]');
      await pause(150);
      assert.deepEqual(await starts(), ['2026-12-01']);
    });

    scenario('Enter saves a typed date, and Finish follows', async ({ page, saved }) => {
      await page.focus('.drawer [name=start]');
      await type(page, '12012026');
      await page.keyboard.press('Enter');
      await soon(async () => {
        const s = await saved();
        assert.equal(s.start, '2026-12-01');
        assert.equal(await value(page, '.drawer [name=end]'), s.schedEnd);
      });
    });

    scenario('years that are too short or too long are refused, and the date goes back', async ({ page, saved }) => {
      await page.focus('.drawer [name=start]');
      await type(page, '12012026');
      await page.keyboard.press('Enter');
      await soon(async () => assert.equal((await saved()).start, '2026-12-01'));

      await type(page, '10126'); // still on the year part, as someone carrying on typing is
      await page.keyboard.press('Tab');
      await click(page, '.drawer [name=notes]');
      await soon(async () => assert.equal(await value(page, '.drawer [name=start]'), '2026-12-01'));

      await page.focus('.drawer [name=start]');
      await type(page, '010126');
      await page.keyboard.press('Tab');
      await soon(async () => {
        assert.equal(await value(page, '.drawer [name=start]'), '2026-12-01');
        assert.match(await toastText(page), /four-digit/);
      });
      assert.equal((await saved()).start, '2026-12-01');
    });

    scenario('a date picked from the calendar saves right away', async ({ page, saved }) => {
      await page.$eval('.drawer [name=start]', (el) => {
        el.value = '2026-12-07';
        el.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await soon(async () => assert.equal((await saved()).start, '2026-12-07'));
    });

    scenario('saving updates the panel in place', async ({ page, saved }) => {
      await page.evaluate(() => {
        window.kept = { field: document.querySelector('.drawer [name=name]'), panel: document.querySelector('.drawer') };
      });
      await click(page, '.drawer [name=pocName]');
      await type(page, 'Bo');
      await click(page, '.drawer [name=notes]');
      await soon(async () => assert.equal((await saved()).pocName, 'Bo'));
      await pause(100);
      assert.deepEqual(await page.evaluate(() => [window.kept.field.isConnected, window.kept.panel.isConnected]), [true, true]);
    });

    scenario('a field never falls back to its old value while saving', async ({ page, saved }) => {
      await page.evaluate(() => {
        window.seen = [];
        const look = () => window.seen.push(document.querySelector('.drawer [name=duration]')?.value);
        new MutationObserver(look).observe(document.body, { subtree: true, childList: true, attributes: true });
      });
      await click(page, '.drawer [name=duration]');
      await selectAll(page);
      await type(page, '9');
      await click(page, '.drawer [name=notes]');
      await soon(async () => assert.equal((await saved()).duration, 9));
      await pause(150);
      const seen = await page.evaluate(() => window.seen);
      assert.equal(seen.at(-1), '9');
      assert.ok(!seen.slice(seen.indexOf('9')).includes('3'), JSON.stringify(seen));
    });

    scenario('the panel keeps its scroll position when saving', async ({ page, saved }) => {
      await page.$eval('.drawer-body', (d) => { d.scrollTop = 200; });
      const top = () => page.$eval('.drawer-body', (d) => d.scrollTop);
      const before = await top();
      assert.ok(before > 0, 'the panel should be long enough to scroll');
      await page.focus('.drawer [name=notes]');
      await type(page, 'note');
      await page.keyboard.press('Tab');
      await soon(async () => assert.equal((await saved()).notes, 'note'));
      assert.ok(Math.abs(await top() - before) < 40, `${before} to ${await top()}`);
    });

    scenario('adding and removing predecessors edits the right links', async ({ page, saved }) => {
      const taskSelect = '.dep-add select:nth-child(2)';
      await page.select(taskSelect, 'other');
      await click(page, '.drawer [name=notes]');
      assert.equal(await value(page, taskSelect), 'other', 'the choice stays after clicking elsewhere');

      await pressText(page, '.dep-add button', 'Add');
      await soon(async () => {
        assert.deepEqual((await saved()).deps.map((d) => d.taskId), ['pred', 'other']);
        assert.equal(await page.$$eval('.dep-row', (rows) => rows.length), 2);
        assert.equal(await value(page, taskSelect), '');
      });

      await page.$eval('.dep-row .btn.ghost.icon', (b) => b.click());
      await soon(async () => assert.deepEqual((await saved()).deps.map((d) => d.taskId), ['other']));

      await page.select('.dep-row select', 'FF');
      await soon(async () => {
        const [link] = (await saved()).deps;
        assert.deepEqual([link.taskId, link.type], ['other', 'FF']);
      });
    });

    scenario('posting an update empties the box and shows it in the history', async ({ page, saved }) => {
      const box = '.drawer textarea[aria-label="Post an update"]';
      await click(page, box);
      await type(page, 'Halfway there');
      await pressText(page, '.drawer button', 'Post update');
      await soon(async () => {
        assert.ok((await saved()).history.some((h) => h.type === 'update' && h.note === 'Halfway there'));
        assert.equal(await value(page, box), '');
        assert.match(await page.$eval('.feed', (d) => d.textContent), /Halfway there/);
      });
    });

    scenario('a change from elsewhere does not disturb what someone is typing', async ({ page, saved }) => {
      await click(page, '.drawer [name=pocName]');
      await type(page, 'Half typ');
      await page.evaluate(async () => {
        if ((await fetch('/api/state').then((r) => r.json())).saving) {
          await fetch('/api/tasks/succ', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notes: 'From elsewhere' }) });
        } else {
          const { LocalStore } = await import('/js/local-store.js');
          new LocalStore().updateTask('succ', { notes: 'From elsewhere' });
          dispatchEvent(new StorageEvent('storage', { key: 'tracker.store' }));
        }
      });
      await soon(async () => assert.equal(await value(page, '.drawer [name=notes]'), 'From elsewhere'));
      assert.equal(await value(page, '.drawer [name=pocName]'), 'Half typ');
      assert.equal(await focused(page), 'pocName');

      await type(page, 'ed');
      await page.keyboard.press('Tab');
      await soon(async () => {
        const s = await saved();
        assert.deepEqual([s.pocName, s.notes], ['Half typed', 'From elsewhere']);
      });
    });

    scenario('the progress label follows the slider, and the value saves', async ({ page, saved }) => {
      const slider = '.drawer input[type=range]';
      await page.$eval(slider, (r) => {
        r.value = 40;
        r.dispatchEvent(new Event('input', { bubbles: true }));
      });
      assert.equal(await page.$eval('.drawer label .num', (n) => n.textContent), '40%');
      await page.$eval(slider, (r) => r.dispatchEvent(new Event('change', { bubbles: true })));
      await soon(async () => {
        const s = await saved();
        assert.deepEqual([s.progress, s.status], [40, 'in_progress']);
      });
    });

    scenario('one click on the list behind the panel saves the field and opens that task', async ({ page, saved }) => {
      await click(page, '.drawer [name=pocName]');
      await type(page, 'Cy');
      const row = await page.evaluateHandle(() => [...document.querySelectorAll('tr.clickable')].find((r) => r.textContent.includes('pred')));
      await click(page, row, { at: 0.12 });
      await soon(async () => {
        assert.equal((await saved()).pocName, 'Cy');
        assert.equal(await page.$eval('.drawer h2', (e) => e.textContent), 'pred');
        assert.equal(await value(page, '.drawer [name=name]'), 'pred');
      });
    });

    scenario('a checkbox follows repeated single clicks', async ({ page, saved }) => {
      for (const expected of [true, false, true]) {
        await click(page, await checkbox(page, 'Manually'));
        await soon(async () => {
          assert.equal((await saved()).manual, expected);
          assert.equal(await (await checkbox(page, 'Manually')).evaluate((i) => i.checked), expected);
        });
      }
    });

    scenario('opening another task starts at the top of the panel', async ({ page, saved }) => {
      await page.$eval('.drawer-body', (d) => { d.scrollTop = 300; });
      await pressText(page, 'tr.clickable', 'other');
      await soon(async () => {
        assert.equal(await page.$eval('.drawer h2', (e) => e.textContent), 'other');
        assert.equal(await page.$eval('.drawer-body', (d) => d.scrollTop), 0);
      });
    });
  });
}
