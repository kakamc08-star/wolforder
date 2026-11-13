'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');

const root = path.join(__dirname, '..');
const images = {};
for (const format of ['PNG', 'JPEG', 'WEBP']) {
  images[format] = fs.readFileSync(path.join(__dirname, 'fixtures/store-images', format));
}

process.env.JWT_SECRET = 'wolforder-local-image-tests';
const accounts = Object.fromEntries(['admin', 'company', 'other', 'viewer', 'driver'].map((role) => [
  role, { id: randomUUID(), role: role === 'other' ? 'company' : role === 'viewer' ? 'instagram_viewer' : role, name: role }
]));
const tokens = Object.fromEntries(Object.entries(accounts).map(([name, user]) => [
  name, 'Bearer ' + jwt.sign(user, process.env.JWT_SECRET)
]));
const companies = { one: accounts.company.id, two: accounts.other.id };
let files, pointers, links, broadcasts, orderCalls;
let failUpload, failSave, unknownSave, failCleanup, migrationReady, failSign;
let origin, server;

const bucket = {
  async upload(key, body, options) {
    if (failUpload) return { error: { message: 'Mock upload failure' } };
    assert.equal(options.upsert, false);
    assert.equal(files.has(key), false);
    files.set(key, { body, contentType: options.contentType });
    return { error: null };
  },
  async remove(paths) {
    if (failCleanup) return { error: { message: 'Mock cleanup failure' } };
    for (const key of paths) {
      assert(![...pointers.values()].includes(key), 'The current image may not be removed');
      files.delete(key);
    }
    return { error: null };
  },
  async createSignedUrl(key, seconds) {
    assert.equal(seconds, 300);
    if (failSign || !files.has(key)) return { error: { message: 'Mock signing failure' } };
    return { data: { signedUrl: origin + '/signed/' + key + '?signature=fixture' }, error: null };
  },
  async createSignedUrls(paths, seconds) {
    const results = await Promise.all(paths.map(async (key) => ({
      path: key,
      signedUrl: (await this.createSignedUrl(key, seconds)).data?.signedUrl || null
    })));
    return { data: results, error: null };
  }
};

const fakeDb = {
  storage: {
    from(name) {
      assert.equal(name, 'instagram-storefront-images');
      return bucket;
    }
  },
  from(table) {
    if (table === 'instagram_storefront_images') {
      return {
        select() {
          if (!migrationReady) return { error: { code: 'PGRST205' } };
          return { data: [...pointers].map(([company_id, object_path]) => ({ company_id, object_path })) };
        }
      };
    }
    assert.equal(table, 'users');
    const filters = {};
    return {
      select() { return this; },
      eq(key, value) { filters[key] = value; return this; },
      maybeSingle() {
        return { data: Object.values(accounts).find((user) => user.id === filters.id && user.role === filters.role) };
      }
    };
  },
  async rpc(name, params) {
    const active = [...links.values()].find((link) => link.slug === params.p_slug?.trim() && link.is_active);
    if (name === 'get_instagram_storefront_image_path') {
      if (!migrationReady) return { error: { code: 'PGRST202' } };
      return { data: active ? pointers.get(active.company_id) || null : null };
    }
    if (name === 'get_instagram_storefront_catalog_filtered') {
      return { data: active ? { company_name: active.slug, products: [] } : null };
    }
    if (name === 'create_instagram_order_atomic') {
      assert(active);
      orderCalls.push(params);
      return { data: { order_number: active.next_order_number++ } };
    }
    assert.equal(name, 'set_instagram_storefront_image_path');
    if (!migrationReady) return { error: { code: 'PGRST202', message: 'Migration missing' } };
    if (failSave) return { error: { code: '23514', message: 'Mock rejected metadata' } };
    if (params.p_actor_user_id !== accounts.admin.id) return { error: { code: '42501', message: 'Forbidden' } };
    if (!Object.values(companies).includes(params.p_company_id)) return { error: { code: 'P0002', message: 'Unknown company' } };
    const previous = pointers.get(params.p_company_id);
    if (params.p_object_path) pointers.set(params.p_company_id, params.p_object_path);
    else pointers.delete(params.p_company_id);
    if (unknownSave) return { error: { code: '', message: 'Mock connection lost after commit' } };
    return { data: previous || null };
  }
};

const config = require.resolve(path.join(root, 'config/db.js'));
require.cache[config] = { id: config, filename: config, loaded: true, exports: fakeDb };

test.before(async () => {
  const app = express();
  app.use(express.json({ limit: '100kb' }));
  app.set('broadcast', (event) => broadcasts.push(event));
  app.use('/api/instagram', require(path.join(root, 'routes/instagram.js')));
  app.get('/signed/:companyId/:name', (req, res) => {
    const key = req.params.companyId + '/' + req.params.name;
    const file = files.get(key);
    if (!file || req.query.signature !== 'fixture') return res.sendStatus(404);
    return res.type(file.contentType).send(file.body);
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  origin = 'http://127.0.0.1:' + server.address().port;
});

test.beforeEach(() => {
  files = new Map();
  pointers = new Map();
  links = new Map([[companies.one, { company_id: companies.one, slug: 'one', next_order_number: 23, is_active: true }]]);
  broadcasts = [];
  orderCalls = [];
  failUpload = failSave = unknownSave = failCleanup = failSign = false;
  migrationReady = true;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function api(url, options = {}) {
  return fetch(origin + '/api/instagram' + url, options);
}

function mutate(companyId, body, actor = 'admin') {
  const headers = {};
  if (actor) headers.Authorization = tokens[actor];
  if (body) headers['Content-Type'] = 'application/octet-stream';
  return api('/links/' + companyId + '/image', {
    method: body ? 'PUT' : 'DELETE', headers, body
  });
}

function publicImage(slug, options = {}) {
  return api('/storefront/' + slug + '/image', options);
}

test('requires the real admin token for reading or mutating admin image state', async () => {
  for (const actor of ['company', 'viewer', 'driver', null]) {
    assert.equal((await mutate(companies.one, images.PNG, actor)).status, actor ? 403 : 401);
    assert.equal((await mutate(companies.one, undefined, actor)).status, actor ? 403 : 401);
    const headers = actor ? { Authorization: tokens[actor] } : {};
    assert.equal((await api('/links/images', { headers })).status, actor ? 403 : 401);
  }
  assert.equal(files.size, 0);
});

test('validates the byte content, size limit, company id and company role', async () => {
  assert.equal((await mutate(companies.one, Buffer.from('<svg onload="alert(1)"></svg>'))).status, 415);
  assert.equal((await mutate(companies.one, Buffer.alloc(3 * 1024 * 1024 + 1))).status, 413);
  assert.equal((await mutate('wrong-id', images.PNG)).status, 400);
  assert.equal((await mutate(accounts.driver.id, images.PNG)).status, 404);
  assert.equal(files.size, 0);
});

test('uploads and serves all supported formats with a short signed redirect', async () => {
  for (const [format, mime] of [['PNG', 'image/png'], ['JPEG', 'image/jpeg'], ['WEBP', 'image/webp']]) {
    const uploaded = await mutate(companies.one, images[format]);
    assert.equal(uploaded.status, 200);
    const result = await uploaded.json();
    assert(result.imageUrl.startsWith(origin + '/signed/'));
    const redirect = await publicImage('one', { redirect: 'manual' });
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get('cache-control'), 'no-store');
    const image = await publicImage('one');
    assert.equal(image.headers.get('content-type'), mime);
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), images[format]);
    assert.equal(files.size, 1);
  }
  assert.equal(broadcasts.length, 3);
  assert(broadcasts.every((event) => event.type === 'INSTAGRAM_STOREFRONT_IMAGE_UPDATED'));
});

test('isolates companies and permits an admin preview before a link is saved', async () => {
  await mutate(companies.one, images.PNG);
  await mutate(companies.two, images.WEBP);
  const before = structuredClone(links);
  const result = await api('/links/images', { headers: { Authorization: tokens.admin } });
  assert.equal((await result.json()).images.length, 2);
  assert.equal((await publicImage('two')).status, 404);
  const oldKey = pointers.get(companies.one);
  const otherKey = pointers.get(companies.two);
  await mutate(companies.one, images.JPEG);
  assert.equal(files.has(oldKey), false);
  assert.equal(pointers.get(companies.two), otherKey);
  assert.equal((await mutate(companies.one)).status, 200);
  assert.equal((await publicImage('one')).status, 404);
  assert(files.has(otherKey));
  assert.deepEqual(links, before);
  links.set(companies.two, { company_id: companies.two, slug: 'two', next_order_number: 42, is_active: true });
  assert.equal((await publicImage('two')).headers.get('content-type'), 'image/webp');
  links.get(companies.two).is_active = false;
  assert.equal((await publicImage('two')).status, 404);
  assert.equal(files.size, 1);
});

test('failed Storage or rejected metadata leaves the previous image intact', async () => {
  await mutate(companies.one, images.PNG);
  const original = pointers.get(companies.one);
  failUpload = true;
  assert.equal((await mutate(companies.one, images.JPEG)).status, 502);
  failUpload = false;
  failSave = true;
  assert.equal((await mutate(companies.one, images.JPEG)).status, 500);
  assert.equal(pointers.get(companies.one), original);
  assert.equal(files.size, 1);
  assert.equal((await publicImage('one')).headers.get('content-type'), 'image/png');
});

test('ambiguous database responses never remove the possibly committed upload', async () => {
  await mutate(companies.one, images.PNG);
  unknownSave = true;
  assert.equal((await mutate(companies.one, images.WEBP)).status, 500);
  assert.equal((await publicImage('one')).headers.get('content-type'), 'image/webp');
});

test('reports failed Storage cleanup while immediately reverting the public badge', async () => {
  await mutate(companies.one, images.PNG);
  failCleanup = true;
  const response = await mutate(companies.one);
  assert.deepEqual(await response.json(), { imageUrl: null, cleanupFailed: true });
  assert.equal((await publicImage('one')).status, 404);
  assert.equal(files.size, 1);
});

test('concurrent uploads retain the last committed object only', async () => {
  await mutate(companies.one, images.PNG);
  const responses = await Promise.all([mutate(companies.one, images.JPEG), mutate(companies.one, images.WEBP)]);
  assert(responses.every((response) => response.status === 200));
  assert.equal(files.size, 1);
  assert(files.has(pointers.get(companies.one)));
  assert.equal((await publicImage('one')).status, 200);
});

test('uses a safe fallback for missing migration or a signing outage', async () => {
  migrationReady = false;
  assert.equal((await publicImage('one')).status, 404);
  assert.equal((await mutate(companies.one, images.PNG)).status, 503);
  assert.equal(files.size, 0);
  migrationReady = true;
  failSign = true;
  assert.equal((await mutate(companies.one, images.PNG)).status, 200);
  assert.equal((await publicImage('one')).status, 404);
  const previews = await api('/links/images', { headers: { Authorization: tokens.admin } });
  assert.deepEqual((await previews.json()).images, [{ companyId: companies.one, imageUrl: null }]);
});

test('catalog and order submission still use the original RPCs and sequence', async () => {
  await mutate(companies.one, images.PNG);
  const catalog = await api('/storefront/one');
  assert.deepEqual(await catalog.json(), { company_name: 'one', products: [] });
  const submission = await api('/storefront/one/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customerName: 'زبون تجريبي',
      customerNumber: '0990000000',
      address: 'عنوان تجريبي',
      items: [{ variantId: randomUUID(), quantity: 1 }],
      idempotencyKey: randomUUID()
    })
  });
  assert.equal(submission.status, 201);
  assert.equal((await submission.json()).order_number, 23);
  assert.equal(orderCalls.length, 1);
  assert.equal(links.get(companies.one).next_order_number, 24);
});

test('accepts a JPEG with a Samsung trailer, an octet-stream MIME and size between 2 and 3 MiB', async () => {
  const body = Buffer.concat([images.JPEG, Buffer.alloc(2947377 - images.JPEG.length - 4), Buffer.from('SEFT')]);
  const response = await mutate(companies.one, body);
  assert.equal(response.status, 200);
  const saved = files.get(pointers.get(companies.one));
  assert.equal(saved.contentType, 'image/jpeg');
  assert.deepEqual(saved.body, body);
  const truncated = images.JPEG.subarray(0, images.JPEG.length - 2);
  assert.equal((await mutate(companies.one, truncated)).status, 415);
});
