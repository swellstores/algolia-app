import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { adminSyncPage, publicContext } from '../worker/swell-server.ts';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const origin = 'https://app.example.invalid';
const headers = {
  'Swell-Store-Id': 'example', 'Swell-Public-Key': 'public-fixture-key',
  'Swell-Admin-Url': 'https://example.swell.store',
  'Swell-API-Host': 'https://api.example.invalid',
  'Swell-Access-Token': 'private-fixture-token',
  'Swell-App-Id': 'algolia',
};
const request = (cookie, { body = { page: 1 }, extra = {} } = {}) => new Request(`${origin}/app-api/admin/sync`, {
  method: 'POST',
  headers: {
    ...headers, Origin: origin, 'Content-Type': 'application/json',
    ...(cookie ? { Cookie: cookie } : {}), ...extra,
  },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});
const validSession = () => Response.json({ user_id: 'staff', client_id: 'example' });

test('runtime context contains public fields only', async () => {
  const result = await publicContext(request()).json();
  assert.equal(result.storeId, 'example');
  assert.equal(result.storefrontApiOrigin, 'https://example.swell.store');
  assert(!JSON.stringify(result).includes('private-fixture-token'));
  assert(!JSON.stringify(result).includes('api.example.invalid'));
});

test('missing runtime context explains how to enter through Swell', () => {
  assert.equal(publicContext(new Request('http://localhost/')).status, 503);
});

for (const extra of [{ Origin: 'https://evil.example' }, { 'Content-Type': 'text/plain' }]) {
  test(`rejects cross-site or non-JSON requests: ${JSON.stringify(extra)}`, async () => {
    globalThis.fetch = () => { throw new Error('Must not contact the platform'); };
    assert.equal((await adminSyncPage(request('_swell_admin_session=fixture', { extra }))).status, 403);
  });
}

for (const body of ['not json', { page: 0 }, { page: 1.5 }, { page: '2' }]) {
  test(`rejects invalid body: ${JSON.stringify(body)}`, async () => {
    globalThis.fetch = () => { throw new Error('Must not contact the platform'); };
    assert.equal((await adminSyncPage(request('_swell_admin_session=fixture', { body }))).status, 400);
  });
}

for (const cookie of [null, '_swell_admin_session=%ZZ']) {
  test(`rejects missing or malformed session: ${cookie}`, async () => {
    globalThis.fetch = () => { throw new Error('Must not contact the platform'); };
    assert.equal((await adminSyncPage(request(cookie))).status, 401);
  });
}

for (const session of [{}, { user_id: 'user', client_id: 'other-store' }]) {
  test(`rejects invalid or other-store session: ${JSON.stringify(session)}`, async () => {
    let calls = 0;
    globalThis.fetch = async () => { calls++; return Response.json(session); };
    assert.equal((await adminSyncPage(request('_swell_admin_session=fixture'))).status, 401);
    assert.equal(calls, 1);
  });
}

const settings = { algolia: { api_application_id: 'APPID', api_admin_key: 'algolia-admin-key', index_name: 'products' } };

// Routes mocked platform and Algolia calls by URL; `overrides` replaces a route's response.
function mockPlatform(overrides = {}) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const { pathname, hostname } = new URL(String(url));
    const method = options.method || 'GET';
    calls.push(`${method} ${hostname}${pathname}`);
    const route = hostname.startsWith('appid') ? `algolia ${method} ${pathname.replace(/\/1\/indexes\/[^/]+/, '/index')}` : `${method} ${pathname}`;
    if (route in overrides) return typeof overrides[route] === 'function' ? overrides[route](url, options) : overrides[route];
    if (hostname !== 'appid.algolia.net') {
      assert.equal(options.redirect, 'manual');
    }
    switch (route) {
      case 'GET /admin/api/session': return validSession();
      case 'GET /settings/algolia': return Response.json(settings);
      case 'GET /settings/store': return Response.json({ locales: [] });
      case 'GET /categories': return Response.json({ count: 0, results: [] });
      case 'GET /products': return Response.json({ count: 2, results: [{ id: 'p1', name: 'One' }, { id: 'p2', name: 'Two' }] });
      case 'algolia GET /1/keys': return Response.json({ keys: [] });
      case 'algolia POST /index/batch': {
        const { requests } = JSON.parse(options.body);
        return Response.json({ objectIDs: requests.map((r) => r.body.objectID) });
      }
      default: throw new Error(`Unexpected request ${route}`);
    }
  };
  return calls;
}

test('validates session, syncs one page and returns only progress fields', async () => {
  const calls = mockPlatform({
    'GET /settings/algolia': (_url, options) => {
      assert.equal(options.headers.Authorization, `Basic ${btoa('example:private-fixture-token')}`);
      return Response.json(settings);
    },
  });
  const result = await adminSyncPage(request('_swell_admin_session=fixture'));
  assert.deepEqual(await result.json(), { page: 1, limit: 100, count: 2, synced: 2, done: true });
  assert.equal(result.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(calls[0], 'GET example.swell.store/admin/api/session');
  assert(calls.includes('GET api.example.invalid/settings/algolia'));
  assert(calls.includes('GET appid.algolia.net/1/keys'));
  assert(calls.includes('POST appid.algolia.net/1/indexes/products/batch'));
});

test('checks Algolia keys only on the first page and requests the given page', async () => {
  let productsUrl;
  const calls = mockPlatform({
    'GET /products': (url) => { productsUrl = new URL(String(url)); return Response.json({ count: 101, results: [{ id: 'p101' }] }); },
  });
  const result = await adminSyncPage(request('_swell_admin_session=fixture', { body: { page: 2 } }));
  assert.deepEqual(await result.json(), { page: 2, limit: 100, count: 101, synced: 1, done: true });
  assert(!calls.includes('GET appid.algolia.net/1/keys'));
  assert.equal(productsUrl.searchParams.get('page'), '2');
  assert.equal(productsUrl.searchParams.get('limit'), '100');
  assert.equal(productsUrl.searchParams.get('active'), 'true');
});

test('syncs only products created on or after the given date', async () => {
  let productsUrl;
  mockPlatform({
    'GET /products': (url) => { productsUrl = new URL(String(url)); return Response.json({ count: 1, results: [{ id: 'p1' }] }); },
  });
  const result = await adminSyncPage(request('_swell_admin_session=fixture', {
    body: { page: 1, created_after: '2026-09-01T00:00:00+02:00' },
  }));
  assert.deepEqual(await result.json(), { page: 1, limit: 100, count: 1, synced: 1, done: true });
  assert.equal(productsUrl.searchParams.get('date_created[$gte]'), '2026-08-31T22:00:00.000Z');
  assert.equal(productsUrl.searchParams.get('sort'), 'date_created asc');
});

test('syncs all products without a date filter', async () => {
  let productsUrl;
  mockPlatform({
    'GET /products': (url) => { productsUrl = new URL(String(url)); return Response.json({ count: 0, results: [] }); },
  });
  await adminSyncPage(request('_swell_admin_session=fixture', { body: { page: 1, created_after: '' } }));
  assert.equal(productsUrl.searchParams.get('date_created[$gte]'), null);
});

test('rejects an invalid date before contacting the platform', async () => {
  globalThis.fetch = () => { throw new Error('Must not contact the platform'); };
  const result = await adminSyncPage(request('_swell_admin_session=fixture', { body: { page: 1, created_after: 'yesterday' } }));
  assert.equal(result.status, 400);
  assert.equal((await result.json()).error, 'Invalid created_after date');
});

test('reports missing Algolia credentials', async () => {
  mockPlatform({ 'GET /settings/algolia': Response.json({ algolia: {} }) });
  const result = await adminSyncPage(request('_swell_admin_session=fixture'));
  assert.equal(result.status, 400);
  const body = await result.json();
  assert.equal(body.error, 'Missing Algolia Application ID or Admin API Key in app settings');
  assert.equal(body.details.step, 'sync');
});

test('reports Algolia errors with their status', async () => {
  mockPlatform({
    'algolia POST /index/batch': Response.json({ message: 'Record is too big' }, { status: 400 }),
  });
  const result = await adminSyncPage(request('_swell_admin_session=fixture'));
  assert.equal(result.status, 502);
  const body = await result.json();
  assert.equal(body.error, 'Algolia 400: Record is too big');
  assert.deepEqual(body.details, { step: 'algolia', page: 1, status: 400 });
});

test('reports Swell API failures with step, status and body without leaking credentials', async () => {
  mockPlatform({
    'GET /products': new Response('bad gateway private-fixture-token', { status: 503, statusText: 'Service Unavailable' }),
  });
  const result = await adminSyncPage(request('_swell_admin_session=fixture'));
  assert.equal(result.status, 502);
  const body = await result.json();
  assert.equal(body.error, 'Swell API GET /products failed with HTTP 503');
  assert.equal(body.details.step, 'swell api');
  assert.equal(body.details.path, '/products');
  assert.equal(body.details.status, 503);
  assert.equal(body.details.response, 'bad gateway [redacted]');
});

test('passes Swell API error messages through', async () => {
  mockPlatform({ 'GET /settings/algolia': Response.json({ error: { message: 'Permission denied' } }, { status: 403 }) });
  const body = await (await adminSyncPage(request('_swell_admin_session=fixture'))).json();
  assert.equal(body.error, 'Permission denied');
  assert.equal(body.details.status, 403);
});

test('upstream exceptions do not leak credentials', async () => {
  mockPlatform({ 'GET /settings/algolia': () => { throw new Error('private-fixture-token'); } });
  const result = await adminSyncPage(request('_swell_admin_session=fixture'));
  assert.equal(result.status, 502);
  const body = JSON.stringify(await result.json());
  assert(!body.includes('private-fixture-token'));
  assert(body.includes('[redacted]'));
});

for (const redirectAt of ['session', 'backend']) {
  test(`rejects ${redirectAt} redirects without following them`, async () => {
    let calls = 0;
    globalThis.fetch = async (_url, options) => {
      calls++;
      assert.equal(options.redirect, 'manual');
      if (redirectAt === 'backend' && calls === 1) return validSession();
      return new Response(null, { status: 302, headers: { Location: 'https://untrusted.example' } });
    };
    const result = await adminSyncPage(request('_swell_admin_session=fixture'));
    assert.equal(result.status, redirectAt === 'session' ? 401 : 502);
    assert.equal(calls, redirectAt === 'session' ? 1 : 2);
    if (redirectAt === 'backend') assert.equal((await result.json()).details.status, 302);
  });
}
