const { normalizeDigits } = require('../utils/instagram-validation');

const numericFields = new Set([
  'price', 'ratio', 'quantity', 'unitPrice', 'unit_price', 'totalPrice', 'total_price',
  'items_total', 'shipping_fee', 'stockTotal', 'stock_total', 'stock_available',
  'nextOrderNumber', 'next_order_number', 'orderNumber', 'order_number',
  'customerNumber', 'customer_number', 'phone', 'page', 'limit', 'startDate', 'endDate'
]);

function normalizeValues(value) {
  if (!value || typeof value !== 'object' || Buffer.isBuffer(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (numericFields.has(key) && typeof item === 'string') {
      value[key] = normalizeDigits(item).replace(/٫/g, '.').replace(/٬/g, '');
    } else if (item && typeof item === 'object') {
      normalizeValues(item);
    }
  }
}

module.exports = function normalizeRequestNumbers(req, _res, next) {
  normalizeValues(req.body);
  normalizeValues(req.query);
  next();
};
