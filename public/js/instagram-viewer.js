const viewerToken = localStorage.getItem('token');
const viewerUser = JSON.parse(localStorage.getItem('user') || 'null');
if (!viewerToken || !viewerUser || viewerUser.role !== 'instagram_viewer') location.href = 'login.html';
document.getElementById('userNameDisplay').textContent = viewerUser?.name || viewerUser?.username || '';
document.getElementById('viewerSidebarName').textContent = viewerUser?.name || 'Instagram';

const viewerState = { orders: [], inventory: [], type: '', status: '' };
const viewerEscape = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
const viewerDate = (value, time = false) => value ? new Date(value).toLocaleString('en-GB', time ? { dateStyle: 'short', timeStyle: 'short' } : { dateStyle: 'short' }) : '-';
const viewerNumber = (value) => (Number(value) || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });

function viewerNotify(message, type = 'error') {
  const item = document.createElement('div'); item.className = `toast-notification toast-${type}`; item.textContent = message; document.getElementById('notificationArea').appendChild(item); setTimeout(() => item.remove(), 4000);
}

async function viewerApi(url) {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${viewerToken}` } });
  const data = await response.json().catch(() => ({}));
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

// تبويبات النوع (الكل/توصيل/شحن)
document.querySelectorAll('[data-viewer-type]').forEach((button) => button.addEventListener('click', () => {
  document.querySelectorAll('[data-viewer-type]').forEach((item) => item.classList.remove('active'));
  button.classList.add('active');
  viewerState.type = button.dataset.viewerType || '';
  // إزالة تفعيل مربع شحن إذا اخترنا نوعاً آخر
  if (viewerState.type !== 'شحن') {
    document.querySelector('[data-shipping="true"]')?.classList.remove('active');
  }
  loadViewerOrders();
}));

// مربعات الحالات السريعة
document.querySelectorAll('.status-quick-box').forEach((box) => {
  box.addEventListener('click', () => {
    // إزالة التفعيل من جميع المربعات
    document.querySelectorAll('.status-quick-box').forEach(b => b.classList.remove('active'));
    // تفعيل المربع المضغوط
    box.classList.add('active');

    if (box.dataset.shipping === 'true') {
      // مربع شحن: يحدد النوع شحن والحالة فارغة
      viewerState.type = 'شحن';
      viewerState.status = '';
      // تحديث تبويبات النوع لتظهر شحن نشط
      document.querySelectorAll('[data-viewer-type]').forEach(t => t.classList.remove('active'));
      document.querySelector('[data-viewer-type="شحن"]')?.classList.add('active');
    } else {
      // مربع حالة
      viewerState.status = box.dataset.status || '';
      // إذا كانت الحالة غير فارغة، نلغي تحديد النوع
      if (viewerState.status) {
        viewerState.type = '';
        document.querySelectorAll('[data-viewer-type]').forEach(t => t.classList.remove('active'));
      }
    }

    // تحديث الفلتر العلوي ليعكس الحالة المحددة
    const statusSelect = document.getElementById('viewerOrderStatus');
    if (statusSelect) {
      statusSelect.value = viewerState.status;
    }

    loadViewerOrders();
  });
});

function renderViewerOrders() {
  const body = document.getElementById('viewerOrdersBody');
  body.innerHTML = viewerState.orders.length ? viewerState.orders.map((order) => `<tr><td data-label="الرقم">#${order.order_number}</td><td data-label="النوع"><span class="order-type-badge ${order.order_type === 'توصيل' ? 'order-type-delivery' : 'order-type-shipping'}">${order.order_type}</span></td><td data-label="الزبون">${viewerEscape(order.customer_name)}</td><td data-label="الموبايل">${viewerEscape(order.customer_number)}</td><td data-label="العنوان">${viewerEscape(order.address)}</td><td data-label="الأصناف"><ul class="ig-order-items">${(order.items || []).map((item) => `<li>${viewerEscape(item.product_name)} — ${viewerEscape(item.color)} / ${viewerEscape(item.size)} × ${item.quantity}</li>`).join('')}</ul></td><td data-label="الإجمالي">${viewerNumber(order.total_price)} ${viewerEscape(order.currency)}</td><td data-label="الحالة"><span class="status-badge status-${viewerEscape(order.status)}">${viewerEscape(order.status)}</span></td><td data-label="تسليم الشحن">${order.order_type === 'شحن' ? (order.shipping_delivery_status === 'delivered' ? `<span class="shipping-delivered">تم التسليم لـ ${viewerEscape(order.company_name)}<br>${viewerDate(order.shipping_delivered_at, true)}</span>` : '<span class="shipping-pending">بانتظار التسليم</span>') : '—'}</td><td data-label="التاريخ">${viewerDate(order.created_at, true)}</td></tr>`).join('') : '<tr><td colspan="10">لا توجد طلبات.</td></tr>';
}

async function loadViewerOrders() {
  try {
    const params = new URLSearchParams();
    const searchInput = document.getElementById('viewerOrderSearch');
    const search = searchInput ? searchInput.value : '';
    const status = viewerState.status || '';
    if (search) params.set('search', search);
    if (status) params.set('status', status);
    if (viewerState.type) params.set('orderType', viewerState.type);

    viewerState.orders = await viewerApi(`/api/instagram/orders?${params}`);
    renderViewerOrders();
  } catch (error) { viewerNotify(error.message); }
}

document.getElementById('viewerRefreshOrders').addEventListener('click', loadViewerOrders);
document.getElementById('viewerApplyOrderFilter').addEventListener('click', () => {
  // لا يوجد فلتر حالة سفلي، فقط بحث
  loadViewerOrders();
});

async function loadViewerInventory() {
  try {
    viewerState.inventory = await viewerApi('/api/instagram/inventory');
    document.getElementById('viewerInventoryBody').innerHTML = viewerState.inventory.length ? viewerState.inventory.map((row) => `<tr><td data-label="الصنف">${viewerEscape(row.product_name)}</td><td data-label="اللون">${viewerEscape(row.color)}</td><td data-label="المقاس">${viewerEscape(row.size)}</td><td data-label="الكلية">${row.quantity_total}</td><td data-label="محجوز توصيل">${row.reserved_delivery}</td><td data-label="محجوز شحن">${row.reserved_shipping}</td><td data-label="المباعة">${row.sold}</td><td data-label="المؤجلة">${row.postponed}</td><td data-label="المرتجع">${row.returned}</td><td data-label="الإلغاء">${row.cancelled}</td><td data-label="المتبقية"><strong>${row.remaining}</strong></td></tr>`).join('') : '<tr><td colspan="11">لا توجد بيانات جرد.</td></tr>';
  } catch (error) { viewerNotify(error.message); }
}
document.getElementById('viewerExportInventory').addEventListener('click', async () => {
  try { const response = await fetch('/api/instagram/inventory/export', { headers: { Authorization: `Bearer ${viewerToken}` } }); if (!response.ok) throw new Error('تعذر تصدير الجرد'); const blob = await response.blob(); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = 'instagram-inventory.xls'; link.click(); URL.revokeObjectURL(link.href); } catch (error) { viewerNotify(error.message); }
});

showViewerPanel('home');