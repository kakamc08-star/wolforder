'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { randomUUID } = require('node:crypto');
const root = path.join(__dirname, '..');
const ids = { product: randomUUID(), other: randomUUID(), one: randomUUID(), two: randomUUID(), missing: randomUUID(), otherVariant: randomUUID() };
const catalog = { company_name: 'متجر الاختبار', products: [
  { product_id: ids.product, name: 'كنزة', unit_price: 25000, currency: 'ل.س', variants: [
    { variant_id: ids.one, color: 'أسود', size: '1' }, { variant_id: ids.two, color: 'أسود', size: '2' },
    { variant_id: ids.missing, color: 'كحلي', size: '3' }
  ] },
  { product_id: ids.other, name: 'قميص', unit_price: 10000, currency: 'ل.س', variants: [{ variant_id: ids.otherVariant, color: 'أسود', size: '1' }] }
] };
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
async function setup() {
  const dom = new JSDOM(fs.readFileSync(path.join(root, 'public/instagram-order.html'), 'utf8'), { url: 'https://example.test/o/store', runScripts: 'outside-only' });
  const w = dom.window;
  const calls = [], pictures = [], submissions = [], replies = new Map();
  w.WebSocket = class { constructor() { w.testSocket = this; } };
  w.setInterval = () => 0;
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.Image = function () {
    const image = w.document.createElement('img');
    Object.defineProperty(image, 'src', {
      get() { return image.getAttribute('src') || ''; },
      set(value) { image.setAttribute('src', value); pictures.push(image); }
    });
    return image;
  };
  w.fetch = async (url, options = {}) => {
    const id = url.match(/\/variants\/([^/]+)\/image/)?.[1];
    if (id) {
      calls.push(id);
      const data = replies.has(id) ? await replies.get(id) : { imageUrl: id === ids.missing ? null : `https://images.test/${id}.webp` };
      return { ok: true, json: async () => data };
    }
    if (options.method === 'POST') {
      submissions.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ order_number: 18 }) };
    }
    return { ok: true, json: async () => structuredClone(catalog) };
  };
  for (const filename of ['instagram-variant-images.js', 'instagram-order.js']) w.eval(fs.readFileSync(path.join(root, 'public/js', filename), 'utf8'));
  await tick();
  const row = () => w.document.querySelector('.storefront-item');
  function choose(field, value, target = row()) {
    const select = target.querySelector(`[data-field="${field}"]`);
    select.value = value;
    select.dispatchEvent(new w.Event('change'));
  }
  function complete(id = ids.one, color = 'أسود', target = row()) {
    choose('product', ids.product, target); choose('color', color, target); choose('size', id, target);
  }
  return { dom, w, row, calls, pictures, submissions, replies, choose, complete };
}

test('does not request product images until product/color/size are complete; resets immediately', async (t) => {
  const ui = await setup(); t.after(() => ui.dom.window.close());
  assert.equal(ui.calls.length, 0);
  ui.choose('product', ids.product); assert.equal(ui.calls.length, 0);
  ui.choose('color', 'أسود'); assert.equal(ui.calls.length, 0);
  ui.choose('size', ids.one); await tick();
  assert.deepEqual(ui.calls, [ids.one]);
  assert(ui.row().querySelector('[role="status"]'));
  ui.pictures.at(-1).onload();
  assert.equal(ui.row().querySelector('.storefront-variant-image img').src, `https://images.test/${ids.one}.webp`);
  ui.choose('product', ids.other);
  assert.equal(ui.row().querySelector('.storefront-variant-image').hidden, true);
  assert.equal(ui.row().querySelector('.storefront-variant-image img'), null);
});

test('late fetch and load callbacks cannot reveal a previous selection', async (t) => {
  const ui = await setup(); t.after(() => ui.dom.window.close());
  const slow = deferred(); ui.replies.set(ids.one, slow.promise);
  ui.complete(); ui.choose('size', ids.two); await tick();
  ui.pictures.at(-1).onload();
  slow.resolve({ imageUrl: 'https://images.test/stale.webp' }); await tick();
  assert.equal(ui.pictures.length, 1);
  const active = ui.pictures.at(-1);
  const oldLoad = active.onload;
  ui.choose('size', ids.missing); // Not an option for this color: clears all picture space.
  oldLoad();
  assert.equal(ui.row().querySelector('.storefront-variant-image').hidden, true);
  assert.equal(ui.row().querySelector('.storefront-variant-image img'), null);
});

test('reuses signed URLs and image browser cache; quantity edits do not fetch another image', async (t) => {
  const ui = await setup(); t.after(() => ui.dom.window.close());
  ui.complete(); await tick(); ui.pictures.at(-1).onload();
  ui.choose('size', ids.two); await tick(); ui.pictures.at(-1).onload();
  ui.choose('size', ids.one); await tick(); ui.pictures.at(-1).onload();
  ui.row().querySelector('.qty-plus').click();
  assert.deepEqual(ui.calls, [ids.one, ids.two]);
  assert.equal(ui.row().querySelector('.qty-value').textContent, '2');
});

test('missing/failed pictures leave no reserved space and never block the original checkout', async (t) => {
  const ui = await setup(); t.after(() => ui.dom.window.close());
  ui.complete(); await tick(); ui.pictures.at(-1).onerror();
  assert.equal(ui.row().querySelector('.storefront-variant-image').hidden, true);
  ui.choose('color', 'كحلي'); ui.choose('size', ids.missing); await tick();
  assert.equal(ui.row().querySelector('.storefront-variant-image').hidden, true);
  ui.w.document.getElementById('customerName').value = 'زبون تجريبي';
  ui.w.document.getElementById('customerNumber').value = '0990000000';
  ui.w.document.getElementById('customerAddress').value = 'دمشق';
  ui.w.document.getElementById('instagramCustomerOrderForm').dispatchEvent(new ui.w.Event('submit', { cancelable: true }));
  await tick();
  assert.equal(ui.submissions.length, 1);
  assert.deepEqual(ui.submissions[0].items, [{ variantId: ids.missing, quantity: 1 }]);
  assert.equal(ui.submissions[0].orderType, 'توصيل');
  assert.equal(ui.w.document.getElementById('storefrontSuccess').hidden, false);
});

test('each item has an independent image and removing an item invalidates its pending request', async (t) => {
  const ui = await setup(); t.after(() => ui.dom.window.close());
  ui.complete(); await tick(); ui.pictures.at(-1).onload();
  ui.w.document.getElementById('addStorefrontItem').click();
  const second = ui.w.document.querySelectorAll('.storefront-item')[1];
  const slow = deferred(); ui.replies.set(ids.two, slow.promise);
  ui.complete(ids.two, 'أسود', second);
  second.querySelector('.storefront-remove').click();
  slow.resolve({ imageUrl: 'https://images.test/removed.webp' }); await tick();
  assert.equal(ui.pictures.length, 1);
  assert.equal(ui.row().querySelector('.storefront-variant-image img').src, `https://images.test/${ids.one}.webp`);
});

test('a live image update invalidates cached URLs and reloads only selected pictures', async (t) => {
  const ui = await setup(); t.after(() => ui.dom.window.close());
  ui.complete(); await tick(); ui.pictures.at(-1).onload();
  ui.replies.set(ids.one, { imageUrl: 'https://images.test/replaced.webp' });
  ui.w.testSocket.onmessage({ data: JSON.stringify({ source: 'instagram', type: 'INSTAGRAM_VARIANT_IMAGE_UPDATED' }) });
  assert.equal(ui.row().querySelector('.storefront-variant-image img'), null);
  await tick(); ui.pictures.at(-1).onload();
  assert.deepEqual(ui.calls, [ids.one, ids.one]);
  assert.equal(ui.row().querySelector('.storefront-variant-image img').src, 'https://images.test/replaced.webp');
});
