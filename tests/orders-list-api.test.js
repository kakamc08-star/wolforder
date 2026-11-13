'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

process.env.JWT_SECRET = 'wolforder-orders-list-tests';
const users = {
  admin: { id: '10000000-0000-4000-8000-000000000001', role: 'admin' },
  company: { id: '10000000-0000-4000-8000-000000000002', role: 'company' },
  driver: { id: '10000000-0000-4000-8000-000000000003', role: 'driver' },
  viewer: { id: '10000000-0000-4000-8000-000000000004', role: 'instagram_viewer' }
};
const tokens = Object.fromEntries(Object.entries(users).map(([name, user]) => [
  name, jwt.sign(user, process.env.JWT_SECRET)
]));
let rows, calls, maxRows, failureOffset, insertedOrder;
let server, origin;

function matches(row, expression, column) {
  const split = expression.indexOf('.');
  const operator = expression.slice(0, split);
  const value = expression.slice(split + 1);
  if (operator === 'eq') return String(row[column]) === value;
  if (row[column] == null) return false;
  if (operator === 'gte') return Date.parse(row[column]) >= Date.parse(value);
  if (operator === 'lte') return Date.parse(row[column]) <= Date.parse(value);
  throw new Error('Unhandled operator ' + operator);
}

const fakeFetch = async (url, options) => {
  const params = new URL(url).searchParams;
  const offset = Number(params.get('offset') || 0);
  calls.push({ params: new URLSearchParams(params), prefer: new Headers(options.headers).get('prefer') });
  if (offset >= failureOffset) {
    return new Response(JSON.stringify({ code: 'XX000', message: 'Fixture database failure' }), { status: 400 });
  }
  let visible = rows.filter((row) => {
    for (const key of ['company_id', 'driver_id', 'status', 'order_type', 'created_at']) {
      for (const expression of params.getAll(key)) {
        if (!matches(row, expression, key)) return false;
      }
    }
    const alternative = params.get('or');
    if (alternative) {
      const expressions = alternative.slice(1, -1).split(',');
      if (!expressions.some((expression) => {
        const separator = expression.indexOf('.');
        return matches(row, expression.slice(separator + 1), expression.slice(0, separator));
      })) return false;
    }
    return true;
  });
  const ordering = params.get('order').split(',');
  visible.sort((a, b) => {
    for (const expression of ordering) {
      const [column, direction] = expression.split('.');
      if (a[column] === b[column]) continue;
      const comparison = a[column] > b[column] ? 1 : -1;
      return direction === 'desc' ? -comparison : comparison;
    }
    return 0;
  });
  const count = visible.length;
  const limit = Math.min(maxRows, Number(params.get('limit')));
  visible = visible.slice(offset, offset + limit);
  if (insertedOrder && offset === 0) {
    rows.unshift(insertedOrder);
    insertedOrder = null;
  }
  return new Response(JSON.stringify(visible), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Content-Range': offset + '-' + (offset + visible.length - 1) + '/' + count
    }
  });
};

const database = createClient('https://wolforder-fixture.supabase.co', 'local-fixture-key', {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { fetch: fakeFetch }
});
const dbPath = require.resolve('../config/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: database };

test.before(async () => {
  const app = express();
  app.use('/api/orders', require('../routes/orders'));
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  origin = 'http://127.0.0.1:' + server.address().port + '/api/orders';
});

test.beforeEach(() => {
  rows = [];
  calls = [];
  maxRows = 5000;
  failureOffset = Infinity;
  insertedOrder = null;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function api(query = '', role = 'admin') {
  return fetch(origin + query, { headers: role ? { Authorization: 'Bearer ' + tokens[role] } : {} });
}

function order(index, values = {}) {
  return {
    id: '20000000-0000-4000-8000-' + String(index).padStart(12, '0'),
    order_number: String(index),
    company_id: users.company.id,
    driver_id: users.driver.id,
    created_at: new Date().toISOString(),
    updated_at: null,
    status: 'قيد المتابعة',
    order_type: 'توصيل',
    driver: { id: users.driver.id, name: 'سائق تجريبي', username: 'driver' },
    company: { id: users.company.id, name: 'شركة تجريبية', username: 'company' },
    ...values
  };
}

test('فترة العرض الافتراضي تطبق في قاعدة البيانات وتشمل القديم قيد المتابعة والمعدل اليوم', async () => {
  rows = [
    order(1, { created_at: '2020-01-01T00:00:00Z' }),
    order(2, { status: 'تم' }),
    order(3, { status: 'تم', created_at: '2020-01-01T00:00:00Z', updated_at: new Date().toISOString() }),
    order(4, { status: 'تم', created_at: '2020-01-01T00:00:00Z' })
  ];
  const response = await api();
  const data = await response.json();
  assert.deepEqual(new Set(data.map((row) => row.order_number)), new Set(['1', '2', '3']));
  assert.match(calls[0].params.get('or'), /status.eq.قيد المتابعة/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(data[0].driver.name, 'سائق تجريبي');
});

test('5000 صف للدفعة لا تخفي الطلبات اللاحقة أو الطلبات بعد حد Supabase الأدنى', async () => {
  rows = Array.from({ length: 5107 }, (_, index) => order(index + 1));
  maxRows = 1000;
  const response = await api();
  const data = await response.json();
  assert.equal(data.length, rows.length);
  assert.equal(new Set(data.map((row) => row.id)).size, rows.length);
  assert.deepEqual(calls.map((call) => Number(call.params.get('offset'))), [0, 1000, 2000, 3000, 4000, 5000]);
  assert(calls.every((call) => call.prefer.includes('count=exact')));
  assert(calls.every((call) => call.params.get('order') === 'created_at.desc,id.desc'));
});

test('جميع الطلبات ضمن حد Supabase ترجع باستعلام واحد', async () => {
  rows = Array.from({ length: 4000 }, (_, index) => order(index + 1));
  const response = await api();
  assert.equal((await response.json()).length, 4000);
  assert.equal(calls.length, 1);
});

test('تغير ترتيب الصفحات أثناء وصول طلب جديد لا يكرر الطلبات في الرد', async () => {
  rows = Array.from({ length: 3 }, (_, index) => order(index + 1, { created_at: '2026-11-01T00:00:00Z' }));
  insertedOrder = order(10);
  maxRows = 1;
  const response = await api();
  const data = await response.json();
  assert.deepEqual(new Set(data.map((row) => row.order_number)), new Set(['1', '2', '3']));
  assert.equal(data.length, 3);
  const latest = await api();
  assert.equal((await latest.json()).length, 4);
});

test('قائمة فارغة ترجع مصفوفة صالحة باستعلام واحد', async () => {
  const response = await api();
  assert.deepEqual(await response.json(), []);
  assert.equal(calls.length, 1);
});

test('قائمة الشركة والسائق تفرض ملكية الحساب رغم معاملات شركة وسائق آخرين', async () => {
  rows = [
    order(1),
    order(2, { company_id: 'foreign-company', driver_id: 'foreign-driver' })
  ];
  for (const role of ['company', 'driver']) {
    const response = await api('?companyId=foreign-company&driverId=foreign-driver', role);
    assert.deepEqual((await response.json()).map((row) => row.order_number), ['1']);
  }
  const response = await api('?companyId=foreign-company&driverId=foreign-driver');
  assert.deepEqual((await response.json()).map((row) => row.order_number), ['2']);
});

test('الشركة ترى تاريخها كاملاً والفلترة الصريحة بالزمن والحالة والنوع تبقى فعالة', async () => {
  rows = [
    order(1, { created_at: '2020-01-01T00:00:00Z', status: 'تم', order_type: 'شحن' }),
    order(2, { created_at: '2020-01-02T00:00:00Z', status: 'تم', order_type: 'شحن لباب المنزل' }),
    order(3)
  ];
  const all = await api('', 'company');
  assert.equal((await all.json()).length, 3);
  const since = encodeURIComponent('2020-01-01T00:00:00Z');
  const until = encodeURIComponent('2020-01-01T23:59:59.999Z');
  const filtered = await api('?startDate=' + since + '&endDate=' + until + '&status=تم&orderType=شحن');
  assert.deepEqual((await filtered.json()).map((row) => row.order_number), ['1']);
  assert.equal(calls.at(-1).params.get('or'), null);
});

test('رفض النوع غير الصالح وصلاحيات المشاهدة والجلسة المفقودة', async () => {
  assert.equal((await api('?orderType=invalid')).status, 400);
  assert.equal((await api('', 'viewer')).status, 403);
  assert.equal((await api('', null)).status, 401);
  assert.equal(calls.length, 0);
});

test('فشل الدفعة التالية لا يرجع قائمة جزئية على أنها تحميل ناجح', async () => {
  maxRows = 1;
  failureOffset = 1;
  rows = [order(1), order(2)];
  const response = await api();
  assert.equal(response.status, 500);
  assert.equal((await response.json()).message, 'Fixture database failure');
});
