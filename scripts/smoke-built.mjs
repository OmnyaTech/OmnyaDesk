import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

const socket = createServer();
await new Promise((resolve, reject) => {
  socket.once('error', reject);
  socket.listen(0, '127.0.0.1', resolve);
});
const port = socket.address().port;
await new Promise((resolve) => socket.close(resolve));

const smokeEnv = { ...process.env };
delete smokeEnv.DATABASE_URL; // The legacy smoke exercises the mock even during PostgreSQL CI.
const child = spawn(process.execPath, ['dist/apps/api/src/main.js'], {
  cwd: process.cwd(),
  env: { ...smokeEnv, OMNYA_HOST: '127.0.0.1', OMNYA_PORT: String(port) },
  stdio: 'ignore',
  windowsHide: true,
});
const base = 'http://127.0.0.1:' + port;
let outcome = false;
try {
  let response;
  for (let i = 0; i < 50; i++) {
    if (child.exitCode !== null) throw new Error('Compiled server stopped early');
    try { response = await fetch(base + '/api/health'); break; }
    catch { await delay(100); }
  }
  assert.ok(response, 'Compiled server did not start');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).mode, 'mock-in-memory');
  const html = await fetch(base + '/');
  assert.equal(html.status, 200);
  assert.match(await html.text(), /OmnyaDesk/);
  const created = await fetch(base + '/api/tasks', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({title: 'S02 compiled smoke', description: 'Testing compiled JS'}),
  });
  assert.equal(created.status, 201);
  const task = (await created.json()).task;
  assert.equal(task.status, 'created');
  outcome = true;
  console.log('PASS: compiled API health, HTML asset and task creation');
} finally {
  const waitExit = new Promise((resolve) => child.once('exit', resolve));
  if (child.exitCode === null) child.kill();
  await Promise.race([waitExit, delay(5000).then(() => { throw new Error('Server shutdown timed out'); })]);
}
if (!outcome) process.exitCode = 1;
