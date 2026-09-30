'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateInstagramEditChanges: validate } = require('../utils/instagram-edit-validation');
const shipping = { order_type: 'شحن', shipping_fee: 10000 };
const delivery = { order_type: 'توصيل', shipping_fee: 0 };
const variant = '30000000-0000-4000-8000-000000000001';

test('طلبات تعديل المشاهدة ترفض تغيير الشركة والسائق والصلاحيات', () => {
  for (const key of ['company_id', 'driver_id', 'role', 'shipping_approval_status', 'ratio']) {
    assert.throws(() => validate({ [key]: 'value' }, shipping), /غير مسموحة/);
  }
  assert.throws(() => validate({}, shipping), /أي تعديل/);
});

test('تغيير نوع الطلب يستخدم حقول وقواعد النوع المقترح', () => {
  const current = { ...delivery, customer_name: 'محمد أحمد علي', customer_number: '0999999999', address: 'دمشق المزة', currency: 'ل.س' };
  assert.deepEqual(validate({ order_type: 'شحن', shipping_delivery_status: 'delivered', total_price: 15000 }, current), {
    order_type: 'شحن', shipping_delivery_status: 'delivered', total_price: 15000
  });
  assert.throws(() => validate({ order_type: 'شحن', status: 'تم' }, current), /التسليم/);
  assert.throws(() => validate({ order_type: 'شحن', total_price: 9999 }, current), /أجور/);
  assert.throws(() => validate({ order_type: 'نوع آخر' }, current), /نوع الطلب/);
  assert.throws(() => validate({ order_type: null }, current), /نوع الطلب/);
  assert.throws(() => validate({ order_type: 'شحن' }, { ...current, customer_name: 'محمد أحمد' }), /الاسم الثلاثي/);
  assert.throws(() => validate({ order_type: 'شحن' }, { ...current, currency: 'دولار' }), /الليرة/);
  assert.deepEqual(validate({ order_type: 'توصيل', address: 'دمشق المزة', status: 'تم', total_price: 5000 }, shipping), {
    order_type: 'توصيل', address: 'دمشق المزة', status: 'تم', total_price: 5000
  });
  assert.throws(() => validate({ order_type: 'توصيل' }, shipping), /العنوان/);
});

test('يمكن طلب تعديل الاسم الثلاثي والهاتف العربي والملاحظة الفارغة', () => {
  assert.deepEqual(validate({ customer_name: ' محمد أحمد علي ', customer_number: '٠٩٩٩٩٩٩٩٩٩', note: '' }, shipping), {
    customer_name: 'محمد أحمد علي', customer_number: '0999999999', note: ''
  });
  assert.throws(() => validate({ customer_name: 'محمد أحمد' }, shipping), /الثلاثي/);
});

test('حالة الشحن تبقى من الحالتين الموجودتين وحالة التوصيل مستقلة', () => {
  assert.deepEqual(validate({ shipping_delivery_status: 'delivered' }, shipping), { shipping_delivery_status: 'delivered' });
  assert.deepEqual(validate({ shipping_delivery_status: 'pending' }, shipping), { shipping_delivery_status: 'pending' });
  assert.throws(() => validate({ status: 'تم' }, shipping), /التسليم/);
  assert.throws(() => validate({ shipping_delivery_status: 'other' }, shipping), /غير صالحة/);
  assert.throws(() => validate({ shipping_delivery_status: 'delivered' }, delivery), /غير صالحة/);
  assert.deepEqual(validate({ status: 'تم' }, delivery), { status: 'تم' });
});

test('السعر المقترح للشحن يتضمن الأجور ولا يقبل قيماً ناقصة أو غير رقمية', () => {
  assert.equal(validate({ total_price: '١٥٠٠٠' }, shipping).total_price, 15000);
  for (const value of [9999, -1, '', null, Infinity, {}, true]) assert.throws(() => validate({ total_price: value }, shipping));
  assert.equal(validate({ total_price: 0 }, delivery).total_price, 0);
});

test('طلبات تعديل الأصناف تدمج الكميات وتمنع التجاوز والكسور', () => {
  assert.deepEqual(validate({ items: [{ variant_id: variant, quantity: 2 }, { variant_id: variant, quantity: 3 }] }, shipping).items,
    [{ variant_id: variant, quantity: 5 }]);
  for (const quantity of [0, -1, 1.5, 1001]) assert.throws(() => validate({ items: [{ variant_id: variant, quantity }] }, shipping));
  assert.throws(() => validate({ items: [{ variant_id: variant, quantity: 600 }, { variant_id: variant, quantity: 600 }] }, shipping));
  assert.throws(() => validate({ items: [] }, shipping));
});

test('إعادة حساب السعر لا تُقبل دون أصناف ولا تُحوَّل قيم غير منطقية', () => {
  assert.throws(() => validate({ recalculate_total_price: true }, shipping));
  assert.throws(() => validate({ items: [{ variant_id: variant, quantity: 1 }], recalculate_total_price: 'true' }, shipping));
  assert.equal(validate({ items: [{ variant_id: variant, quantity: 1 }], recalculate_total_price: true }, shipping).recalculate_total_price, true);
});
