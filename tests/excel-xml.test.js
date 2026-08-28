'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildInventoryWorkbook, safeSheetName } = require('../utils/excel-xml');

test('ينشئ ملف Excel متعدد الصفحات مع الهروب من XML', () => {
  const workbook = buildInventoryWorkbook(
    [['شركة & متجر', 'فستان <صيفي>', 'أسود', 'M', 10, 2, 1, 1, 0, 0, 6]],
    [{ name: 'فستان/صيفي', rows: [[1001, '27/08/2026', 'زبون', '099', 'دمشق', 'فستان', 'أسود', 'M', 2, 'توصيل', 'تم', 'شركة']] }]
  );
  assert.match(workbook, /Worksheet ss:Name="ملخص الأصناف"/);
  assert.match(workbook, /Worksheet ss:Name="فستان صيفي"/);
  assert.match(workbook, /شركة &amp; متجر/);
  assert.match(workbook, /فستان &lt;صيفي&gt;/);
});

test('يجعل أسماء صفحات الأصناف فريدة وأقصر من 31 حرفاً', () => {
  const used = new Set();
  const first = safeSheetName('اسم طويل جداً جداً جداً جداً جداً جداً', used);
  const second = safeSheetName('اسم طويل جداً جداً جداً جداً جداً جداً', used);
  assert.ok(first.length <= 31);
  assert.ok(second.length <= 31);
  assert.notEqual(first, second);
});
