'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('لوحة مدير إنستغرام تحتوي إجراءات الطلب والتحديد الجماعي', () => {
  const html = read('public/instagram-admin.html');
  const script = read('public/js/instagram-admin.js');
  assert.match(html, /id="selectAllInstagramOrders"/);
  assert.match(html, /id="instagramBulkAction"/);
  assert.match(script, /data-instagram-action="edit"/);
  assert.match(script, /data-instagram-action="delete"/);
  assert.match(script, /data-instagram-action="print"/);
  assert.match(script, /data-instagram-action="assign"/);
  assert.match(script, /applyBulkAction/);
});

test('حذف الصنف والجرد والطلب يعتمد مسارات ودوال مخزون آمنة', () => {
  const route = read('routes/instagram.js');
  const sql = read('database/2026-08-28-admin-parity-and-safe-deletions.sql');
  assert.match(route, /router\.delete\('\/products\/:id', requireAdmin/);
  assert.match(route, /router\.delete\('\/inventory\/:id', requireAdmin/);
  assert.match(route, /router\.delete\('\/orders\/:id', requireAdmin/);
  assert.match(sql, /archive_instagram_product/i);
  assert.match(sql, /archive_instagram_inventory/i);
  assert.match(sql, /delete_instagram_order/i);
  assert.match(sql, /available_quantity = available_quantity \+ item_row\.quantity/i);
});

test('الجرد يعرض فلتر الشحن وعدد الطلبات والقطع', () => {
  const html = read('public/instagram-admin.html');
  const route = read('routes/instagram.js');
  assert.match(html, /id="inventoryOrderType"/);
  assert.match(html, /id="pendingShippingOrdersCount"/);
  assert.match(html, /id="pendingShippingPiecesCount"/);
  assert.match(route, /getPendingShippingSummary/);
  assert.match(route, /pieceCount/);
});

test('رابط الطلب لا يعرض زر حذف ويعرض رسالة النجاح باسم الشركة فقط', () => {
  const html = read('public/instagram-order.html');
  const script = read('public/js/instagram-public.js');
  assert.doesNotMatch(script, /remove-instagram-item/);
  assert.doesNotMatch(html, />شحن فقط</);
  assert.match(script, /تم إنشاء الطلب وهو الآن قيد المتابعة/);
  assert.match(script, /شكرًا لطلبكم من/);
  assert.doesNotMatch(script, /رقم الطلب:/);
});

test('لوحة السائق تدمج المصدرين ضمن جدول واحد', () => {
  const html = read('public/driver.html');
  const script = read('public/js/driver.js');
  assert.doesNotMatch(html, /instagramDriverOrdersSection/);
  assert.match(html, /<th>المصدر<\/th>/);
  assert.match(script, /api\/orders/);
  assert.match(script, /api\/instagram-orders/);
  assert.match(script, /\[\.\.\.basicOrders, \.\.\.instagramOrders\]/);
});

test('لوحة المدير الأساسية لا تطلب 50 طلبًا ولا تعرض تقسيم صفحات', () => {
  const html = read('public/admin.html');
  const script = read('public/js/admin.js');
  const route = read('routes/orders.js');
  assert.doesNotMatch(html, /ordersPrevPage|ordersNextPage|ordersPageInfo/);
  assert.doesNotMatch(script, /ORDERS_PAGE_SIZE|paginate:\s*'1'/);
  assert.match(route, /for \(let rangeStart = 0; rangeStart < 100000; rangeStart \+= batchSize\)/);
  assert.match(script, /Array\.isArray\(data\)/);
});
