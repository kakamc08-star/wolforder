'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const sharp = require('sharp');
const { PGlite } = require('@electric-sql/pglite');
const { optimizeVariantImage, cleanupVariantImages } = require('../routes/instagram-variant-images');
const root = path.join(__dirname, '..');
const db = new PGlite();
const ids = Object.fromEntries(['admin', 'company', 'other', 'driver', 'viewer', 'product', 'variant', 'variant2', 'otherProduct', 'otherVariant'].map((key) => [key, randomUUID()]));
process.env.JWT_SECRET = 'local-variant-image-test-secret';
let files, failUpload, failCleanup, ambiguousSave, failSign, image, origin, server;
const migration = fs.readFileSync(path.join(root, 'database/2026-11-18-instagram-variant-images.sql'), 'utf8');
const rpc = async (name, params = []) => (await db.query(`select public.${name}(${params.map((_, index) => '$' + (index + 1)).join(',')}) as result`, params)).rows[0].result;
const pointer = async (id = ids.variant) => (await db.query('select object_path from instagram_variant_images where variant_id=$1', [id])).rows[0]?.object_path;
const bucket = {
  async upload(key, bytes, options) {
    if (failUpload) return { error: { message: 'Storage unavailable' } };
    assert.equal(options.contentType, 'image/webp');
    assert.equal(options.upsert, false);
    assert(!files.has(key));
    files.set(key, bytes);
    return { error: null };
  },
  async createSignedUrl(key, seconds) {
    assert.equal(seconds, 300);
    if (failSign || !files.has(key)) return { error: { message: 'Signing unavailable' } };
    return { data: { signedUrl: `${origin}/signed/${key}?token=test` } };
  },
  async createSignedUrls(paths, seconds) {
    return { data: await Promise.all(paths.map(async (key) => ({ path: key, signedUrl: (await this.createSignedUrl(key, seconds)).data?.signedUrl || null }))) };
  },
  async remove(paths) {
    if (failCleanup) return { error: { message: 'Deletion unavailable' } };
    for (const key of paths) {
      assert.equal((await db.query('select 1 from instagram_variant_images where object_path=$1', [key])).rows.length, 0);
      files.delete(key);
    }
    return { error: null };
  }
};
const fakeDb = {
  storage: { from(name) { assert.equal(name, 'instagram-variant-images'); return bucket; } },
  from(name) {
    assert.equal(name, 'instagram_variant_images');
    return { select() { return this; }, async in(_column, values) {
      try { return { data: (await db.query('select variant_id, object_path from instagram_variant_images where variant_id=any($1::uuid[])', [values])).rows }; }
      catch (error) { return { error }; }
    } };
  },
  async rpc(name, params = {}) {
    try {
      if (name === 'get_instagram_variant_image_cleanup_batch') return { data: (await db.query('select * from get_instagram_variant_image_cleanup_batch()')).rows };
      const data = await rpc(name, Object.values(params));
      if (ambiguousSave && name === 'set_instagram_variant_image_path') return { error: { message: 'Connection lost after commit' } };
      return { data };
    } catch (error) { return { error }; }
  }
};
const config = require.resolve('../config/db');
require.cache[config] = { id: config, filename: config, loaded: true, exports: fakeDb };

test.before(async () => {
  await db.exec(fs.readFileSync(path.join(__dirname, 'fixtures/instagram-live-schema.sql'), 'utf8'));
  await db.exec(`create schema storage;
    create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(), bucket_id text);
    alter table storage.objects enable row level security;
    grant usage on schema storage to anon, authenticated, service_role;
    grant select, insert, update, delete on storage.objects to anon, authenticated, service_role;
    create policy existing_broad_policy on storage.objects for all to anon, authenticated using(true) with check(true);`);
  await db.exec(migration);
  const app = express();
  app.use(express.json({ limit: '100kb' }));
  app.use('/api/instagram', require('../routes/instagram'));
  app.get('/signed/:variantId/:file', (req, res) => {
    const bytes = files.get(`${req.params.variantId}/${req.params.file}`);
    return bytes && req.query.token === 'test' ? res.type('webp').send(bytes) : res.sendStatus(404);
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  image = await sharp({ create: { width: 2400, height: 1600, channels: 3, background: '#7c3aed' } }).jpeg({ quality: 95 }).toBuffer();
});
test.beforeEach(async () => {
  await db.exec('truncate users cascade; truncate instagram_variant_image_cleanup;');
  for (const role of ['admin', 'company', 'other', 'driver', 'viewer']) {
    await db.query('insert into users(id,role) values($1,$2)', [ids[role], role === 'other' ? 'company' : role === 'viewer' ? 'instagram_viewer' : role]);
  }
  for (const [product, company] of [['product', 'company'], ['otherProduct', 'other']]) {
    await db.query('insert into instagram_products(id,company_id,name,unit_price) values($1,$2,$3,5000)', [ids[product], ids[company], product]);
  }
  for (const variant of ['variant', 'variant2', 'otherVariant']) {
    await db.query('insert into instagram_variants(id,product_id,color,size,stock_total,stock_available) values($1,$2,$3,$4,10,10)', [ids[variant], ids[variant === 'otherVariant' ? 'otherProduct' : 'product'], 'أسود', variant]);
  }
  await db.query("insert into instagram_company_links(company_id,slug) values($1,'one'),($2,'two')", [ids.company, ids.other]);
  files = new Map();
  failUpload = failCleanup = ambiguousSave = failSign = false;
});
test.after(async () => { await new Promise((resolve) => server.close(resolve)); await db.close(); });

function request(url, options = {}, actor) {
  const headers = { ...options.headers };
  if (actor) headers.Authorization = 'Bearer ' + jwt.sign({ id: ids[actor], role: actor === 'viewer' ? 'instagram_viewer' : actor }, process.env.JWT_SECRET);
  return fetch(origin + '/api/instagram' + url, { ...options, headers });
}
const upload = (bytes = image, id = ids.variant, actor = 'admin') => request(`/variants/${id}/image`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes }, actor);
const remove = (id = ids.variant, actor = 'admin') => request(`/variants/${id}/image`, { method: 'DELETE' }, actor);
const read = (slug = 'one', id = ids.variant) => request(`/storefront/${slug}/variants/${id}/image`);

test('re-encodes real pixels, strips metadata, honors orientation and never upscales', async () => {
  const output = await optimizeVariantImage(image);
  const metadata = await sharp(output).metadata();
  assert.equal(metadata.format, 'webp');
  assert.equal(metadata.width, 1200);
  assert.equal(metadata.height, 800);
  assert(output.length < image.length);
  assert.equal(metadata.exif, undefined);
  const rotated = await sharp({ create: { width: 80, height: 40, channels: 3, background: 'red' } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
  const result = await sharp(await optimizeVariantImage(rotated)).metadata();
  assert.equal(result.width, 40);
  assert.equal(result.height, 80);
  assert.equal(result.exif, undefined);
});

test('upload, preview, signed display, replacement and deletion preserve stock and product metadata', async () => {
  const snapshot = (await db.query('select * from instagram_variants order by id')).rows;
  assert.equal((await upload()).status, 200);
  const first = await pointer();
  const publicResult = await read();
  assert.equal(publicResult.headers.get('cache-control'), 'no-store');
  const signed = await publicResult.json();
  assert.equal((await fetch(signed.imageUrl)).headers.get('content-type'), 'image/webp');
  const previews = await request('/variant-images/previews', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ variantIds: [ids.variant, ids.variant2] }) }, 'admin');
  assert.equal((await previews.json()).images.length, 1);
  assert.equal((await upload()).status, 200);
  assert.notEqual(await pointer(), first);
  assert.equal(files.has(first), false);
  assert.equal(files.size, 1);
  assert.equal((await remove()).status, 200);
  assert.deepEqual(await (await read()).json(), { imageUrl: null });
  assert.equal(files.size, 0);
  assert.deepEqual((await db.query('select * from instagram_variants order by id')).rows, snapshot);
});

test('isolates company links, inactive links/products/variants and missing images', async () => {
  await upload();
  assert.deepEqual(await (await read('two')).json(), { imageUrl: null });
  assert.deepEqual(await (await read('one', ids.variant2)).json(), { imageUrl: null });
  for (const [disable, restore] of [
    ["update instagram_company_links set is_active=false where slug='one'", "update instagram_company_links set is_active=true"],
    ["update instagram_products set status='stopped'", "update instagram_products set status='active'"],
    ['update instagram_variants set is_active=false', 'update instagram_variants set is_active=true'],
    ['update instagram_variants set stock_available=0', 'update instagram_variants set stock_available=10']
  ]) { await db.exec(disable); assert.deepEqual(await (await read()).json(), { imageUrl: null }); await db.exec(restore); }
});

test('each size has a separate image and deleting one never deletes another size image', async () => {
  await upload();
  const first = await pointer();
  assert.equal((await upload(image, ids.variant2)).status, 200);
  const second = await pointer(ids.variant2);
  assert.notEqual(first, second);
  assert.equal(files.size, 2);
  await remove();
  assert.equal(files.has(first), false);
  assert.equal(files.has(second), true);
  assert((await (await read('one', ids.variant2)).json()).imageUrl);
});

test('rejects unauthenticated/other roles, a revoked admin and invalid image bytes', async () => {
  for (const actor of [null, 'company', 'viewer', 'driver']) {
    assert.equal((await upload(image, ids.variant, actor)).status, actor ? 403 : 401);
    assert.equal((await remove(ids.variant, actor)).status, actor ? 403 : 401);
  }
  assert.equal((await upload(Buffer.from('<svg onload="alert(1)"></svg>'))).status, 415);
  assert.equal((await upload(Buffer.alloc(12 * 1024 * 1024 + 1))).status, 413);
  assert.equal((await upload(image, randomUUID())).status, 404);
  assert.equal((await upload(image, 'invalid')).status, 400);
  await db.query("update users set role='company' where id=$1", [ids.admin]);
  assert.equal((await upload()).status, 403);
  assert.equal(files.size, 0);
});

test('failed uploads and ambiguous saves do not delete the current image; abandoned uploads are collected', async () => {
  await upload();
  const first = await pointer();
  failUpload = true;
  assert.equal((await upload()).status, 502);
  assert.equal(await pointer(), first);
  failUpload = false;
  ambiguousSave = true;
  assert.equal((await upload()).status, 500);
  assert.notEqual(await pointer(), first);
  assert.equal(files.size, 2);
  ambiguousSave = false;
  await cleanupVariantImages(fakeDb);
  assert.equal(files.size, 1);
  assert(files.has(await pointer()));
  const abandoned = `${ids.variant}/${randomUUID()}.webp`;
  await rpc('prepare_instagram_variant_image_upload', [ids.variant, ids.admin, abandoned]);
  files.set(abandoned, Buffer.from('interrupted upload'));
  await cleanupVariantImages(fakeDb);
  assert(files.has(abandoned));
  await db.query("update instagram_variant_image_cleanup set available_at=now()-interval '1 second'");
  await assert.rejects(rpc('set_instagram_variant_image_path', [ids.variant, ids.admin, abandoned]), /expired/);
  await cleanupVariantImages(fakeDb);
  assert.equal(files.size, 1);
});

test('cleanup retries durably and cascaded variant deletion retires the image', async () => {
  await upload();
  failCleanup = true;
  assert.equal((await (await remove()).json()).cleanupFailed, true);
  assert.equal(files.size, 1);
  assert.deepEqual(await (await read()).json(), { imageUrl: null });
  failCleanup = false;
  await cleanupVariantImages(fakeDb);
  assert.equal(files.size, 0);
  await upload();
  await db.query('delete from instagram_variants where id=$1', [ids.variant]);
  await cleanupVariantImages(fakeDb);
  assert.equal(files.size, 0);
});

test('concurrent replacements keep exactly the last committed file', async () => {
  await upload();
  const responses = await Promise.all([upload(), upload(), upload()]);
  assert(responses.every((response) => response.status === 200));
  await cleanupVariantImages(fakeDb);
  assert.equal(files.size, 1);
  assert(files.has(await pointer()));
});

test('SQL is repeatable and RLS blocks even broad pre-existing client policies', async () => {
  await upload();
  const previous = await pointer();
  await db.exec(migration);
  assert.equal(await pointer(), previous);
  for (const role of ['anon', 'authenticated']) {
    await db.exec('set role ' + role);
    try {
      await assert.rejects(db.query('select * from instagram_variant_images'), /permission denied/);
      await assert.rejects(rpc('set_instagram_variant_image_path', [ids.variant, ids.admin, null]), /permission denied/);
      await assert.rejects(db.exec("insert into storage.objects(bucket_id) values('instagram-variant-images')"), /row-level security/);
      await db.exec("insert into storage.objects(bucket_id) values('unrelated-bucket')");
    } finally { await db.exec('reset role'); }
  }
});

test('image signing outages do not lose the saved picture', async () => {
  failSign = true;
  const result = await upload();
  assert.equal(result.status, 200);
  assert.equal((await result.json()).imageUrl, null);
  assert.equal((await read()).status, 503);
  failSign = false;
  assert((await (await read()).json()).imageUrl);
});
