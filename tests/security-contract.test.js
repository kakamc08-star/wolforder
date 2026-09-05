'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('طلبات Instagram في جدول ومسار منفصلين عن الطلبات الأساسية', () => {
  const normalRoute = read('routes/orders.js');
  const instagramRoute = read('routes/instagram.js');
  assert.match(normalRoute, /from\('orders'\)/);
  assert.doesNotMatch(normalRoute, /from\('instagram_orders'\)/);
  assert.match(instagramRoute, /from\('instagram_orders'\)/);
  assert.match(instagramRoute, /router\.use\(authenticateToken\)/);
});

test('حساب المشاهدة يقرأ شركة واحدة ويملك مسار اعتماد الشحن', () => {
  const instagramRoute = read('routes/instagram.js');
  assert.match(instagramRoute, /function requireRole\(\.\.\.roles\)/);
  assert.match(instagramRoute, /router\.get\('\/orders', requireRole\('admin', 'instagram_viewer', 'driver'\)/);
  assert.match(instagramRoute, /getViewerCompanyId\(req\.user\.id\)/);
  assert.match(instagramRoute, /router\.post\('\/orders\/:id\/shipping\/approve', requireRole\('instagram_viewer'\)/);
  assert.match(instagramRoute, /router\.post\('\/orders\/:id\/shipping\/reject', requireRole\('instagram_viewer'\)/);
  assert.doesNotMatch(instagramRoute, /router\.get\('\/orders', requireRole\([^)]*'company'/);
  assert.match(instagramRoute, /router\.patch\('\/orders\/:id', requireRole\('admin'\)/);
  assert.match(instagramRoute, /router\.post\('\/products', requireRole\('admin'\)/);
});

test('ترحيل الشحن يضيف حفظاً ذرياً وقفل مخزون وصلاحيات مقيدة', () => {
  const sql = read('database/2026-09-04-instagram-shipping-workflow.sql');
  assert.match(sql, /add column if not exists shipping_approval_status/i);
  assert.match(sql, /add column if not exists shipping_fee/i);
  assert.match(sql, /add column if not exists shipping_delivered_to_name/i);
  assert.match(sql, /create or replace function public\.approve_instagram_shipping_order_atomic/i);
  assert.match(sql, /create or replace function public\.reject_instagram_shipping_order_atomic/i);
  assert.match(sql, /create or replace function public\.mark_instagram_shipping_delivered_atomic/i);
  assert.doesNotMatch(sql, /create or replace function public\.update_instagram_order_atomic/i);
  assert.match(sql, /security definer/i);
  assert.match(sql, /for update/i);
  assert.match(sql, /instagram_inventory_movements/i);
  assert.match(sql, /revoke all on function public\.approve_instagram_shipping_order_atomic/i);
  assert.match(sql, /grant execute on function public\.approve_instagram_shipping_order_atomic[\s\S]*to service_role/i);
  assert.match(sql, /instagram_orders_shipping_driver_guard/i);
  assert.match(sql, /delete from public\.instagram_orders/i);
  assert.match(sql, /p_items jsonb/i);
});

test('مسارات قراءة Instagram تعرض التوصيل والشحن المقبول وتحافظ على الطلبات القديمة', () => {
  const route = read('routes/instagram.js');
  const sql = read('database/2026-09-04-instagram-shipping-workflow.sql');
  assert.match(route, /function isInstagramOrderVisibleToUser/);
  assert.match(route, /if \(user\?\.role === 'instagram_viewer'\) return true/);
  assert.match(route, /order_type\.eq\.توصيل,order_type\.is\.null/);
  assert.doesNotMatch(route, /router\.get\('\/orders', requireRole\([^)]*'company'/);
  assert.match(sql, /Legacy NULL\/English order types are treated as[\s\S]*delivery/i);
  assert.match(sql, /legacy Arabic shipping rows are treated as already accepted/i);
  assert.match(sql, /before insert or update of order_type, driver_id/i);
});

test('صفحة Instagram العامة تعرض خيار الشحن بينما النظام الأساسي يحتفظ بخياراته', () => {
  const publicPage = read('public/instagram-order.html');
  const viewerPage = read('public/instagram-viewer.html');
  const adminPage = read('public/instagram-admin.html');
  const companyPage = read('public/company.html');
  assert.match(publicPage, /name="orderType" value="شحن"/);
  assert.match(publicPage, /سيتم إضافة 10,000 ل\.س أجور شحن/);
  assert.match(publicPage, /id="storefrontShippingSummary"/);
  assert.match(`${viewerPage}\n${adminPage}`, /شحن/);
  assert.match(companyPage, /شحن لباب المنزل/);
});

test('Service Worker لا يخزن API ويبطل نسخة الكاش القديمة', () => {
  const serviceWorker = read('public/sw.js');
  assert.match(serviceWorker, /pathname\.startsWith\('\/api\/'\)/);
  assert.match(serviceWorker, /if \(requestUrl\.pathname\.startsWith\('\/api\/'\).*return;/s);
  assert.match(serviceWorker, /wolforder-pwa-v13-instagram-inventory-fix/);
});
