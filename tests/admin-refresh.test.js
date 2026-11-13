'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/js/admin.js'), 'utf8');
const core = source.slice(source.indexOf('// ==================== جلب الطلبات'), source.indexOf('// ==================== حذف طلب'));
const state = source.slice(source.indexOf('let selectedOrderIds'), source.indexOf('// تشغيل الاتصال الفوري الآن'));
const formatters = source.slice(source.indexOf('function formatDate'), source.indexOf('function showNotification'));
const digits = source.slice(source.indexOf('function convertToEnglishDigits'), source.indexOf('// ==================== جلب الطلبات'));

function createDashboard() {
  const timers = new Map();
  const requests = [];
  const notifications = [];
  const elements = new Map();
  let timerId = 0;
  let createdRows = 0;
  for (const id of ['searchInput', 'filterStatus', 'filterOrderType', 'filterDriver', 'filterCompany', 'filterStartDate', 'filterEndDate']) {
    elements.set(id, { value: '' });
  }
  for (const id of ['lastUpdateTime', 'totalPriceSYR', 'totalPriceUSD', 'totalRatioSum']) {
    elements.set(id, { textContent: '' });
  }
  const tbody = {
    rows: [],
    replaceChildren(fragment) { this.rows = [...fragment.children]; }
  };
  elements.set('ordersTableBody', tbody);
  const document = {
    getElementById: (id) => elements.get(id) || null,
    createDocumentFragment: () => ({
      children: [],
      appendChild(row) { this.children.push(row); }
    }),
    createElement: () => {
      createdRows += 1;
      return {
        style: {},
        children: [],
        set innerHTML(html) {
          this.html = html;
          this.cells = [...html.matchAll(/<td\b/g)].map(() => ({ textContent: '' }));
          this.children = this.cells;
          this.checkbox = { value: html.match(/class="orderCheckbox" value="([^"]+)"/)[1] };
        },
        querySelector() { return this.checkbox; }
      };
    }
  };
  const context = vm.createContext({
    document, token: 'fixture-token', AbortController, URLSearchParams, Intl,
    console: { error() {} },
    showNotification: (message) => notifications.push(message),
    setTimeout(callback) {
      timers.set(++timerId, callback);
      return timerId;
    },
    clearTimeout: (id) => timers.delete(id),
    fetch: (url, options) => new Promise((resolve) => {
      requests.push({
        url, options,
        resolve: (orders, ok = true) => resolve({ ok, json: async () => structuredClone(orders) })
      });
    })
  });
  vm.runInContext(state + formatters + digits + core, context);
  return {
    context, elements, tbody, requests, timers, notifications,
    run: (code) => vm.runInContext(code, context),
    rowsCreated: () => createdRows,
    flushTimers() {
      const scheduled = [...timers.values()];
      timers.clear();
      scheduled.forEach((callback) => callback());
    },
    async load(orders) {
      const promise = vm.runInContext('fetchOrders()', context);
      requests.at(-1).resolve(orders);
      await promise;
    }
  };
}

function order(id, values = {}) {
  return {
    id, order_number: id, customer_name: 'زبون ' + id, customer_number: '0990000000',
    order_contents: 'قميص', address: 'دمشق', price: 1000, currency: 'ل.س',
    status: 'قيد المتابعة', created_at: '2026-11-01T10:00:00Z', ...values
  };
}

test('كتابة البحث أثناء تحميل الطلبات تبقى وتستخدم مع الرد الجديد', async () => {
  const dashboard = createDashboard();
  const pending = dashboard.run('fetchOrders()');
  dashboard.elements.get('searchInput').value = 'هند';
  dashboard.requests[0].resolve([order('1', { customer_name: 'هند' }), order('2')]);
  await pending;
  assert.equal(dashboard.elements.get('searchInput').value, 'هند');
  assert.deepEqual(dashboard.tbody.rows.map((row) => row.checkbox.value), ['1']);
});

test('تغيير الفلاتر أثناء الطلب يمنع عرض الرد القديم ويجلب القيم الحالية', async () => {
  const dashboard = createDashboard();
  const pending = dashboard.run('fetchOrders()');
  dashboard.elements.get('filterCompany').value = 'company-two';
  dashboard.elements.get('filterStatus').value = 'تم';
  dashboard.requests[0].resolve([order('old')]);
  await pending;
  assert.equal(dashboard.tbody.rows.length, 0);
  assert.equal(dashboard.timers.size, 1);
  dashboard.flushTimers();
  const params = new URL(dashboard.requests[1].url, 'http://local').searchParams;
  assert.equal(params.get('companyId'), 'company-two');
  assert.equal(params.get('status'), 'تم');
  dashboard.requests[1].resolve([order('new', { status: 'تم' })]);
  await dashboard.run('ordersRequest.promise');
  assert.equal(dashboard.elements.get('filterCompany').value, 'company-two');
  assert.deepEqual(dashboard.tbody.rows.map((row) => row.checkbox.value), ['new']);
});

test('رد طلب ملغى يصل متأخراً لا يستبدل نتائج الفلاتر الأحدث', async () => {
  const dashboard = createDashboard();
  const first = dashboard.run('fetchOrders()');
  dashboard.elements.get('filterStatus').value = 'تم';
  const second = dashboard.run('fetchOrders()');
  assert(dashboard.requests[0].options.signal.aborted);
  dashboard.requests[1].resolve([order('new', { status: 'تم' })]);
  await second;
  dashboard.requests[0].resolve([order('old')]);
  await first;
  assert.deepEqual(dashboard.tbody.rows.map((row) => row.checkbox.value), ['new']);
  assert.equal(dashboard.notifications.length, 0);
});

test('التحديثات المتقاربة تشترك في طلب واحد وتحتفظ بتحديث لاحق أثناء التحميل', async () => {
  const dashboard = createDashboard();
  dashboard.run('for (let i = 0; i < 10; i += 1) scheduleOrdersRefresh()');
  assert.equal(dashboard.timers.size, 1);
  dashboard.flushTimers();
  assert.equal(dashboard.requests.length, 1);
  dashboard.run('for (let i = 0; i < 10; i += 1) scheduleOrdersRefresh()');
  const pending = dashboard.run('ordersRequest.promise');
  dashboard.requests[0].resolve([order('one')]);
  await pending;
  assert.equal(dashboard.timers.size, 1);
  dashboard.flushTimers();
  assert.equal(dashboard.requests.length, 2);
  const trailing = dashboard.run('ordersRequest.promise');
  dashboard.requests[1].resolve([order('one'), order('two')]);
  await trailing;
  assert.equal(dashboard.timers.size, 0);
  assert.equal(dashboard.tbody.rows.length, 2);
});

test('التحديث اليدوي المتكرر ينتظر الطلب الجاري نفسه', async () => {
  const dashboard = createDashboard();
  const first = dashboard.run('fetchOrders()');
  const second = dashboard.run('fetchOrders()');
  assert.equal(first, second);
  assert.equal(dashboard.requests.length, 1);
  dashboard.requests[0].resolve([]);
  await first;
});

test('فشل تحميل البيانات يحتفظ بالجدول والبحث ويعرض رسالة فشل', async () => {
  const dashboard = createDashboard();
  await dashboard.load([order('saved')]);
  dashboard.elements.get('searchInput').value = 'saved';
  const pending = dashboard.run('fetchOrders()');
  dashboard.requests.at(-1).resolve([], false);
  await pending;
  assert.equal(dashboard.elements.get('searchInput').value, 'saved');
  assert.equal(dashboard.tbody.rows[0].checkbox.value, 'saved');
  assert.equal(dashboard.notifications.length, 1);
});

test('البحث والترتيب يعيدان استخدام الصفوف ويحافظان على التحديد والمجاميع', async () => {
  const dashboard = createDashboard();
  const orders = [order('ten', { order_number: 10 }), order('two', { order_number: 2, price: 5, currency: 'دولار' })];
  await dashboard.load(orders);
  const original = [...dashboard.tbody.rows];
  dashboard.run("selectedOrderIds.add('ten')");
  dashboard.elements.get('searchInput').value = 'two';
  dashboard.run('applyFiltersAndRender()');
  assert.equal(dashboard.tbody.rows[0], original[1]);
  assert.equal(dashboard.tbody.rows[0].cells[2].textContent, 1);
  dashboard.elements.get('searchInput').value = '';
  dashboard.run("currentSort = 'asc'; applyFiltersAndRender()");
  assert.deepEqual(dashboard.tbody.rows.map((row) => row.checkbox.value), ['two', 'ten']);
  assert.equal(dashboard.tbody.rows[1].checkbox.checked, true);
  assert.equal(dashboard.rowsCreated(), 2);
  assert.equal(dashboard.elements.get('totalPriceSYR').textContent, '1,000 ل.س');
  assert.equal(dashboard.elements.get('totalPriceUSD').textContent, '5 $');
  await dashboard.load(orders);
  assert.equal(dashboard.rowsCreated(), 2);
  await dashboard.load([order('ten', { order_number: 10, price: 2500 }), orders[1]]);
  assert.equal(dashboard.rowsCreated(), 3);
  assert.equal(dashboard.elements.get('totalPriceSYR').textContent, '2,500 ل.س');
  await dashboard.load([orders[1]]);
  assert.equal(dashboard.run('orderRows.size'), 1);
});

test('البحث يدعم الحقول القديمة والأرقام العربية والفارسية والطلبات بعد 1000', async () => {
  const dashboard = createDashboard();
  const orders = Array.from({ length: 1200 }, (_, index) => order(String(index + 1)));
  orders[1199].customer_number = '٠٩٩١٢٣٤٥٦٧';
  await dashboard.load(orders);
  dashboard.elements.get('searchInput').value = '۰۹۹۱۲۳۴۵۶۷';
  dashboard.run('applyFiltersAndRender()');
  assert.equal(dashboard.tbody.rows[0].checkbox.value, '1200');
  assert.equal(dashboard.rowsCreated(), 1200);
  const legacy = { orderNumber: 42, customerName: 'Legacy Client', orderContents: 'Legacy Product', address: 'abc', note: 'def' };
  dashboard.context.legacy = legacy;
  assert.equal(dashboard.run("filterOrdersBySearch([legacy], 'legacy client').length"), 1);
  assert.equal(dashboard.run("filterOrdersBySearch([legacy], 'abcdef').length"), 0);
});

test('نطاق التاريخ يشمل آخر جزء من الثانية في اليوم المحدد', async () => {
  const dashboard = createDashboard();
  dashboard.elements.get('filterStartDate').value = '2026-11-13';
  dashboard.elements.get('filterEndDate').value = '2026-11-13';
  const pending = dashboard.run('fetchOrders()');
  const params = new URL(dashboard.requests[0].url, 'http://local').searchParams;
  assert.equal(params.get('startDate'), new Date('2026-11-13T00:00:00').toISOString());
  assert.equal(params.get('endDate'), new Date('2026-11-13T23:59:59.999').toISOString());
  dashboard.requests[0].resolve([]);
  await pending;
});

test('محاولات الاتصال المتكررة تنشئ اتصال WebSocket واحداً', () => {
  const connections = [];
  class Socket {
    static CONNECTING = 0;
    static OPEN = 1;
    constructor() { this.readyState = Socket.CONNECTING; connections.push(this); }
  }
  const context = vm.createContext({
    WebSocket: Socket, window: { location: { protocol: 'http:', host: 'local' } },
    console: { log() {} }, setTimeout() {}, scheduleOrdersRefresh() {}
  });
  vm.runInContext(source.slice(0, source.indexOf('// ==================== 2. المصادقة')), context);
  vm.runInContext('connectWebSocket(); connectWebSocket()', context);
  assert.equal(connections.length, 1);
  connections[0].readyState = Socket.OPEN;
  vm.runInContext('connectWebSocket()', context);
  assert.equal(connections.length, 1);
});
