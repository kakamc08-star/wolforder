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

const viewerState = { orders: [], allOrders: [], inventory: [], status: '' };
const viewerEscape = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
const viewerDate = (value, time = false) => value ? new Date(value).toLocaleString('en-GB', time ? { dateStyle: 'short', timeStyle: 'short' } : { dateStyle: 'short' }) : '-';
const viewerNumber = (value) => (Number(value) || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });

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

function showViewerPanel(panel) {
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
  body.innerHTML = viewerState.orders.length ? viewerState.orders.map((order, index) => `<tr><td data-label="العداد">${index + 1}</td><td data-label="رقم الطلب"><span class="ig-order-number">#${viewerEscape(order.order_number)}</span></td><td data-label="نوع الطلب"><span class="order-type-badge order-type-delivery">توصيل</span></td><td class="text-wrap-column" data-label="محتويات الطلب"><ul class="ig-order-items">${(Array.isArray(order.items) ? order.items : []).map((item) => `<li>${viewerEscape(item.product_name)} — ${viewerEscape(item.color)} / ${viewerEscape(item.size)} × ${item.quantity}</li>`).join('')}</ul></td><td data-label="اسم العميل">${viewerEscape(order.customer_name)}</td><td data-label="رقم العميل">${viewerEscape(order.customer_number)}</td><td data-label="العنوان">${viewerEscape(order.address)}</td><td data-label="السعر">${viewerNumber(order.total_price)} ${viewerEscape(order.currency)}</td><td data-label="الحالة"><span class="status-badge status-${viewerEscape(order.status)}">${viewerEscape(order.status)}</span></td><td data-label="التاريخ">${viewerDate(order.created_at, true)}</td></tr>`).join('') : '<tr><td colspan="10">لا توجد طلبات.</td></tr>';

  updateViewerTotals();
}

async function loadViewerOrders() {
  try {
    const params = new URLSearchParams();
    const status = viewerState.status || '';
    if (status) params.set('status', status);
    viewerState.allOrders = await viewerApi(`/api/instagram/orders?${params}`);
    const search = document.getElementById('viewerOrderSearch')?.value || '';
    viewerState.orders = viewerState.allOrders.filter((order) => matchesViewerSearch(order, search));
    renderViewerOrders();
  } catch (error) { viewerNotify(error.message); }
}

document.getElementById('viewerRefreshOrders').addEventListener('click', loadViewerOrders);
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
    document.getElementById('viewerInventoryBody').innerHTML = viewerState.inventory.length ? viewerState.inventory.map((row) => `<tr><td data-label="الصنف">${viewerEscape(row.product_name)}</td><td data-label="اللون">${viewerEscape(row.color)}</td><td data-label="المقاس">${viewerEscape(row.size)}</td><td data-label="الكلية">${row.quantity_total}</td><td data-label="محجوز التوصيل">${row.reserved_delivery}</td><td data-label="المباعة">${row.sold}</td><td data-label="المؤجلة">${row.postponed}</td><td data-label="المرتجع">${row.returned}</td><td data-label="الإلغاء">${row.cancelled}</td><td data-label="المتبقية"><strong>${row.remaining}</strong></td></tr>`).join('') : '<tr><td colspan="10">لا توجد بيانات جرد.</td></tr>';
  } catch (error) { viewerNotify(error.message); }
}

showViewerPanel('home');
}
