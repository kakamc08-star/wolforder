'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const base = '10000000-0000-4000-8000-';
const ids = { admin: `${base}000000000001`, company: `${base}000000000002`, other: `${base}000000000003`, viewer: `${base}000000000004`, otherViewer: `${base}000000000005`, driver: `${base}000000000006`, pending: `${base}000000000010`, delivered: `${base}000000000011`, delivery: `${base}000000000012`, foreign: `${base}000000000013`, request: `${base}000000000014` };
const product = '20000000-0000-4000-8000-000000000001';
const fixture = [
  { id: ids.pending, company_id: ids.company, order_type: 'شحن', shipping_approval_status: 'pending', shipping_delivery_status: 'pending', status: 'قيد المتابعة', shipping_fee: 10000, items_total: 5000, total_price: 15000, items: [{ product_id: product, quantity: 1 }], is_archived: false },
  { id: ids.delivered, company_id: ids.company, order_type: 'شحن', shipping_delivery_status: 'delivered', status: 'قيد المتابعة', shipping_fee: 10000, items_total: 5000, total_price: 15000, items: [{ product_id: product, quantity: 1 }], is_archived: false },
  { id: ids.delivery, company_id: ids.company, driver_id: ids.driver, order_type: 'توصيل', status: 'تم', total_price: 5000, items: [], is_archived: false },
  { id: ids.foreign, company_id: ids.other, order_type: 'شحن', shipping_delivery_status: 'pending', status: 'قيد المتابعة', items: [], is_archived: false }
];
let rpcCalls = [];
class Query {
  constructor(table) { this.table = table; this.filters = []; this.single = false; }
  select() { return this; }
  eq(key, value) { this.filters.push((row) => row[key] === value); return this; }
  is(key, value) { this.filters.push((row) => value === null ? row[key] == null : row[key] === value); return this; }
  in(key, values) { this.filters.push((row) => values.includes(row[key])); return this; }
  or(expression) {
    this.filters.push((row) => expression.split(',').some((part) => {
      const [key, op, value] = part.split('.'); return op === 'is' ? row[key] == null : row[key] === value;
    })); return this;
  }
  order() { return this; }
  limit() { return this; }
  range() { return this; }
  gte() { return this; }
  lte() { return this; }
  maybeSingle() { this.single = true; return this; }
  then(resolve, reject) {
    let data;
    if (this.table === 'instagram_orders') data = structuredClone(fixture);
    else if (this.table === 'instagram_viewer_companies') data = [{ viewer_user_id: ids.viewer, company_id: ids.company }, { viewer_user_id: ids.otherViewer, company_id: ids.other }];
    else if (this.table === 'instagram_inventory_summary') data = [{ company_id: ids.company, product_id: product, color: 'أسود', size: 'L', sold: 99, reserved_shipping: 99, reserved_delivery: 2, remaining: 8 }];
    else if (this.table === 'instagram_inventory_delivery_totals') data = [{ company_id: ids.company, product_id: product, color: 'أسود', size: 'L', sold_delivery: 3, reserved_shipping: 1, shipping_delivered: 1 }];
    else if (this.table === 'instagram_order_edit_requests') data = [{ id: ids.request, company_id: ids.company, status: 'معلق' }, { id: ids.foreign, company_id: ids.other, status: 'معلق' }];
    else data = [];
    data = data.filter((row) => this.filters.every((filter) => filter(row)));
    return Promise.resolve({ data: this.single ? data[0] || null : data, error: null }).then(resolve, reject);
  }
}
const fakeDb = {
  from: (table) => new Query(table),
  rpc: async (name, params) => { rpcCalls.push({ name, params }); return { data: { id: ids.request, status: 'معلق', changed_count: 1, delivered_count: 1 }, error: null }; }
};
const dbPath = require.resolve('../config/db');
const authPath = require.resolve('../middleware/auth');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb };
require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports: (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const roles = { admin: 'admin', viewer: 'instagram_viewer', otherViewer: 'instagram_viewer', driver: 'driver', company: 'company' };
  if (!roles[token]) return res.sendStatus(401);
  req.user = { id: ids[token], role: roles[token] }; next();
} };
const app = express(); app.use(express.json()); app.use('/api/instagram', require('../routes/instagram'));
let server; let origin;
test.before(async () => { server = app.listen(0, '127.0.0.1'); await new Promise((resolve) => server.once('listening', resolve)); origin = `http://127.0.0.1:${server.address().port}/api/instagram`; });
test.after(async () => { await new Promise((resolve) => server.close(resolve)); });
async function api(path, role = 'viewer', method = 'GET', body) {
  const response = await fetch(origin + path, { method, headers: { Authorization: `Bearer ${role}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, data };
}

test('الشحن يظهر للأدمن مباشرة حتى مع علامة الموافقة القديمة', async () => {
  const response = await api('/orders?orderType=شحن', 'admin');
  assert.equal(response.status, 200); assert(response.data.some((order) => order.id === ids.pending));
  const order = response.data.find((row) => row.id === ids.pending);
  assert.equal(order.status_label, 'لم يتم التسليم'); assert.equal(order.shipping_approval_status, undefined);
});

test('فلاتر تم التسليم ولم يتم التسليم تستخدم الحقل الحالي', async () => {
  const delivered = await api('/orders?status=تم التسليم');
  const pending = await api('/orders?status=لم يتم التسليم');
  assert.deepEqual(delivered.data.map((order) => order.id), [ids.delivered]);
  assert.deepEqual(pending.data.map((order) => order.id), [ids.pending]);
  assert.equal(delivered.data[0].status_label, 'تم التسليم');
  const explicit = await api('/orders?shippingDeliveryStatus=delivered');
  assert.deepEqual(explicit.data.map((order) => order.id), [ids.delivered]);
});

test('حالات التوصيل العامة لا تخلط طلبات الشحن وتبقى فعالة', async () => {
  const response = await api('/orders?status=تم'); assert.deepEqual(response.data.map((order) => order.id), [ids.delivery]);
  const pending = await api('/orders?status=قيد المتابعة'); assert.deepEqual(pending.data, []);
});

test('فلتر المدير يميز بدون سائق عن كل السائقين وعن سائق محدد', async () => {
  const all = await api('/orders', 'admin'); assert.equal(all.data.length, 4);
  const unassigned = await api('/orders?driverId=unassigned', 'admin');
  assert.equal(unassigned.status, 200); assert.deepEqual(unassigned.data.map((order) => order.id), [ids.pending, ids.delivered, ids.foreign]);
  const assigned = await api(`/orders?driverId=${ids.driver}`, 'admin');
  assert.deepEqual(assigned.data.map((order) => order.id), [ids.delivery]);
  const delivered = await api('/orders?driverId=unassigned&shippingDeliveryStatus=delivered', 'admin');
  assert.deepEqual(delivered.data.map((order) => order.id), [ids.delivered]);
  const pending = await api(`/orders?driverId=unassigned&shippingDeliveryStatus=pending&companyId=${ids.company}`, 'admin');
  assert.deepEqual(pending.data.map((order) => order.id), [ids.pending]);
});

test('فلتر بدون سائق الجديد لا يغيّر عرض المشاهدة أو صلاحية السائق', async () => {
  const viewer = await api('/orders?driverId=unassigned');
  assert.deepEqual(viewer.data.map((order) => order.id), [ids.pending, ids.delivered, ids.delivery]);
  const driver = await api('/orders?driverId=unassigned', 'driver');
  assert.deepEqual(driver.data.map((order) => order.id), [ids.delivery]);
});

test('معرف الشركة في الرابط لا يسمح للمشاهد برؤية شركة أخرى', async () => {
  const response = await api(`/orders?companyId=${ids.other}`);
  assert.equal(response.status, 200); assert(response.data.every((order) => order.company_id === ids.company));
  assert.equal((await api(`/orders/${ids.foreign}`)).status, 404);
});

test('الجرد وتصديره يعرضان المباعة والشحن المسلم كلّاً في موضعه', async () => {
  const response = await api('/inventory'); assert.equal(response.data[0].reserved_shipping, 1);
  assert.equal(response.data[0].shipping_delivered, 1); assert.equal(response.data[0].sold, 3);
  assert.equal(response.data[0].reserved_delivery, 2); assert.equal(response.data[0].remaining, 8);
  const exported = await api('/inventory/export', 'admin');
  assert(exported.data.indexOf('المباعة') < exported.data.indexOf('الشحن المُسلَّم'));
  assert(exported.data.indexOf('الشحن المُسلَّم') < exported.data.indexOf('المؤجلة'));
});

test('جدول الشحن المسلم مقيد بحالة التسليم وشركة حساب المشاهدة', async () => {
  const response = await api(`/inventory/shipping-delivered?companyId=${ids.other}&productId=${product}`);
  assert.equal(response.status, 200); assert.deepEqual(response.data.orders.map((order) => order.id), [ids.delivered]);
  assert.equal(response.data.has_more, false);
});

test('المشاهد يرسل مقترحاً للأدمن دون تعديل بيانات الطلب مباشرة', async () => {
  rpcCalls = []; const before = structuredClone(fixture);
  const response = await api(`/orders/${ids.pending}/edit-requests`, 'viewer', 'POST', { changes: { customer_number: '٠٩٨٨٨٨٨٨٨٨' }, reason: 'تصحيح الهاتف' });
  assert.equal(response.status, 201); assert.deepEqual(fixture, before);
  assert.equal(rpcCalls.length, 1); assert.equal(rpcCalls[0].name, 'create_instagram_order_edit_request_atomic');
  assert.equal(rpcCalls[0].params.p_actor_user_id, ids.viewer); assert.equal(rpcCalls[0].params.p_changes.customer_number, '0988888888');
});

test('تجاوز الشركة وإرسال حقول غير مصرح بها يُرفضان قبل تسجيل المقترح', async () => {
  rpcCalls = [];
  assert.equal((await api(`/orders/${ids.foreign}/edit-requests`, 'viewer', 'POST', { changes: { note: 'x' } })).status, 404);
  assert.equal((await api(`/orders/${ids.pending}/edit-requests`, 'viewer', 'POST', { changes: { company_id: ids.other } })).status, 400);
  assert.equal(rpcCalls.length, 0);
});

test('حساب المشاهدة والسائق والشركة لا يملكون التعديل المباشر أو قرار الأدمن', async () => {
  rpcCalls = [];
  for (const role of ['viewer', 'driver', 'company']) {
    assert.equal((await api(`/orders/${ids.pending}`, role, 'PATCH', { note: 'x' })).status, 403);
    assert.equal((await api(`/orders/${ids.pending}/shipping-status`, role, 'PATCH', { shipping_delivery_status: 'delivered' })).status, 403);
    assert.equal((await api(`/edit-requests/${ids.request}/accept`, role, 'PATCH', {})).status, 403);
  }
  assert.equal(rpcCalls.length, 0);
});

test('الأدمن يوافق أو يرفض من خلال معاملة القرار نفسها', async () => {
  rpcCalls = [];
  assert.equal((await api(`/edit-requests/${ids.request}/accept`, 'admin', 'PATCH', { note: 'موافقة' })).status, 200);
  assert.equal(rpcCalls[0].name, 'decide_instagram_order_edit_request_atomic'); assert.equal(rpcCalls[0].params.p_approve, true);
  assert.equal((await api(`/edit-requests/${ids.request}/reject`, 'admin', 'PATCH', { note: 'رفض' })).status, 200);
  assert.equal(rpcCalls[1].params.p_approve, false);
});

test('زر تعديل الشحن يرسل تغييرات الأدمن إلى معاملة التعديل فقط', async () => {
  rpcCalls = [];
  const response = await api(`/orders/${ids.pending}`, 'admin', 'PATCH', { note: 'تصحيح الشحن', shipping_delivery_status: 'delivered' });
  assert.equal(response.status, 200); assert.equal(rpcCalls.length, 1);
  assert.equal(rpcCalls[0].name, 'edit_instagram_order_atomic');
  assert.deepEqual(rpcCalls[0].params.p_changes, { note: 'تصحيح الشحن', shipping_delivery_status: 'delivered' });
  assert.equal(rpcCalls[0].params.p_actor_user_id, ids.admin);
});

test('تغيير نوع الطلب يقبل حالة النوع الجديد ويرفض حالة النوع الآخر', async () => {
  rpcCalls = [];
  const changed = await api(`/orders/${ids.pending}`, 'admin', 'PATCH', { order_type: 'توصيل', status: 'تم' });
  assert.equal(changed.status, 200); assert.deepEqual(rpcCalls[0].params.p_changes, { status: 'تم', order_type: 'توصيل' });
  const count = rpcCalls.length;
  for (const changes of [{ order_type: 'ثالث' }, { status: 'تم' }, { shipping_delivery_status: 'ثالث' }, { order_type: 'توصيل', shipping_delivery_status: 'delivered' }]) {
    assert.equal((await api(`/orders/${ids.pending}`, 'admin', 'PATCH', changes)).status, 400);
  }
  assert.equal(rpcCalls.length, count);
});

test('المشاهد يقترح نوع الطلب ولا يطبقه مباشرة', async () => {
  rpcCalls = [];
  const before = structuredClone(fixture);
  const response = await api(`/orders/${ids.pending}/edit-requests`, 'viewer', 'POST', { changes: { order_type: 'توصيل', address: 'دمشق المزة', status: 'قيد المتابعة' } });
  assert.equal(response.status, 201); assert.deepEqual(fixture, before);
  assert.equal(rpcCalls[0].name, 'create_instagram_order_edit_request_atomic');
  assert.equal(rpcCalls[0].params.p_changes.order_type, 'توصيل');
});

test('مسارات قبول ورفض الشحن أُزيلت وحالات الشحن العامة محمية', async () => {
  rpcCalls = [];
  for (const action of ['approve', 'reject']) assert.equal((await api(`/orders/${ids.pending}/shipping/${action}`, 'viewer', 'POST', {})).status, 404);
  assert.equal((await api(`/orders/${ids.pending}/status`, 'admin', 'PATCH', { status: 'تم' })).status, 400);
  assert.equal((await api('/orders/bulk-status', 'admin', 'PATCH', { ids: [ids.pending], status: 'تم' })).status, 400);
  assert.equal(rpcCalls.length, 0);
});
