// The base URL shown on the key page has to be the gateway's origin, not the
// dashboard's loopback port, and it must never come from a hard-coded domain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePublicOrigin } from '../public-origin.mjs';

test('an explicit origin wins and loses its trailing slash', () => {
  assert.equal(resolvePublicOrigin({ configured: 'https://api.example.com/', host: '127.0.0.1:3191' }), 'https://api.example.com');
  assert.equal(resolvePublicOrigin({ configured: 'https://api.example.com', host: 'anything' }), 'https://api.example.com');
  assert.equal(resolvePublicOrigin({ configured: '   ', host: '127.0.0.1:3191' }), 'http://127.0.0.1:3190');
});

test('a public host without a port is used as is', () => {
  assert.equal(resolvePublicOrigin({ proto: 'https', host: 'api.example.com' }), 'https://api.example.com');
  // A standard port is equivalent to no port; printing it would look wrong.
  assert.equal(resolvePublicOrigin({ proto: 'https', host: 'api.example.com:443' }), 'https://api.example.com');
  assert.equal(resolvePublicOrigin({ proto: 'http', host: 'api.example.com:80' }), 'http://api.example.com');
});

test('a dashboard port is replaced by the gateway port', () => {
  assert.equal(resolvePublicOrigin({ proto: 'http', host: '127.0.0.1:3191' }), 'http://127.0.0.1:3190');
  assert.equal(resolvePublicOrigin({ proto: 'http', host: 'localhost:8080', gatewayPort: 4000 }), 'http://localhost:4000');
});

test('a host already on the gateway port is kept', () => {
  assert.equal(resolvePublicOrigin({ proto: 'http', host: '127.0.0.1:3190' }), 'http://127.0.0.1:3190');
});

test('the first value of a comma-separated forwarded header is used', () => {
  assert.equal(resolvePublicOrigin({ proto: 'https, http', host: 'api.example.com, proxy.internal' }), 'https://api.example.com');
});

test('IPv6 brackets survive the port rewrite', () => {
  assert.equal(resolvePublicOrigin({ proto: 'http', host: '[::1]:3191' }), 'http://[::1]:3190');
});

test('nothing in the rule assumes a particular deployment', () => {
  // A different domain and a different port pair produce that deployment's URL.
  assert.equal(
    resolvePublicOrigin({ proto: 'https', host: 'gateway.internal:9443', gatewayPort: 9443 }),
    'https://gateway.internal:9443',
  );
  assert.equal(
    resolvePublicOrigin({ proto: 'http', host: 'gateway.internal:8080', gatewayPort: 9090 }),
    'http://gateway.internal:9090',
  );
});
