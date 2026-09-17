import test from 'node:test';
import assert from 'node:assert/strict';
import { createRouter } from '../apps/web/src/http/router.js';

function responseRecorder() {
  return {
    status: 0,
    body: '',
    writeHead(status) { this.status = status; },
    end(body = '') { this.body = body; },
  };
}

test('router distinguishes authenticated desktop routes from public pairing routes', async () => {
  const handler = () => { throw new Error('must not run'); };
  const privateRouter = createRouter([{ method: 'GET', path: '/private', access: 'desktop', handler }]);
  const privateResponse = responseRecorder();
  await privateRouter.dispatch({
    request: { method: 'GET' }, response: privateResponse, url: { pathname: '/private' }, identity: null,
  });
  assert.equal(privateResponse.status, 401);

  const pairingRouter = createRouter([{
    method: 'GET', path: '/pairing', access: 'desktop-public', forbidden: '只能在本机生成配对二维码', handler,
  }]);
  const pairingResponse = responseRecorder();
  await pairingRouter.dispatch({
    request: { method: 'GET' }, response: pairingResponse, url: { pathname: '/pairing' }, identity: null,
  });
  assert.equal(pairingResponse.status, 403);
  assert.match(pairingResponse.body, /只能在本机/);
});
