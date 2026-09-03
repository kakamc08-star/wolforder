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

test('حساب المشاهدة يقرأ شركة واحدة ولا يملك مسار تعديل الطلب', () => {
  const instagramRoute = read('routes/instagram.js');
  assert.match(instagramRoute, /function requireRole\(\.\.\.roles\)/);
  assert.match(instagramRoute, /router\.get\('\/orders', requireRole\('admin', 'instagram_viewer', 'driver'\)/);
  assert.match(instagramRoute, /getViewerCompanyId\(req\.user\.id\)/);
  assert.match(instagramRoute, /router\.patch\('\/orders\/:id', requireRole\('admin'\)/);
  assert.match(instagramRoute, /router\.post\('\/products', requireRole\('admin'\)/);
});

test('ملف SQL الجديد يضيف حفظاً ذرياً وقفل مخزون وصلاحيات مقيدة', () => {
  const sql = read('database/instagram-order-edit.sql');
  assert.match(sql, /create or replace function public\.update_instagram_order_atomic/i);
  assert.match(sql, /security definer/i);
  assert.match(sql, /for update/i);
  assert.match(sql, /instagram_inventory_movements/i);
  assert.match(sql, /revoke all on function public\.update_instagram_order_atomic/i);
  assert.match(sql, /grant execute on function public\.update_instagram_order_atomic[\s\S]*to service_role/i);
  assert.match(sql, /instagram_orders_delivery_only_guard/i);
  assert.match(sql, /p_items jsonb/i);
  assert.doesNotMatch(sql, /insert into public\.instagram_order_items[\s\S]*line_total/i);
});

test('مسارات قراءة Instagram تستبعد سجلات الشحن القديمة وتحافظ عليها دون حذف', () => {
  const route = read('routes/instagram.js');
  const sql = read('database/instagram-order-edit.sql');
  assert.match(route, /\.eq\('order_type', 'توصيل'\)/);
  assert.match(sql, /سجلات الشحن القديمة محفوظة/);
  assert.match(sql, /before insert or update of order_type/i);
});

test('صفحة Instagram العامة لا تعرض الشحن بينما النظام الأساسي يحتفظ بخياراته', () => {
  const publicPage = read('public/instagram-order.html');
  const viewerPage = read('public/instagram-viewer.html');
  const adminPage = read('public/instagram-admin.html');
  const companyPage = read('public/company.html');
  assert.doesNotMatch(`${publicPage}\n${viewerPage}\n${adminPage}`, /شحن|shipping/i);
  assert.match(companyPage, /شحن لباب المنزل/);
});

test('Service Worker لا يخزن API ويبطل نسخة الكاش القديمة', () => {
  const serviceWorker = read('public/sw.js');
  assert.match(serviceWorker, /pathname\.startsWith\('\/api\/'\)/);
  assert.match(serviceWorker, /if \(requestUrl\.pathname\.startsWith\('\/api\/'\).*return;/s);
  assert.match(serviceWorker, /wolforder-pwa-v7-instagram-edit/);
});
