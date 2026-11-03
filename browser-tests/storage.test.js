// Where projects are kept when SAVE_DATA is off and on, with real browser profiles
// and real server restarts. Tests within a group share a page and run in order.

import { after, afterEach, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { launchBrowser, newPage, pause, pressText, soon, startServer, tempFolder, toastText } from './helpers.js';

const RECONNECT = 15000; // how long an open tab may take to notice a restart

let browser;
let temp;
before(async () => {
  temp = tempFolder();
  browser = await launchBrowser();
});
after(async () => {
  await browser?.close();
  temp?.remove();
});

// A server that restarts on the same port, as one group's tests need.
function restartableServer() {
  const holder = {
    current: null,
    restart: async (options) => {
      const port = holder.current?.port;
      await holder.current?.stop();
      holder.current = await startServer({ port, ...options });
    },
  };
  return holder;
}

const stored = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('tracker.store') ?? 'null'));
const sidebar = (page) => page.$eval('.sidebar', (el) => el.textContent);
const main = (page) => page.$eval('.main', (el) => el.textContent);
const bannerShown = (page) => page.$eval('.save-banner', (b) => !b.hidden && b.getBoundingClientRect().height > 0);

const open = async (url, viewport = { width: 1280, height: 800 }) => {
  const page = await newPage(browser, viewport);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.sidebar');
  return page;
};
const hash = async (page, value) => {
  await page.evaluate((h) => { location.hash = h; }, value);
  await pause(250);
};
const addTask = async (page, name) => {
  await page.click('#quick-add');
  await page.keyboard.type(name);
  await page.keyboard.press('Enter');
};
const newProject = async (page, name) => {
  await page.$eval('.sidebar [aria-label="New project"]', (b) => b.click());
  await page.waitForSelector('dialog input[type=text]');
  await page.type('dialog input[type=text]', name);
  await page.click('[data-action=save-project]');
  await soon(async () => assert.ok((await sidebar(page)).includes(name), `${name} should be in the sidebar`));
};
// Records every change sent to the server.
const watchSends = (page) => {
  const sent = [];
  page.on('request', (r) => {
    if (r.method() !== 'GET' && r.url().includes('/api/')) sent.push(`${r.method()} ${r.url()}`);
  });
  return sent;
};

describe('where projects are kept', { concurrency: 3 }, () => {
  describe('with saving off, a browser keeps its own copy', { concurrency: 1 }, () => {
    const host = restartableServer();
    let server;
    const restart = async (options) => {
      await host.restart(options);
      server = host.current;
    };
    let file;
    let page;
    let sent;
    let projectId;
    let projectName;

    before(async () => {
      file = join(temp.folder, 'a', 'store.json');
      await restart({ dataFile: file });
      page = await open(server.url);
      sent = watchSends(page);
    });
    after(async () => {
      const { problems } = page;
      await page.closeAll();
      await server?.stop();
      assert.deepEqual(problems, []);
    });

    test('the server warns about it, and the page shows the banner', async () => {
      assert.match(server.output, /each browser keeps its own/i);
      assert.equal(await bannerShown(page), true);
      assert.match(await main(page), /Plan your first project/);
    });

    test('sample projects are kept in the browser', async () => {
      await pressText(page, 'button', 'Load sample');
      await soon(async () => assert.ok((await stored(page))?.projects.length >= 2));
      ({ id: projectId, name: projectName } = (await stored(page)).projects[0]);
    });

    test('added tasks show on the page and are stored with their history', async () => {
      await hash(page, `#/p/${projectId}/tasks`);
      await addTask(page, 'Browser task');
      await soon(async () => assert.match(await main(page), /Browser task/));
      const added = (await stored(page)).projects[0].tasks.find((t) => t.name === 'Browser task');
      assert.ok(added.history.length > 0);
    });

    test('every chart page draws from the browser data', async () => {
      for (const tab of ['gantt', 'timeline', 'links']) {
        await hash(page, `#/p/${projectId}/${tab}`);
        assert.ok((await main(page)).includes(projectName), tab);
        assert.equal(await bannerShown(page), true, tab);
      }
      await hash(page, '#/portfolio/gantt');
      assert.ok(await page.$('.chart-scroll'));
    });

    test('edits and updates in the task panel are stored', async () => {
      await hash(page, `#/p/${projectId}/tasks`);
      await pressText(page, 'tr', 'Browser task');
      await page.waitForSelector('input[name=pocName]');
      await page.click('input[name=pocName]');
      await page.keyboard.type('Ana Local');
      await page.keyboard.press('Tab');
      await soon(async () => assert.equal((await stored(page)).projects[0].tasks.find((t) => t.name === 'Browser task').pocName, 'Ana Local'));
      await page.type('textarea[aria-label="Post an update"]', 'Local note');
      await pressText(page, 'button', 'Post update');
      await soon(async () => {
        const { history } = (await stored(page)).projects[0].tasks.find((t) => t.name === 'Browser task');
        assert.ok(history.some((h) => h.type === 'update' && h.note === 'Local note'));
        assert.ok(history.some((h) => h.changes?.some((c) => c.field === 'pocName')));
      });
      await page.keyboard.press('Escape');
      await pause(150);
    });

    test('a dependency loop is refused in the browser', async () => {
      const [a, b] = (await stored(page)).projects[0].tasks.filter((t) => !t.deps?.length);
      const refused = await page.evaluate(async (first, second) => {
        const { api } = await import('/js/ctx.js');
        await api('PATCH', `/api/tasks/${second}`, { deps: [{ taskId: first }] });
        return (await api('PATCH', `/api/tasks/${first}`, { deps: [{ taskId: second }] })) === null;
      }, a.id, b.id);
      assert.equal(refused, true);
      assert.match(await toastText(page), /loop/);
    });

    test('nothing reached the server', () => {
      assert.deepEqual(sent, []);
      assert.equal(existsSync(join(temp.folder, 'a')), false);
    });

    test('projects survive a reload and a server restart', async () => {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await soon(async () => assert.match(await main(page), /Browser task/));
      await restart({ dataFile: file });
      await pause(500);
      await addTask(page, 'After restart');
      await soon(async () => assert.match(await main(page), /After restart/));
      await page.reload({ waitUntil: 'domcontentloaded' });
      await soon(async () => {
        assert.match(await main(page), /Browser task/);
        assert.match(await main(page), /After restart/);
      });
    });

    test('two tabs update each other and overwrite nothing', async () => {
      const second = await page.browserContext().newPage();
      await second.setViewport({ width: 1280, height: 800 });
      await second.emulateFocusedPage(true);
      await second.goto(`${server.url}/#/p/${projectId}/tasks`, { waitUntil: 'domcontentloaded' });
      await second.waitForSelector('#quick-add');
      await addTask(page, 'Seen in tab two');
      await soon(async () => assert.match(await main(second), /Seen in tab two/));
      await addTask(second, 'Seen in tab one');
      await soon(async () => assert.match(await main(page), /Seen in tab one/));
      const names = (await stored(page)).projects[0].tasks.map((t) => t.name);
      assert.ok(names.includes('Seen in tab two') && names.includes('Seen in tab one'));
      await second.close();
    });

    test('another browser starts with its own, separate data', async () => {
      const other = await open(server.url);
      assert.match(await main(other), /Plan your first project/);
      await other.closeAll();
    });

    test('a network address over plain HTTP works, as a separate copy', async (t) => {
      const address = Object.values(networkInterfaces()).flat().find((n) => n.family === 'IPv4' && !n.internal)?.address;
      if (!address) {
        t.skip('this computer has no network address');
        return;
      }
      const lan = await page.browserContext().newPage();
      await lan.setViewport({ width: 1280, height: 800 });
      await lan.emulateFocusedPage(true);
      await lan.goto(`http://${address}:${server.port}`, { waitUntil: 'domcontentloaded' });
      await lan.waitForSelector('.sidebar');
      assert.match(await main(lan), /Plan your first project/);
      await newProject(lan, 'Over plain HTTP');
      await lan.close();
    });

    test('export and replace-import carry a browser’s data to another, with no server involved', async () => {
      const downloads = join(temp.folder, 'downloads');
      mkdirSync(downloads);
      const cdp = await page.createCDPSession();
      await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads, browserContextId: page.browserContext().id });
      await pressText(page, '.sidebar a', 'Export all projects');
      let name;
      await soon(async () => {
        name = readdirSync(downloads).find((f) => f.endsWith('.json'));
        assert.ok(name);
        JSON.parse(readFileSync(join(downloads, name), 'utf8'));
      });
      const exported = JSON.parse(readFileSync(join(downloads, name), 'utf8'));
      assert.equal(exported.format, 'project-tracker-export');
      assert.ok(JSON.stringify(exported).includes('Browser task'));
      assert.ok(await page.$('.save-banner a'));

      const other = await open(server.url);
      const sends = watchSends(other);
      await newProject(other, 'To be replaced');
      await pressText(other, '.sidebar button', 'Import projects');
      await other.waitForSelector('dialog input[type=file]');
      await (await other.$('dialog input[type=file]')).uploadFile(join(downloads, name));
      await pause(300);
      await other.evaluate(() => [...document.querySelectorAll('dialog input[type=radio]')].find((r) => /replace/i.test(r.value)).click());
      await pressText(other, 'dialog button', 'Import');
      await soon(async () => assert.match(await other.evaluate(() => [...document.querySelectorAll('dialog[open]')].at(-1)?.textContent ?? ''), /No backup copy is made/));
      assert.doesNotMatch(await other.evaluate(() => [...document.querySelectorAll('dialog[open]')].at(-1).textContent), /data\/backups/);
      await pressText(other, 'dialog[open] button', 'Replace everything');
      await soon(async () => {
        const text = JSON.stringify(await stored(other));
        assert.ok(text.includes('Browser task'));
        assert.ok(!text.includes('To be replaced'));
      });
      assert.deepEqual(sends, []);

      // Full storage, on this browser's copy.
      await other.evaluate(() => {
        let chunk = 'x'.repeat(1024 * 1024);
        for (let n = 0; chunk.length >= 1; n++) {
          try {
            localStorage.setItem(`filler${n}`, chunk);
          } catch {
            chunk = chunk.slice(0, Math.floor(chunk.length / 2));
          }
        }
      });
      const before = JSON.stringify(await stored(other));
      await hash(other, `#/p/${(await stored(other)).projects[0].id}/tasks`);
      await addTask(other, 'Does not fit');
      await soon(async () => assert.match(await toastText(other), /could not store/));
      assert.ok(!(await main(other)).includes('Does not fit'), 'not shown as saved');
      assert.equal(JSON.stringify(await stored(other)), before, 'existing data intact');
      assert.equal(await other.$eval('#quick-add', (i) => i.value), 'Does not fit', 'text kept to retry');
      await other.closeAll();
    });
  });

  describe('changing SAVE_DATA', { concurrency: 1 }, () => {
    const host = restartableServer();
    let server;
    const restart = async (options) => {
      await host.restart(options);
      server = host.current;
    };
    let file;
    let page;
    let sent;
    before(async () => {
      file = join(temp.folder, 'b', 'store.json');
      await restart({ dataFile: file, saving: true });
      page = await open(server.url);
      sent = watchSends(page);
    });
    after(async () => {
      await page.closeAll();
      await server?.stop();
    });

    test('saving on: no banner, written to the file, nothing kept in the browser', async () => {
      assert.equal(await bannerShown(page), false);
      await newProject(page, 'On the server');
      await soon(async () => assert.ok(readFileSync(file, 'utf8').includes('On the server')));
      assert.equal(await stored(page), null);
      assert.ok(sent.some((s) => s.includes('/api/projects')));
    });

    test('turning it off: an open tab moves by itself and copies the server’s projects once', async () => {
      const before = readFileSync(file, 'utf8');
      await restart({ dataFile: file, saving: false });
      await soon(async () => assert.equal(await bannerShown(page), true), RECONNECT);
      await soon(async () => assert.ok((await sidebar(page)).includes('On the server')));
      sent.length = 0;
      await newProject(page, 'Only in browser');
      assert.deepEqual(sent, []);
      assert.equal(readFileSync(file, 'utf8'), before, 'the server file is unchanged');
      assert.match(server.output, /read the projects in the server's data file/);
    });

    test('deleted copies stay deleted after a reload', async () => {
      await page.evaluate(async () => {
        const { api } = await import('/js/ctx.js');
        for (const p of JSON.parse(localStorage.getItem('tracker.store')).projects) await api('DELETE', `/api/projects/${p.id}`);
      });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.sidebar');
      await pause(300);
      assert.ok(!(await sidebar(page)).includes('On the server'));
      await newProject(page, 'Local again');
    });

    test('each mode keeps its own data when switching back and forth', async () => {
      await restart({ dataFile: file, saving: true });
      await soon(async () => {
        assert.equal(await bannerShown(page), false);
        assert.ok((await sidebar(page)).includes('On the server'));
        assert.ok(!(await sidebar(page)).includes('Local again'));
      }, RECONNECT);
      await restart({ dataFile: file, saving: false });
      await soon(async () => {
        assert.equal(await bannerShown(page), true);
        assert.ok((await sidebar(page)).includes('Local again'));
      }, RECONNECT);
    });
  });

  describe('edge cases with saving off', { concurrency: 1 }, () => {
    const host = restartableServer();
    let server;
    const restart = async (options) => {
      await host.restart(options);
      server = host.current;
    };
    let page;
    before(() => restart({ dataFile: join(temp.folder, 'c', 'store.json') }));
    afterEach(() => page?.closeAll());
    after(() => server?.stop());

    test('damaged data is set aside, and the app still opens and says so', async () => {
      page = await open(server.url);
      await page.evaluate(() => localStorage.setItem('tracker.store', '{broken'));
      await page.reload({ waitUntil: 'domcontentloaded' });
      await soon(async () => assert.match(await toastText(page), /could not be read/));
      assert.ok(await sidebar(page));
      assert.equal(await page.evaluate(() => localStorage.getItem('tracker.store.damaged')), '{broken');
      page.problems.length = 0;
    });

    test('on a phone, the banner and docked add box both fit, and tasks are stored', async () => {
      page = await open(server.url, { width: 390, height: 664, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
      await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent.includes('Load sample')));
      await pressText(page, 'button', 'Load sample');
      await soon(async () => assert.ok((await stored(page))?.projects.length));
      await hash(page, `#/p/${(await stored(page)).projects[0].id}/tasks`);
      const fit = await page.evaluate(() => ({
        bottom: Math.round(document.querySelector('.add-row').getBoundingClientRect().bottom),
        banner: document.querySelector('.save-banner').getBoundingClientRect().height > 0,
        fits: document.documentElement.scrollHeight <= innerHeight,
      }));
      assert.deepEqual(fit, { bottom: 664, banner: true, fits: true });
      await page.tap('#quick-add');
      await page.keyboard.type('From phone');
      await page.keyboard.press('Enter');
      await soon(async () => assert.ok(JSON.stringify(await stored(page)).includes('From phone')));
    });
  });
});
