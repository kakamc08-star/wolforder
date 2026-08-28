const token = localStorage.getItem('token');
const userStr = localStorage.getItem('user');
if (!token || !userStr) window.location.href = 'login.html';
const user = JSON.parse(userStr);
if (user.role !== 'driver') window.location.href = 'login.html';
document.getElementById('userNameDisplay').textContent = user.name || user.username;

const offlineStore = window.DriverOfflineStore;
const driverOfflineScope = String(user.id || user._id || user.username);
const notificationSound = new Audio('data:audio/wav;base64,UklGRlwAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YVoAAACAgYGBgYGBgYCAgICAgICAgICAf39/f39/f39/f39/f39/f3+AgICAgICBgYGBgYGBgYGBgYCAgICAgID///8=');
let previousOrderIds = new Set();
let allOrders = [];
let isFetchingOrders = false;
let isSyncingPendingUpdates = false;
let autoRefresh = null;
let heartbeatInterval = null;
let ordersFetchController = null;
let driverSearchTimer = null;

function startDriverPolling() {
  if (autoRefresh) return;
  autoRefresh = setInterval(() => {
    if (!document.hidden && navigator.onLine && !isSyncingPendingUpdates) fetchOrders();
  }, 30000);
}

window.addEventListener('beforeunload', () => {
  if (autoRefresh) clearInterval(autoRefresh);
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  if (ordersFetchController) ordersFetchController.abort();
});

window.clearDriverOfflineData = async function clearDriverOfflineData() {
  if (!offlineStore) return;
  await offlineStore.clearScope(driverOfflineScope);
};

// ==================== دوال مساعدة ====================
function formatDate(date) {
  if (!date) return '-';
  const d = new Date(date);
  if (isNaN(d.getTime())) return '-';
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  return `${day}/${month}/${year}`;
}

function showNotification(msg, type = 'info') {
  const area = document.getElementById('notificationArea');
  if (!area) return;
  const n = document.createElement('div');
  n.className = `toast-notification toast-${type}`;
  n.innerHTML = `<span>${msg}</span>`;
  area.appendChild(n);
  setTimeout(() => {
    n.style.opacity = '0';
    setTimeout(() => n.remove(), 300);
  }, 4000);
  const closeBtn = document.createElement('button');
  closeBtn.innerHTML = '✕';
  closeBtn.style.cssText = 'background:none;border:none;color:inherit;margin-left:10px;cursor:pointer;font-size:16px;';
  closeBtn.onclick = () => n.remove();
  n.appendChild(closeBtn);
}

function formatNumber(num) {
  if (num === null || num === undefined || isNaN(num)) return '0';
  const rounded = Math.round(num);
  return rounded.toLocaleString('en-US');
}

function orderIdentity(order) {
  return `${order._source || 'basic'}:${order.id || order._id}`;
}

function instagramItemsSummary(items) {
  return (items || []).map(item => `${item.product_name} — ${item.color} / ${item.size} × ${Number(item.quantity)}`).join('، ') || '-';
}

// ==================== البحث والفلترة ====================
function filterOrdersBySearch(orders, searchText) {
  if (!searchText || !searchText.trim()) return orders;
  const searchLower = searchText.trim().toLowerCase();
  return orders.filter(order => {
    return (
      String(order.order_number || order.orderNumber || '').toLowerCase().includes(searchLower) ||
      String(order.customer_name || order.customerName || '').toLowerCase().includes(searchLower) ||
      String(order.customer_number || order.customerNumber || '').toLowerCase().includes(searchLower) ||
      String(order.address || '').toLowerCase().includes(searchLower) ||
      String(order.note || '').toLowerCase().includes(searchLower)
    );
  });
}

function applyFiltersAndRender() {
  let filtered = allOrders.length ? [...allOrders] : [];
  const searchInput = document.getElementById('searchInput');
  if (searchInput) {
    filtered = filterOrdersBySearch(filtered, searchInput.value);
  }
  const statusSelect = document.getElementById('filterStatus');
  if (statusSelect && statusSelect.value) {
    const selectedStatus = statusSelect.value;
    filtered = filtered.filter(order => order.status === selectedStatus || (selectedStatus === 'إلغاء' && order.status === 'ملغي'));
  }
  renderTable(filtered);
}

// ==================== التخزين والعمل دون إنترنت ====================
function applyPendingUpdates(orders, pendingUpdates) {
  if (!pendingUpdates.length) return orders;

  const pendingByOrderId = new Map(
    pendingUpdates.map(update => [String(update.orderId), update])
  );

  return orders.map(order => {
    if (order._source === 'instagram') return order;
    const orderId = String(order.id || order._id);
    const pending = pendingByOrderId.get(orderId);
    if (!pending) return order;

    return {
      ...order,
      status: pending.status,
      note: pending.note,
      _offlinePending: true
    };
  });
}

async function saveCurrentOrders() {
  if (!offlineStore) return;

  try {
    await offlineStore.saveSnapshot(driverOfflineScope, allOrders);
  } catch (error) {
    console.warn('تعذر حفظ الطلبات محلياً:', error);
  }
}

async function restoreCachedOrders(showMessage = false) {
  if (!offlineStore) return false;

  try {
    const snapshot = await offlineStore.getSnapshot(driverOfflineScope);
    if (!snapshot || !Array.isArray(snapshot.orders)) return false;

    const pendingUpdates = await offlineStore.getPendingUpdates(driverOfflineScope);
    allOrders = applyPendingUpdates(snapshot.orders, pendingUpdates);
    previousOrderIds = new Set(allOrders.map(orderIdentity));
    applyFiltersAndRender();

    const savedAt = snapshot.updatedAt ? new Date(snapshot.updatedAt) : null;
    const savedTime = savedAt && !isNaN(savedAt.getTime())
      ? savedAt.toLocaleTimeString('ar')
      : '-';
    const lastUpdate = document.getElementById('lastUpdateTime');
    if (lastUpdate) lastUpdate.textContent = `نسخة محفوظة: ${savedTime}`;

    if (showMessage) {
      showNotification('📦 تم عرض آخر نسخة محفوظة من الطلبات.', 'warning');
    }
    return true;
  } catch (error) {
    console.warn('تعذر قراءة الطلبات المحفوظة:', error);
    return false;
  }
}

async function queueOrderUpdate(orderId, status, note) {
  if (!offlineStore) throw new Error('التخزين المحلي غير متاح');

  await offlineStore.queueUpdate(driverOfflineScope, {
    orderId,
    status,
    note
  });
}

async function syncPendingUpdates() {
  if (!offlineStore || !navigator.onLine || isSyncingPendingUpdates) return;

  isSyncingPendingUpdates = true;
  let syncedCount = 0;
  let rejectedCount = 0;

  try {
    const pendingUpdates = await offlineStore.getPendingUpdates(driverOfflineScope);

    for (const update of pendingUpdates) {
      try {
        const response = await apiFetch(`/api/orders/${update.orderId}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify({ status: update.status, note: update.note })
        });

        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          const error = new Error(data.message || 'فشل إرسال التعديل المحفوظ');
          error.isPermanent = response.status >= 400 && response.status < 500;
          throw error;
        }

        await offlineStore.removePendingUpdate(update.key);
        syncedCount += 1;
      } catch (error) {
        if (error.isPermanent) {
          await offlineStore.removePendingUpdate(update.key);
          rejectedCount += 1;
          continue;
        }

        break;
      }
    }

    if (syncedCount > 0) {
      showNotification(`✅ تم إرسال ${syncedCount} تعديل محفوظ.`, 'success');
    }
    if (rejectedCount > 0) {
      showNotification(`⚠️ تعذر اعتماد ${rejectedCount} تعديل لأن حالة الطلب تغيرت على الخادم.`, 'warning');
    }
  } catch (error) {
    console.warn('تعذرت مزامنة التعديلات:', error);
  } finally {
    isSyncingPendingUpdates = false;
  }
}

// ==================== جلب الطلبات ====================
async function fetchOrders() {
  if (ordersFetchController) ordersFetchController.abort();
  ordersFetchController = new AbortController();
  isFetchingOrders = true;

  try {
    const savedStatus = document.getElementById('filterStatus')?.value || '';
    const savedSearch = document.getElementById('searchInput')?.value || '';

    if (!navigator.onLine) {
      if (!allOrders.length) await restoreCachedOrders();
      const lastUpdate = document.getElementById('lastUpdateTime');
      if (lastUpdate && !lastUpdate.textContent) lastUpdate.textContent = 'غير متصل - بيانات محفوظة';
      return;
    }

    const basicParams = new URLSearchParams();
    const instagramParams = new URLSearchParams({ all: '1' });
    if (savedStatus) {
      basicParams.set('status', savedStatus);
      instagramParams.set('status', savedStatus === 'إلغاء' ? 'ملغي' : savedStatus);
    }
    if (savedSearch.trim()) {
      basicParams.set('search', savedSearch.trim());
      instagramParams.set('search', savedSearch.trim());
    }

    const [basicResponse, instagramResponse] = await Promise.all([
      apiFetch(`/api/orders?${basicParams}`, {
        headers: { 'Authorization': `Bearer ${token}` },
        signal: ordersFetchController.signal
      }),
      apiFetch(`/api/instagram-orders?${instagramParams}`, { signal: ordersFetchController.signal })
    ]);
    if (!basicResponse.ok || !instagramResponse.ok) throw new Error('فشل جلب قائمة الطلبات الموحدة');

    const [basicData, instagramData] = await Promise.all([basicResponse.json(), instagramResponse.json()]);
    const basicOrders = (Array.isArray(basicData) ? basicData : (basicData.orders || [])).map(order => ({ ...order, _source: 'basic' }));
    const instagramOrders = (instagramData.orders || []).map(order => ({
      ...order,
      _source: 'instagram',
      customer_number: order.customer_phone,
      order_contents: instagramItemsSummary(order.items),
      price: 0,
      ratio: 0,
      currency: 'ل.س'
    }));
    const orders = [...basicOrders, ...instagramOrders].sort((left, right) => {
      const leftDate = new Date(left.created_at || left.createdAt || 0).getTime();
      const rightDate = new Date(right.created_at || right.createdAt || 0).getTime();
      return rightDate - leftDate;
    });
    const pendingUpdates = offlineStore
      ? await offlineStore.getPendingUpdates(driverOfflineScope)
      : [];
    const ordersWithPendingChanges = applyPendingUpdates(orders, pendingUpdates);

    const newOrders = orders.filter(order => !previousOrderIds.has(orderIdentity(order)));
    if (newOrders.length > 0 && previousOrderIds.size > 0) {
      newOrders.forEach(order => {
        showNotification(`🚚 طلب جديد #${order.order_number || order.orderNumber}`, 'success');
        notificationSound.play().catch(() => {});
      });
    }
    previousOrderIds = new Set(orders.map(orderIdentity));

    allOrders = ordersWithPendingChanges;
    applyFiltersAndRender();
    await saveCurrentOrders();

    const elStatus = document.getElementById('filterStatus');
    const elSearch = document.getElementById('searchInput');
    if (elStatus && elStatus.value !== savedStatus) elStatus.value = savedStatus;
    if (elSearch && elSearch.value !== savedSearch) elSearch.value = savedSearch;

    document.getElementById('lastUpdateTime').textContent = `آخر تحديث: ${new Date().toLocaleTimeString('ar')}`;
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error('fetchOrders error:', err);
    if (!allOrders.length) await restoreCachedOrders(true);
    const lastUpdate = document.getElementById('lastUpdateTime');
    if (lastUpdate && allOrders.length) lastUpdate.textContent = 'غير متصل - آخر نسخة محفوظة';
  } finally {
    isFetchingOrders = false;
  }
}

function startHeartbeat() {
  if (heartbeatInterval) return;
  heartbeatInterval = setInterval(async () => {
    if (navigator.onLine) {
      try {
        await apiFetch('/api/auth/heartbeat', {
          method: 'PATCH',
          headers: { 'Authorization': `Bearer ${token}` }
        });
      } catch (e) { /* فشل صامت */ }
    }
  }, 25000);
}

// ==================== عرض الجدول ====================
function renderTable(orders) {
  const tbody = document.getElementById('ordersTableBody');
  if (!tbody) return;
  tbody.innerHTML = '';
  let totalSYR = 0, totalUSD = 0, totalRatio = 0;

  orders.forEach((order, index) => {
    const isInstagram = order._source === 'instagram';
    const price = Number(order.price) || 0;
    if (isInstagram) {
      // طلب إنستغرام لا يحتوي سعراً أو نسبة في نموذج هذه القناة.
    } else if (order.currency === 'دولار') {
      totalUSD += price;
    } else {
      totalSYR += price;
    }
    totalRatio += Number(order.ratio) || 0;

    const tr = document.createElement('tr');
    const orderId = order.id || order._id;
    const orderNumber = order.order_number || order.orderNumber;
    const customerName = order.customer_name || order.customerName;
    const customerNumber = order.customer_number || order.customerNumber;
    const address = order.address;
    const priceVal = order.price;
    const currency = order.currency || 'ل.س';
    const ratio = order.ratio || 0;
    const status = order.status;
    const note = order.note;
    const createdAt = order.created_at || order.createdAt;
    const pendingSyncLabel = order._offlinePending
      ? '<small class="pending-sync-label">بانتظار المزامنة</small>'
      : '';
    const canEdit = isInstagram
      ? ['قيد المتابعة', 'مؤجل'].includes(status)
      : status === 'قيد المتابعة';
    const editButton = canEdit
      ? `<button class="btn btn-sm btn-primary" onclick='openEditModal("${orderId}")'>تعديل</button>`
      : '<span style="color:#999;">—</span>';

    tr.innerHTML = `
      <td data-label="عداد الطلبات :">${index + 1}</td>
      <td data-label="المصدر :"><span class="order-source-badge ${isInstagram ? 'order-source-instagram' : 'order-source-basic'}">${isInstagram ? 'إنستغرام' : 'أساسي'}</span></td>
      <td data-label="رقم الطلب :">${orderNumber}</td>
      <td class="text-wrap-column" data-label="محتويات الطلب :">${order.order_contents || order.orderContents || '-'}</td>
      <td data-label="اسم العميل :">${customerName}</td>
      <td data-label="رقم العميل :">${customerNumber ? `<a href="tel:${customerNumber}">${customerNumber}</a>` : '-'}</td>
      <td data-label="العنوان :">${address}</td>
      <td data-label="السعر :">${isInstagram ? '—' : `${formatNumber(priceVal)} ${currency}`}</td>
      <td data-label="النسبة :">${isInstagram ? '—' : formatNumber(ratio)}</td>
      <td data-label="الحالة :"><span class="status-badge status-${status}">${status}</span>${pendingSyncLabel}</td>
      <td data-label="الشركة :">${order.company_name || order.companyName || '-'}</td> 
      <td class="text-wrap-column" data-label="ملاحظة :">${note || '-'}</td>
      <td data-label="التاريخ :">${formatDate(createdAt)}</td>
      <td data-label="إجراء :">${editButton}</td>
    `;
    tbody.appendChild(tr);
  });

  document.getElementById('totalPriceSYR').textContent = formatNumber(totalSYR) + ' ل.س';
  document.getElementById('totalPriceUSD').textContent = formatNumber(totalUSD) + ' $';
  document.getElementById('totalRatioSum').textContent = formatNumber(totalRatio);
}

// ==================== تعديل الحالة ====================
async function openEditModal(orderId) {
  const localOrder = allOrders.find(o => String(o.id || o._id) === String(orderId));
  
  let order = null;
  let usedLocal = false;

  if (navigator.onLine && localOrder?._source !== 'instagram') {
    try {
      const res = await apiFetch(`/api/orders/${orderId}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        order = await res.json();
      }
    } catch (e) {
      console.warn('تعذر جلب البيانات من الخادم');
    }
  }

  if (!order) {
    if (localOrder) {
      order = localOrder;
      usedLocal = true;
    } else {
      alert('❌ الطلب غير موجود في البيانات المحلية. يرجى الاتصال بالإنترنت وتحديث الصفحة.');
      return;
    }
  }

  order._source = localOrder?._source || 'basic';

  if (order._source === 'instagram' && !navigator.onLine) {
    showNotification('يلزم الاتصال بالإنترنت لتحديث طلب إنستغرام.', 'warning');
    return;
  }

  document.getElementById('editOrderId').value = order.id || order._id;
  document.getElementById('editOrderSource').value = order._source;
  const statusSelect = document.getElementById('editStatus');
  const statuses = order._source === 'instagram'
    ? ['تم', 'مؤجل', 'مرتجع', 'ملغي']
    : ['تم', 'مؤجل', 'مرتجع', 'إلغاء'];
  statusSelect.innerHTML = statuses.map(status => `<option value="${status}">${status}</option>`).join('');
  statusSelect.value = statuses.includes(order.status) ? order.status : statuses[0];
  document.getElementById('editNote').value = order.note || '';
  document.getElementById('editNote').readOnly = order._source === 'instagram';
  document.getElementById('editNoteHint').textContent = order._source === 'instagram' ? 'ملاحظة طلب إنستغرام للعرض فقط؛ يمكن للسائق تغيير الحالة.' : '';
  statusSelect.disabled = order._source === 'instagram'
    ? !['قيد المتابعة', 'مؤجل'].includes(order.status)
    : order.status !== 'قيد المتابعة';
  document.getElementById('editModal').style.display = 'flex';

  if (usedLocal) {
    showNotification('⚠️ أنت غير متصل. البيانات المعروضة قد لا تكون محدثة.', 'warning');
  }
}

function closeModal() {
  document.getElementById('editModal').style.display = 'none';
}

document.getElementById('editOrderForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = document.getElementById('editOrderId').value;
  const source = document.getElementById('editOrderSource').value || 'basic';
  const newStatus = document.getElementById('editStatus').value;
  const newNote = document.getElementById('editNote').value;

  const orderIndex = allOrders.findIndex(o => String(o.id || o._id) === String(id) && (o._source || 'basic') === source);
  if (orderIndex === -1) return;

  if (source === 'instagram') {
    if (!navigator.onLine) return showNotification('يلزم الاتصال بالإنترنت لتحديث طلب إنستغرام.', 'warning');
    try {
      const response = await apiFetch(`/api/instagram-orders/driver-orders/${id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || 'تعذر تحديث طلب إنستغرام');
      allOrders[orderIndex].status = newStatus;
      closeModal();
      applyFiltersAndRender();
      await saveCurrentOrders();
      showNotification('تم تحديث طلب إنستغرام', 'success');
    } catch (error) {
      showNotification(`❌ ${error.message}`, 'error');
    }
    return;
  }

  const originalOrder = { ...allOrders[orderIndex] };

  // تحديث الواجهة والنسخة المحلية فوراً.
  allOrders[orderIndex].status = newStatus;
  allOrders[orderIndex].note = newNote;
  allOrders[orderIndex]._offlinePending = !navigator.onLine;
  applyFiltersAndRender();
  await saveCurrentOrders();
  closeModal();

  if (!navigator.onLine) {
    try {
      await queueOrderUpdate(id, newStatus, newNote);
      showNotification('📥 تم حفظ التعديل على الجهاز وسيُرسل عند عودة الإنترنت.', 'warning');
    } catch (error) {
      allOrders[orderIndex] = originalOrder;
      applyFiltersAndRender();
      await saveCurrentOrders();
      showNotification('❌ تعذر حفظ التعديل على الجهاز.', 'error');
    }
    return;
  }

  try {
    const res = await apiFetch(`/api/orders/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ status: newStatus, note: newNote })
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      const error = new Error(data.message || 'فشل التحديث');
      error.isPermanent = res.status >= 400 && res.status < 500;
      throw error;
    }

    delete allOrders[orderIndex]._offlinePending;
    await saveCurrentOrders();
    showNotification('تم تحديث الطلب', 'success');
  } catch (err) {
    if (err.isPermanent) {
      allOrders[orderIndex] = originalOrder;
      applyFiltersAndRender();
      await saveCurrentOrders();
      showNotification(`❌ ${err.message}`, 'error');
      return;
    }

    try {
      allOrders[orderIndex]._offlinePending = true;
      await queueOrderUpdate(id, newStatus, newNote);
      await saveCurrentOrders();
      showNotification('📥 تعذر الاتصال، تم حفظ التعديل وسيُرسل تلقائياً.', 'warning');
    } catch (storageError) {
      allOrders[orderIndex] = originalOrder;
      applyFiltersAndRender();
      await saveCurrentOrders();
      showNotification('❌ تعذر الاتصال ولم نتمكن من حفظ التعديل محلياً.', 'error');
    }
  }
});

// offline notification
function updateOnlineStatus() {
  const offlineBar = document.getElementById('offlineBar');
  if (!navigator.onLine) {
    if (!offlineBar) {
      const bar = document.createElement('div');
      bar.id = 'offlineBar';
      bar.style.cssText = 'background:#f39c12; color:white; text-align:center; padding:8px; margin-bottom:10px; border-radius:8px;';
      bar.textContent = '⚠️ أنت غير متصل. الطلبات محفوظة على الجهاز والتعديلات ستُرسل عند عودة الإنترنت.';
      document.querySelector('.dashboard-header').after(bar);
    }
  } else {
    if (offlineBar) offlineBar.remove();
  }
}
window.addEventListener('online', async () => {
  updateOnlineStatus();
  showNotification('🌐 عاد الاتصال بالإنترنت، جاري مزامنة التعديلات...', 'info');
  await syncPendingUpdates();
  await fetchOrders();
});
window.addEventListener('offline', updateOnlineStatus);
document.addEventListener('DOMContentLoaded', updateOnlineStatus);

// ==================== الوضع الليلي ====================
function toggleDarkMode(event) {
  document.body.classList.toggle('dark-mode');
  const isDark = document.body.classList.contains('dark-mode');
  localStorage.setItem('darkMode', isDark);
  const btn = event.currentTarget;
  btn.textContent = isDark ? '☀️' : '🌙';
}

document.addEventListener('DOMContentLoaded', () => {
  if (localStorage.getItem('darkMode') === 'true') {
    document.body.classList.add('dark-mode');
    const btn = document.querySelector('[onclick="toggleDarkMode(event)"]');
    if (btn) btn.textContent = '☀️';
  }
  
  const searchInput = document.getElementById('searchInput');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      clearTimeout(driverSearchTimer);
      driverSearchTimer = setTimeout(fetchOrders, 400);
    });
  }
  startHeartbeat();
  startDriverPolling();
});

// ==================== بدء التطبيق ====================
async function initializeDriverOrders() {
  await restoreCachedOrders(!navigator.onLine);

  if (navigator.onLine) {
    await syncPendingUpdates();
    await fetchOrders();
  }
}

initializeDriverOrders();
