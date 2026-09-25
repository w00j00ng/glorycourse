import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startLocalServer } from '../../backend/src/server.ts';

test('protected shutdown finishes an accepted save and allows restart with saved data', async (t) => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'glorycourse-shutdown-'));
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  let releaseSave;
  let saveStarted;
  const saving = new Promise((resolve) => { saveStarted = resolve; });
  const proceed = new Promise((resolve) => { releaseSave = resolve; });
  t.after(() => releaseSave());
  const runtime = await startLocalServer({
    dataDirectory, staticDirectory: 'frontend',
    apiHandler: async (request, { store }) => {
      if (request.path !== '/api/v1/save') return;
      saveStarted();
      await proceed;
      await store.write({}, (data) => { data.meta.storeEpoch = 'saved-before-exit'; });
      return { status: 200, json: { saved: true } };
    },
  });
  t.after(() => runtime.close());
  const session = await fetch(`${runtime.origin}/api/v1/session`, { method: 'POST', headers: { Origin: runtime.origin } }).then((r) => r.json());
  const headers = { Origin: runtime.origin, 'X-Glorycourse-Session': session.token };
  for (const supplied of [{ Origin: runtime.origin }, { ...headers, Origin: 'https://other.example' }]) {
    assert.equal((await fetch(`${runtime.origin}/api/v1/shutdown`, { method: 'POST', headers: supplied })).status, 403);
  }
  assert.equal((await fetch(`${runtime.origin}/api/v1/shutdown`, { headers })).status, 405);
  const save = fetch(`${runtime.origin}/api/v1/save`, { method: 'POST', headers });
  await saving;
  let shutdownFinished = false;
  const shutdown = fetch(`${runtime.origin}/api/v1/shutdown`, { method: 'POST', headers }).then(async (r) => {
    const body = await r.json();
    shutdownFinished = true;
    return { status: r.status, body };
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(shutdownFinished, false, 'exit must wait for the accepted save');
  releaseSave();
  assert.equal((await save).status, 200);
  assert.deepEqual(await shutdown, { status: 200, body: { state: 'stopped' } });
  await runtime.close();
  const restarted = await startLocalServer({ dataDirectory, staticDirectory: 'frontend' });
  t.after(() => restarted.close());
  assert.equal(restarted.store.read().meta.storeEpoch, 'saved-before-exit');
});
