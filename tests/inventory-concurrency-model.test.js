'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

class LockedInventory {
  constructor(available) { this.available = available; this.reserved = 0; this.sold = 0; this.queue = Promise.resolve(); }
  transact(action) {
    const next = this.queue.then(() => action(this));
    this.queue = next.catch(() => {});
    return next;
  }
  reserve(quantity) {
    return this.transact(state => {
      if (state.available < quantity) throw new Error('OUT_OF_STOCK');
      state.available -= quantity; state.reserved += quantity;
    });
  }
  cancel(quantity) {
    return this.transact(state => {
      if (state.reserved < quantity) return;
      state.reserved -= quantity; state.available += quantity;
    });
  }
  complete(quantity) {
    return this.transact(state => {
      if (state.reserved < quantity) throw new Error('INVALID_RESERVED_STOCK');
      state.reserved -= quantity; state.sold += quantity;
    });
  }
  returnSold(quantity) {
    return this.transact(state => {
      if (state.sold < quantity) return;
      state.sold -= quantity; state.available += quantity;
    });
  }
}

test('محاكاة التزامن: آخر قطعة لا تنجح لطلبين', async () => {
  const stock = new LockedInventory(1);
  const results = await Promise.allSettled([stock.reserve(1), stock.reserve(1)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.deepEqual({ available: stock.available, reserved: stock.reserved }, { available: 0, reserved: 1 });
});

test('الإلغاء المكرر لا يعيد الكمية مرتين في نموذج الحالة', async () => {
  const stock = new LockedInventory(1);
  await stock.reserve(1);
  await stock.cancel(1);
  await stock.cancel(1);
  assert.deepEqual({ available: stock.available, reserved: stock.reserved }, { available: 1, reserved: 0 });
});

test('المرتجع بعد البيع يعيد القطعة مرة واحدة فقط', async () => {
  const stock = new LockedInventory(1);
  await stock.reserve(1);
  await stock.complete(1);
  await stock.returnSold(1);
  await stock.returnSold(1);
  assert.deepEqual(
    { available: stock.available, reserved: stock.reserved, sold: stock.sold },
    { available: 1, reserved: 0, sold: 0 }
  );
});
