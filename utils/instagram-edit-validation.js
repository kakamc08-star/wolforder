'use strict';

const { normalizePhone, normalizeDigits } = require('./instagram-validation');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DELIVERY_STATUSES = new Set(['قيد المتابعة', 'تم', 'مؤجل', 'مرتجع', 'إلغاء']);
const FIELDS = new Set([
  'order_number', 'customer_name', 'customer_number', 'address', 'note',
  'total_price', 'items', 'recalculate_total_price', 'status', 'shipping_delivery_status', 'order_type'
]);

function validateInstagramEditChanges(input, order) {
  const fail = (message) => { const error = new Error(message); error.status = 400; throw error; };
  if (!input || typeof input !== 'object' || Array.isArray(input) || !Object.keys(input).length) fail('لم يتم إرسال أي تعديل');
  if (Object.keys(input).some((key) => !FIELDS.has(key))) fail('يتضمن طلب التعديل حقولاً غير مسموحة');
  const result = {};
  const orderType = input.order_type ?? order.order_type ?? 'توصيل';
  if ('order_type' in input) {
    if (!['شحن', 'توصيل'].includes(input.order_type)) fail('نوع الطلب غير صالح');
    result.order_type = input.order_type;
  }
  const isShipping = orderType === 'شحن';
  const typeChanged = orderType !== (order.order_type || 'توصيل');
  const shippingFee = isShipping ? (typeChanged ? 10000 : Number(order.shipping_fee) || 0) : 0;
  if (typeChanged) {
    const name = input.customer_name ?? order.customer_name ?? '';
    const phone = normalizePhone(input.customer_number ?? order.customer_number ?? '');
    const address = input.address ?? order.address ?? '';
    if (isShipping && (typeof name !== 'string' || name.trim().split(/\s+/).length < 3 || !/^\d{10}$/.test(phone))) fail('الشحن يتطلب الاسم الثلاثي ورقماً من 10 أرقام');
    if (isShipping && (order.currency || 'ل.س') !== 'ل.س') fail('طلبات الشحن متاحة بالليرة السورية فقط');
    if (!isShipping && (typeof address !== 'string' || address.trim().length < 5)) fail('العنوان مطلوب لطلب التوصيل');
  }
  for (const [key, min, max] of [['customer_name', 2, 100], ['address', isShipping ? 0 : 5, 300], ['note', 0, 1000]]) {
    if (!(key in input)) continue;
    if (typeof input[key] !== 'string') fail('بيانات التعديل غير صالحة');
    const value = input[key].trim();
    if (value.length < min || value.length > max) fail(`قيمة ${key === 'customer_name' ? 'اسم العميل' : key === 'address' ? 'العنوان' : 'الملاحظة'} غير صالحة`);
    if (key === 'customer_name' && isShipping && value.split(/\s+/).length < 3) fail('لطلبات الشحن يجب إدخال الاسم الثلاثي');
    result[key] = value;
  }
  if ('customer_number' in input) {
    result.customer_number = normalizePhone(input.customer_number);
    if (!/^\d{10}$/.test(result.customer_number)) fail('رقم العميل يجب أن يتكون من 10 أرقام');
  }
  if ('order_number' in input) {
    const value = normalizeDigits(input.order_number).trim();
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) fail('رقم الطلب غير صالح');
    result.order_number = Number(value);
  }
  if ('total_price' in input) {
    if (input.total_price === null || input.total_price === '' || !['number', 'string'].includes(typeof input.total_price)) fail('السعر غير صالح');
    result.total_price = Number(normalizeDigits(input.total_price));
    if (!Number.isFinite(result.total_price) || result.total_price < shippingFee) fail('السعر النهائي يجب ألا يقل عن أجور الشحن');
  }
  if ('status' in input) {
    if (isShipping || !DELIVERY_STATUSES.has(input.status)) fail('طلبات الشحن تستخدم حالة التسليم فقط');
    result.status = input.status;
  }
  if ('shipping_delivery_status' in input) {
    if (!isShipping || !['pending', 'delivered'].includes(input.shipping_delivery_status)) fail('حالة تسليم الشحن غير صالحة');
    result.shipping_delivery_status = input.shipping_delivery_status;
  }
  if ('items' in input) {
    if (!Array.isArray(input.items) || !input.items.length || input.items.length > 50) fail('يجب اختيار من 1 إلى 50 صنفاً');
    const merged = new Map();
    for (const item of input.items) {
      const id = item?.variant_id;
      const quantity = Number(item?.quantity);
      if (!UUID.test(id || '') || !Number.isInteger(quantity) || quantity < 1 || quantity > 1000) fail('الصنف أو الكمية غير صالحة');
      const total = (merged.get(id.toLowerCase()) || 0) + quantity;
      if (total > 1000) fail('إجمالي كمية الصنف الواحد يتجاوز الحد المسموح');
      merged.set(id.toLowerCase(), total);
    }
    result.items = [...merged].sort(([a], [b]) => a.localeCompare(b)).map(([variant_id, quantity]) => ({ variant_id, quantity }));
  }
  if ('recalculate_total_price' in input) {
    if (typeof input.recalculate_total_price !== 'boolean' || !result.items) fail('إعادة حساب السعر تتطلب أصنافاً صالحة');
    result.recalculate_total_price = input.recalculate_total_price;
  }
  return result;
}

module.exports = { validateInstagramEditChanges };
