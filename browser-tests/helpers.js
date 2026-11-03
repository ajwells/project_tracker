// Shared by the browser tests: starts the real server, opens real Chrome, and
// clicks and types with human timing. These live outside test/ so `npm test`
// stays fast and needs nothing installed.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { availableParallelism, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Tests in a group run side by side, each with its own server and browser profile.
export const CONCURRENCY = Number(process.env.BROWSER_TEST_CONCURRENCY) || Math.max(2, Math.min(16, Math.floor(availableParallelism() / 2)));

export const pause = (ms) => new Promise((done) => setTimeout(done, ms));

// Retries a check that contains assertions until it passes, so tests wait only as
// long as the page needs. For something that must NOT happen, pause and then assert.
export async function soon(check, timeout = 10000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      return await check();
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await pause(50);
    }
  }
}

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const { PROGRAMFILES = '', 'PROGRAMFILES(X86)': x86 = '', LOCALAPPDATA = '' } = process.env;
  const places = [
    join(PROGRAMFILES, 'Google/Chrome/Application/chrome.exe'),
    join(x86, 'Google/Chrome/Application/chrome.exe'),
    join(LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  return places.find((path) => existsSync(path));
}

export async function launchBrowser() {
  let puppeteer;
  try {
    ({ default: puppeteer } = await import('puppeteer-core'));
  } catch {
    throw new Error('The browser tests need puppeteer-core. Run `npm install` first.');
  }
  const executablePath = findChrome();
  if (!executablePath) throw new Error('Chrome was not found. Set CHROME_PATH to where it is installed.');
  return puppeteer.launch({ executablePath, headless: true, args: process.env.CI ? ['--no-sandbox'] : [] });
}

export function tempFolder() {
  const folder = mkdtempSync(join(tmpdir(), 'tracker-browser-'));
  return { folder, remove: () => rmSync(folder, { recursive: true, force: true, maxRetries: 3 }) };
}

function freePort() {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.on('error', fail);
    probe.listen(0, () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });
}

// Runs index.js exactly as `npm start` does, on its own port and data file. Servers
// starting side by side can pick the same free port, so a clash just tries another.
export async function startServer(options = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await launchServer(options);
    } catch (error) {
      if (options.port || attempt === 5 || !/already in use/.test(error.message)) throw error;
    }
  }
}

async function launchServer({ dataFile, saving, port, firmLeads }) {
  const usedPort = port ?? await freePort();
  const env = { ...process.env, PORT: String(usedPort), DATA_FILE: dataFile, APP_PASSWORD: '' };
  delete env.SAVE_DATA;
  if (saving !== undefined) env.SAVE_DATA = String(saving);
  delete env.FIRM_LEADS;
  if (firmLeads !== undefined) env.FIRM_LEADS = String(firmLeads);
  const child = spawn(process.execPath, ['index.js'], { cwd: ROOT, env });
  const server = {
    port: usedPort,
    url: `http://localhost:${usedPort}`,
    output: '',
    stop: () => new Promise((done) => {
      if (child.exitCode !== null) done();
      else {
        child.once('exit', () => done());
        child.kill();
      }
    }),
  };
  child.stdout.on('data', (text) => { server.output += text; });
  child.stderr.on('data', (text) => { server.output += text; });
  // Only this server's own message counts: another test's could answer on a clashing port.
  const deadline = Date.now() + 15000;
  while (!/is running/.test(server.output)) {
    if (/already in use/.test(server.output) || child.exitCode !== null) {
      await server.stop();
      throw new Error(`The server stopped: ${server.output}`);
    }
    if (Date.now() > deadline) throw new Error(`The server did not start: ${server.output}`);
    await pause(25);
  }
  return server;
}

// Browser messages that are expected: a test restarting the server, or the server
// refusing a bad change, which the page reports in its own words.
const EXPECTED_NOISE = /ERR_CONNECTION_(RESET|REFUSED)|ERR_INCOMPLETE_CHUNKED|status of 40[09]/;

// A page in its own browser profile, so nothing carries over from another test. It
// records script errors, which the check below turns into a test failure.
export async function newPage(browser, viewport = { width: 1280, height: 1100 }) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport(viewport);
  page.problems = [];
  page.on('pageerror', (error) => page.problems.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && !EXPECTED_NOISE.test(message.text())) page.problems.push(message.text());
  });
  page.closeAll = () => context.close();
  // Lets a page keep behaving as focused while others run beside it.
  await page.emulateFocusedPage(true);
  return page;
}

// Puts projects in place the way the app does, in whichever storage mode it's in.
export async function loadProjects(page, url, projects, hash) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.evaluate(async (data) => {
    const file = { format: 'project-tracker-export', schemaVersion: 1, projects: data };
    if ((await fetch('/api/state').then((r) => r.json())).saving) {
      await fetch('/api/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: file, mode: 'replace' }) });
    } else {
      const { LocalStore } = await import('/js/local-store.js');
      new LocalStore().importAll(file, 'replace');
    }
  }, projects);
  await page.goto(`${url}/${hash}`, { waitUntil: 'domcontentloaded' });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.main');
}

export const savedProjects = (page) => page.evaluate(async () => {
  const state = await fetch('/api/state').then((r) => r.json());
  return (state.saving ? state : JSON.parse(localStorage.getItem('tracker.store'))).projects;
});

export const savedTask = async (page, id) => (await savedProjects(page)).flatMap((p) => p.tasks).find((t) => t.id === id);

// A real press and release of the mouse, slow enough to be a person's.
export async function click(page, target, { count = 1, at = 0.5, delay = 70 } = {}) {
  const handle = typeof target === 'string' ? await page.waitForSelector(target) : target;
  await handle.evaluate((el) => el.scrollIntoView({ block: 'nearest' }));
  const box = await handle.boundingBox();
  await page.mouse.click(box.x + box.width * at, box.y + box.height / 2, { count, delay });
  await pause(90);
}

export const type = (page, text) => page.keyboard.type(text, { delay: 35 });

export async function selectAll(page) {
  await page.keyboard.down('Control');
  await page.keyboard.press('a');
  await page.keyboard.up('Control');
}

export const value = (page, selector) => page.$eval(selector, (el) => el.value);

export const toastText = (page) => page.$eval('#toasts', (el) => el.textContent);

// Clicks by what a control says, once it's been drawn, for controls with no better handle.
export const pressText = (page, selector, text) => soon(() => page.evaluate((s, t) => {
  const el = [...document.querySelectorAll(s)].find((e) => e.textContent.includes(t));
  if (!el) throw new Error(`Nothing matching ${s} says "${t}"`);
  el.click();
}, selector, text));

export const openTask = async (page, name) => {
  await pressText(page, 'tr.clickable', name);
  await page.waitForSelector('.drawer');
};

// One test's whole world: a server, a page with these projects, and its clean-up.
export async function openApp(browser, { saving, projects, hash, viewport, firmLeads } = {}) {
  const temp = tempFolder();
  const server = await startServer({ dataFile: join(temp.folder, 'store.json'), saving, firmLeads });
  const page = await newPage(browser, viewport);
  if (projects) await loadProjects(page, server.url, projects, hash);
  return {
    server,
    page,
    close: async () => {
      const { problems } = page;
      await page.closeAll();
      await server.stop();
      temp.remove();
      return problems;
    },
  };
}

export const task = (id, fields = {}) => ({ id, name: id, start: '2026-11-02', duration: 3, deps: [], ...fields });
export const project = (id, tasks) => ({ id, name: id, tasks });
