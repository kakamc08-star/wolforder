'use strict';

// Instagram currently supports delivery only. Legacy shipping rows remain in
// the database for history, but must not be accepted by the public form.
const ORDER_TYPES = new Set(['توصيل']);
const ORDER_STATUSES = new Set(['قيد المتابعة', 'تم', 'مؤجل', 'ملغي', 'مرتجع']);
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
  return normalizeDigits(value).replace(/[^0-9]/g, '');
}

function validatePublicOrder(body) {
  const source = body && typeof body === 'object' ? body : {};
  const customerName = cleanText(source.customerName, 100);
  const customerPhone = normalizePhone(source.customerPhone);
  const address = cleanText(source.address, 300);
  const note = cleanText(source.note, 500);
  const orderType = cleanText(source.orderType, 20);
  const website = cleanText(source.website, 100);
  const rawItems = Array.isArray(source.items) ? source.items : [];
  const errors = [];

  if (website) errors.push('تعذر قبول الطلب');
  if (customerName.length < 2) errors.push('الاسم مطلوب ويجب أن يتكون من حرفين على الأقل');
  if (!/^\d{10}$/.test(customerPhone)) errors.push('رقم العميل يجب أن يتكون من 10 أرقام');
  if (address.length < 5) errors.push('العنوان مطلوب ويجب أن يكون واضحاً');
  if (!ORDER_TYPES.has(orderType)) errors.push('نوع الطلب غير صالح');
  if (rawItems.length < 1 || rawItems.length > 20) errors.push('يجب اختيار صنف واحد على الأقل وبحد أقصى 20 صنفاً');

  const merged = new Map();
  for (const rawItem of rawItems) {
    const inventoryId = cleanText(rawItem && rawItem.inventoryId, 80);
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

  return {
    valid: errors.length === 0,
    errors: Array.from(new Set(errors)),
    value: { customerName, customerPhone, address, note, orderType, items }
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
  validatePublicOrder,
  validateProduct,
  parsePagination,
  sanitizeSearch,
  inventoryBucket
};
