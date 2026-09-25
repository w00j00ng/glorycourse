import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { openDesktop } from '../../scripts/runtime-paths.mjs';

test('opens a page in the configured desktop browser', { timeout: 20_000 }, async (t) => {
  let visited;
  const pageOpened = new Promise((resolve) => { visited = resolve; });
  const server = createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end('<title>Glorycourse 브라우저 확인</title><p>브라우저 자동 열기를 확인했습니다. 이 탭을 닫아도 됩니다.</p>');
    if (request.url === '/desktop-check') visited(request.method);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  await openDesktop(`http://127.0.0.1:${server.address().port}/desktop-check`);
  assert.equal(await pageOpened, 'GET');
});
