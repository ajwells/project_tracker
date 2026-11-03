// The test servers themselves. A failed restart once made a whole run wait forever.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { startServer, tempFolder } from './helpers.js';

const temp = tempFolder();
after(() => temp.remove());
const dataFile = (name) => join(temp.folder, name, 'store.json');
const LIMIT = { timeout: 30000 };

test('a server can be stopped again after it has stopped', LIMIT, async () => {
  const server = await startServer({ dataFile: dataFile('twice') });
  await server.stop();
  await server.stop();
});

test('restarting on the same port waits for it to come free', LIMIT, async () => {
  const first = await startServer({ dataFile: dataFile('wait') });
  await first.stop();
  const holder = createServer();
  await new Promise((done) => holder.listen(first.port, '0.0.0.0', done));
  setTimeout(() => holder.close(), 1000);
  const second = await startServer({ dataFile: dataFile('wait'), port: first.port });
  assert.equal(second.port, first.port);
  assert.equal((await fetch(`${second.url}/api/state`)).status, 200);
  await second.stop();
});

test('a port that stays taken is reported, not waited on forever', LIMIT, async () => {
  const first = await startServer({ dataFile: dataFile('taken') });
  await assert.rejects(startServer({ dataFile: dataFile('taken'), port: first.port }), /already in use/);
  await first.stop();
});

test('a server that will restart gets a port the system won\'t hand to another', LIMIT, async () => {
  const server = await startServer({ dataFile: dataFile('steady'), steadyPort: true });
  assert.ok(server.port < 32768, `port ${server.port} is in the range the system hands out`);
  await server.stop();
});

test('other servers get ports the system picks', LIMIT, async () => {
  const server = await startServer({ dataFile: dataFile('any') });
  assert.ok(server.port >= 32768, `port ${server.port}`);
  await server.stop();
});
