// Swiping and tapping on an emulated phone: every page can reach its end, and the
// add box stays docked. Each test has its own server and its own sample projects.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CONCURRENCY, launchBrowser, openApp, pause, pressText, soon } from './helpers.js';

const PORTRAIT = { width: 390, height: 664, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const SIDEWAYS = { ...PORTRAIT, width: 664, height: 390 };
const DESKTOP = { width: 1440, height: 500 };

describe('on a phone', { concurrency: CONCURRENCY }, () => {
  let browser;
  before(async () => { browser = await launchBrowser(); });
  after(() => browser?.close());

  // What a test can do on its page, once the sample projects are in place.
  const tools = (page, cdp, projectId) => {
    const go = async (hash) => {
      await page.evaluate((h) => { location.hash = h; }, hash);
      await pause(300);
    };
    const scrollView = async (top) => {
      await page.evaluate((y) => { document.querySelector('.view').scrollTop = y; }, top);
      await pause(100);
    };
    // Raw touch events, pausing before lifting the finger so there's no fling.
    const swipe = async (direction = 'up', times = 8) => {
      const { width, height } = page.viewport();
      const x = width / 2;
      const from = direction === 'up' ? height * 0.85 : height * 0.35;
      const step = (direction === 'up' ? -1 : 1) * height * 0.05;
      for (let n = 0; n < times; n++) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: from }] });
        for (let i = 1; i <= 10; i++) {
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: from + i * step }] });
          await pause(16);
        }
        await pause(120);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await pause(120);
      }
      await pause(250);
    };
    const whatIsAt = (selector) => page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return 'missing';
      const b = el.getBoundingClientRect();
      const x = b.left + b.width / 2;
      const y = b.top + b.height / 2;
      if (y < 0 || y > innerHeight) return `off screen (y=${Math.round(y)}, screen=${innerHeight})`;
      const hit = document.elementFromPoint(x, y);
      return hit === el || el.contains(hit) ? 'tappable' : `covered by ${hit?.tagName}.${hit?.className}`;
    }, selector);
    const dock = () => page.evaluate(() => {
      const view = document.querySelector('.view');
      const add = document.querySelector('.add-row').getBoundingClientRect();
      const rows = [...document.querySelectorAll('tr.clickable')];
      const last = rows.at(-1).getBoundingClientRect();
      return {
        top: Math.round(view.scrollTop), screen: innerHeight, width: innerWidth,
        addTop: Math.round(add.top), addBottom: Math.round(add.bottom), addLeft: Math.round(add.left), addRight: Math.round(add.right),
        lastTop: Math.round(last.top), lastBottom: Math.round(last.bottom), lastName: rows.at(-1).textContent,
        sideways: view.scrollWidth > view.clientWidth,
      };
    });
    const addTask = async (name) => {
      await page.tap('#quick-add');
      await page.keyboard.type(name);
      await page.keyboard.press('Enter');
    };
    return {
      page, projectId, go, scrollView, swipe, whatIsAt, dock, addTask,
      tasks: `#/p/${projectId}/tasks`,
      gantt: `#/p/${projectId}/gantt`,
      state: () => page.evaluate(() => fetch('/api/state').then((r) => r.json())),
      viewTop: () => page.evaluate(() => Math.round(document.querySelector('.view').scrollTop)),
    };
  };

  const scenario = (name, viewport, body) => test(name, async () => {
    const app = await openApp(browser, { saving: true, viewport });
    let problems;
    try {
      const { page, server } = app;
      await page.goto(server.url, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent.includes('sample')));
      await pressText(page, 'button', 'sample');
      const projectId = await soon(async () => {
        const { projects } = await page.evaluate(() => fetch('/api/state').then((r) => r.json()));
        assert.ok(projects.length);
        return projects[0].id;
      });
      await pause(200);
      await body(tools(page, await page.createCDPSession(), projectId));
    } finally {
      problems = await app.close();
    }
    assert.deepEqual(problems, []);
  });

  for (const [name, hash] of [
    ['overview', () => '#/'],
    ['tasks', (id) => `#/p/${id}/tasks`],
    ['links', (id) => `#/p/${id}/links`],
    ['all-project links', () => '#/portfolio/links'],
    ['timeline', (id) => `#/p/${id}/timeline`],
    ['Gantt', (id) => `#/p/${id}/gantt`],
  ]) {
    scenario(`${name}: swiping reaches the end of the page`, PORTRAIT, async ({ page, projectId, go, swipe }) => {
      await go(hash(projectId));
      await swipe();
      const bottom = await page.evaluate(() => Math.round(document.querySelector('.view').lastElementChild.getBoundingClientRect().bottom));
      assert.ok(bottom <= PORTRAIT.height, `content ends at ${bottom} of ${PORTRAIT.height}`);
    });
  }

  scenario('the add box can be reached and used on a long list', PORTRAIT, async ({ go, tasks, swipe, whatIsAt, state, addTask }) => {
    await go(tasks);
    await swipe();
    assert.equal(await whatIsAt('#quick-add'), 'tappable');
    const count = (await state()).projects[0].tasks.length;
    await addTask('Added from phone');
    await soon(async () => assert.equal((await state()).projects[0].tasks.length, count + 1));
    assert.equal(await whatIsAt('#quick-add'), 'tappable');
  });

  scenario('the add box stays docked wherever the list is scrolled', PORTRAIT, async ({ page, go, tasks, scrollView, dock, whatIsAt }) => {
    await go(tasks);
    await scrollView(0);
    const atTop = await dock();
    assert.equal(atTop.top, 0);
    assert.equal(atTop.addBottom, atTop.screen);
    assert.equal(await whatIsAt('#quick-add'), 'tappable');
    assert.deepEqual([atTop.addLeft, atTop.addRight, atTop.sideways], [0, atTop.width, false]);

    await scrollView(500);
    const middle = await dock();
    assert.equal(middle.top, 500);
    assert.equal(middle.addBottom, middle.screen);

    await page.evaluate(() => { const v = document.querySelector('.view'); v.scrollTop = v.scrollHeight; });
    await pause(100);
    const atEnd = await dock();
    assert.ok(atEnd.lastBottom <= atEnd.addTop, `last task ends ${atEnd.lastBottom}, box starts ${atEnd.addTop}`);
    assert.equal(atEnd.addBottom, atEnd.screen);
  });

  scenario('a task added from the top of the list comes into view, and stays there', PORTRAIT, async ({ page, go, tasks, scrollView, addTask, dock }) => {
    await go(tasks);
    await scrollView(0);
    await addTask('Added from top');
    let added;
    await soon(async () => {
      added = await dock();
      assert.match(added.lastName, /Added from top/);
      assert.ok(added.lastBottom <= added.addTop && added.lastTop >= 0, JSON.stringify(added));
    });
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'quick-add');
    await pause(600); // the live update redraws the page
    assert.equal((await dock()).top, added.top);
  });

  scenario('an empty project keeps the add box above its message', PORTRAIT, async ({ page, go }) => {
    const id = await page.evaluate(async () => (await (await fetch('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Empty' }) })).json()).createdId);
    await go(`#/p/${id}/tasks`);
    const empty = await page.evaluate(() => {
      const add = document.querySelector('.add-row');
      return { position: getComputedStyle(add).position, above: add.getBoundingClientRect().bottom <= document.querySelector('.empty').getBoundingClientRect().top };
    });
    assert.deepEqual(empty, { position: 'static', above: true });
  });

  for (const [name, hash] of [['overview', () => '#/'], ['all-project links', () => '#/portfolio/links'], ['tasks', (id) => `#/p/${id}/tasks`]]) {
    scenario(`${name}: keeps its place when someone else makes a change`, PORTRAIT, async ({ page, projectId, go, scrollView, viewTop }) => {
      await go(hash(projectId));
      await scrollView(150);
      const start = await viewTop();
      assert.ok(start > 0, 'the page should be long enough to scroll');
      await page.evaluate(() => fetch('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: `Other ${Math.random()}` }) }));
      await pause(500);
      assert.equal(await viewTop(), start);
    });
  }

  scenario('a task panel swipes to its end, and closing it returns to the same place', PORTRAIT, async ({ page, go, tasks, scrollView, viewTop, swipe }) => {
    await go(tasks);
    await scrollView(150);
    const start = await viewTop();
    await page.evaluate(() => document.querySelector('tr.clickable').click());
    await page.waitForSelector('.drawer-body');
    await pause(200);
    await swipe();
    assert.ok(await page.$eval('.drawer-body', (b) => Math.abs(b.scrollHeight - b.clientHeight - b.scrollTop) <= 2));
    await page.keyboard.press('Escape');
    await pause(300);
    assert.equal(await viewTop(), start);
  });

  scenario('upright, the Gantt chart scrolls inside its frame', PORTRAIT, async ({ page, go, gantt }) => {
    await go(gantt);
    const frame = await page.evaluate(() => {
      const c = document.querySelector('.chart-scroll');
      const v = document.querySelector('.view');
      return { chartH: c.clientHeight, chartScroll: c.scrollHeight, viewH: v.clientHeight, viewScroll: v.scrollHeight };
    });
    assert.ok(frame.viewScroll <= frame.viewH + 1, JSON.stringify(frame));
    assert.ok(frame.chartScroll > frame.chartH, JSON.stringify(frame));
  });

  scenario('on its side, the Gantt chart has room and scrolls both ways', SIDEWAYS, async ({ page, go, gantt, swipe }) => {
    await go(gantt);
    const chart = () => page.evaluate(() => {
      const c = document.querySelector('.chart-scroll');
      return { height: c.clientHeight, top: c.scrollTop, view: document.querySelector('.view').scrollTop };
    });
    assert.ok((await chart()).height >= 200, `${(await chart()).height}px`);
    await swipe('up');
    assert.ok((await chart()).top > 0);
    await swipe('down');
    const back = await chart();
    assert.deepEqual([back.top, back.view], [0, 0]);
  });

  scenario('on its side, the add box can still be reached', SIDEWAYS, async ({ go, tasks, swipe, whatIsAt }) => {
    await go(tasks);
    await swipe('up', 20);
    assert.equal(await whatIsAt('#quick-add'), 'tappable');
  });

  scenario('on a desktop, the table scrolls in its frame and new tasks come into view', DESKTOP, async ({ page, go, tasks }) => {
    await go(tasks);
    const desk = await page.evaluate(() => {
      const v = document.querySelector('.view');
      const t = document.querySelector('.table-wrap');
      const add = document.querySelector('.add-row');
      return {
        overflow: getComputedStyle(v).overflowY, position: getComputedStyle(add).position,
        scrolls: t.scrollHeight > t.clientHeight, onScreen: add.getBoundingClientRect().bottom <= innerHeight,
      };
    });
    assert.deepEqual(desk, { overflow: 'hidden', position: 'static', scrolls: true, onScreen: true });
    await page.evaluate(() => { document.querySelector('.table-wrap').scrollTop = 0; });
    await page.type('#quick-add', 'Added on desktop');
    await page.keyboard.press('Enter');
    await soon(async () => {
      const added = await page.evaluate(() => {
        const t = document.querySelector('.table-wrap').getBoundingClientRect();
        const r = [...document.querySelectorAll('tr.clickable')].at(-1);
        const b = r.getBoundingClientRect();
        return { name: r.textContent, visible: b.top >= t.top && b.bottom <= t.bottom + 1 };
      });
      assert.match(added.name, /Added on desktop/);
      assert.equal(added.visible, true);
    });
  });
});
