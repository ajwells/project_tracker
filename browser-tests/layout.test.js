// With room to spare, the task panel sits beside the page so all of it stays visible.
// Also the plain-English description of each link.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONCURRENCY, click, launchBrowser, openApp, openTask, pressText, project, savedTask, soon, task, type,
} from './helpers.js';

const projects = () => [
  project('proj', [
    task('pred', { start: '2026-11-11', duration: 5 }),
    task('succ', { start: '2026-11-30', onTimeline: true, deps: [{ taskId: 'pred', type: 'SF', lag: -30 }] }),
    task('free', { startSet: false, deps: [{ taskId: 'pred', type: 'FS', lag: -30 }] }),
    task('gate', { start: '2026-12-15', milestone: true, duration: 0 }),
    task('late', { start: '2027-06-01', duration: 5 }),
    task('firm', { startSet: false, deps: [{ taskId: 'late', type: 'SF', lag: -30 }] }),
  ]),
  project('other', [task('far', { start: '2026-11-02' })]),
];

const edges = (page, selector) => page.$eval(selector, (el) => {
  const b = el.getBoundingClientRect();
  return { left: b.left, right: b.right, width: b.width };
});

describe('the task panel and the page', { concurrency: CONCURRENCY }, () => {
  let browser;
  before(async () => { browser = await launchBrowser(); });
  after(() => browser?.close());

  const scenario = (name, viewport, hash, body, options = {}) => test(name, async () => {
    const app = await openApp(browser, { projects: projects(), hash, viewport, ...options });
    let problems;
    try {
      await body(app.page);
    } finally {
      problems = await app.close();
    }
    assert.deepEqual(problems, []);
  });
  const WIDE = { width: 1400, height: 900 };

  scenario('in a wide window the task list shrinks instead of being covered', WIDE, '#/p/proj/tasks', async (page) => {
    const before = await edges(page, '.main');
    assert.equal(before.right, 1400);
    await openTask(page, 'succ');
    await soon(async () => {
      const main = await edges(page, '.main');
      const panel = await edges(page, '.drawer');
      assert.equal(panel.width, 480);
      assert.ok(main.right <= panel.left + 1, `the page ends at ${main.right}, the panel starts at ${panel.left}`);
      const list = await edges(page, '.table-wrap');
      assert.ok(list.right <= panel.left + 1, `the list ends at ${list.right}`);
    });
    // Nothing on the page sits under the panel: its last column can be reached by scrolling.
    assert.equal(await page.evaluate(() => {
      const panel = document.querySelector('.drawer').getBoundingClientRect();
      return document.elementFromPoint(panel.left - 8, panel.top + 300) !== null
        && !document.querySelector('.drawer').contains(document.elementFromPoint(panel.left - 8, panel.top + 300));
    }), true);

    await page.$eval('.drawer .btn.ghost.icon', (b) => b.click());
    await soon(async () => assert.equal((await edges(page, '.main')).right, 1400));
  });

  scenario('the Gantt chart redraws to fit beside the panel, and back', WIDE, '#/p/proj/gantt', async (page) => {
    await pressText(page, '.seg button', 'Fit');
    await page.waitForSelector('.chart-scroll svg');
    const fits = () => page.$eval('.chart-scroll', (s) => s.scrollWidth <= s.clientWidth + 1);
    const wide = await edges(page, '.chart-scroll');
    assert.equal(await fits(), true);
    await page.evaluate(async () => {
      const { ctx } = await import('/js/ctx.js');
      ctx.openTask('succ');
    });
    await page.waitForSelector('.drawer');
    await soon(async () => {
      const chart = await edges(page, '.chart-scroll');
      const panel = await edges(page, '.drawer');
      assert.ok(chart.right <= panel.left + 1, `the chart ends at ${chart.right}, the panel starts at ${panel.left}`);
      assert.ok(chart.width < wide.width);
      assert.equal(await fits(), true, 'drawn to fit the narrower space, with no sideways scrolling');
    });
    await page.keyboard.press('Escape');
    await soon(async () => {
      assert.equal((await edges(page, '.chart-scroll')).width, wide.width);
      assert.equal(await fits(), true);
      assert.ok(await page.$eval('.gantt-grid', (g) => g.getBoundingClientRect().width) > wide.width - 10, 'drawn back out to the full width');
    });
  });

  scenario('the timeline stays beside the panel', WIDE, '#/p/proj/timeline', async (page) => {
    await page.waitForSelector('.chart-card');
    await page.evaluate(async () => {
      const { ctx } = await import('/js/ctx.js');
      ctx.openTask('succ');
    });
    await page.waitForSelector('.drawer');
    await soon(async () => {
      const card = await edges(page, '.chart-card');
      assert.ok(card.right <= (await edges(page, '.drawer')).left + 1);
    });
  });

  scenario('the banner about saving is not covered', WIDE, '#/p/proj/tasks', async (page) => {
    await openTask(page, 'succ');
    await soon(async () => {
      const banner = await edges(page, '.save-banner');
      assert.ok(banner.right <= (await edges(page, '.drawer')).left + 1);
    });
  });

  scenario('from the list behind it, one click still opens another task', WIDE, '#/p/proj/tasks', async (page) => {
    await openTask(page, 'succ');
    const row = await page.evaluateHandle(() => [...document.querySelectorAll('tr.clickable')].find((r) => r.textContent.includes('free')));
    await click(page, row, { at: 0.2 });
    await soon(async () => assert.equal(await page.$eval('.drawer h2', (e) => e.textContent), 'free'));
  });

  scenario('in a narrower window the panel covers the page, as there is no room', { width: 1000, height: 800 }, '#/p/proj/tasks', async (page) => {
    await openTask(page, 'succ');
    await soon(async () => assert.equal((await edges(page, '.drawer')).width, 480));
    assert.equal((await edges(page, '.main')).right, 1000);
  });

  scenario('on a phone the panel fills the screen', { width: 390, height: 664, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, '#/p/proj/tasks', async (page) => {
    await openTask(page, 'succ');
    await soon(async () => assert.equal((await edges(page, '.drawer')).width, 390));
  });

  const rings = (page) => page.$$eval('[data-selected=ring]', (els) => els.map((e) => e.getAttribute('data-task')));
  const pickOnChart = async (page, id) => {
    const bar = await page.waitForSelector(`.pane-body [data-task="${id}"]:not([data-selected]), .chart-card [data-task="${id}"]:not([data-selected])`);
    await click(page, bar);
  };

  scenario('the Gantt chart highlights the task being edited, and follows the selection', WIDE, '#/p/proj/gantt', async (page) => {
    await page.waitForSelector('.pane-body');
    assert.deepEqual(await rings(page), []);

    await pickOnChart(page, 'succ');
    await soon(async () => assert.deepEqual(await rings(page), ['succ']));
    // Its bar, its name and the row between them are all marked.
    assert.equal(await page.$$eval('.pane-labels [data-selected=band]', (e) => e.length), 1);
    assert.equal(await page.$$eval('.pane-body [data-selected=band]', (e) => e.length), 1);
    const box = await page.$eval('[data-selected=ring]', (r) => {
      const a = r.getBoundingClientRect();
      const b = document.querySelector('.pane-body rect[data-task="succ"]:not([data-selected])').getBoundingClientRect();
      return a.left <= b.left && a.right >= b.right && a.top <= b.top && a.bottom >= b.bottom;
    });
    assert.equal(box, true, 'the ring surrounds the bar');

    await pickOnChart(page, 'pred');
    await soon(async () => assert.deepEqual(await rings(page), ['pred']));
    assert.equal(await page.$eval('.drawer h2', (e) => e.textContent), 'pred');

    await page.keyboard.press('Escape');
    await soon(async () => assert.deepEqual(await rings(page), []));
    assert.equal(await page.$$eval('[data-selected]', (e) => e.length), 0);
  });

  scenario('the highlight stays through a save, and the critical outline stays too', WIDE, '#/p/proj/gantt', async (page) => {
    await page.waitForSelector('.pane-body');
    await pickOnChart(page, 'late');
    await soon(async () => assert.deepEqual(await rings(page), ['late']));
    const outlined = () => page.$eval('.pane-body rect[data-task="late"]:not([data-selected])', (r) => r.getAttribute('stroke'));
    assert.ok(await outlined(), 'late ends the project, so it is critical and outlined');
    await click(page, '.drawer [name=notes]');
    await type(page, 'Saved');
    await click(page, '.drawer [name=pocName]');
    await soon(async () => assert.match(await page.$eval('.feed', (f) => f.textContent), /Notes updated/));
    assert.deepEqual(await rings(page), ['late']);
    assert.ok(await outlined());
  });

  scenario('a milestone is highlighted on the Gantt chart too', WIDE, '#/p/proj/gantt', async (page) => {
    await page.waitForSelector('.pane-body');
    await pickOnChart(page, 'gate');
    await soon(async () => assert.deepEqual(await rings(page), ['gate']));
    assert.equal(await page.$eval('[data-selected=ring]', (r) => r.tagName), 'polygon');
  });

  scenario('clicking the highlight itself does not lose the task', WIDE, '#/p/proj/gantt', async (page) => {
    await page.waitForSelector('.pane-body');
    await pickOnChart(page, 'succ');
    await soon(async () => assert.deepEqual(await rings(page), ['succ']));
    const ring = await page.$('[data-selected=ring]');
    const b = await ring.boundingBox();
    await page.mouse.click(b.x + b.width / 2, b.y + 1, { delay: 60 });
    await soon(async () => assert.equal(await page.$eval('.drawer h2', (e) => e.textContent), 'succ'));
  });

  scenario('the timeline highlights a bar and a milestone', WIDE, '#/p/proj/timeline', async (page) => {
    await page.waitForSelector('.chart-card svg');
    assert.deepEqual(await rings(page), []);
    await pickOnChart(page, 'succ');
    await soon(async () => assert.deepEqual(await rings(page), ['succ']));
    assert.equal(await page.$eval('[data-selected=ring]', (r) => r.tagName), 'rect');
    await pickOnChart(page, 'gate');
    await soon(async () => assert.deepEqual(await rings(page), ['gate']));
    assert.equal(await page.$eval('[data-selected=ring]', (r) => r.tagName), 'polygon');
    await page.keyboard.press('Escape');
    await soon(async () => assert.deepEqual(await rings(page), []));
  });

  scenario('a selected task out of view scrolls into the space beside the panel', WIDE, '#/p/proj/gantt', async (page) => {
    await page.waitForSelector('.pane-body');
    await pressText(page, '.seg button', 'Day');
    await page.waitForSelector('.pane-body');
    await page.$eval('.chart-scroll', (s) => { s.scrollLeft = 0; });
    await page.evaluate(async () => {
      const { ctx } = await import('/js/ctx.js');
      ctx.openTask('late');
    });
    await soon(async () => {
      const seen = await page.evaluate(() => {
        const ring = document.querySelector('[data-selected=ring]').getBoundingClientRect();
        const frame = document.querySelector('.chart-scroll').getBoundingClientRect();
        const names = document.querySelector('.pane-labels').getBoundingClientRect();
        return { left: ring.left, right: ring.right, limitLeft: names.right, limitRight: frame.right };
      });
      assert.ok(seen.left >= seen.limitLeft && seen.right <= seen.limitRight, JSON.stringify(seen));
    });
  });

  scenario('a selected task scrolled off to the left comes back clear of the frozen names', WIDE, '#/p/proj/gantt', async (page) => {
    await page.waitForSelector('.pane-body');
    await pressText(page, '.seg button', 'Day');
    await page.waitForSelector('.pane-body');
    await page.$eval('.chart-scroll', (s) => { s.scrollLeft = s.scrollWidth; });
    await page.evaluate(async () => {
      const { ctx } = await import('/js/ctx.js');
      ctx.openTask('pred');
    });
    await soon(async () => {
      const seen = await page.evaluate(() => ({
        ring: document.querySelector('[data-selected=ring]').getBoundingClientRect().left,
        names: document.querySelector('.pane-labels').getBoundingClientRect().right,
      }));
      assert.ok(seen.ring >= seen.names, JSON.stringify(seen));
    });
  });

  scenario('a save does not pull the chart back to the selected task', WIDE, '#/p/proj/gantt', async (page) => {
    await page.waitForSelector('.pane-body');
    await pressText(page, '.seg button', 'Day');
    await page.waitForSelector('.pane-body');
    await pickOnChart(page, 'succ');
    await soon(async () => assert.deepEqual(await rings(page), ['succ']));
    await page.$eval('.chart-scroll', (s) => { s.scrollLeft = 0; });
    await click(page, '.drawer [name=pocName]');
    await type(page, 'Ana');
    await click(page, '.drawer [name=notes]');
    await soon(async () => assert.match(await page.$eval('.feed', (f) => f.textContent), /Ana/));
    assert.equal(await page.$eval('.chart-scroll', (s) => s.scrollLeft), 0);
  });

  for (const [tab, chart] of [['gantt', '.pane-body'], ['timeline', '.chart-card svg']]) {
    scenario(`the highlight never reaches an export of the ${tab}`, WIDE, `#/p/proj/${tab}`, async (page) => {
      await page.waitForSelector(chart);
      await pickOnChart(page, 'succ');
      await soon(async () => assert.deepEqual(await rings(page), ['succ']));
      // The app's security policy blocks fetching the preview, so catch it as it's made.
      await page.evaluate(() => {
        const make = URL.createObjectURL.bind(URL);
        URL.createObjectURL = (blob) => {
          window.lastBlob = blob;
          return make(blob);
        };
      });
      await pressText(page, 'button', 'Copy for PowerPoint');
      const picture = await soon(async () => {
        const text = await page.evaluate(() => window.lastBlob?.text());
        assert.ok(text);
        return text;
      });
      assert.match(picture, /<svg/);
      assert.doesNotMatch(picture, /data-selected/);
      assert.doesNotMatch(picture, /#e7f0fb|#1d2d44/i, 'no highlighted row');
    });
  }

  scenario('each link says in plain English what it does, and updates as it is changed', WIDE, '#/p/proj/tasks', async (page) => {
    await openTask(page, 'free');
    const plain = () => page.$eval('.dep-row .dep-plain', (p) => p.textContent);
    assert.equal(await plain(), '"free" starts no earlier than 30 working days before "pred" finishes.');

    await page.select('.dep-row select', 'SS');
    await soon(async () => assert.equal(await plain(), '"free" starts 30 working days before "pred" starts.'));
    assert.match(await page.$eval('.dep-row', (r) => r.textContent), /differs from the standard meaning/);

    await click(page, '.dep-row input[type=number]', { at: 0.3 });
    await type(page, '2');
    await page.keyboard.press('Tab');
    await soon(async () => assert.equal(await plain(), '"free" starts no earlier than 2 working days after "pred" starts.'));
    assert.doesNotMatch(await page.$eval('.dep-row', (r) => r.textContent), /differs from the standard meaning/);

    await page.select('.dep-row select', 'FF');
    await soon(async () => assert.equal(await plain(), '"free" finishes no earlier than 2 working days after "pred" finishes.'));
  });

  scenario('a task later than a firm link allows shows a conflict, and is at risk', WIDE, '#/p/proj/tasks', async (page) => {
    await openTask(page, 'succ');
    assert.match(await page.$eval('.dep-row .dep-plain', (p) => p.textContent), /"succ" finishes 30 working days before "pred" starts/);
    assert.match(await page.$eval('.dep-row .dep-standing.bad', (p) => p.textContent), /"succ" is \d+ working days later than this link allows/);
    assert.match(await page.$eval('.drawer-body', (d) => d.textContent), /later than its firm link to "pred" allows/);
    assert.ok(await page.$('.drawer-body .callout.bad'));
    assert.match(await page.$eval('.drawer-body', (d) => d.textContent), /At risk/);
  });

  scenario('a firm link says how it differs from the standard', WIDE, '#/p/proj/tasks', async (page) => {
    await openTask(page, 'succ');
    assert.match(await page.$eval('.dep-row', (r) => r.textContent), /differs from the standard meaning of a negative SS or SF/);
  });

  scenario('a following task on a firm link has no conflict, and is critical with its predecessor', WIDE, '#/p/proj/tasks', async (page) => {
    await openTask(page, 'firm');
    assert.equal(await page.$('.dep-row .dep-standing.bad'), null);
    assert.equal(await page.$('.drawer-body .callout.bad'), null);
    assert.match(await page.$eval('.drawer-body', (d) => d.textContent), /Critical path/);
  }, { firmLeads: undefined });

  scenario('with FIRM_LEADS off, the same link is allowed, with the standard wording', WIDE, '#/p/proj/tasks', async (page) => {
    await openTask(page, 'succ');
    assert.match(await page.$eval('.dep-row .dep-plain', (p) => p.textContent), /"succ" finishes no earlier than 30 working days before "pred" starts/);
    assert.match(await page.$eval('.dep-row .dep-standing', (p) => p.textContent), /"succ" is \d+ working days later than this link requires, which is allowed/);
    assert.doesNotMatch(await page.$eval('.dep-row', (r) => r.textContent), /differs from the standard/);
    assert.equal(await page.$('.drawer-body .callout.bad'), null);
    await pressText(page, 'tr.clickable', 'firm');
    await soon(async () => assert.equal(await page.$eval('.drawer h2', (e) => e.textContent), 'firm'));
    assert.doesNotMatch(await page.$eval('.drawer-body', (d) => d.textContent), /Critical path/);
  }, { firmLeads: false });

  scenario('a task following its link has nothing extra to say', WIDE, '#/p/proj/tasks', async (page) => {
    await openTask(page, 'free');
    assert.equal(await page.$('.dep-row .dep-standing'), null);
  });

  scenario('the predecessor’s panel says the same of what waits on it', WIDE, '#/p/proj/tasks', async (page) => {
    await openTask(page, 'pred');
    const text = await page.$eval('.drawer-body', (d) => d.textContent);
    assert.match(text, /"succ" finishes 30 working days before "pred" starts/);
    assert.match(text, /"free" starts no earlier than 30 working days before "pred" finishes/);
  });

  scenario('the task list explains a link when pointed at', WIDE, '#/p/proj/tasks', async (page) => {
    await page.waitForSelector('.dep-chip');
    assert.equal(await page.$eval('.dep-chip', (c) => c.title), '"succ" finishes 30 working days before "pred" starts.');
  });

  scenario('the cross-project dialog previews its sentence as you choose', WIDE, '#/p/proj/links', async (page) => {
    await pressText(page, 'button', 'Add cross-project link');
    const plain = () => page.$eval('dialog .dep-plain', (p) => p.textContent);
    await page.waitForSelector('dialog .dep-plain');
    assert.equal(await plain(), '"pred" starts after "far" finishes.');
    await (await page.$$('dialog select')).at(-2).select('SF');
    await click(page, 'dialog input[type=number]', { at: 0.3 });
    await type(page, '-30');
    await soon(async () => assert.equal(await plain(), '"pred" finishes 30 working days before "far" starts.'));
  });

  scenario('the Links tab says each link in plain English', WIDE, '#/p/proj/links', async (page) => {
    await pressText(page, 'button', 'Add cross-project link');
    await page.waitForSelector('dialog .dep-plain');
    await pressText(page, 'dialog button', 'Add link');
    await soon(async () => assert.match(await page.$eval('.main', (m) => m.textContent), /"pred" starts after "far" finishes\./));
  });

  for (const [size, viewport] of [['a wide window', WIDE], ['a small phone', { width: 320, height: 640, isMobile: true, hasTouch: true }]]) {
    scenario(`in ${size} the history puts posted updates and recorded changes on opposite sides of the line`, viewport, '#/p/proj/tasks', async (page) => {
      await openTask(page, 'succ');
      const box = '.drawer textarea[aria-label="Post an update"]';
      await click(page, box);
      await type(page, `A${'very'.repeat(40)} long update`);
      await pressText(page, '.drawer button', 'Post update');
      await page.waitForSelector('.feed-item.update');
      await click(page, '.drawer [name=pocName]');
      await type(page, 'Ana');
      await page.keyboard.press('Tab');
      await page.waitForSelector('.feed-change');

      await soon(async () => {
        const feed = await page.$eval('.feed', (f) => {
          const box = f.getBoundingClientRect();
          const line = box.left + box.width / 2;
          return {
            line,
            fits: f.scrollWidth <= f.clientWidth && box.right <= innerWidth,
            sides: [...f.children].map((item) => {
              const content = [...item.children].map((c) => c.getBoundingClientRect());
              const edge = item.classList.contains('update') ? item.getBoundingClientRect().right - 1 : item.getBoundingClientRect().left;
              return {
                kind: item.classList.contains('update') ? 'update' : 'other',
                left: Math.min(...content.map((c) => c.left)),
                right: Math.max(...content.map((c) => c.right)),
                edge,
              };
            }),
          };
        });
        assert.ok(feed.fits, 'the history fits the panel');
        // Newest first, whichever side each entry is on.
        assert.deepEqual(feed.sides.map((s) => s.kind), ['other', 'update']);
        for (const side of feed.sides) {
          assert.ok(Math.abs(side.edge - feed.line) <= 1, `the line stays in one place: ${side.edge} vs ${feed.line}`);
          if (side.kind === 'update') assert.ok(side.right <= feed.line, `update ends left of the line: ${side.right} vs ${feed.line}`);
          else assert.ok(side.left >= feed.line, `change starts right of the line: ${side.left} vs ${feed.line}`);
        }
        assert.deepEqual(await page.$eval('.feed-sides', (s) => [...s.children].map((c) => c.textContent)), ['Updates', 'Changes']);
      });
    });
  }

  // ---- working or calendar days ----

  scenario('counting a duration in calendar days moves the finish and keeps the number', WIDE, '#/p/proj/tasks', async (page) => {
    await openTask(page, 'pred');
    const finish = () => page.$eval('.drawer [name=end]', (el) => el.value);
    assert.equal(await finish(), '2026-11-17');
    await page.select('.drawer [name=durationUnit]', 'calendar');
    await soon(async () => {
      assert.equal(await finish(), '2026-11-15');
      assert.equal(await page.$eval('.drawer [name=duration]', (el) => el.value), '5');
      assert.equal((await savedTask(page, 'pred')).durationUnit, 'calendar');
      assert.equal(await page.$eval('.drawer [name=durationUnit]', (el) => el.value), 'calendar');
      // The task list says which days it means.
      const cell = await page.$eval('tr.clickable td.num.hide-card', (td) => [td.textContent, td.title]);
      assert.deepEqual(cell, ['5cd', '5 calendar days']);
      assert.match(await page.$eval('.feed', (el) => el.textContent), /Duration counts: Working days → Calendar days/);
    });
  });

  scenario('tracked by dates, counting calendar days changes the number and keeps the dates', WIDE, '#/p/proj/tasks', async (page) => {
    await openTask(page, 'pred');
    await page.select('.drawer [name=trackBy]', 'dates');
    await soon(async () => assert.equal(await page.$eval('.drawer [name=end]', (el) => el.disabled), false));
    await page.select('.drawer [name=durationUnit]', 'calendar');
    await soon(async () => {
      assert.equal(await page.$eval('.drawer [name=duration]', (el) => el.value), '7');
      assert.equal(await page.$eval('.drawer [name=end]', (el) => el.value), '2026-11-17');
    });
  });

  scenario('a task with no history has no sides to label', WIDE, '#/p/proj/tasks', async (page) => {
    await openTask(page, 'pred');
    assert.equal(await page.$('.feed-sides'), null);
  });

  scenario('summaries and milestones have no unit to choose', WIDE, '#/p/proj/tasks', async (page) => {
    await openTask(page, 'gate');
    assert.equal(await page.$('.drawer [name=durationUnit]'), null);
  });

  scenario('a link can count calendar days, and its sentence and date follow', WIDE, '#/p/proj/tasks', async (page) => {
    await openTask(page, 'free');
    const plain = () => page.$eval('.dep-row .dep-plain', (el) => el.textContent);
    const start = () => page.$eval('.drawer [name=start]', (el) => el.value);
    assert.match(await plain(), /30 working days before/);
    const working = await start();
    await page.select('.dep-row select[aria-label="Lag counted in"]', 'calendar');
    await soon(async () => {
      assert.match(await plain(), /30 calendar days before/);
      assert.equal((await savedTask(page, 'free')).deps[0].lagUnit, 'calendar');
      assert.equal((await savedTask(page, 'free')).deps[0].lag, -30);
      assert.notEqual(await start(), working);
      assert.equal(await page.$eval('.dep-row select[aria-label="Lag counted in"]', (el) => el.value), 'calendar');
    });
    // Changing another part of the link keeps the unit.
    await page.select('.dep-row select[aria-label="Dependency type"]', 'SS');
    await soon(async () => {
      const [link] = (await savedTask(page, 'free')).deps;
      assert.deepEqual([link.type, link.lagUnit], ['SS', 'calendar']);
    });
    await soon(async () => assert.match(await page.$eval('tr.clickable:nth-child(3) .dep-chip', (el) => el.textContent), /SS-30cd/));
  });

  scenario('the cross-project dialog can count calendar days', WIDE, '#/p/proj/links', async (page) => {
    await pressText(page, 'button', 'Add cross-project link');
    await page.waitForSelector('dialog .dep-plain');
    await click(page, 'dialog input[type=number]', { at: 0.3 });
    await type(page, '4');
    const choices = await page.$$('dialog select');
    await choices.at(-1).select('calendar');
    await soon(async () => assert.match(await page.$eval('dialog .dep-plain', (el) => el.textContent), /4 calendar days after/));
    await pressText(page, 'dialog button', 'Add link');
    await soon(async () => {
      const links = (await savedTask(page, 'pred')).deps;
      assert.deepEqual(links.map((l) => [l.lag, l.lagUnit]), [[4, 'calendar']]);
      assert.match(await page.$eval('.main', (m) => m.textContent), /FS\+4cd/);
    });
  });

  for (const width of [320, 390]) {
    scenario(`at ${width}px every setting on a link fits and can be used`, { width, height: 700, isMobile: true, hasTouch: true }, '#/p/proj/tasks', async (page) => {
      await openTask(page, 'free');
      await page.waitForSelector('.dep-row');
      const layout = await page.$eval('.dep-row', (row) => {
        const box = (el) => el.getBoundingClientRect();
        const outer = box(row);
        const controls = [...row.querySelectorAll('select, input, button.icon')].map(box);
        return {
          scrolls: document.querySelector('.drawer-body').scrollWidth > document.querySelector('.drawer-body').clientWidth,
          inside: controls.every((c) => c.left >= outer.left - 1 && c.right <= outer.right + 1),
          minWidth: Math.min(...controls.map((c) => c.width)),
          sameLine: new Set(controls.map((c) => Math.round(c.top + c.height / 2))).size === 1,
          nameAbove: box(row.querySelector('.dep-name')).bottom <= controls[0].top + 1,
          overlap: controls.some((c, i) => i && c.left < controls[i - 1].right),
          unitClipped: (() => {
            const unit = row.querySelector('select[aria-label="Lag counted in"]');
            return unit.getBoundingClientRect().width < 74;
          })(),
        };
      });
      assert.deepEqual(layout, { ...layout, scrolls: false, inside: true, sameLine: true, nameAbove: true, overlap: false, unitClipped: false });
      assert.ok(layout.minWidth >= 38, `smallest control is ${layout.minWidth}px`);
    });
  }

  // ---- the project's default ----

  const setDefault = async (page, unit) => {
    await page.waitForSelector('[aria-label="Project settings"]');
    await page.click('[aria-label="Project settings"]');
    await page.waitForSelector('dialog [name=defaultDayUnit]');
    await page.select('dialog [name=defaultDayUnit]', unit);
    await page.click('dialog [data-action=save-project]');
    await soon(async () => assert.equal(await page.$('dialog[open]'), null));
  };
  const addTask = async (page, name) => {
    await click(page, 'input[placeholder="Add a task and press Enter"]');
    await type(page, name);
    await page.keyboard.press('Enter');
    await soon(() => openTask(page, name));
  };

  scenario('with a calendar default, new tasks and links count calendar days, and either can be changed', WIDE, '#/p/proj/tasks', async (page) => {
    await setDefault(page, 'calendar');
    // What was already there hasn't changed.
    assert.equal((await savedTask(page, 'pred')).durationUnit ?? 'working', 'working');
    await addTask(page, 'added');
    const unit = () => page.$eval('.drawer [name=durationUnit]', (el) => el.value);
    await soon(async () => assert.equal(await unit(), 'calendar'));

    // Add a predecessor the way the panel does.
    const pickers = await page.$$('.dep-add select');
    await pickers[1].select('pred');
    await pressText(page, '.dep-add button', 'Add');
    const lagUnit = () => page.$eval('.dep-row select[aria-label="Lag counted in"]', (el) => el.value);
    await soon(async () => assert.equal(await lagUnit(), 'calendar'));

    // The default is only a starting point.
    await page.select('.dep-row select[aria-label="Lag counted in"]', 'working');
    await soon(async () => assert.equal(await lagUnit(), 'working'));
    await page.select('.dep-row select[aria-label="Dependency type"]', 'SS');
    await soon(async () => {
      assert.equal(await page.$eval('.dep-row select[aria-label="Dependency type"]', (el) => el.value), 'SS');
      assert.equal(await lagUnit(), 'working');
    });
    await page.select('.drawer [name=durationUnit]', 'working');
    await soon(async () => assert.equal(await unit(), 'working'));
  });

  scenario('the settings dialog shows the saved default, and says it leaves existing work alone', WIDE, '#/p/proj/tasks', async (page) => {
    await setDefault(page, 'calendar');
    await page.click('[aria-label="Project settings"]');
    await page.waitForSelector('dialog [name=defaultDayUnit]');
    assert.equal(await page.$eval('dialog [name=defaultDayUnit]', (el) => el.value), 'calendar');
    assert.match(await page.$eval('dialog', (d) => d.textContent), /Existing tasks and links keep what they count/);
  });

  scenario('the cross-project dialog starts on the waiting project\'s default', WIDE, '#/p/proj/tasks', async (page) => {
    await setDefault(page, 'calendar');
    await page.evaluate(() => { location.hash = '#/p/proj/links'; });
    await pressText(page, 'button', 'Add cross-project link');
    await page.waitForSelector('dialog .dep-plain');
    const selects = await page.$$('dialog select');
    const lagUnit = () => selects.at(-1).evaluate((el) => el.value);
    assert.equal(await lagUnit(), 'calendar');
    await selects[0].select('other');
    await soon(async () => assert.equal(await lagUnit(), 'working'));
  });
});
