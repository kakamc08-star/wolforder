'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  inventoryBucket,
  normalizePhone,
  parsePagination,
  validateProduct,
  validatePublicOrder
} = require('../utils/instagram-validation');

test('يقبل طلباً عاماً صالحاً ويدمج الصنف المكرر بعد توحيد أرقام الهاتف', () => {
  const inventoryId = '11111111-1111-4111-8111-111111111111';
  const result = validatePublicOrder({
    customerName: 'أسامة',
    customerPhone: '٠٩٩١ ٢٣٤ ٥٦٧',
    address: 'دمشق - المزة',
    orderType: 'توصيل',
    items: [
      { inventoryId, quantity: '٢' },
      { inventoryId, quantity: 1 }
    ]
  });
  assert.equal(result.valid, true);
  assert.equal(result.value.customerPhone, '0991234567');
  assert.deepEqual(result.value.items, [{ inventoryId, quantity: 3 }]);
});

test('يدعم الأرقام الفارسية ويحافظ على الصفر الأول', () => {
  assert.equal(normalizePhone('۰۹۳۳۱۲۳۴۵۶'), '0933123456');
  assert.equal(normalizePhone('(۰۹۳۳) ۱۲۳-۴۵۶'), '0933123456');
});

test('يقبل الشحن بالاسم الثلاثي ويرفض الاسم غير الثلاثي وأرقام الهاتف الأقصر أو الأطول', () => {
  const base = {
    customerName: 'عميل',
    address: 'عنوان واضح',
    items: [{ inventoryId: '11111111-1111-4111-8111-111111111111', quantity: 1 }]
  };
  const shipping = validatePublicOrder({ ...base, customerName: 'عميل أول ثالث', customerPhone: '0991234567', orderType: 'شحن' });
  const shippingShortName = validatePublicOrder({ ...base, customerName: 'عميل أول', customerPhone: '0991234567', orderType: 'شحن' });
  const shortPhone = validatePublicOrder({ ...base, customerPhone: '099123456', orderType: 'توصيل' });
  const longPhone = validatePublicOrder({ ...base, customerPhone: '09912345678', orderType: 'توصيل' });

  assert.equal(shipping.valid, true);
  assert.equal(shipping.value.orderType, 'شحن');
  assert.equal(shippingShortName.valid, false);
  assert.match(shippingShortName.errors.join(' '), /الاسم الثلاثي/);
  assert.match(shortPhone.errors.join(' '), /رقم العميل يجب أن يتكون من 10 أرقام/);
  assert.match(longPhone.errors.join(' '), /رقم العميل يجب أن يتكون من 10 أرقام/);
});

test('يرفض حقل المصيدة والكمية غير الصحيحة', () => {
  const result = validatePublicOrder({
    customerName: 'عميل', customerPhone: '0991234567', address: 'عنوان واضح', orderType: 'توصيل', website: 'bot',
    items: [{ inventoryId: '11111111-1111-4111-8111-111111111111', quantity: 0 }]
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.length >= 2);
});

test('يتحقق من تركيبات اللون والمقاس ويمنع التكرار', () => {
  const result = validateProduct({
    companyId: 'company-id', name: 'فستان', variants: [
      { color: 'أسود', size: 'M', quantity: 5 },
      { color: 'أسود', size: 'M', quantity: 4 }
    ]
  });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(' '), /مكررة/);
});

test('التصفح محدود بين 1 و100 طلب', () => {
  assert.deepEqual(parsePagination({ page: '-2', limit: '999' }), { page: 1, limit: 100, from: 0, to: 99 });
  assert.deepEqual(parsePagination({ page: '3', limit: '50' }), { page: 3, limit: 50, from: 100, to: 149 });
});

test('تصنيف الحالات يضمن أن المؤجل يبقى محجوزاً والملغي والمرتجع محرران', () => {
  assert.equal(inventoryBucket('قيد المتابعة'), 'reserved');
  assert.equal(inventoryBucket('مؤجل'), 'reserved');
  assert.equal(inventoryBucket('تم'), 'sold');
  assert.equal(inventoryBucket('ملغي'), 'released');
  assert.equal(inventoryBucket('إلغاء'), 'released');
  assert.equal(inventoryBucket('مرتجع'), 'released');
});
