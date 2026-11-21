import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { listenOnLoopback } from './http-listener.mjs';

for (const [host, expectedAddress] of [
  [undefined, '127.0.0.1'],
  ['127.0.0.1', '127.0.0.1'],
  ['localhost', '127.0.0.1'],
  ['::1', '::1'],
]) {
  test(`${host ?? 'default'} binds to ${expectedAddress}`, async (t) => {
    const server = createServer();
    t.after(() => server.close());

    let url;
    listenOnLoopback(server, 0, (boundUrl) => { url = new URL(boundUrl); }, host);
    await once(server, 'listening');
    const { address, port } = server.address();
    assert.equal(address, expectedAddress);
    assert.equal(Number(url.port), port);
    assert.equal(url.hostname, host === '::1' ? '[::1]' : expectedAddress);
    assert.equal(url.pathname, '/mcp');
  });
}

for (const host of ['0.0.0.0', '::', '', 'example.test']) {
  test(`MCP_HOST=${JSON.stringify(host)} is rejected before listen`, (t) => {
    const server = createServer();
    const listen = t.mock.method(server, 'listen', () => {});
    assert.throws(
      () => listenOnLoopback(server, 0, () => {}, host),
      /backend Bearer verification is not implemented.*docs\/adr\/0001-mcp-http-authorization\.md/,
    );
    assert.equal(listen.mock.callCount(), 0);
  });
}
