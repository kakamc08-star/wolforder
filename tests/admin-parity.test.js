'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('لوحة مدير Instagram تدعم تعديل البيانات والأصناف والتحديد الجماعي', () => {
  const html = read('public/instagram-admin.html');
  const script = read('public/js/instagram-admin.js');
  const route = read('routes/instagram.js');

  assert.match(html, /id="igSelectAll"/);
  assert.match(html, /id="igBulkAction"/);
  assert.match(html, /id="igEditItems"/);
  assert.match(html, /id="igAddEditItem"/);
  assert.match(script, /data-action="edit"/);
  assert.match(script, /data-action="delete"/);
  assert.match(script, /data-action="print"/);
  assert.match(script, /addEditItemRow/);
  assert.match(script, /collectEditItems/);
  assert.match(route, /router\.patch\('\/orders\/:id', requireRole\('admin'\)/);
  assert.match(route, /update_instagram_order_atomic/);
});

test('واجهات Instagram ومساراته تميز التوصيل عن الشحن', () => {
  const instagramUi = [
    'public/instagram-admin.html',
    'public/instagram-viewer.html',
    'public/instagram-order.html',
    'public/js/instagram-admin.js',
    'public/js/instagram-viewer.js',
    'public/js/instagram-order.js',
    'public/css/instagram.css'
  ].map(read).join('\n');
  const route = read('routes/instagram.js');

  assert.match(instagramUi, /شحن|shipping_delivered|order-type-shipping|shipping-delivery/i);
  assert.match(route, /const INSTAGRAM_ORDER_TYPES = new Set\(\['توصيل', 'شحن'\]\)/);
  assert.match(route, /const INSTAGRAM_SHIPPING_FEE = 10000/);
  assert.match(route, /router\.patch\('\/orders\/shipping-delivered'/);
  assert.match(route, /router\.post\('\/orders\/:id\/shipping\/approve'/);
  assert.match(route, /router\.post\('\/orders\/:id\/shipping\/reject'/);
  assert.match(route, /\.eq\('order_type', 'توصيل'\)/);
});

test('بطاقات إدارة الأصناف عمودان على الكمبيوتر وعمود واحد على الهاتف', () => {
  const css = read('public/css/instagram.css');
  assert.match(css, /\.instagram-theme \.ig-card-grid\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(css, /@media[\s\S]*?\.instagram-theme \.ig-card-grid\s*\{\s*grid-template-columns:\s*1fr/);
  assert.match(css, /\.instagram-theme \.ig-mini-card\s*\{[\s\S]*?min-width:\s*0[\s\S]*?overflow-wrap:\s*anywhere/);
});

test('رابط Instagram يطبّق تنظيف الهاتف والتحقق النهائي قبل الإرسال', () => {
  const html = read('public/instagram-order.html');
  const script = read('public/js/instagram-order.js');
  const route = read('routes/instagram.js');

  assert.match(html, /id="customerNumber"[^>]*maxlength="10"/);
  assert.match(html, /pattern="\[0-9\]\{10\}"/);
  assert.match(script, /٠-٩/);
  assert.match(script, /۰-۹/);
  assert.match(script, /addEventListener\('paste'/);
  assert.match(script, /رقم العميل يجب أن يتكون من 10 أرقام/);
  assert.match(script, /phoneTooLong/);
  assert.match(route, /normalizeInstagramPhone/);
  assert.match(route, /customerNumber.*\[0-9\]\{10\}/s);
});

test('بطاقة مصدر الطلب في لوحة السائق لها لونان ثابتان', () => {
  const css = read('public/css/instagram.css');
  const script = read('public/js/driver.js');
  assert.match(script, /source-badge source-\$\{source\}/);
  assert.match(css, /\.role-driver \.source-badge\.source-basic/);
  assert.match(css, /\.role-driver \.source-badge\.source-instagram/);
  assert.match(css, /background:\s*#e8f1ff/);
  assert.match(css, /background:\s*#7d1f3f/);
});

test('الحذف وتعديل الأصناف يستخدمان دوال Supabase الذرية', () => {
  const route = read('routes/instagram.js');
  const actionsSql = read('database/instagram-actions-update.sql');
  const editSql = read('database/instagram-order-edit.sql');

  assert.match(route, /router\.delete\('\/products\/:id', requireRole\('admin'\)/);
  assert.match(route, /router\.delete\('\/orders\/:id', requireRole\('admin'\)/);
  assert.match(actionsSql, /delete_instagram_order_atomic/i);
  assert.match(actionsSql, /delete_instagram_product_safe/i);
  assert.match(editSql, /create or replace function public\.update_instagram_order_atomic/i);
  assert.match(editSql, /stock_available = stock_available - v_desired_item\.quantity/i);
});

test('إصلاح مخزون Instagram يعيد الطلبات القديمة ويحدّث الرابط تلقائياً', () => {
  const route = read('routes/instagram.js');
  const migration = read('database/2026-09-05-instagram-inventory-release-fix.sql');
  const adminScript = read('public/js/instagram-admin.js');
  const viewerScript = read('public/js/instagram-viewer.js');
  const storefrontScript = read('public/js/instagram-order.js');

  assert.match(migration, /actual order items/i);
  assert.match(migration, /create or replace function public\.delete_instagram_order_atomic/i);
  assert.match(migration, /item_totals\.item_quantity/);
  assert.match(migration, /variant\.stock_available > 0/);
  assert.match(route, /delete_instagram_orders_atomic/);
  assert.match(route, /broadcastInstagramUpdate\(req, 'INSTAGRAM_INVENTORY_UPDATED'\)/);
  assert.match(adminScript, /scheduleInstagramInventoryRefresh/);
  assert.match(viewerScript, /connectViewerSocket/);
  assert.match(storefrontScript, /setInterval\(\(\) => refreshStorefrontCatalog\(\), 30000\)/);
});

test('طلبات الشحن المعلقة مخفية عن المدير حتى موافقة الشركة', () => {
  const route = read('routes/instagram.js');

  assert.match(route, /function isInstagramOrderVisibleToUser/);
  assert.match(route, /if \(user\?\.role === 'instagram_viewer'\) return true/);
  assert.match(route, /return instagramApprovalStatus\(order\) === 'accepted'/);
  assert.match(route, /orders = \(orders \|\| \[\]\)\.filter\(\(order\) => isInstagramOrderVisibleToUser\(order, req\.user\)\)/);
});

test('حجز الشحن يبدأ عند إنشاء الطلب والقبول لا يخصم مرتين', () => {
  const sql = read('database/2026-09-05-instagram-shipping-pending-reservation.sql');
  const approvalStart = sql.indexOf('create or replace function public.approve_instagram_shipping_order_atomic');
  const approvalEnd = sql.indexOf('-- =========================================================\n-- Rejection:', approvalStart);
  const approvalBlock = sql.slice(approvalStart, approvalEnd);

  assert.match(sql, /if v_stock_available < v_item\.quantity/);
  assert.match(sql, /stock_available = stock_available - v_item\.quantity/);
  assert.match(sql, /shipping-pending-reservation/);
  assert.match(sql, /perform public\.reserve_instagram_shipping_order_stock/);
  assert.doesNotMatch(approvalBlock, /stock_available = stock_available - v_item\.quantity/);
  assert.match(sql, /stock_available = stock_available \+ v_release/);
});

test('لوحة السائق الأساسية تبقي المصدرين في جدول واحد', () => {
  const html = read('public/driver.html');
  const script = read('public/js/driver.js');
  assert.match(html, /<th>المصدر<\/th>/);
  assert.match(script, /\[\.\.\.basicOrders, \.\.\.instagramOrders\]/);
});

test('لوحة المدير الأساسية تحتفظ بخيارات الشحن الخاصة بالنظام العام', () => {
  const admin = read('public/admin.html');
  const company = read('public/company.html');
  assert.match(admin, /شحن لباب المنزل/);
  assert.match(company, /شحن لباب المنزل/);
});
