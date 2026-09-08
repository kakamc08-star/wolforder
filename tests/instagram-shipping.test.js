'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('رابط Instagram يبدأ بنوع الطلب ويعرض تفصيل أجور الشحن', () => {
  const html = read('public/instagram-order.html');
  const script = read('public/js/instagram-order.js');

  assert.ok(html.indexOf('name="orderType"') < html.indexOf('id="customerName"'));
  assert.match(html, /name="orderType" value="توصيل"/);
  assert.match(html, /name="orderType" value="شحن"/);
  assert.match(html, /سيتم إضافة 10,000 ل\.س أجور شحن إلى قيمة الطلب، والشحن حصرًا عن طريق شركة القدموس/);
  assert.match(html, /id="storefrontItemsTotal"/);
  assert.match(html, /id="storefrontShippingFee"/);
  assert.match(html, /id="storefrontFinalTotal"/);
  assert.match(html, /<span>قيمة الأصناف<\/span>/);
  assert.match(html, /<span>أجور الشحن<\/span><strong id="storefrontShippingFee">10,000 ل\.س<\/strong>/);
  assert.match(html, /<span>الإجمالي النهائي<\/span>/);
  assert.match(script, /const INSTAGRAM_SHIPPING_FEE = 10000/);
  assert.match(script, /orderType/);
  assert.match(script, /shippingSummary\.hidden = !isShipping/);
  assert.match(script, /deliveryTotal\.hidden = isShipping/);
  assert.match(script, /itemsTotal\.textContent = isShipping \? formatMoney\(total, currency\) : ''/);
  assert.match(script, /finalTotal\.textContent = !isShipping/);
  assert.match(script, /nameParts\.length < 3/);
  assert.match(script, /total \+ INSTAGRAM_SHIPPING_FEE/);
});

test('الـ Backend يحسب النوع والأجور ولا يعتمد على قيمة المتصفح', () => {
  const route = read('routes/instagram.js');
  const sql = read('database/2026-09-04-instagram-shipping-workflow.sql');

  assert.match(route, /p_order_type: orderType/);
  assert.match(route, /const INSTAGRAM_SHIPPING_FEE = 10000/);
  assert.match(sql, /v_shipping_fee := 10000/);
  assert.match(sql, /v_items_total \+ v_shipping_fee/);
  assert.match(sql, /when v_order_type = 'شحن' then 'pending'/);
  assert.match(sql, /if v_order_type = 'توصيل' and v_stock_available < v_item\.quantity/);
  assert.match(sql, /shipping_approval_status,\s+shipping_fee,\s+items_total/s);
  assert.match(sql, /add column if not exists next_order_number/i);
  assert.match(sql, /v_order_number bigint/);
  assert.match(sql, /set next_order_number = v_order_number \+ 1/);
  assert.match(sql, /insert into public\.instagram_order_items \([\s\S]*unit_price, quantity\s*\)/);
  assert.doesNotMatch(sql, /unit_price, quantity, line_total/);
  assert.match(sql, /instagram_inventory_movement_type_check/);
  assert.match(sql, /'reservation',\s+'shipping_approval',\s+'return_release'/s);
  assert.match(sql, /instagram_orders_address_check/);
  assert.match(sql, /char_length\(coalesce\(address, ''\)\) <= 300/);
  assert.doesNotMatch(sql, /char_length\(btrim\(coalesce\(p_address, ''\)\)\) not between 5 and 300/);
  assert.match(route, /line_total\|generated column\|non-DEFAULT value/);
  assert.match(route, /instagram_inventory_movement_type_check\|check constraint/);
});

test('عنوان Instagram يقبل النص القصير ولا يفرض خمسة أحرف', () => {
  const html = read('public/instagram-order.html');
  const script = read('public/js/instagram-order.js');
  const route = read('routes/instagram.js');

  assert.match(html, /id="customerAddress"[^>]*maxlength="300"/);
  assert.doesNotMatch(html, /for="customerAddress">العنوان \*<\/label>/);
  assert.doesNotMatch(script, /!customerName \|\| !address/);
  assert.doesNotMatch(route, /if \(!customerName \|\| !address/);
});

test('قبول الشحن يثبت الحجز ولا يخصم المخزون مرتين', () => {
  const route = read('routes/instagram.js');
  const sql = read('database/2026-09-05-instagram-shipping-pending-reservation.sql');
  const approvalStart = sql.indexOf('create or replace function public.approve_instagram_shipping_order_atomic');
  const approvalEnd = sql.indexOf('-- =========================================================\n-- Rejection:', approvalStart);
  const approvalBlock = sql.slice(approvalStart, approvalEnd);

  assert.match(route, /router\.post\('\/orders\/:id\/shipping\/approve', requireRole\('instagram_viewer'\)/);
  assert.match(route, /approve_instagram_shipping_order_atomic/);
  assert.match(sql, /create or replace function public\.approve_instagram_shipping_order_atomic/);
  assert.match(sql, /create or replace function public\.reserve_instagram_shipping_order_stock/);
  assert.match(sql, /perform public\.reserve_instagram_shipping_order_stock/);
  assert.match(sql, /from public\.instagram_viewer_companies mapping/);
  assert.match(sql, /if coalesce\(v_order\.company_id::text, ''\) <> coalesce\(v_company_id::text, ''\)/);
  assert.match(sql, /shipping_approval_status = 'accepted'/);
  assert.doesNotMatch(approvalBlock, /stock_available = stock_available - v_item\.quantity/);
  assert.match(sql, /if coalesce\(v_order\.shipping_approval_status, 'pending'\) = 'accepted'/);
});

test('رفض الشحن من حساب المشاهدة يعيد الحجز ثم يحذف الطلب', () => {
  const route = read('routes/instagram.js');
  const sql = read('database/2026-09-05-instagram-shipping-pending-reservation.sql');
  const viewer = read('public/js/instagram-viewer.js');

  assert.match(route, /router\.post\('\/orders\/:id\/shipping\/reject', requireRole\('instagram_viewer'\)/);
  assert.match(sql, /create or replace function public\.reject_instagram_shipping_order_atomic/);
  assert.match(sql, /shipping_approval_status, 'pending'/);
  assert.match(sql, /v_release := least\(v_item\.quantity, greatest\(-v_net_delta, 0\)\)/);
  assert.match(sql, /stock_available = stock_available \+ v_release/);
  assert.match(sql, /delete from public\.instagram_order_items where order_id = p_order_id/);
  assert.match(sql, /delete from public\.instagram_orders where id = p_order_id/);
  assert.match(viewer, /هل أنت متأكد من رفض وحذف طلب الشحن نهائياً؟/);
});

test('طلبات الشحن لا تقبل تعيين سائق من الواجهة أو الـ Backend', () => {
  const admin = read('public/js/instagram-admin.js');
  const route = read('routes/instagram.js');
  const sql = read('database/2026-09-04-instagram-shipping-workflow.sql');

  assert.match(admin, /const isDelivery = instagramOrderType\(order\) === 'توصيل'/);
  assert.match(admin, /const assignBtn = isDelivery/);
  assert.match(route, /await assertInstagramDeliveryOrders\(ids\)/);
  assert.match(sql, /create trigger instagram_orders_shipping_driver_guard/);
  assert.match(sql, /if coalesce\(new\.order_type, 'توصيل'\) = 'شحن' and new\.driver_id is not null/);
  assert.match(sql, /if v_order_type <> 'توصيل'/);
});

test('طباعة Instagram تطابق طباعة الطلبات الأساسية حسب نوع الطلب', () => {
  const admin = read('public/js/instagram-admin.js');
  const printStart = admin.indexOf('function instagramPrintDeliveryRow');
  const printEnd = admin.indexOf('// ========== Products ==========', printStart);
  const printBlock = admin.slice(printStart, printEnd);

  assert.match(printBlock, /orderType === 'شحن'/);
  assert.match(printBlock, /نوع الطلب:/);
  assert.match(printBlock, /أجور التوصيل:/);
  assert.match(printBlock, /instagramPrintDeliveryRow\(order\)/);
  assert.match(printBlock, /WolfOrder/);
  assert.doesNotMatch(printBlock, /قيمة الأصناف/);
  assert.doesNotMatch(printBlock, /أجور الشحن/);
  assert.doesNotMatch(printBlock, /الشحن حصرًا عن طريق شركة القدموس/);
});

test('التسليم الفردي والجماعي يحفظان اسم حساب الشركة لكل طلب', () => {
  const adminHtml = read('public/instagram-admin.html');
  const admin = read('public/js/instagram-admin.js');
  const route = read('routes/instagram.js');
  const sql = read('database/2026-09-04-instagram-shipping-workflow.sql');

  assert.match(adminHtml, /data-type=""[^>]*>الكل/);
  assert.match(adminHtml, /data-type="توصيل"[^>]*>توصيل/);
  assert.match(adminHtml, /data-type="شحن"[^>]*>شحن/);
  assert.match(admin, /تم التسليم لـ \$\{igEscape\(order\.company_name/);
  assert.match(admin, /shippingIds/);
  assert.match(admin, /instagramOrderType\(order\) === 'شحن'/);
  assert.match(route, /router\.patch\('\/orders\/shipping-delivered', requireRole\('admin'\)/);
  assert.match(route, /mark_instagram_shipping_delivered_atomic/);
  assert.match(sql, /select coalesce\(nullif\(btrim\(company\.name\), ''\), nullif\(btrim\(company\.username\), ''\)\)/);
  assert.match(sql, /shipping_delivered_to_name = v_company_name/);
  assert.match(sql, /shipping_delivered_at = now\(\)/);
  assert.match(sql, /shipping_delivered_by = p_actor_user_id/);
  assert.match(sql, /select distinct value from unnest\(p_order_ids\).*order by value/s);
});

test('واجهة المدير تبقي فلترة النوع وتزيل لوحة Instagram من حساب الشركة الأساسي', () => {
  const adminHtml = read('public/instagram-admin.html');
  const admin = read('public/js/instagram-admin.js');
  const adminCss = read('public/css/instagram.css');
  const company = read('public/js/company.js');
  const companyHtml = read('public/company.html');

  assert.match(adminHtml, /ig-order-top-filters/);
  assert.match(adminHtml, /data-type=""[^>]*>الكل/);
  assert.match(adminHtml, /data-type="توصيل"[^>]*>توصيل/);
  assert.match(adminHtml, /data-type="شحن"[^>]*>شحن/);
  assert.doesNotMatch(adminHtml, /id="igOrderCompany"/);
  assert.doesNotMatch(adminHtml, /ig-company-top-filter/);
  assert.doesNotMatch(admin, /igOrderCompany/);
  assert.match(admin, /function instagramDriverDisplay\(order\)/);
  assert.match(admin, /instagramDriverDisplay\(order\)/);
  assert.match(adminCss, /th:nth-child\(18\)/);
  assert.match(adminCss, /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.doesNotMatch(companyHtml, /data-company-view="instagram"/);
  assert.doesNotMatch(companyHtml, /id="instagramOrdersSection"/);
  assert.doesNotMatch(company, /fetchInstagramCompanyOrders|submitInstagramCompanyDecision|data-instagram-company-action/);
});

test('حساب المشاهدة يفلتر الطلبات حسب الكل والتوصيل والشحن', () => {
  const viewerHtml = read('public/instagram-viewer.html');
  const viewer = read('public/js/instagram-viewer.js');

  assert.match(viewerHtml, /data-viewer-order-type=""[^>]*>الكل/);
  assert.match(viewerHtml, /data-viewer-order-type="توصيل"[^>]*>توصيل/);
  assert.match(viewerHtml, /data-viewer-order-type="شحن"[^>]*>شحن/);
  assert.match(viewer, /orderType: ''/);
  assert.match(viewer, /data-viewer-order-type/);
  assert.match(viewer, /params\.set\('orderType', viewerState\.orderType\)/);
});

test('حالة الإلغاء تظهر باسم إلغاء وفلتر تسليم الشحن يميز المرحّل عن غير المرحّل', () => {
  const adminHtml = read('public/instagram-admin.html');
  const admin = read('public/js/instagram-admin.js');
  const viewerHtml = read('public/instagram-viewer.html');
  const viewer = read('public/js/instagram-viewer.js');
  const route = read('routes/instagram.js');

  assert.match(adminHtml, /value="إلغاء">إلغاء/);
  assert.match(viewerHtml, /data-status="إلغاء">إلغاء/);
  assert.match(adminHtml, /id="igShippingDeliveryStatus"[\s\S]*value="pending">لم يتم التسليم[\s\S]*value="delivered">تم التسليم/);
  assert.match(viewerHtml, /id="viewerShippingDeliveryStatus"[\s\S]*value="pending">لم يتم التسليم[\s\S]*value="delivered">تم التسليم/);
  assert.match(admin, /\['shippingDeliveryStatus', 'igShippingDeliveryStatus'\]/);
  assert.match(viewer, /params\.set\('shippingDeliveryStatus', viewerState\.shippingDeliveryStatus\)/);
  assert.match(route, /normalizeInstagramShippingDeliveryStatus/);
  assert.match(route, /matchesInstagramShippingDeliveryStatus/);
  assert.match(route, /return status;/);
});

test('صفحات Instagram مجهزة للإضافة إلى الشاشة الرئيسية على iPhone', () => {
  const pages = [
    read('public/instagram-admin.html'),
    read('public/instagram-viewer.html'),
    read('public/instagram-login.html')
  ].join('\n');

  assert.equal((pages.match(/rel="manifest"/g) || []).length, 3);
  assert.match(pages, /apple-mobile-web-app-capable/);
  assert.match(pages, /apple-touch-icon-180x180\.png/);
  assert.match(pages, /\/js\/pwa\.js\?v=20260908\.2/);
});

test('حساب المشاهدة وحده يعرض أزرار اعتماد طلبات الشحن', () => {
  const route = read('routes/instagram.js');
  const companyHtml = read('public/company.html');
  const viewerHtml = read('public/instagram-viewer.html');
  const viewer = read('public/js/instagram-viewer.js');

  assert.match(route, /if \(user\?\.role === 'instagram_viewer'\) return true/);
  assert.match(route, /return order\?\.shipping_approval_status \|\| 'pending'/);
  assert.doesNotMatch(companyHtml, /طلبات Instagram|instagramOrdersSection|data-company-view="instagram"/);
  assert.match(viewerHtml, /<th>الإجراء<\/th>/);
  assert.match(viewer, /data-viewer-instagram-action="approve"/);
  assert.match(viewer, /data-viewer-instagram-action="reject"/);
  assert.match(route, /requireRole\('instagram_viewer'\)/);
});

test('الجرد يعرض محجوز الشحن مع حجزه قبل الاعتماد', () => {
  const adminHtml = read('public/instagram-admin.html');
  const admin = read('public/js/instagram-admin.js');
  const viewerHtml = read('public/instagram-viewer.html');
  const viewer = read('public/js/instagram-viewer.js');
  const route = read('routes/instagram.js');
  const sql = read('database/2026-09-05-instagram-shipping-pending-reservation.sql');

  assert.match(adminHtml, /<th>محجوز الشحن<\/th>/);
  assert.match(viewerHtml, /<th>محجوز الشحن<\/th>/);
  assert.match(admin, /data-label="محجوز الشحن">\$\{row\.reserved_shipping\}/);
  assert.match(viewer, /data-label="محجوز الشحن">\$\{row\.reserved_shipping\}/);
  assert.match(route, /\['reserved_shipping', 'المحجوزة من الشحن'\]/);
  assert.match(route, /reserved_shipping: Number\(row\.reserved_shipping\) \|\| 0/);
  assert.match(sql, /shipping-pending-reservation/);
  assert.match(sql, /Both order types reserve immediately/);
});

test('قاعدة البيانات تحافظ على الطلبات القديمة وتبقي النظام الأساسي منفصلاً', () => {
  const sql = read('database/2026-09-04-instagram-shipping-workflow.sql');
  const normalRoute = read('routes/orders.js');
  const companyPage = read('public/company.html');

  assert.match(sql, /when order_type = 'شحن' then 'accepted'/);
  assert.match(sql, /order_type = 'توصيل'/);
  assert.match(sql, /does not create the old instagram_inventory or shipping-batch tables/i);
  assert.doesNotMatch(normalRoute, /from\('instagram_orders'\)/);
  assert.match(companyPage, /شحن لباب المنزل/);
});
