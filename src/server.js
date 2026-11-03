// HTTP server using only the Node standard library: a JSON API, live-update
// events and the static front end.

import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { timingSafeEqual, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { HttpError, Store } from './store.js';
import { applyChange } from '../public/shared/routes.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = join(ROOT, 'public');
const MAX_BODY = 50 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};

function sendJson(res, status, body, extra = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...extra });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  if (!(req.headers['content-type'] || '').includes('application/json')) {
    throw new HttpError(415, 'Requests must be sent as JSON.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'That file is too large (50 MB limit).');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object') throw new Error();
    return parsed;
  } catch {
    throw new HttpError(400, 'The request was not valid JSON.');
  }
}

function serveStatic(req, res, pathname) {
  const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const filePath = resolve(PUBLIC_DIR, relative);
  if (!filePath.startsWith(PUBLIC_DIR + sep) || relative.split(/[\\/]/).some((p) => p.startsWith('.'))) {
    return sendJson(res, 404, { error: 'Not found.' });
  }
  let info;
  try {
    info = statSync(filePath);
  } catch {
    return sendJson(res, 404, { error: 'Not found.' });
  }
  if (!info.isFile()) return sendJson(res, 404, { error: 'Not found.' });
  res.writeHead(200, {
    'Content-Type': MIME[extname(filePath)] || 'application/octet-stream',
    'Content-Length': info.size,
    'Cache-Control': 'no-cache',
    ...SECURITY_HEADERS,
  });
  if (req.method === 'HEAD') return res.end();
  createReadStream(filePath).pipe(res);
}

function sha(value) {
  return createHash('sha256').update(value).digest();
}

function isAuthorized(req, password) {
  if (!password) return true;
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const supplied = decoded.slice(decoded.indexOf(':') + 1);
  return timingSafeEqual(sha(supplied), sha(password));
}

// A typo must not silently pick a mode: it could lose data, or write data that was meant to stay off disk.
function parseOnOff(name, value, whenUnset) {
  const text = (value ?? '').trim().toLowerCase();
  if (text === '') return whenUnset;
  if (['true', 'on', 'yes', '1'].includes(text)) return true;
  if (['false', 'off', 'no', '0'].includes(text)) return false;
  throw new Error(`${name} must be true or false, not "${value}".`);
}

export const parseSaveData = (value) => parseOnOff('SAVE_DATA', value, false);
export const parseFirmLeads = (value) => parseOnOff('FIRM_LEADS', value, true);

export function createApp({ dataFile, password = process.env.APP_PASSWORD, saving = parseSaveData(process.env.SAVE_DATA), firmLeads = parseFirmLeads(process.env.FIRM_LEADS) } = {}) {
  const store = new Store(dataFile ?? process.env.DATA_FILE ?? join(ROOT, 'data', 'store.json'), { saving, firmLeads });
  const sseClients = new Set();

  store.subscribe((revision) => {
    for (const client of sseClients) client.write(`data: ${revision}\n\n`);
  });

  const route = async (req, res, url) => {
    const { pathname } = url;
    const method = req.method;

    if (method === 'GET' && pathname === '/api/state') return sendJson(res, 200, store.snapshot());
    if (method === 'GET' && pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        ...SECURITY_HEADERS,
      });
      res.write(': connected\n\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }
    if (method === 'GET' && pathname === '/api/export') {
      const stamp = new Date().toISOString().slice(0, 10);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="project-tracker-export-${stamp}.json"`,
        'Cache-Control': 'no-store',
        ...SECURITY_HEADERS,
      });
      return res.end(JSON.stringify(store.exportAll(), null, 2));
    }

    if (method === 'GET') throw new HttpError(404, 'Not found.');
    if (!store.saving) throw new HttpError(409, 'Saving on the server is off, so this server does not accept changes. Reload the page.');
    const body = method === 'DELETE' ? await readJsonOptional(req) : await readJson(req);
    const result = applyChange(store, method, pathname, body);
    return sendJson(res, result.status, result.body);
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const hostHeader = (req.headers.host || '').toLowerCase();

      if (!isAuthorized(req, password)) {
        return sendJson(res, 401, { error: 'Password required.' }, { 'WWW-Authenticate': 'Basic realm="Project Tracker", charset="UTF-8"' });
      }
      if (url.pathname.startsWith('/api/')) {
        // Blocks cross-site writes from other pages open in the same browser.
        const origin = req.headers.origin;
        if (req.method !== 'GET' && origin && new URL(origin).host.toLowerCase() !== hostHeader) {
          return sendJson(res, 403, { error: 'Cross-site requests are not allowed.' });
        }
        return await route(req, res, url);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed.' });
      return serveStatic(req, res, url.pathname);
    } catch (error) {
      if (error instanceof HttpError) return sendJson(res, error.status, { error: error.message });
      if (error instanceof URIError || error instanceof TypeError && error.code === 'ERR_INVALID_URL') {
        return sendJson(res, 400, { error: 'Bad request.' });
      }
      console.error(error);
      if (!res.headersSent) sendJson(res, 500, { error: 'Something went wrong on the server.' });
      else res.end();
    }
  });

  server.on('close', () => {
    for (const client of sseClients) client.end();
  });
  // Lets close() finish even with live-update connections open.
  const closeAll = () =>
    new Promise((done) => {
      for (const client of sseClients) client.end();
      server.close(done);
      server.closeAllConnections();
    });

  return { server, store, close: closeAll };
}

async function readJsonOptional(req) {
  if ((req.headers['content-type'] || '').includes('application/json')) return readJson(req);
  req.resume();
  return {};
}

export function startServer({ port = Number(process.env.PORT) || 3000 } = {}) {
  let saving;
  try {
    saving = parseSaveData(process.env.SAVE_DATA);
    parseFirmLeads(process.env.FIRM_LEADS);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  const { server, store } = createApp({ saving });
  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`Port ${port} is already in use. Set the PORT environment variable to use another one.`);
      process.exit(1);
    }
    throw error;
  });
  server.listen(port, '0.0.0.0', () => {
    console.log(`\n  Project Tracker is running\n\n  This computer:  http://localhost:${port}`);
    for (const list of Object.values(networkInterfaces())) {
      for (const net of list ?? []) {
        if (net.family === 'IPv4' && !net.internal) console.log(`  Your network:   http://${net.address}:${port}`);
      }
    }
    if (!process.env.APP_PASSWORD && (saving || store.state.projects.length)) {
      console.log(saving
        ? '\n  Warning: anyone on this network can open and edit your projects.'
        : '\n  Warning: anyone on this network can read the projects in the server\'s data file.');
      console.log('  Set the APP_PASSWORD environment variable to require a password.');
    }
    if (!saving) {
      console.log('\n  Warning: saving on the server is off. Each browser keeps its own projects,');
      console.log('  so they are not shared between people or devices.');
      console.log('  Set the SAVE_DATA environment variable to true to save them here instead.');
    }
    console.log('');
  });
  return server;
}
