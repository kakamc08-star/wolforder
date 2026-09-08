const viewerToken = localStorage.getItem('token');
let viewerUser = null;
try {
  viewerUser = JSON.parse(localStorage.getItem('user') || 'null');
} catch (error) {
  localStorage.removeItem('user');
}
const viewerHasSession = Boolean(viewerToken && viewerUser && viewerUser.role === 'instagram_viewer');

if (!viewerHasSession) {
  localStorage.removeItem('token');
  localStorage.removeItem('refreshToken');
  localStorage.removeItem('user');
  window.location.replace('/instagram-login.html');
} else {
document.getElementById('userNameDisplay').textContent = viewerUser?.name || viewerUser?.username || '';
document.getElementById('viewerSidebarName').textContent = viewerUser?.name || 'Instagram';

const viewerState = { orders: [], allOrders: [], inventory: [], status: '', orderType: '', shippingDeliveryStatus: '', activePanel: 'home', inventoryLoaded: false };
const viewerEscape = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
const viewerDate = (value, time = false) => value ? new Date(value).toLocaleString('en-GB', time ? { dateStyle: 'short', timeStyle: 'short' } : { dateStyle: 'short' }) : '-';
const viewerNumber = (value) => (Number(value) || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
let viewerSocket;
let viewerInventoryRefreshTimer;

function scheduleViewerInventoryRefresh() {
  if (viewerState.activePanel !== 'inventory' && !viewerState.inventoryLoaded) return;
  window.clearTimeout(viewerInventoryRefreshTimer);
  viewerInventoryRefreshTimer = window.setTimeout(() => {
    loadViewerInventory();
  }, 150);
}

function connectViewerSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  viewerSocket = new WebSocket(`${protocol}//${window.location.host}`);

  viewerSocket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      const isOrderEvent = ['INSTAGRAM_ORDER_CREATED', 'INSTAGRAM_ORDER_UPDATED', 'INSTAGRAM_ORDER_DELETED'].includes(data.type);
      const isInventoryEvent = data.type === 'INSTAGRAM_INVENTORY_UPDATED';
      if (isOrderEvent && viewerState.activePanel === 'orders') loadViewerOrders();
      if (isOrderEvent || isInventoryEvent) scheduleViewerInventoryRefresh();
    } catch (error) {
      console.error('Viewer WebSocket message error:', error);
    }
  };

  viewerSocket.onclose = () => {
    window.setTimeout(connectViewerSocket, 5000);
  };

  viewerSocket.onerror = () => {
    viewerSocket.close();
  };
}

function normalizeViewerSearch(value) {
  return String(value ?? '')
    .trim()
    .toLocaleLowerCase('ar')
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - '٠'.charCodeAt(0)))
    .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - '۰'.charCodeAt(0)))
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[\u064B-\u065F\u0670ـ]/g, '')
    .replace(/[\s\-_/+#().,:؛،]/g, '');
}

function viewerOrderSearchValues(order) {
  const itemValues = (Array.isArray(order.items) ? order.items : []).flatMap((item) => [
    item.product_name,
    item.color,
    item.size,
    item.quantity
  ]);
  return [
    order.order_number,
    order.customer_name,
    order.customer_number,
    order.address,
    order.note,
    order.company_name,
    order.order_type,
    order.status,
    order.display_status,
    order.shipping_delivered_to_name,
    ...itemValues
  ];
}

function viewerShippingCompanyName(order) {
  return order.shipping_delivered_to_name || order.company_name || 'غير معروف';
}

function viewerStatusHtml(order, isShipping) {
  if (!isShipping) {
    const status = order.status_label || order.status || '';
    const label = status === 'ملغي' ? 'إلغاء' : status;
    return `<span class="status-badge status-${viewerEscape(label)}">${viewerEscape(label)}</span>`;
  }
  const delivered = order.shipping_delivery_status === 'delivered';
  const label = order.display_status
    || `${delivered ? 'تم تسليم' : 'لم يتم تسليم'} ${viewerShippingCompanyName(order)}`;
  const deliveryDetails = delivered
    ? `<small class="ig-shipping-status-details">تاريخ التسليم: ${viewerDate(order.shipping_delivered_at)}<br>وقت التسليم: ${viewerDate(order.shipping_delivered_at, true).split(', ').slice(-1)[0] || '-'}</small>`
    : '';
  return `<div class="ig-order-status-stack"><span class="status-badge ${delivered ? 'shipping-status-delivered' : 'shipping-status-pending'}">${viewerEscape(label)}</span>${deliveryDetails}</div>`;
}

function matchesViewerSearch(order, value) {
  const term = normalizeViewerSearch(value);
  if (!term) return true;
  return viewerOrderSearchValues(order)
    .some((field) => normalizeViewerSearch(field).includes(term));
}

function applyViewerOrderSearch() {
  const search = document.getElementById('viewerOrderSearch')?.value || '';
  viewerState.orders = viewerState.allOrders.filter((order) => matchesViewerSearch(order, search));
  renderViewerOrders();
}

function viewerNotify(message, type = 'error') {
  const item = document.createElement('div'); item.className = `toast-notification toast-${type}`; item.textContent = message; document.getElementById('notificationArea').appendChild(item); setTimeout(() => item.remove(), 4000);
}

async function viewerApi(url) {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${viewerToken}` } });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 || response.status === 403) {
    localStorage.removeItem('token');
    localStorage.removeItem('refreshToken');
    localStorage.removeItem('user');
    window.location.replace('/instagram-login.html');
    throw new Error('انتهت جلسة الدخول، يرجى تسجيل الدخول من جديد');
  }
  if (!response.ok) throw new Error(data.message || 'تعذر تحميل البيانات');
  return data;
}

async function submitViewerShippingDecision(orderId, action) {
  const response = await fetch(`/api/instagram/orders/${encodeURIComponent(orderId)}/shipping/${action}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${viewerToken}`,
      'Content-Type': 'application/json'
    },
    body: '{}'
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 || response.status === 403) {
    localStorage.removeItem('token');
    localStorage.removeItem('refreshToken');
    localStorage.removeItem('user');
    window.location.replace('/instagram-login.html');
    throw new Error('انتهت جلسة الدخول، يرجى تسجيل الدخول من جديد');
  }
  if (!response.ok) throw new Error(data.message || 'تعذر تنفيذ العملية');
  return data;
}

function showViewerPanel(panel) {
  viewerState.activePanel = panel;
  document.querySelectorAll('[data-viewer-panel]').forEach((item) => { item.hidden = item.dataset.viewerPanel !== panel; });
  document.querySelectorAll('[data-viewer-section]').forEach((item) => item.classList.toggle('active', item.dataset.viewerSection === panel));
  document.getElementById('viewerPageTitle').textContent = panel === 'orders' ? 'طلبات الإنستغرام' : panel === 'inventory' ? 'الجرد والمبيعات' : `مرحباً ${viewerUser.name || ''}`;
  if (panel === 'orders' && !viewerState.orders.length) loadViewerOrders();
  if (panel === 'inventory' && !viewerState.inventory.length) loadViewerInventory();
  document.body.classList.remove('sidebar-open');
}
document.querySelectorAll('[data-viewer-section]').forEach((button) => button.addEventListener('click', () => showViewerPanel(button.dataset.viewerSection)));
document.querySelectorAll('[data-open-viewer]').forEach((button) => button.addEventListener('click', () => showViewerPanel(button.dataset.openViewer)));

// مربعات الحالات السريعة
document.querySelectorAll('.status-quick-box').forEach((box) => {
  box.addEventListener('click', () => {
    document.querySelectorAll('.status-quick-box').forEach(b => b.classList.remove('active'));
    box.classList.add('active');

    viewerState.status = box.dataset.status || '';
    loadViewerOrders();
  });
});

document.querySelectorAll('[data-viewer-order-type]').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('[data-viewer-order-type]').forEach((item) => item.classList.remove('active'));
    button.classList.add('active');
    viewerState.orderType = button.dataset.viewerOrderType || '';
    loadViewerOrders();
  });
});

document.getElementById('viewerShippingDeliveryStatus')?.addEventListener('change', (event) => {
  viewerState.shippingDeliveryStatus = event.target.value || '';
  loadViewerOrders();
});

// ✅ دالة تحديث الإجماليات (السعر فقط بدون نسبة)
function updateViewerTotals() {
  let totalSYR = 0;
  let totalUSD = 0;

  viewerState.orders.forEach(order => {
    const price = Number(order.total_price) || 0;
    if (order.currency === 'دولار') {
      totalUSD += price;
    } else {
      totalSYR += price;
    }
  });

  const elSYR = document.getElementById('viewerTotalSYR');
  const elUSD = document.getElementById('viewerTotalUSD');
  if (elSYR) elSYR.textContent = `${totalSYR.toLocaleString('en-US')} ل.س`;
  if (elUSD) elUSD.textContent = `${totalUSD.toLocaleString('en-US')} $`;
}

function renderViewerOrders() {
  const body = document.getElementById('viewerOrdersBody');
  const visibleCount = document.getElementById('viewerVisibleCount');
  if (visibleCount) visibleCount.textContent = viewerState.orders.length.toLocaleString('en-US');
  body.innerHTML = viewerState.orders.length ? viewerState.orders.map((order, index) => {
    const orderType = order.order_type || 'توصيل';
    const isShipping = orderType === 'شحن';
    const itemsTotal = Number(order.items_total) || Math.max(0, (Number(order.total_price) || 0) - (Number(order.shipping_fee) || 0));
    const priceHtml = isShipping
      ? `<div class="viewer-price-breakdown"><span>الأصناف: ${viewerNumber(itemsTotal)} ${viewerEscape(order.currency)}</span><span>الشحن: ${viewerNumber(order.shipping_fee || 0)} ل.س</span><strong>النهائي: ${viewerNumber(order.total_price)} ${viewerEscape(order.currency)}</strong></div>`
      : `${viewerNumber(order.total_price)} ${viewerEscape(order.currency)}`;
    const approval = order.shipping_approval_status || (isShipping ? 'pending' : 'not_required');
    const actionHtml = isShipping && approval === 'pending'
      ? '<div class="instagram-viewer-decision-actions"><button type="button" class="btn btn-success btn-sm" data-viewer-instagram-action="approve">قبول</button><button type="button" class="btn btn-danger btn-sm" data-viewer-instagram-action="reject">رفض</button></div>'
      : isShipping ? '<span class="viewer-order-decision-status">تمت معالجة الطلب</span>' : '-';
    return `<tr data-viewer-instagram-order-id="${viewerEscape(order.id)}"><td data-label="العداد">${index + 1}</td><td data-label="رقم الطلب"><span class="ig-order-number">#${viewerEscape(order.order_number)}</span></td><td data-label="نوع الطلب"><span class="order-type-badge ${isShipping ? 'order-type-shipping' : 'order-type-delivery'}">${viewerEscape(orderType)}</span></td><td class="text-wrap-column" data-label="محتويات الطلب"><ul class="ig-order-items">${(Array.isArray(order.items) ? order.items : []).map((item) => `<li>${viewerEscape(item.product_name)} — ${viewerEscape(item.color)} / ${viewerEscape(item.size)} × ${item.quantity}</li>`).join('')}</ul></td><td data-label="اسم العميل">${viewerEscape(order.customer_name)}</td><td data-label="رقم العميل">${viewerEscape(order.customer_number)}</td><td data-label="العنوان">${viewerEscape(order.address)}</td><td data-label="السعر">${priceHtml}</td><td data-label="الحالة">${viewerStatusHtml(order, isShipping)}</td><td data-label="التاريخ">${viewerDate(order.created_at, true)}</td><td class="viewer-order-actions-cell" data-label="الإجراء">${actionHtml}</td></tr>`;
  }).join('') : '<tr><td colspan="11">لا توجد طلبات.</td></tr>';

  updateViewerTotals();
}

async function loadViewerOrders() {
  try {
    const params = new URLSearchParams();
    const status = viewerState.status || '';
    if (status) params.set('status', status);
    if (viewerState.orderType) params.set('orderType', viewerState.orderType);
    if (viewerState.shippingDeliveryStatus) params.set('shippingDeliveryStatus', viewerState.shippingDeliveryStatus);
    viewerState.allOrders = await viewerApi(`/api/instagram/orders?${params}`);
    const search = document.getElementById('viewerOrderSearch')?.value || '';
    viewerState.orders = viewerState.allOrders.filter((order) => matchesViewerSearch(order, search));
    renderViewerOrders();
  } catch (error) { viewerNotify(error.message); }
}

document.getElementById('viewerRefreshOrders').addEventListener('click', loadViewerOrders);
document.getElementById('viewerOrdersBody').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-viewer-instagram-action]');
  if (!button) return;
  const row = button.closest('[data-viewer-instagram-order-id]');
  const orderId = row?.dataset.viewerInstagramOrderId;
  const action = button.dataset.viewerInstagramAction;
  if (!orderId || !['approve', 'reject'].includes(action)) return;
  if (action === 'reject' && !confirm('هل أنت متأكد من رفض وحذف طلب الشحن نهائياً؟')) return;

  row.querySelectorAll('[data-viewer-instagram-action]').forEach((item) => { item.disabled = true; });
  try {
    await submitViewerShippingDecision(orderId, action);
    viewerNotify(action === 'approve' ? 'تم قبول طلب الشحن وتثبيت حجز المخزون' : 'تم رفض طلب الشحن وإعادة القطع للمخزون وحذف الطلب', 'success');
    await loadViewerOrders();
    if (action === 'approve') await loadViewerInventory();
  } catch (error) {
    viewerNotify(error.message);
    row.querySelectorAll('[data-viewer-instagram-action]').forEach((item) => { item.disabled = false; });
  }
});
document.getElementById('viewerApplyOrderFilter').addEventListener('click', () => {
  if (viewerState.allOrders.length) applyViewerOrderSearch();
  else loadViewerOrders();
});
const viewerSearchInput = document.getElementById('viewerOrderSearch');
let viewerSearchTimer;
viewerSearchInput.addEventListener('input', () => {
  window.clearTimeout(viewerSearchTimer);
  viewerSearchTimer = window.setTimeout(applyViewerOrderSearch, 180);
});
viewerSearchInput.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  window.clearTimeout(viewerSearchTimer);
  applyViewerOrderSearch();
});

async function loadViewerInventory() {
  try {
    viewerState.inventory = await viewerApi('/api/instagram/inventory');
    viewerState.inventoryLoaded = true;
    document.getElementById('viewerInventoryBody').innerHTML = viewerState.inventory.length ? viewerState.inventory.map((row) => `<tr><td data-label="الصنف">${viewerEscape(row.product_name)}</td><td data-label="اللون">${viewerEscape(row.color)}</td><td data-label="المقاس">${viewerEscape(row.size)}</td><td data-label="الكلية">${row.quantity_total}</td><td data-label="محجوز التوصيل">${row.reserved_delivery}</td><td data-label="محجوز الشحن">${row.reserved_shipping}</td><td data-label="المباعة">${row.sold}</td><td data-label="المؤجلة">${row.postponed}</td><td data-label="المرتجع">${row.returned}</td><td data-label="الإلغاء">${row.cancelled}</td><td data-label="المتبقية"><strong>${row.remaining}</strong></td></tr>`).join('') : '<tr><td colspan="11">لا توجد بيانات جرد.</td></tr>';
  } catch (error) { viewerNotify(error.message); }
}

connectViewerSocket();
showViewerPanel('home');
}
