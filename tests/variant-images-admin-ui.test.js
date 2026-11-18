'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { JSDOM } = require('jsdom');
const root = path.join(__dirname, '..');
const ids = { company: randomUUID(), product: randomUUID(), variant: randomUUID(), other: randomUUID() };
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function setup() {
  const dom = new JSDOM(fs.readFileSync(path.join(root, 'public/instagram-admin.html'), 'utf8'), { url: 'https://example.test/instagram-admin.html', runScripts: 'outside-only' });
  const w = dom.window;
  w.localStorage.setItem('token', 'local-admin-test-token');
  w.localStorage.setItem('user', JSON.stringify({ id: randomUUID(), role: 'admin' }));
  w.WebSocket = class {};
  w.confirm = () => true;
  const mutations = [], images = new Map();
  let revision = 0, failMutation = false;
  const products = [{ id: ids.product, company_id: ids.company, name: 'كنزة', currency: 'ل.س', unit_price: 5000, status: 'active', variants: [
    { id: ids.variant, color: 'أسود', size: '1', stock_total: 10, is_active: true },
    { id: ids.other, color: 'كحلي', size: '2', stock_total: 20, is_active: true }
  ] }];
  w.fetch = async (url, options = {}) => {
    let data = [];
    const id = url.match(/\/variants\/([^/]+)\/image/)?.[1];
    if (id) {
      mutations.push({ id, method: options.method, body: options.body, headers: options.headers });
      if (failMutation) return { ok: false, json: async () => ({ message: 'فشل تجريبي في الرفع' }) };
      if (options.method === 'PUT') images.set(id, `https://images.test/${id}-${++revision}.webp`);
      else images.delete(id);
      data = { imageUrl: images.get(id) || null, cleanupFailed: false };
    } else if (url.includes('/admin/bootstrap')) {
      data = { companies: [{ id: ids.company, name: 'متجر' }], drivers: [], links: [], viewers: [], viewerMappings: [] };
    } else if (url.includes('/variant-images/previews')) {
      data = { images: [...images].map(([variantId, imageUrl]) => ({ variantId, imageUrl })) };
    } else if (url.includes('/products')) data = structuredClone(products);
    return { ok: true, json: async () => data };
  };
  for (const filename of ['instagram-variant-images-admin.js', 'instagram-admin.js']) w.eval(fs.readFileSync(path.join(root, 'public/js', filename), 'utf8'));
  await tick();
  await w.loadInstagramProducts(); await tick();
  const line = (id = ids.variant) => w.document.querySelector(`[data-variant-id="${id}"]`);
  function upload(id = ids.variant) {
    const input = line(id).querySelector('.variant-image-input');
    const file = new w.File(['test image bytes'], 'photo.jpg', { type: 'image/jpeg' });
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    input.dispatchEvent(new w.Event('change', { bubbles: true }));
  }
  return { dom, w, mutations, images, line, upload, fail: () => { failMutation = true; } };
}

test('real admin product renderer adds upload/preview/change/delete under each saved variant', async (t) => {
  const ui = await setup(); t.after(() => ui.dom.window.close());
  assert.equal(ui.w.document.querySelectorAll('.variant-image-controls').length, 2);
  assert.equal(ui.line().querySelector('[data-variant-image-action="upload"]').textContent, 'رفع صورة');
  assert.equal(ui.line().querySelector('[data-variant-image-action="delete"]').disabled, true);
  ui.upload(); await tick();
  assert.equal(ui.mutations[0].method, 'PUT');
  assert.equal(ui.mutations[0].headers['Content-Type'], 'application/octet-stream');
  assert(ui.mutations[0].body instanceof ui.w.Blob);
  const first = ui.images.get(ids.variant);
  const image = ui.line().querySelector('img'); image.onload();
  assert.equal(image.hidden, false);
  assert.equal(ui.line().querySelector('[data-variant-image-action="upload"]').textContent, 'تغيير الصورة');
  ui.upload(); await tick();
  assert.notEqual(ui.images.get(ids.variant), first);
  ui.line().querySelector('[data-variant-image-action="delete"]').click(); await tick();
  assert.equal(ui.mutations.at(-1).method, 'DELETE');
  assert.equal(ui.line().querySelector('img').hidden, true);
  assert.equal(ui.line().querySelector('.variant-color').value, 'أسود');
  assert.equal(ui.line().querySelector('.variant-size').value, '1');
  assert.equal(ui.line().querySelector('.variant-stock').value, '10');
  assert.equal(ui.line(ids.other).querySelector('.variant-color').value, 'كحلي');
});

test('failed replacement preserves the saved preview and does not call any product or stock mutation', async (t) => {
  const ui = await setup(); t.after(() => ui.dom.window.close());
  ui.upload(); await tick();
  const first = ui.images.get(ids.variant);
  ui.fail(); ui.upload(); await tick(); await tick();
  assert.equal(ui.images.get(ids.variant), first);
  assert.equal(ui.line().querySelector('img').src, first);
  assert.equal(ui.line().querySelector('[data-variant-image-action="upload"]').disabled, false);
  assert(ui.mutations.every((mutation) => mutation.method === 'PUT' && mutation.id === ids.variant));
  assert.equal(ui.line().querySelector('.variant-stock').value, '10');
});
