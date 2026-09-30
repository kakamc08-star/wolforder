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

const viewerState = { orders: [], allOrders: [], inventory: [], editRequests: [], editProducts: [], editOrder: null, status: '', orderType: '', activePanel: 'home', inventoryLoaded: false };
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
      if (data.type === 'INSTAGRAM_EDIT_REQUEST_UPDATED') loadViewerEditRequests();
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
    viewerStatusLabel(order),
    ...itemValues
  ];
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

async function viewerApi(url, options = {}) {
  const headers = { Authorization: `Bearer ${viewerToken}` };
  if (options.body && typeof options.body !== 'string') {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(options.body);
  }
  const response = await fetch(url, { ...options, headers });
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

function showViewerPanel(panel) {
  viewerState.activePanel = panel;
  document.querySelectorAll('[data-viewer-panel]').forEach((item) => { item.hidden = item.dataset.viewerPanel !== panel; });
  document.querySelectorAll('[data-viewer-section]').forEach((item) => item.classList.toggle('active', item.dataset.viewerSection === panel));
  document.getElementById('viewerPageTitle').textContent = panel === 'orders' ? 'طلبات الإنستغرام' : panel === 'inventory' ? 'الجرد والمبيعات' : panel === 'editRequests' ? 'طلبات التعديل' : `مرحباً ${viewerUser.name || ''}`;
  if (panel === 'orders' && !viewerState.orders.length) loadViewerOrders();
  if (panel === 'inventory' && !viewerState.inventory.length) loadViewerInventory();
  if (panel === 'editRequests') loadViewerEditRequests();
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
    const isShippingStatus = (value) => ['تم التسليم', 'لم يتم التسليم'].includes(value);
    if ((viewerState.orderType === 'شحن' && viewerState.status && !isShippingStatus(viewerState.status))
      || (viewerState.orderType === 'توصيل' && isShippingStatus(viewerState.status))) viewerState.status = '';
    document.querySelectorAll('#viewerStatusQuickBoxes .status-quick-box').forEach((box) => {
      const value = box.dataset.status;
      box.hidden = Boolean(value && ((viewerState.orderType === 'شحن' && !isShippingStatus(value))
        || (viewerState.orderType === 'توصيل' && isShippingStatus(value))));
      box.classList.toggle('active', value === viewerState.status);
    });
    loadViewerOrders();
  });
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
    const pending = viewerState.editRequests.some((request) => request.order_id === order.id && request.status === 'معلق');
    const actionHtml = pending ? '<span class="viewer-order-decision-status">طلب تعديل معلّق</span>'
      : '<button type="button" class="btn btn-primary btn-sm" data-viewer-instagram-action="request-edit">طلب تعديل</button>';
    return `<tr data-viewer-instagram-order-id="${viewerEscape(order.id)}"><td data-label="العداد">${index + 1}</td><td data-label="رقم الطلب"><span class="ig-order-number">#${viewerEscape(order.order_number)}</span></td><td data-label="نوع الطلب"><span class="order-type-badge ${isShipping ? 'order-type-shipping' : 'order-type-delivery'}">${viewerEscape(orderType)}</span></td><td class="text-wrap-column" data-label="محتويات الطلب"><ul class="ig-order-items">${(Array.isArray(order.items) ? order.items : []).map((item) => `<li>${viewerEscape(item.product_name)} — ${viewerEscape(item.color)} / ${viewerEscape(item.size)} × ${item.quantity}</li>`).join('')}</ul></td><td data-label="اسم العميل">${viewerEscape(order.customer_name)}</td><td data-label="رقم العميل">${viewerEscape(order.customer_number)}</td><td data-label="العنوان">${viewerEscape(order.address)}</td><td data-label="السعر">${priceHtml}</td><td data-label="الحالة"><span class="status-badge status-${viewerEscape(order.order_type === 'شحن' ? (order.shipping_delivery_status === 'delivered' ? 'تم' : 'قيد المتابعة') : order.status)}">${viewerEscape(viewerStatusLabel(order))}</span></td><td data-label="التاريخ">${viewerDate(order.created_at, true)}</td><td class="viewer-order-actions-cell" data-label="الإجراء">${actionHtml}</td></tr>`;
  }).join('') : '<tr><td colspan="11">لا توجد طلبات.</td></tr>';

  updateViewerTotals();
}

async function loadViewerOrders() {
  try {
    const params = new URLSearchParams();
    const status = viewerState.status || '';
    if (status) params.set('status', status);
    if (viewerState.orderType) params.set('orderType', viewerState.orderType);
    const [orders, requests] = await Promise.all([viewerApi(`/api/instagram/orders?${params}`), viewerApi('/api/instagram/edit-requests')]);
    viewerState.allOrders = orders;
    viewerState.editRequests = requests;
    const search = document.getElementById('viewerOrderSearch')?.value || '';
    viewerState.orders = viewerState.allOrders.filter((order) => matchesViewerSearch(order, search));
    renderViewerOrders();
  } catch (error) { viewerNotify(error.message); }
}

document.getElementById('viewerRefreshOrders').addEventListener('click', loadViewerOrders);
document.getElementById('viewerOrdersBody').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-viewer-instagram-action="request-edit"]');
  if (!button) return;
  const id = button.closest('[data-viewer-instagram-order-id]')?.dataset.viewerInstagramOrderId;
  const order = viewerState.orders.find((item) => item.id === id);
  if (!order) return;
  button.disabled = true;
  try { await openViewerEditRequest(order); }
  catch (error) { viewerNotify(error.message); }
  finally { button.disabled = false; }
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
    document.getElementById('viewerInventoryBody').innerHTML = viewerState.inventory.length ? viewerState.inventory.map((row) => `<tr><td data-label="الصنف">${viewerEscape(row.product_name)}</td><td data-label="اللون">${viewerEscape(row.color)}</td><td data-label="المقاس">${viewerEscape(row.size)}</td><td data-label="الكلية">${row.quantity_total}</td><td data-label="محجوز التوصيل">${row.reserved_delivery}</td><td data-label="محجوز الشحن">${row.reserved_shipping}</td><td data-label="المباعة">${row.sold}</td><td data-label="الشحن المُسلَّم">${row.shipping_delivered}</td><td data-label="المؤجلة">${row.postponed}</td><td data-label="المرتجع">${row.returned}</td><td data-label="الإلغاء">${row.cancelled}</td><td data-label="المتبقية"><strong>${row.remaining}</strong></td></tr>`).join('') : '<tr><td colspan="12">لا توجد بيانات جرد.</td></tr>';
  } catch (error) { viewerNotify(error.message); }
}

function viewerStatusLabel(order) {
  return order.order_type === 'شحن' ? (order.shipping_delivery_status === 'delivered' ? 'تم التسليم' : 'لم يتم التسليم') : order.status;
}

async function loadViewerEditRequests() {
  try {
    viewerState.editRequests = await viewerApi('/api/instagram/edit-requests');
    document.getElementById('viewerEditRequestsGrid').innerHTML = viewerState.editRequests.length ? viewerState.editRequests.map((request) => `
      <article class="ig-edit-request-card"><header><h3>طلب #${viewerEscape(request.order?.order_number || request.original_values?.order_number)}</h3><strong>${viewerEscape(request.status)}</strong></header>
      <p>${viewerDate(request.created_at, true)}</p>${InstagramEditRequestsUI.changeList(request, viewerEscape)}
      ${request.reason ? `<p>السبب: ${viewerEscape(request.reason)}</p>` : ''}
      ${request.responded_at ? `<p>قرار الأدمن: ${viewerDate(request.responded_at, true)} · ${viewerEscape(request.admin_note || '—')}</p>` : '<p>بانتظار قرار الأدمن</p>'}</article>`).join('') : '<p>لا توجد طلبات تعديل.</p>';
    if (viewerState.activePanel === 'orders') renderViewerOrders();
  } catch (error) { viewerNotify(error.message); }
}
document.getElementById('viewerRefreshEditRequests').addEventListener('click', loadViewerEditRequests);

function viewerEditableVariants() {
  const currentIds = new Set((viewerState.editOrder?.items || []).map((item) => item.variant_id));
  return viewerState.editProducts.flatMap((product) => (product.variants || []).filter((variant) =>
    (variant.is_active && product.status === 'active' && (product.currency || 'ل.س') === (viewerState.editOrder?.currency || 'ل.س')) || currentIds.has(variant.id)
  ).map((variant) => ({ ...variant, product_name: product.name, unit_price: product.unit_price, currency: product.currency || 'ل.س' })));
}

function addViewerRequestItem(item = {}) {
  const container = document.getElementById('viewerEditItems');
  if (container.children.length >= 50) return viewerNotify('الحد الأقصى 50 صنفاً');
  const variants = viewerEditableVariants();
  const selectedExists = variants.some((variant) => variant.id === item.variant_id);
  const fallback = item.variant_id && !selectedExists ? `<option value="${viewerEscape(item.variant_id)}" selected>${viewerEscape(item.product_name)} — ${viewerEscape(item.color)} / ${viewerEscape(item.size)}</option>` : '';
  const row = document.createElement('div'); row.className = 'viewer-edit-item-row';
  row.innerHTML = `<div class="form-group"><label>الصنف واللون والمقاس</label><select class="viewer-request-variant"><option value="">اختر الصنف</option>${fallback}${variants.map((variant) => `<option value="${viewerEscape(variant.id)}" ${variant.id === item.variant_id ? 'selected' : ''}>${viewerEscape(variant.product_name)} — ${viewerEscape(variant.color)} / ${viewerEscape(variant.size)}</option>`).join('')}</select></div><div class="form-group"><label>الكمية</label><input type="number" class="viewer-request-quantity" min="1" max="1000" step="1" value="${Math.max(1, Number(item.quantity) || 1)}"></div><button type="button" class="btn btn-danger btn-sm" data-viewer-remove-item>حذف</button>`;
  container.appendChild(row);
}

function viewerRequestItems() {
  return [...document.querySelectorAll('#viewerEditItems .viewer-edit-item-row')].map((row) => ({
    variant_id: row.querySelector('.viewer-request-variant').value,
    quantity: Number(row.querySelector('.viewer-request-quantity').value)
  }));
}

function normalizedViewerRequestItems(items) {
  const totals = new Map();
  for (const item of items) totals.set(item.variant_id || '', (totals.get(item.variant_id || '') || 0) + Number(item.quantity));
  return [...totals].sort(([a], [b]) => a.localeCompare(b)).map(([variant_id, quantity]) => ({ variant_id, quantity }));
}

function updateViewerRequestPrice() {
  const input = document.getElementById('viewerEditTotalPrice');
  if (input.dataset.priceMode === 'manual') return;
  const variants = viewerEditableVariants();
  const items = viewerRequestItems();
  if (items.some((item) => !variants.some((variant) => variant.id === item.variant_id))) return;
  const itemsTotal = items.reduce((sum, item) => sum + Number(variants.find((variant) => variant.id === item.variant_id).unit_price || 0) * item.quantity, 0);
  input.value = (itemsTotal + InstagramEditRequestsUI.shippingFee(viewerState.editOrder, document.getElementById('viewerEditOrderType').value)).toFixed(2);
}

function updateViewerRequestType(typeChanged = false) {
  const order = viewerState.editOrder;
  if (!order) return;
  const type = document.getElementById('viewerEditOrderType').value;
  const shipping = type === 'شحن';
  const fee = InstagramEditRequestsUI.shippingFee(order, type);
  const price = document.getElementById('viewerEditTotalPrice');
  if (typeChanged) {
    price.value = Math.max(0, Number(price.value) - Number(price.dataset.shippingFee || 0)) + fee;
    document.getElementById(shipping ? 'viewerEditShippingStatus' : 'viewerEditDeliveryStatus').value = InstagramEditRequestsUI.initialStatus(order, type);
  }
  price.dataset.shippingFee = fee;
  price.min = fee;
  document.getElementById('viewerEditShippingStatusGroup').hidden = !shipping;
  document.getElementById('viewerEditDeliveryStatusGroup').hidden = shipping;
  document.getElementById('viewerEditAddress').required = !shipping;
  document.getElementById('viewerEditAddress').minLength = shipping ? 0 : 5;
  document.getElementById('viewerEditPriceHint').textContent = shipping ? `يشمل ${viewerNumber(fee)} ل.س أجور الشحن` : order.currency || 'ل.س';
}
document.getElementById('viewerEditOrderType').addEventListener('change', () => updateViewerRequestType(true));

async function openViewerEditRequest(order) {
  const [currentOrder, products] = await Promise.all([viewerApi(`/api/instagram/orders/${encodeURIComponent(order.id)}`), viewerApi('/api/instagram/edit-options')]);
  viewerState.editOrder = currentOrder;
  viewerState.editProducts = products;
  document.getElementById('viewerEditRequestForm').reset();
  document.getElementById('viewerEditOrderId').value = order.id;
  document.getElementById('viewerEditOrderType').value = currentOrder.order_type || 'توصيل';
  for (const [field, id] of [['order_number', 'viewerEditOrderNumber'], ['customer_name', 'viewerEditCustomerName'], ['customer_number', 'viewerEditCustomerNumber'], ['address', 'viewerEditAddress'], ['total_price', 'viewerEditTotalPrice'], ['note', 'viewerEditNote']]) document.getElementById(id).value = currentOrder[field] ?? '';
  const isShipping = currentOrder.order_type === 'شحن';
  document.getElementById('viewerEditShippingStatusGroup').hidden = !isShipping;
  document.getElementById('viewerEditDeliveryStatusGroup').hidden = isShipping;
  document.getElementById('viewerEditShippingStatus').value = currentOrder.shipping_delivery_status === 'delivered' ? 'delivered' : 'pending';
  document.getElementById('viewerEditDeliveryStatus').value = currentOrder.status;
  document.getElementById('viewerEditAddress').required = !isShipping;
  document.getElementById('viewerEditAddress').minLength = isShipping ? 0 : 5;
  document.getElementById('viewerEditPriceHint').textContent = isShipping ? `يشمل ${viewerNumber(currentOrder.shipping_fee)} ل.س أجور الشحن` : currentOrder.currency || 'ل.س';
  document.getElementById('viewerEditTotalPrice').min = isShipping ? Number(currentOrder.shipping_fee) || 0 : 0;
  document.getElementById('viewerEditTotalPrice').dataset.priceMode = 'auto';
  document.getElementById('viewerEditTotalPrice').dataset.shippingFee = InstagramEditRequestsUI.shippingFee(currentOrder, currentOrder.order_type || 'توصيل');
  updateViewerRequestType();
  document.getElementById('viewerEditItems').innerHTML = '';
  (currentOrder.items || []).forEach(addViewerRequestItem);
  document.getElementById('viewerEditRequestModal').hidden = false;
  document.getElementById('viewerEditCustomerName').focus();
}

function closeViewerEditRequest() { document.getElementById('viewerEditRequestModal').hidden = true; }
document.querySelectorAll('[data-viewer-close-edit]').forEach((button) => button.addEventListener('click', closeViewerEditRequest));
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeViewerEditRequest(); });
document.getElementById('viewerAddEditItem').addEventListener('click', () => addViewerRequestItem());
document.getElementById('viewerEditTotalPrice').addEventListener('input', () => { document.getElementById('viewerEditTotalPrice').dataset.priceMode = 'manual'; });
document.getElementById('viewerEditItems').addEventListener('input', updateViewerRequestPrice);
document.getElementById('viewerEditItems').addEventListener('change', updateViewerRequestPrice);
document.getElementById('viewerEditItems').addEventListener('click', (event) => {
  const button = event.target.closest('[data-viewer-remove-item]');
  if (!button) return;
  if (document.getElementById('viewerEditItems').children.length <= 1) return viewerNotify('لا يمكن حذف جميع أصناف الطلب');
  button.closest('.viewer-edit-item-row').remove(); updateViewerRequestPrice();
});
document.getElementById('viewerEditRequestForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const order = viewerState.editOrder; if (!order) return;
  const changes = {};
  for (const [field, id] of [['order_number', 'viewerEditOrderNumber'], ['customer_name', 'viewerEditCustomerName'], ['customer_number', 'viewerEditCustomerNumber'], ['address', 'viewerEditAddress'], ['total_price', 'viewerEditTotalPrice'], ['note', 'viewerEditNote']]) {
    let value = document.getElementById(id).value.trim();
    if (field === 'customer_number') value = value.replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - '٠'.charCodeAt(0))).replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - '۰'.charCodeAt(0))).replace(/[^0-9]/g, '');
    const numeric = ['order_number', 'total_price'].includes(field);
    if (numeric) value = Number(value);
    if (value !== (numeric ? Number(order[field]) : String(order[field] ?? ''))) changes[field] = value;
  }
  const orderType = document.getElementById('viewerEditOrderType').value;
  if (orderType !== (order.order_type || 'توصيل')) changes.order_type = orderType;
  const isShipping = orderType === 'شحن';
  const statusKey = isShipping ? 'shipping_delivery_status' : 'status';
  const status = document.getElementById(isShipping ? 'viewerEditShippingStatus' : 'viewerEditDeliveryStatus').value;
  if (status !== (isShipping ? order.shipping_delivery_status || 'pending' : order.status)) changes[statusKey] = status;
  const items = normalizedViewerRequestItems(viewerRequestItems());
  if (JSON.stringify(items) !== JSON.stringify(normalizedViewerRequestItems(order.items || []))) {
    if (items.some((item) => !item.variant_id || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 1000)) return viewerNotify('اختر أصنافاً صالحة وكميات بين 1 و1000');
    changes.items = items;
    changes.recalculate_total_price = document.getElementById('viewerEditTotalPrice').dataset.priceMode === 'auto';
  }
  if (!Object.keys(changes).length) return viewerNotify('لم يتغير أي بيان في الطلب');
  const button = document.getElementById('viewerSubmitEditRequest'); button.disabled = true;
  try {
    await viewerApi(`/api/instagram/orders/${encodeURIComponent(order.id)}/edit-requests`, { method: 'POST', body: { changes, reason: document.getElementById('viewerEditReason').value.trim() } });
    viewerNotify('تم إرسال طلب التعديل إلى الأدمن، ولم تُغيَّر بيانات الطلب', 'success');
    closeViewerEditRequest();
    await loadViewerOrders(); await loadViewerEditRequests();
  } catch (error) { viewerNotify(error.message); }
  finally { button.disabled = false; }
});

connectViewerSocket();
showViewerPanel('home');
}
