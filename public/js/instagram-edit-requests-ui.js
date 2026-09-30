'use strict';

window.InstagramEditRequestsUI = {
  shippingFee(order, type) {
    return type === 'شحن' ? (order.order_type === 'شحن' ? Number(order.shipping_fee) || 0 : 10000) : 0;
  },
  initialStatus(order, type) {
    if (type === 'شحن') return order.order_type === 'شحن'
      ? (order.shipping_delivery_status === 'delivered' ? 'delivered' : 'pending')
      : (order.status === 'تم' ? 'delivered' : 'pending');
    if (order.order_type !== 'شحن' || ['مرتجع', 'إلغاء'].includes(order.status)) return order.status || 'قيد المتابعة';
    return order.shipping_delivery_status === 'delivered' ? 'تم' : 'قيد المتابعة';
  },
  changeList(request, escape) {
    const labels = { order_type: 'نوع الطلب', order_number: 'رقم الطلب', customer_name: 'اسم العميل', customer_number: 'رقم العميل',
      address: 'العنوان', note: 'الملاحظة', total_price: 'السعر النهائي', status: 'حالة التوصيل', shipping_delivery_status: 'حالة الشحن', items: 'الأصناف' };
    const format = (key, value, items) => {
      if (key === 'shipping_delivery_status') return value === 'delivered' ? 'تم التسليم' : 'لم يتم التسليم';
      if (key === 'items') return (items || []).map((item) => `${item.product_name || item.variant_id} — ${item.color || ''} / ${item.size || ''} × ${item.quantity}`).join('، ');
      return String(value ?? '') || '—';
    };
    return `<dl class="ig-request-changes">${Object.entries(request.requested_changes || {})
      .filter(([key]) => key !== 'recalculate_total_price')
      .map(([key, value]) => `<div><dt>${escape(labels[key] || key)}</dt><dd><span class="ig-request-before">${escape(format(key, request.original_values?.[key], request.original_items))}</span><span aria-label="إلى"> ← </span><strong>${escape(format(key, value, request.proposed_items))}</strong></dd></div>`).join('')}</dl>`;
  }
};
