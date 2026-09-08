'use strict';

// Instagram supports both delivery and shipping. The Arabic values are the
// values stored by the current database; the English aliases keep API clients
// from having to depend on presentation language.
const ORDER_TYPE_ALIASES = Object.freeze({
  'توصيل': 'توصيل',
  delivery: 'توصيل',
  'شحن': 'شحن',
  shipping: 'شحن'
});
const ORDER_TYPES = new Set(Object.keys(ORDER_TYPE_ALIASES));
const ORDER_STATUSES = new Set(['قيد المتابعة', 'تم', 'مؤجل', 'ملغي', 'إلغاء', 'مرتجع']);
const INVENTORY_BUCKETS = Object.freeze({
  'قيد المتابعة': 'reserved',
  'مؤجل': 'reserved',
  'تم': 'sold',
  'ملغي': 'released',
  'مرتجع': 'released'
});

function normalizeDigits(value) {
  return String(value ?? '')
    .replace(/[٠-٩]/g, digit => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
    .replace(/[۰-۹]/g, digit => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)));
}

function cleanText(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function normalizePhone(value) {
  const digits = normalizeDigits(value).replace(/[^0-9]/g, '');

  // Accept the common Syrian international forms when a customer pastes a
  // number from a contact card, then keep one canonical local representation.
  for (const prefix of ['00963', '963']) {
    if (!digits.startsWith(prefix)) continue;
    const localPart = digits.slice(prefix.length);
    if (localPart.length === 9) return `0${localPart}`;
    if (localPart.length === 10 && localPart.startsWith('0')) return localPart;
  }

  // A nine-digit Syrian mobile number is often copied without its local 0.
  if (digits.length === 9 && digits.startsWith('9')) return `0${digits}`;
  return digits;
}

function normalizeOrderType(value, fallback = '') {
  const key = cleanText(value, 20).toLocaleLowerCase('en-US');
  return ORDER_TYPE_ALIASES[key] || fallback;
}

function validatePublicOrder(body) {
  const source = body && typeof body === 'object' ? body : {};
  const customerName = cleanText(source.customerName, 100);
  const customerPhone = normalizePhone(source.customerPhone);
  const address = cleanText(source.address, 300);
  const note = cleanText(source.note, 85);
  const orderType = normalizeOrderType(source.orderType);
  const website = cleanText(source.website, 100);
  const rawItems = Array.isArray(source.items) ? source.items : [];
  const errors = [];

  if (website) errors.push('تعذر قبول الطلب');
  const nameParts = customerName.split(/\s+/).filter(Boolean);
  if (customerName.length < 2) errors.push('الاسم مطلوب ويجب أن يتكون من حرفين على الأقل');
  if (orderType === 'شحن' && nameParts.length < 3) {
    errors.push('لطلبات الشحن يجب إدخال الاسم الثلاثي (3 أجزاء على الأقل)');
  }
  if (!/^0\d{9}$/.test(customerPhone)) {
    errors.push('رقم العميل يجب أن يتكون من 10 أرقام ويبدأ بالرقم 0');
  }
  if (address.length < 3) errors.push('العنوان مطلوب ويجب أن يتكون من 3 محارف على الأقل');
  if (!ORDER_TYPES.has(orderType)) errors.push('نوع الطلب غير صالح');
  if (rawItems.length < 1 || rawItems.length > 20) errors.push('يجب اختيار صنف واحد على الأقل وبحد أقصى 20 صنفاً');

  const merged = new Map();
  for (const rawItem of rawItems) {
    const inventoryId = cleanText(rawItem && (rawItem.variantId || rawItem.inventoryId), 80);
    const quantity = Number(normalizeDigits(rawItem && rawItem.quantity));
    if (!/^[0-9a-f-]{16,80}$/i.test(inventoryId)) {
      errors.push('أحد الأصناف المختارة غير صالح');
      continue;
    }
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
      errors.push('الكمية يجب أن تكون رقماً صحيحاً بين 1 و100');
      continue;
    }
    merged.set(inventoryId, (merged.get(inventoryId) || 0) + quantity);
  }

  const items = Array.from(merged, ([inventoryId, quantity]) => ({ inventoryId, quantity }));
  if (items.some(item => item.quantity > 100)) errors.push('إجمالي كمية الصنف الواحد يتجاوز الحد المسموح');

  const identifierKey = rawItems.some(item => item && item.variantId !== undefined)
    ? 'variantId'
    : 'inventoryId';
  const normalizedItems = items.map(item => ({ [identifierKey]: item.inventoryId, quantity: item.quantity }));

  return {
    valid: errors.length === 0,
    errors: Array.from(new Set(errors)),
    value: { customerName, customerPhone, address, note, orderType, items: normalizedItems }
  };
}

function validateProduct(body) {
  const source = body && typeof body === 'object' ? body : {};
  const name = cleanText(source.name, 120);
  const companyId = cleanText(source.companyId, 80);
  const active = source.active !== false;
  const rawVariants = Array.isArray(source.variants) ? source.variants : [];
  const errors = [];

  if (!companyId) errors.push('الشركة مطلوبة');
  if (name.length < 2) errors.push('اسم الصنف مطلوب');
  if (rawVariants.length < 1 || rawVariants.length > 200) errors.push('أضف تركيبة لون ومقاس واحدة على الأقل');

  const seen = new Set();
  const variants = [];
  for (const rawVariant of rawVariants) {
    const color = cleanText(rawVariant && rawVariant.color, 60);
    const size = cleanText(rawVariant && rawVariant.size, 60);
    const quantity = Number(normalizeDigits(rawVariant && rawVariant.quantity));
    const key = `${color.toLocaleLowerCase('ar')}|${size.toLocaleLowerCase('ar')}`;
    if (!color || !size) {
      errors.push('اللون والمقاس مطلوبان لكل تركيبة');
      continue;
    }
    if (!Number.isInteger(quantity) || quantity < 0 || quantity > 1000000) {
      errors.push('كمية المخزون غير صالحة');
      continue;
    }
    if (seen.has(key)) {
      errors.push(`التركيبة ${color} / ${size} مكررة`);
      continue;
    }
    seen.add(key);
    variants.push({ color, size, quantity });
  }

  return { valid: errors.length === 0, errors: Array.from(new Set(errors)), value: { companyId, name, active, variants } };
}

function parsePagination(query, defaultLimit = 50, maxLimit = 100) {
  const page = Math.max(1, Number.parseInt(query && query.page, 10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, Number.parseInt(query && query.limit, 10) || defaultLimit));
  return { page, limit, from: (page - 1) * limit, to: page * limit - 1 };
}

function sanitizeSearch(value) {
  return cleanText(value, 100).replace(/[%_,()."']/g, ' ').replace(/\s+/g, ' ').trim();
}

function inventoryBucket(status) {
  return INVENTORY_BUCKETS[status] || (status === 'إلغاء' ? 'released' : null);
}

module.exports = {
  ORDER_TYPES,
  ORDER_STATUSES,
  cleanText,
  normalizeDigits,
  normalizePhone,
  normalizeOrderType,
  validatePublicOrder,
  validateProduct,
  parsePagination,
  sanitizeSearch,
  inventoryBucket
};
