'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('طلبات إنستغرام في جدول ومسار منفصلين عن الطلبات الأساسية', () => {
  const normalRoute = read('routes/orders.js');
  const instagramRoute = read('routes/instagram.js');
  assert.match(normalRoute, /from\('orders'\)/);
  assert.doesNotMatch(normalRoute, /from\('instagram_orders'\)/);
  assert.match(instagramRoute, /from\('instagram_orders'\)/);
  assert.match(normalRoute, /\['admin', 'driver', 'company'\]/);
});

test('حساب المشاهدة لا يملك مسارات تعديل أو تصدير', () => {
  const instagramRoute = read('routes/instagram.js');
  assert.match(instagramRoute, /function requireAdmin/);
  assert.match(instagramRoute, /router\.post\('\/products', requireAdmin/);
  assert.match(instagramRoute, /router\.post\('\/inventory\/:id\/adjust', requireAdmin/);
  assert.match(instagramRoute, /router\.get\('\/export', requireAdmin/);
  assert.match(instagramRoute, /router\.post\('\/shipping-batches', requireAdmin/);
  assert.match(instagramRoute, /getViewerCompany\(req\.user\.id\)/);
});

test('Migration تحتوي قفل صف وحركات مخزون وRLS ومنع التنفيذ المباشر', () => {
  const sql = read('database/2026-08-27-instagram-orders-and-performance.sql');
  assert.match(sql, /for update of i/i);
  assert.match(sql, /pg_advisory_xact_lock/i);
  assert.match(sql, /instagram_inventory_movements/i);
  assert.match(sql, /enable row level security/i);
  assert.match(sql, /revoke execute on function public\.create_instagram_order/i);
  assert.match(sql, /if order_row\.status = p_new_status then return/i);
  assert.match(sql, /create_instagram_shipping_batch/i);
  assert.match(sql, /instagram_items_inventory_order_idx/i);
});

test('صفحة إنستغرام لا تعرض شحن لباب المنزل بينما النظام الأساسي يحتفظ به', () => {
  const publicPage = read('public/instagram-order.html');
  const companyPage = read('public/company.html');
  assert.doesNotMatch(publicPage, /شحن لباب المنزل/);
  assert.match(companyPage, /شحن لباب المنزل/);
});

test('Service Worker لا يخزن API أو صفحات الجلسات', () => {
  const serviceWorker = read('public/sw.js');
  assert.match(serviceWorker, /pathname\.startsWith\('\/api\/'\)/);
  assert.match(serviceWorker, /cache: 'no-store'/);
});
