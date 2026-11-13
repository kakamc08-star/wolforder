'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..', 'public', 'js');
const adminSource = fs.readFileSync(path.join(root, 'instagram-admin.js'), 'utf8');
const linksCode = adminSource.slice(adminSource.indexOf('// ========== Links =========='), adminSource.indexOf('// ========== Viewers =========='));
const storeSource = fs.readFileSync(path.join(root, 'instagram-order.js'), 'utf8');
const storeCode = storeSource.slice(storeSource.indexOf('let storefrontImageRevision'), storeSource.indexOf('async function initializeStorefront'));

function imageElement() {
  const attrs = new Map();
  const classes = new Set();
  const listeners = {};
  return {
    hidden: true,
    get src() { return attrs.get('src'); },
    set src(value) { attrs.set('src', value); },
    parentElement: { classList: { toggle: (key, active) => active ? classes.add(key) : classes.delete(key) } },
    getAttribute: (key) => attrs.get(key) || null,
    removeAttribute: (key) => attrs.delete(key),
    matches: (selector) => selector === 'img.store-image-file',
    addEventListener: (event, callback) => { listeners[event] = callback; },
    fire: (event) => listeners[event](),
    hasCustomImage: () => classes.has('has-store-image')
  };
}

function linkCard(companyId) {
  const card = { dataset: { companyId } };
  const input = {
    files: [],
    clicks: 0,
    value: 'previous selection',
    click() { this.clicks += 1; },
    closest: () => card,
    matches: (selector) => selector === '.link-image-input'
  };
  const elements = {
    '.store-image-file': imageElement(),
    '[data-link-image-action="upload"]': { dataset: { linkImageAction: 'upload' }, closest: () => card },
    '[data-link-image-action="delete"]': { dataset: { linkImageAction: 'delete' }, closest: () => card },
    '.link-image-input': input,
    '.link-slug': { value: 'unsaved draft' },
    '.link-order-start': { value: '91' }
  };
  card.querySelector = (selector) => elements[selector];
  return card;
}

test('manager previews, upload picker and deletion are scoped to their cards', async () => {
  const cards = [linkCard('first'), linkCard('second')];
  const listeners = {};
  const requests = [];
  const notifications = [];
  const grid = {
    innerHTML: '',
    addEventListener: (event, callback) => { listeners[event] = callback; },
    querySelectorAll: () => cards,
    querySelector: (selector) => cards.find((card) => selector.includes('"' + card.dataset.companyId + '"'))
  };
  const context = vm.createContext({
    document: { getElementById: () => grid },
    location: { origin: 'http://wolforder.local' },
    igState: { bootstrap: { links: [], companies: cards.map((card) => ({ id: card.dataset.companyId, name: 'Store' })) } },
    igEscape: String,
    igNotify: (message) => notifications.push(message),
    confirm: () => true,
    loadInstagramBootstrap: async () => {},
    igApi: async (url, options) => {
      requests.push({ url, options });
      if (url.endsWith('/images')) return { images: [{ companyId: 'second', imageUrl: '/preview/second' }] };
      return { imageUrl: options.method === 'PUT' ? '/preview/first' : null };
    }
  });
  vm.runInContext(linksCode, context);
  vm.runInContext('renderInstagramLinks()', context);
  assert(grid.innerHTML.includes('رفع صورة'));
  assert(grid.innerHTML.includes('حذف الصورة'));
  assert(grid.innerHTML.includes('accept="image/jpeg,image/png,image/webp"'));
  await vm.runInContext('loadInstagramLinkCards()', context);
  const [first, second] = cards;
  const firstImage = first.querySelector('.store-image-file');
  const secondImage = second.querySelector('.store-image-file');
  listeners.load({ target: secondImage });
  assert.equal(secondImage.src, '/preview/second');
  assert.equal(secondImage.hasCustomImage(), true);
  assert.equal(firstImage.hasCustomImage(), false);
  assert.equal(first.querySelector('[data-link-image-action="delete"]').disabled, true);

  const upload = first.querySelector('[data-link-image-action="upload"]');
  await listeners.click({ target: { closest: () => upload } });
  const input = first.querySelector('.link-image-input');
  assert.equal(input.clicks, 1);
  assert.equal(input.value, '');
  const file = new Blob(['test'], { type: 'image/png' });
  input.files = [file];
  listeners.change({ target: input });
  await new Promise(setImmediate);
  assert.equal(requests[1].url, '/api/instagram/links/first/image');
  assert.equal(requests[1].options.body, file);
  assert.equal(requests[1].options.headers['Content-Type'], 'application/octet-stream');
  assert.equal(firstImage.src, '/preview/first');
  listeners.load({ target: firstImage });
  assert(firstImage.hasCustomImage());
  assert(!first.querySelector('[data-link-image-action="delete"]').disabled);
  assert.equal(first.querySelector('.link-slug').value, 'unsaved draft');
  assert.equal(first.querySelector('.link-order-start').value, '91');

  listeners.error({ target: firstImage });
  assert(!firstImage.hasCustomImage());
  assert(!first.querySelector('[data-link-image-action="delete"]').disabled);
  const remove = first.querySelector('[data-link-image-action="delete"]');
  await listeners.click({ target: { closest: () => remove } });
  assert.equal(requests[2].options.method, 'DELETE');
  assert.equal(firstImage.src, undefined);
  assert.equal(remove.disabled, true);
  assert.equal(secondImage.src, '/preview/second');
  assert(notifications.at(-1).includes('Instagram'));
});

test('the public badge uses the existing fallback on errors and refreshes on image changes', () => {
  const image = imageElement();
  let socket, catalogRefreshes = 0;
  const context = vm.createContext({
    storefrontElements: { companyImage: image },
    storefrontState: { slug: 'store / one' },
    window: { location: { protocol: 'http:', host: 'wolforder.local' } },
    WebSocket: class { constructor() { socket = this; } },
    refreshStorefrontCatalog: () => { catalogRefreshes += 1; }
  });
  vm.runInContext(storeCode, context);
  vm.runInContext('refreshStorefrontImage(); connectStorefrontSocket()', context);
  assert.equal(image.src, '/api/instagram/storefront/store%20%2F%20one/image?v=1');
  assert.equal(image.hidden, true);
  image.fire('load');
  assert.equal(image.hasCustomImage(), true);
  socket.onmessage({ data: JSON.stringify({ source: 'instagram', type: 'INSTAGRAM_STOREFRONT_IMAGE_UPDATED' }) });
  assert(image.src.endsWith('?v=2'));
  assert.equal(catalogRefreshes, 0);
  image.fire('error');
  assert.equal(image.hidden, true);
  assert.equal(image.hasCustomImage(), false);
  socket.onmessage({ data: JSON.stringify({ source: 'instagram', type: 'INSTAGRAM_ORDER_CREATED' }) });
  assert.equal(catalogRefreshes, 1);
});
