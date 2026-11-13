'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const source = file => fs.readFileSync(path.join(__dirname, '../public/js', file), 'utf8');
const pause = () => new Promise(resolve => setTimeout(resolve, 30));
function dom(html) { return new JSDOM(html, { url: 'https://wolforder.test', runScripts: 'outside-only', pretendToBeVisual: true }); }

test('English digits cover text, dynamic rows, phones and numeric input while credentials and IDs stay intact', async () => {
  const page = dom('<p id="display">طلب ١٢٣ والسعر ۲۵</p><a href="tel:٠٩٨٤١٥٥٢١٥">٠٩٨٤١٥٥٢١٥</a><input id="username" value="اسم١٢٣"><input id="password" type="password" value="سر١٢٣"><span data-preserve-digits>حساب١٢٣</span><input id="quantity" type="number" min="1" max="10" step="1"><input id="date" type="date"><div id="rows"></div>');
  const { window } = page; const document = window.document;
  window.eval(source('number-format.js')); await pause();
  assert.equal(document.getElementById('display').textContent, 'طلب 123 والسعر 25');
  assert.equal(document.querySelector('a').getAttribute('href'), 'tel:0984155215');
  assert.equal(document.getElementById('username').value, 'اسم١٢٣');
  assert.equal(document.getElementById('password').value, 'سر١٢٣');
  assert.equal(document.querySelector('[data-preserve-digits]').textContent, 'حساب١٢٣');
  assert.equal(document.getElementById('date').lang, 'en-GB');
  const quantity = document.getElementById('quantity');
  quantity.value = '٥'; quantity.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal(quantity.value, '5'); assert.equal(quantity.checkValidity(), true);
  for (const value of ['٠', '١١', '١٫٥', '0xff']) {
    quantity.value = value; quantity.dispatchEvent(new window.Event('input', { bubbles: true }));
    assert.equal(quantity.checkValidity(), false, value);
  }
  document.getElementById('rows').innerHTML = '<p data-order-id="id١٢">رقم ٩٨٧</p>';
  await pause();
  assert.equal(document.querySelector('[data-order-id]').textContent, 'رقم 987');
  assert.equal(document.querySelector('[data-order-id]').dataset.orderId, 'id١٢');
  page.window.close();
});

test('request normalization accepts Arabic prices and phones without rewriting credentials, IDs or binary uploads', () => {
  const middleware = require('../middleware/numbers');
  const req = { body: { username: 'حساب١٢', newPassword: 'سر١٢٣', companyId: 'uuid١٢', phone: '٠٩٨٤١٥٥٢١٥', price: '١٬٢٥٠٫٥', variants: [{ stockTotal: '١٢' }] }, query: { startDate: '٢٠٢٦-١١-١٣', page: '٢' } };
  let next = false; middleware(req, {}, () => { next = true; });
  assert(next); assert.equal(req.body.username, 'حساب١٢'); assert.equal(req.body.newPassword, 'سر١٢٣'); assert.equal(req.body.companyId, 'uuid١٢');
  assert.equal(req.body.price, '1250.5'); assert.equal(req.body.phone, '0984155215'); assert.equal(req.body.variants[0].stockTotal, '12'); assert.equal(req.query.startDate, '2026-11-13');
  const bytes = Buffer.from([0xff, 0xd8, 0xff]); const binary = { body: bytes };
  middleware(binary, {}, () => {}); assert.equal(binary.body, bytes);
});

test('login countdown survives reload, is account-specific and expires; unavailable storage does not bypass the UI lock', () => {
  function loginPage(storageBlocked = false) {
    const page = dom('<input id="username" value="driver"><button>دخول</button>');
    let now = 1000000; const messages = [];
    page.window.Date.now = () => now; page.window.setTimeout = () => 1;
    if (storageBlocked) Object.defineProperty(page.window, 'localStorage', { get() { throw new Error('blocked'); } });
    page.window.eval(source('login-lockout.js'));
    const button = page.window.document.querySelector('button'); const input = page.window.document.querySelector('input');
    const lock = page.window.createLoginLockout(button, input, message => messages.push(message));
    return { page, button, input, lock, messages, advance(seconds) { now += seconds * 1000; input.dispatchEvent(new page.window.Event('input')); } };
  }
  const first = loginPage(); first.lock.start(300, 'driver');
  assert.equal(first.button.disabled, true); assert.match(first.messages.at(-1), /05:00/);
  const second = loginPage();
  second.page.window.localStorage.setItem('wolforderLoginLock:driver', first.page.window.localStorage.getItem('wolforderLoginLock:driver'));
  second.input.dispatchEvent(new second.page.window.Event('input'));
  assert.equal(second.lock.isBlocked(), true); assert.equal(second.button.disabled, true);
  second.input.value = 'other'; second.input.dispatchEvent(new second.page.window.Event('input'));
  assert.equal(second.lock.isBlocked(), false); assert.equal(second.button.disabled, false);
  first.advance(300); assert.equal(first.lock.isBlocked(), false); assert.equal(first.button.disabled, false);
  const blocked = loginPage(true); blocked.lock.start(300, 'driver'); assert.equal(blocked.lock.isBlocked(), true);
  for (const item of [first, second, blocked]) item.page.window.close();
});

test('company inventory filter retains every field and selection across refresh without additional filtering requests', async () => {
  const page = dom('<select id="viewerInventoryProduct"></select><table><tbody id="viewerInventoryBody"></tbody></table>');
  const script = source('instagram-viewer.js');
  const code = script.slice(script.indexOf('async function loadViewerInventory()'), script.indexOf('function viewerStatusLabel'));
  let requests = 0;
  const rows = ['first', 'second'].map((product_id, i) => ({ product_id, product_name: 'صنف ' + i, color: 'أسود', size: 'L', quantity_total: 25, reserved_delivery: 3, reserved_shipping: 2, sold: 4, shipping_delivered: 1, postponed: 1, returned: 2, cancelled: 0, remaining: 15 }));
  page.window.viewerState = { inventory: [] };
  page.window.viewerApi = async url => { assert.equal(url, '/api/instagram/inventory'); requests++; return structuredClone(rows); };
  page.window.viewerEscape = value => String(value); page.window.viewerNotify = message => { throw new Error(message); };
  page.window.eval(code); await page.window.loadViewerInventory();
  const select = page.window.document.querySelector('select');
  assert.equal(select.options.length, 3); assert.equal(page.window.document.querySelectorAll('tbody tr').length, 2);
  select.value = 'second'; select.dispatchEvent(new page.window.Event('change'));
  assert.equal(requests, 1); assert.equal(page.window.document.querySelectorAll('tbody tr').length, 1);
  assert.equal(page.window.document.querySelectorAll('tbody td').length, 12);
  assert.equal(page.window.document.querySelector('tbody td').textContent, 'صنف 1');
  await page.window.loadViewerInventory(); assert.equal(select.value, 'second');
  select.value = ''; select.dispatchEvent(new page.window.Event('change'));
  assert.equal(page.window.document.querySelectorAll('tbody tr').length, 2);
  page.window.close();
});

test('legacy archived products render stopped without mutation and toggle save targets the correct product', async () => {
  const page = dom('<div id="instagramProductsGrid"></div><button id="loadInstagramProducts"></button>');
  const script = source('instagram-admin.js');
  const code = script.slice(script.indexOf('function renderInstagramProducts()'), script.indexOf('// ========== Inventory =========='));
  const product = { id: 'product-one', company_id: 'company', name: 'قميص', status: 'archived', unit_price: 5000, variants: [{ id: 'variant-one', color: 'أسود', size: 'L', stock_total: 8, is_active: true }] };
  page.window.igState = { products: [product], bootstrap: { companies: [{ id: 'company', name: 'شركة' }] } };
  page.window.igEscape = String; page.window.igNotify = () => {}; page.window.loadInstagramProducts = async () => {};
  const requests = []; page.window.igApi = async (url, options) => { requests.push({ url, options }); };
  page.window.eval(code); page.window.renderInstagramProducts();
  const toggle = page.window.document.querySelector('[role="switch"]');
  assert.equal(toggle.checked, false); assert.equal(product.status, 'archived');
  assert.equal(page.window.document.querySelectorAll('[data-variant-id]').length, 1);
  toggle.checked = true;
  page.window.document.querySelector('[data-product-action="save"]').click(); await pause();
  assert.equal(requests[0].url, '/api/instagram/products/product-one'); assert.equal(requests[0].options.body.status, 'active');
  assert.equal(product.status, 'archived'); page.window.close();
});

test('password administration searches accounts and submits the chosen account with unmodified credentials', async () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/admin.html'), 'utf8');
  const page = dom(html); const { window } = page; const document = window.document;
  window.TextEncoder = TextEncoder; window.localStorage.setItem('token', 'local-fixture');
  const accounts = [{ id: 'driver-id', username: 'driver١٢', name: 'سائق', role: 'driver' }, { id: 'admin-id', username: 'admin', name: 'مدير', role: 'admin' }];
  const requests = [];
  window.fetch = async (url, options) => {
    requests.push({ url, options });
    return { ok: true, json: async () => url.endsWith('password-accounts') ? accounts : { message: 'تم تغيير كلمة المرور بنجاح' } };
  };
  window.eval(source('number-format.js')); window.eval(source('password-admin.js'));
  document.querySelector('a[href="#passwordsSection"]').click(); await pause();
  assert.equal(document.querySelectorAll('[data-password-account]').length, 2);
  const search = document.getElementById('passwordAccountSearch'); search.value = 'driver12'; search.dispatchEvent(new window.Event('input'));
  assert.equal(document.querySelectorAll('[data-password-account]').length, 1);
  assert.match(document.getElementById('passwordAccountsList').textContent, /driver١٢/);
  document.querySelector('[data-password-account]').click();
  const password = 'new-secret-١٢٣'; document.getElementById('managedNewPassword').value = password;
  document.getElementById('managedConfirmPassword').value = 'mismatch';
  const form = document.getElementById('passwordChangeForm');
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await pause();
  assert.equal(requests.length, 1);
  document.getElementById('managedConfirmPassword').value = password;
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await pause();
  assert.equal(requests[1].url, '/api/auth/users/driver-id/password');
  assert.deepEqual(JSON.parse(requests[1].options.body), { newPassword: password, confirmPassword: password });
  assert.equal(form.hidden, true); assert.equal(document.getElementById('managedNewPassword').value, '');
  page.window.close();
});

test('mobile and desktop select-all controls operate on the displayed order IDs and stay synchronized', () => {
  const page = dom('<input id="igSelectAll" type="checkbox"><input id="igSelectAllMobile" type="checkbox"><div id="igBulkBar"></div><span id="igSelectedCount"></span>');
  const script = source('instagram-admin.js'); const { window } = page; const document = window.document;
  window.igState = { orders: [{ id: 'one' }, { id: 'two' }], selectedOrders: new Set() };
  window.updateBulkActionOptions = () => {};
  window.eval(script.slice(script.indexOf('function updateBulkBar()'), script.indexOf('function updateBulkActionOptions()')));
  window.renderInstagramOrders = () => window.updateBulkBar();
  window.eval(script.slice(script.indexOf('function selectAllInstagramOrders('), script.indexOf('async function performOrderAction(')));
  document.getElementById('igSelectAllMobile').click();
  assert.deepEqual([...window.igState.selectedOrders], ['one', 'two']); assert.equal(document.getElementById('igSelectAll').checked, true);
  document.getElementById('igSelectAll').click(); assert.equal(window.igState.selectedOrders.size, 0);
  assert.equal(document.getElementById('igSelectAllMobile').checked, false); assert.equal(document.getElementById('igBulkBar').hidden, true);
  page.window.close();
});
