// HTTP server using only the Node standard library: a JSON API, live-update
// events and the static front end.

import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { timingSafeEqual, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { HttpError, Store } from './store.js';
import { buildSample } from './sample.js';

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

export function createApp({ dataFile, lan = false, password = process.env.APP_PASSWORD } = {}) {
  const store = new Store(dataFile ?? process.env.DATA_FILE ?? join(ROOT, 'data', 'store.json'));
  const sseClients = new Set();

  store.subscribe((revision) => {
    for (const client of sseClients) client.write(`data: ${revision}\n\n`);
  });

  const route = async (req, res, url) => {
    const { pathname } = url;
    const method = req.method;
    const parts = pathname.split('/').filter(Boolean).slice(1); // drop "api"
    const ok = () => sendJson(res, 200, store.snapshot());

    if (method === 'GET' && pathname === '/api/state') return ok();
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
    const body = method === 'DELETE' ? await readJsonOptional(req) : await readJson(req);
    const actor = body.actor;

    if (method === 'POST' && pathname === '/api/projects') {
      const id = store.createProject(body);
      return sendJson(res, 201, { ...store.snapshot(), createdId: id });
    }
    if (method === 'POST' && pathname === '/api/import') {
      const result = store.importAll(body.data, body.mode);
      return sendJson(res, 200, { ...store.snapshot(), importResult: result });
    }
    if (method === 'POST' && pathname === '/api/sample') {
      const result = store.importAll(buildSample(store.snapshot().today), 'merge');
      return sendJson(res, 200, { ...store.snapshot(), importResult: result });
    }
    if (parts[0] === 'projects' && parts[1]) {
      const id = parts[1];
      if (parts.length === 2 && method === 'PATCH') {
        store.updateProject(id, body);
        return ok();
      }
      if (parts.length === 2 && method === 'DELETE') {
        store.deleteProject(id, actor);
        return ok();
      }
      if (parts[2] === 'tasks' && parts.length === 3 && method === 'POST') {
        const taskId = store.createTask(id, body);
        return sendJson(res, 201, { ...store.snapshot(), createdId: taskId });
      }
      if (parts[2] === 'baseline' && parts.length === 3) {
        if (method === 'POST') store.setBaseline(id, true);
        else if (method === 'DELETE') store.setBaseline(id, false);
        else throw new HttpError(405, 'Method not allowed.');
        return ok();
      }
    }
    if (parts[0] === 'tasks' && parts[1]) {
      const id = parts[1];
      if (parts.length === 2 && method === 'PATCH') {
        store.updateTask(id, body);
        return ok();
      }
      if (parts.length === 2 && method === 'DELETE') {
        store.deleteTask(id, actor);
        return ok();
      }
      if (parts[2] === 'updates' && parts.length === 3 && method === 'POST') {
        store.addUpdate(id, body);
        return ok();
      }
      if (parts[2] === 'move' && parts.length === 3 && method === 'POST') {
        store.moveTask(id, body.direction, actor);
        return ok();
      }
    }
    throw new HttpError(404, 'Not found.');
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const hostHeader = (req.headers.host || '').toLowerCase();
      const hostname = hostHeader.replace(/:\d+$/, '');

      // Blocks DNS rebinding: in local mode only local hostnames are served.
      if (!lan && !['localhost', '127.0.0.1', '[::1]'].includes(hostname)) {
        return sendJson(res, 403, { error: 'This server only accepts local connections. Start it with --lan to share it.' });
      }
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

export function startServer({ lan = false, port = Number(process.env.PORT) || 3000 } = {}) {
  const host = lan ? '0.0.0.0' : '127.0.0.1';
  const { server } = createApp({ lan });
  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`Port ${port} is already in use. Set the PORT environment variable to use another one.`);
      process.exit(1);
    }
    throw error;
  });
  server.listen(port, host, () => {
    console.log(`\n  Project Tracker is running\n\n  This computer:  http://localhost:${port}`);
    if (lan) {
      for (const list of Object.values(networkInterfaces())) {
        for (const net of list ?? []) {
          if (net.family === 'IPv4' && !net.internal) console.log(`  Your network:   http://${net.address}:${port}`);
        }
      }
      if (!process.env.APP_PASSWORD) {
        console.log('\n  Warning: anyone on this network can open and edit your projects.');
        console.log('  Set the APP_PASSWORD environment variable to require a password.');
      }
    } else {
      console.log('  To open it on your phone, restart with: npm run start:lan');
    }
    console.log('');
  });
  return server;
}
