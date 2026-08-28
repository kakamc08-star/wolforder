// ==================== 1. تعريف المتغيرات والاتصال الفوري (WebSocket) أولاً ====================
const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const wsUrl = `${wsProtocol}//${window.location.host}`;

let socket;
let socketReconnectTimer = null;
let socketRefreshTimer = null;
let socketStopped = false;

function connectWebSocket() {
  if (socketStopped || (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING))) return;
  if (socketReconnectTimer) {
    clearTimeout(socketReconnectTimer);
    socketReconnectTimer = null;
  }
  socket = new WebSocket(wsUrl);

  socket.onopen = () => {
    console.log('🟢 تم الاتصال الفوري بالسيرفر بنجاح');
  };

  socket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'ORDER_UPDATED' || data.type === 'ORDER_CREATED' || data.type === 'ORDER_DELETED') {
        clearTimeout(socketRefreshTimer);
        socketRefreshTimer = setTimeout(() => {
          if (typeof fetchOrders === 'function') fetchOrders();
        }, 300);
      }
    } catch (err) {
      console.error('❌ خطأ في قراءة بيانات WebSocket:', err);
    }
  };

  socket.onclose = () => {
    console.log('⚠️ انقطع الاتصال الفوري، جاري المحاولة بعد 5 ثوانٍ...');
    socket = null;
    if (!socketStopped && !socketReconnectTimer) socketReconnectTimer = setTimeout(connectWebSocket, 5000);
  };

  socket.onerror = (error) => {
    console.error('❌ خطأ في الاتصال الفوري:', error);
    socket.close();
  };
}


// ==================== 2. المصادقة والتحقق من الصلاحيات ====================
const token = localStorage.getItem('token');
const userStr = localStorage.getItem('user');

if (!token || !userStr) {
  window.location.href = 'login.html';
}

const user = JSON.parse(userStr);
if (user.role !== 'admin') {
  alert('غير مصرح');
  window.location.href = 'login.html';
}

// عرض اسم المستخدم بعد التأكد من تحميل العناصر أو استخدام DOMContentLoaded
document.addEventListener('DOMContentLoaded', () => {
  const userNameDisplay = document.getElementById('userNameDisplay');
  if (userNameDisplay) {
    userNameDisplay.textContent = user.name || user.username;
  }
});


// ==================== 3. المتغيرات العامة وتشغيل الاتصال ====================
let selectedOrderIds = new Set();
let allOrders = [];
let currentSort = 'default';
let ordersPage = 1;
let ordersTotalPages = 1;
let ordersFetchController = null;
const ORDERS_PAGE_SIZE = 50;

// تشغيل الاتصال الفوري الآن بأمان بعد تعريف المتغيرات والدالة
connectWebSocket();


// ==================== الترقيم الآلي المطور لكل شركة ====================
function getAutoNumberKeyForCompany(companyId) {
  return `autoOrderNumber_company_${companyId || 'no_company'}`;
}

function getAutoToggleKeyForCompany(companyId) {
  return `autoToggle_company_${companyId || 'no_company'}`;
}

function loadAutoOrderNumberForCompany() {
  const companySelect = document.getElementById('companySelect');
  const companyId = companySelect ? companySelect.value : '';
  const input = document.getElementById('orderNumber');
  const manualToggle = document.getElementById('manualOrderToggle');
  
  if (!input) return;

  const toggleKey = getAutoToggleKeyForCompany(companyId);
  const savedMode = localStorage.getItem(toggleKey);
  const isManual = savedMode === null || savedMode === 'true';

  if (manualToggle) manualToggle.checked = isManual;

  if (isManual) {
    input.readOnly = false; // السماح بالكتابة اليدوية الكاملة
    return;
  }

  input.readOnly = true; // قفل الحقل للترقيم الآلي
  const key = getAutoNumberKeyForCompany(companyId);
  const lastNumber = parseInt(localStorage.getItem(key), 10);

  if (!isNaN(lastNumber) && lastNumber > 0) {
    input.value = lastNumber + 1;
  } else {
    input.value = 1; // نقطة بداية افتراضية
  }
}

// تحديد رقم بداية مخصص للشركة
function setCustomStartNumberForCompany() {
  const companySelect = document.getElementById('companySelect');
  const companyId = companySelect ? companySelect.value : '';
  const input = document.getElementById('orderNumber');
  
  if (!input) return;
  
  const customVal = prompt("أدخل رقم البداية الجديد لهذه الشركة:", input.value || "1");
  const num = parseInt(customVal, 10);
  
  if (!isNaN(num) && num > 0) {
    const key = getAutoNumberKeyForCompany(companyId);
    localStorage.setItem(key, num - 1); // نحفظ الرقم السابق لكي يبدأ العد من الرقم المدخل تماماً
    input.value = num;
  }
}

// تبديل وضع الإدخال اليدوي أو الآلي
function toggleManualOrderInput(checkbox) {
  const companySelect = document.getElementById('companySelect');
  const companyId = companySelect ? companySelect.value : '';
  const input = document.getElementById('orderNumber');
  
  if (!input) return;

  const toggleKey = getAutoToggleKeyForCompany(companyId);
  
  if (checkbox.checked) {
    localStorage.setItem(toggleKey, 'true');
    input.readOnly = false;
    input.value = '';
    input.focus();
  } else {
    localStorage.setItem(toggleKey, 'false');
    loadAutoOrderNumberForCompany();
  }
}

// حفظ آخر رقم طلب تم إنشاؤه لتحديث العداد
function saveLastOrderNumberForCompany(companyId, orderNumber) {
  const num = parseInt(orderNumber, 10);
  if (!isNaN(num) && num > 0) {
    const key = getAutoNumberKeyForCompany(companyId);
    localStorage.setItem(key, num);
  }
}

function resetAutoNumber() {
  const companySelect = document.getElementById('companySelect');
  const companyId = companySelect ? companySelect.value : '';
  const key = getAutoNumberKeyForCompany(companyId);
  localStorage.removeItem(key);
  const input = document.getElementById('orderNumber');
  if (input) {
    input.value = '';
    input.focus();
  }
}


// ==================== إدراج المتغيرات في قالب الرسائل ====================
function insertVariable(variable) {
  const textarea = document.getElementById('messageTemplate');
  if (!textarea) return;
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const text = textarea.value;
  textarea.value = text.substring(0, start) + variable + text.substring(end);
  textarea.focus();
  textarea.setSelectionRange(start + variable.length, start + variable.length);
}


// ==================== تهيئة الأحداث عند تحميل الصفحة ====================
document.addEventListener('DOMContentLoaded', () => {
  // ربط تغير الشركة بدالة جلب رقم الطلب الآلي
  const companySelect = document.getElementById('companySelect');
  if (companySelect) {
    companySelect.addEventListener('change', loadAutoOrderNumberForCompany);
    loadAutoOrderNumberForCompany(); // تحميل أولي عند فتح الصفحة
  }

  // حفظ الرقم عند إرسال النموذج بنجاح
  const createOrderForm = document.getElementById('createOrderForm');
  if (createOrderForm) {
    createOrderForm.addEventListener('submit', () => {
      const compSelect = document.getElementById('companySelect');
      const orderNumInput = document.getElementById('orderNumber');
      const manualToggle = document.getElementById('manualOrderToggle');
      
      const compId = compSelect ? compSelect.value : '';
      
      // إذا لم يكن الوضع يدوياً، نقوم بحفظ الرقم الحالي كآخر رقم مستخدم لهذه الشركة
      if (orderNumInput && (!manualToggle || !manualToggle.checked)) {
        saveLastOrderNumberForCompany(compId, orderNumInput.value);
      }
    });
  }
});


// ==================== دوال مساعدة ====================
function setSortAndRender(direction) {
  currentSort = direction;
  ordersPage = 1;
  fetchOrders();
}

function formatDate(date) {
  if (!date) return '-';
  const d = new Date(date);
  if (isNaN(d.getTime())) return '-';
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  return `${day}/${month}/${year}`;
}

function formatNumber(num) {
  if (num === null || num === undefined || isNaN(num)) return '0';
  const rounded = Math.round(num);
  return rounded.toLocaleString('en-US');
}

window.addEventListener('beforeunload', () => {
  socketStopped = true;
  clearTimeout(socketReconnectTimer);
  clearTimeout(socketRefreshTimer);
  if (ordersFetchController) ordersFetchController.abort();
  if (socket) socket.close();
});

function getOrderType(order) {
  return order.order_type || order.orderType || 'توصيل';
}

function getOrderTypeClass(orderType) {
  if (orderType === 'شحن') return 'order-type-shipping';
  if (orderType === 'شحن لباب المنزل') return 'order-type-home-shipping';
  return 'order-type-delivery';
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

function validateCustomerName(name) {
  if (!name || name.trim() === '') return true;
  return /[^\d]/.test(name.trim());
}

function validateCustomerNumber(number) {
  if (!number || number.trim() === '') return true;
  return /^\d{10}$/.test(number.trim());
}

function convertToEnglishDigits(value) {
    return String(value)
        .replace(/[٠-٩]/g, digit => '٠١٢٣٤٥٦٧٨٩'.indexOf(digit))
        .replace(/[۰-۹]/g, digit => '۰۱۲۳۴۵۶۷۸۹'.indexOf(digit))
        .replace(/٫/g, '.')
        .replace(/٬/g, '');
}

document.addEventListener('input', function (event) {
    const input = event.target;

    if (!input.matches('input, textarea')) return;

    const convertedValue = convertToEnglishDigits(input.value);

    if (input.value !== convertedValue) {
        input.value = convertedValue;
    }
});

// ==================== جلب الطلبات ====================
async function fetchOrders() {
  if (ordersFetchController) ordersFetchController.abort();
  ordersFetchController = new AbortController();
  try {
    const savedStatus = document.getElementById('filterStatus')?.value || '';
    const savedStartDateInput = document.getElementById('filterStartDate')?.value || '';
    const savedEndDateInput = document.getElementById('filterEndDate')?.value || '';
    const savedDriverId = document.getElementById('filterDriver')?.value || '';
    const savedCompanyId = document.getElementById('filterCompany')?.value || '';
    const savedOrderType = document.getElementById('filterOrderType')?.value || '';
    const savedSearch = document.getElementById('searchInput')?.value || '';

    let startDate = '';
    let endDate = '';
    if (savedStartDateInput) {
      const localStart = new Date(savedStartDateInput + 'T00:00:00');
      startDate = localStart.toISOString();
    }
    if (savedEndDateInput) {
      const localEnd = new Date(savedEndDateInput + 'T23:59:59');
      endDate = localEnd.toISOString();
    }

    const params = new URLSearchParams({ paginate: '1', page: String(ordersPage), limit: String(ORDERS_PAGE_SIZE) });
    if (savedStatus) params.set('status', savedStatus);
    if (startDate) params.set('startDate', startDate);
    if (endDate) params.set('endDate', endDate);
    if (savedDriverId) params.set('driverId', savedDriverId);
    if (savedCompanyId) params.set('companyId', savedCompanyId);
    if (savedOrderType) params.set('orderType', savedOrderType);
    if (savedSearch.trim()) params.set('search', savedSearch.trim());
    if (currentSort === 'asc' || currentSort === 'desc') params.set('sort', currentSort);

    const res = await apiFetch(`/api/orders?${params}`, {
      headers: { 'Authorization': `Bearer ${token}` },
      signal: ordersFetchController.signal
    });
    if (!res.ok) throw new Error('فشل جلب الطلبات');
    const data = await res.json();
    allOrders = data.orders || [];
    ordersTotalPages = data.pagination?.totalPages || 1;
    if (ordersPage > ordersTotalPages) {
      ordersPage = ordersTotalPages;
      return fetchOrders();
    }
    applyFiltersAndRender();
    updateOrdersPagination(data.pagination || {});

    const elStatus = document.getElementById('filterStatus');
    const elStart = document.getElementById('filterStartDate');
    const elEnd = document.getElementById('filterEndDate');
    const elDriver = document.getElementById('filterDriver');
    const elCompany = document.getElementById('filterCompany');
    const elOrderType = document.getElementById('filterOrderType');
    const elSearch = document.getElementById('searchInput');

    if (elStatus && elStatus.value !== savedStatus) elStatus.value = savedStatus;
    if (elStart && elStart.value !== savedStartDateInput) elStart.value = savedStartDateInput;
    if (elEnd && elEnd.value !== savedEndDateInput) elEnd.value = savedEndDateInput;
    if (elDriver && elDriver.value !== savedDriverId) elDriver.value = savedDriverId;
    if (elCompany && elCompany.value !== savedCompanyId) elCompany.value = savedCompanyId;
    if (elOrderType && elOrderType.value !== savedOrderType) elOrderType.value = savedOrderType;
    if (elSearch && elSearch.value !== savedSearch) elSearch.value = savedSearch;

    document.getElementById('lastUpdateTime').textContent = `آخر تحديث: ${new Date().toLocaleTimeString('ar')}`;
  } catch (err) {
    if (err.name !== 'AbortError') console.error('fetchOrders error:', err);
  }
}

function updateOrdersPagination(pagination) {
  const info = document.getElementById('ordersPageInfo');
  const previous = document.getElementById('ordersPrevPage');
  const next = document.getElementById('ordersNextPage');
  if (info) info.textContent = `صفحة ${pagination.page || ordersPage} من ${pagination.totalPages || ordersTotalPages} — ${pagination.total || 0} طلب`;
  if (previous) previous.disabled = ordersPage <= 1;
  if (next) next.disabled = ordersPage >= ordersTotalPages;
}

function changeOrdersPage(delta) {
  const target = ordersPage + delta;
  if (target < 1 || target > ordersTotalPages) return;
  ordersPage = target;
  selectedOrderIds.clear();
  if (typeof updateBulkControls === 'function') updateBulkControls();
  fetchOrders();
}

function applyFiltersAndRender() {
  let filtered = [...allOrders];
  const searchText = document.getElementById('searchInput')?.value || '';
  filtered = filterOrdersBySearch(filtered, searchText);

  const status = document.getElementById('filterStatus')?.value;
  if (status) {
    filtered = filtered.filter(o => o.status === status);
  }

  const orderType = document.getElementById('filterOrderType')?.value;
  if (orderType) {
    filtered = filtered.filter(o => getOrderType(o) === orderType);
  }

  if (currentSort === 'asc') {
    filtered.sort((a, b) => (a.order_number || '').localeCompare(b.order_number || '', 'ar', { numeric: true }));
  } else if (currentSort === 'desc') {
    filtered.sort((a, b) => (b.order_number || '').localeCompare(a.order_number || '', 'ar', { numeric: true }));
  }
  renderOrdersTable(filtered);
}

function clearFilters() {
  const fields = ['filterStatus', 'filterOrderType', 'filterStartDate', 'filterEndDate', 'filterDriver', 'filterCompany', 'searchInput'];
  fields.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  ordersPage = 1;
  fetchOrders();
}

// ==================== عرض الجدول ====================
function renderOrdersTable(orders) {
  const tbody = document.getElementById('ordersTableBody');
  if (!tbody) return;
  const currentSelected = new Set(selectedOrderIds);
  tbody.innerHTML = '';
  const now = new Date();
  let totalSYR = 0, totalUSD = 0, totalRatio = 0;

  orders.forEach((order, index) => {
    const price = Number(order.price) || 0;
    if (order.currency === 'دولار') {
      totalUSD += price;
    } else {
      totalSYR += price;
    }
    totalRatio += Number(order.ratio) || 0;

    const tr = document.createElement('tr');
    const createdAt = new Date(order.created_at || order.createdAt);
    if ((now - createdAt) < 10000) tr.style.backgroundColor = '#e0f2fe';

    let actionButtons = `<div style="display:flex; gap:8px; flex-wrap:wrap;">`;
    if (!order.driver_id && !order.driver) {
      actionButtons += `<button class="btn btn-sm btn-primary" onclick="showAssignDriverModal('${order.id}')">🚚 تعيين</button>`;
    }
    actionButtons += `<button class="btn btn-sm btn-secondary" onclick="showEditOrderModal('${order.id}')">✏️ تعديل</button>`;
    actionButtons += `<button class="btn btn-sm btn-info" onclick="printOrder('${order.id || order._id}')">🖨️ طباعة</button>`;
    actionButtons += `<button class="btn btn-sm btn-danger" onclick="deleteOrder('${order.id}')">🗑️ حذف</button>`;
    actionButtons += `</div>`;

    const orderId = order.id || order._id;
    const isChecked = currentSelected.has(orderId) ? 'checked' : '';

    tr.innerHTML = `
      <td><input type="checkbox" class="orderCheckbox" value="${orderId}" ${isChecked} onchange="handleCheckboxChange(this)"></td>
      <td data-label="الرقم التسلسلي :">${order.serial_number || order.serialNumber || ''}</td>
      <td data-label="عداد الطلبات :">${((ordersPage - 1) * ORDERS_PAGE_SIZE) + index + 1}</td>
      <td data-label="رقم الطلب :">${order.order_number || order.orderNumber}</td>
      <td data-label="نوع الطلب :"><span class="order-type-badge ${getOrderTypeClass(getOrderType(order))}">${getOrderType(order)}</span></td>
      <td class="text-wrap-column" data-label="محتويات الطلب :">${order.order_contents || '-'}</td>
      <td data-label="اسم العميل :">${order.customer_name || order.customerName}</td>
      <td data-label="رقم العميل :">${order.customer_number ? `<a href="tel:${order.customer_number}">${order.customer_number}</a>` : '-'}</td>
      <td data-label="العنوان :">${order.address}</td>
      <td data-label="السعر :">${formatNumber(order.price)} ${order.currency || 'ل.س'}</td>
      <td data-label="النسبة :">${formatNumber(order.ratio || 0)}</td>
      <td data-label="الحالة :"><span class="status-badge status-${order.status}">${order.status}</span></td>
      <td class="text-wrap-column" data-label="ملاحظة :">${order.note || '-'}</td>
      <td data-label="السائق :">${order.driver_name || order.driverName || '-'}</td>
      <td data-label="الشركة :">${order.company_name || order.companyName || '-'}</td>
      <td data-label="التاريخ :">${formatDate(order.created_at || order.createdAt)}</td>
      <td data-label="">${actionButtons}</td>
    `;
    tbody.appendChild(tr);
  });

  const elSYR = document.getElementById('totalPriceSYR');
  const elUSD = document.getElementById('totalPriceUSD');
  const elRatio = document.getElementById('totalRatioSum');
  if (elSYR) elSYR.textContent = formatNumber(totalSYR) + ' ل.س';
  if (elUSD) elUSD.textContent = formatNumber(totalUSD) + ' $';
  if (elRatio) elRatio.textContent = formatNumber(totalRatio);
}

// ==================== فلترة وبحث ====================
function filterOrdersBySearch(orders, searchText) {
  if (!searchText.trim()) return orders;
  const searchLower = searchText.trim().toLowerCase();
  
  return orders.filter(o => {
    return (
      // 1. رقم الطلب (أساسي)
      (o.order_number && String(o.order_number).toLowerCase().includes(searchLower)) ||
      (o.orderNumber && String(o.orderNumber).toLowerCase().includes(searchLower)) ||
      
      // 2. محتويات الطلب (الإضافة الجديدة)
      (o.order_contents && String(o.order_contents).toLowerCase().includes(searchLower)) ||
      (o.orderContents && String(o.orderContents).toLowerCase().includes(searchLower)) ||

      // 3. نوع الطلب
      getOrderType(o).toLowerCase().includes(searchLower) ||
      
      // 4. اسم العميل
      (o.customer_name && String(o.customer_name).toLowerCase().includes(searchLower)) ||
      (o.customerName && String(o.customerName).toLowerCase().includes(searchLower)) ||
      
      // 5. رقم العميل
      (o.customer_number && String(o.customer_number).toLowerCase().includes(searchLower)) ||
      (o.customerNumber && String(o.customerNumber).toLowerCase().includes(searchLower)) ||
      
      // 6. العنوان
      (o.address && String(o.address).toLowerCase().includes(searchLower)) ||
      
      // 7. الملاحظات
      (o.note && String(o.note).toLowerCase().includes(searchLower))
    );
  });
}

// ==================== حذف طلب ====================
async function deleteOrder(orderId) {
  if (!confirm('هل أنت متأكد من حذف هذا الطلب نهائياً؟')) return;
  try {
    const res = await apiFetch(`/api/orders/${orderId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!res.ok) throw new Error((await res.json()).message);
    showNotification('✅ تم حذف الطلب بنجاح');
    fetchOrders();
  } catch (err) {
    alert('❌ فشل حذف الطلب: ' + err.message);
  }
}

// ==================== إنشاء طلب ====================
const createForm = document.getElementById('createOrderForm');
if (createForm) {
  createForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const customerName = document.getElementById('customerName').value.trim();
    const customerNumber = document.getElementById('customerNumber').value.trim();
    if (!validateCustomerName(customerName)) {
      alert('❌ اسم العميل يجب أن يحتوي على أحرف');
      return;
    }
    if (customerNumber !== '' && !validateCustomerNumber(customerNumber)) {
      alert('❌ رقم العميل يجب أن يتكون من 10 أرقام بالضبط');
      return;
    }
    const price = parseFloat(document.getElementById('price').value);
    const ratio = parseFloat(document.getElementById('ratio').value) || 0;
    const currency = document.getElementById('currency').value;
    if (currency === 'ل.س' && ratio > price) {
      alert('❌ النسبة لا يمكن أن تكون أكبر من السعر');
      return;
    }
    const data = {
      orderNumber: document.getElementById('orderNumber').value,
      orderType: document.getElementById('orderType')?.value || 'توصيل',
      orderContents: document.getElementById('orderContents').value,
      customerName,
      customerNumber,
      address: document.getElementById('address').value,
      price,
      currency,
      ratio,
      driverId: document.getElementById('driverSelect').value || null,
      companyId: document.getElementById('companySelect').value || null
    };
    try {
      const res = await apiFetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify(data)
      });
      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.message || 'فشل الإنشاء');
      }
      const orderNumberInput = document.getElementById('orderNumber');
      const companySelect = document.getElementById('companySelect');
      if (orderNumberInput && companySelect) {
        saveLastOrderNumberForCompany(companySelect.value, orderNumberInput.value);
      }
      createForm.reset();
      fetchOrders();
      showNotification('تم إنشاء الطلب');
    } catch (err) { alert(err.message); }
  });
}

// ==================== تعديل الطلب ====================
let currentEditOrder = null;

async function showEditOrderModal(orderId) {
  try {
    const res = await apiFetch(`/api/orders/${orderId}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!res.ok) throw new Error('فشل جلب بيانات الطلب');
    const order = await res.json();
    currentEditOrder = order;

    document.getElementById('editOrderId').value = order.id;
    document.getElementById('editOrderNumber').value = order.order_number || order.orderNumber;
    document.getElementById('editOrderType').value = order.order_type || order.orderType || 'توصيل';
    document.getElementById('editOrderContents').value = order.order_contents || '';
    document.getElementById('editCustomerNumber').value = order.customer_number || '';
    document.getElementById('editCustomerName').value = order.customer_name || order.customerName;
    document.getElementById('editAddress').value = order.address;
    document.getElementById('editPrice').value = order.price;
    document.getElementById('editCurrency').value = order.currency || 'ل.س';
    document.getElementById('editRatio').value = order.ratio || 0;
    document.getElementById('editStatus').value = order.status;
    document.getElementById('editNote').value = order.note || '';

    await populateEditSelects();

    if (order.driver_id) {
      document.getElementById('editDriverSelect').value = order.driver_id;
    } else {
      document.getElementById('editDriverSelect').value = '';
    }
    if (order.company_id) {
      document.getElementById('editCompanySelect').value = order.company_id;
    } else {
      document.getElementById('editCompanySelect').value = '';
    }

    document.getElementById('editOrderModal').style.display = 'flex';
  } catch (err) {
    alert('خطأ: ' + err.message);
  }
}

function closeEditModal() {
  document.getElementById('editOrderModal').style.display = 'none';
  currentEditOrder = null;
}

async function populateEditSelects() {
  try {
    const driversRes = await apiFetch('/api/online-drivers', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const drivers = driversRes.ok ? await driversRes.json() : [];

    const usersRes = await apiFetch('/api/orders/users-list', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = usersRes.ok ? await usersRes.json() : { companies: [] };
    const companies = data.companies || [];

    const driverSelect = document.getElementById('editDriverSelect');
    const companySelect = document.getElementById('editCompanySelect');

    if (driverSelect) {
      const selectedDriver = driverSelect.value;
      driverSelect.innerHTML = '<option value="">-- بدون سائق --</option>';
      drivers.forEach(d => {
        const onlineStatus = d.online ? '🟢' : '⚫';
        driverSelect.innerHTML += `<option value="${d._id || d.id}">${onlineStatus} ${d.name}</option>`;
      });
      driverSelect.value = selectedDriver;
    }

    if (companySelect) {
      const selectedCompany = companySelect.value;
      companySelect.innerHTML = '<option value="">-- بدون شركة --</option>';
      companies.forEach(c => {
        companySelect.innerHTML += `<option value="${c._id || c.id}">${c.name}</option>`;
      });
      companySelect.value = selectedCompany;
    }
  } catch (err) {
    console.error('فشل تحميل القوائم في نافذة التعديل:', err);
  }
}

const editForm = document.getElementById('editOrderForm');
if (editForm) {
  editForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const orderId = document.getElementById('editOrderId').value;
    const price = parseFloat(document.getElementById('editPrice').value);
    const ratio = parseFloat(document.getElementById('editRatio').value) || 0;
    const currency = document.getElementById('editCurrency').value;

    if (currency === 'ل.س' && ratio > price) {
      alert('❌ النسبة لا يمكن أن تكون أكبر من السعر');
      return;
    }

    const updatedData = {
      orderNumber: document.getElementById('editOrderNumber').value,
      orderType: document.getElementById('editOrderType').value,
      orderContents: document.getElementById('editOrderContents').value,
      customerName: document.getElementById('editCustomerName').value,
      customerNumber: document.getElementById('editCustomerNumber').value.trim(),
      address: document.getElementById('editAddress').value,
      price,
      currency,
      ratio,
      driverId: document.getElementById('editDriverSelect').value || null,
      companyId: document.getElementById('editCompanySelect').value || null,
      status: document.getElementById('editStatus').value,
      note: document.getElementById('editNote').value
    };

    try {
      const res = await apiFetch(`/api/orders/${orderId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify(updatedData)
      });
      if (!res.ok) throw new Error((await res.json()).message);
      closeEditModal();
      fetchOrders();
      showNotification('✅ تم تحديث الطلب بنجاح');
    } catch (err) {
      alert('❌ ' + err.message);
    }
  });
}

// ==================== تعيين سائق ====================
let currentAssignOrder = null;

async function showAssignDriverModal(orderId) {
  document.getElementById('assignOrderId').value = orderId;
  try {
    const orderRes = await apiFetch(`/api/orders/${orderId}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (orderRes.ok) {
      currentAssignOrder = await orderRes.json();
    } else {
      currentAssignOrder = null;
    }

    const res = await apiFetch('/api/online-drivers', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const drivers = await res.json();

    const select = document.getElementById('assignDriverSelect');
    select.innerHTML = '';
    drivers.forEach(d => {
      const status = d.online ? '🟢' : '⚫';
      select.innerHTML += `<option value="${d._id || d.id}">${status} ${d.name}</option>`;
    });

    document.getElementById('assignRatio').value = 0;
    document.getElementById('assignDriverModal').style.display = 'flex';
  } catch (err) {
    alert('خطأ في تحميل السائقين');
  }
}

function closeAssignModal() {
  document.getElementById('assignDriverModal').style.display = 'none';
}

const assignForm = document.getElementById('assignDriverForm');
if (assignForm) {
  assignForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const orderId = document.getElementById('assignOrderId').value;
    const driverId = document.getElementById('assignDriverSelect').value;
    const ratio = parseFloat(document.getElementById('assignRatio').value) || 0;

    if (currentAssignOrder) {
      const price = currentAssignOrder.price;
      const currency = currentAssignOrder.currency || 'ل.س';
      if (currency === 'ل.س' && ratio > price) {
        alert(`❌ النسبة (${ratio}) لا يمكن أن تكون أكبر من السعر (${price} ل.س)`);
        return;
      }
    }

    try {
      const res = await apiFetch(`/api/orders/${orderId}/assign-driver`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ driverId, ratio })
      });
      if (!res.ok) throw new Error((await res.json()).message);
      closeAssignModal();
      fetchOrders();
      showNotification('✅ تم تعيين السائق بنجاح');
    } catch (err) {
      alert('❌ ' + err.message);
    }
  });
}

// ==================== تحميل قوائم المستخدمين ====================
async function loadUsersLists() {
  let drivers = [];
  let allDrivers = [];
  let companies = [];

  try {
    const driversRes = await apiFetch('/api/online-drivers', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    drivers = driversRes.ok ? await driversRes.json() : [];

    const usersRes = await apiFetch('/api/orders/users-list', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const allData = usersRes.ok ? await usersRes.json() : { drivers: [], companies: [] };
    allDrivers = allData.drivers || [];
    companies = allData.companies || [];

    const savedFilterDriver = document.getElementById('filterDriver')?.value || '';
    const savedFilterCompany = document.getElementById('filterCompany')?.value || '';
    const savedReportDriver = document.getElementById('reportDriver')?.value || '';
    const savedReportCompany = document.getElementById('reportCompany')?.value || '';
    const savedDriverSelect = document.getElementById('driverSelect')?.value || '';
    const savedCompanySelect = document.getElementById('companySelect')?.value || '';

    const driverSelect = document.getElementById('driverSelect');
    const reportDriver = document.getElementById('reportDriver');
    const companySelect = document.getElementById('companySelect');
    const reportCompany = document.getElementById('reportCompany');
    const filterDriver = document.getElementById('filterDriver');
    const filterCompany = document.getElementById('filterCompany');

    if (driverSelect) {
      driverSelect.innerHTML = '<option value="">-- بدون سائق --</option>';
      drivers.forEach(d => {
        const onlineStatus = d.online ? '🟢' : '⚫';
        driverSelect.innerHTML += `<option value="${d._id || d.id}">${onlineStatus} ${d.name}</option>`;
      });
    }

    if (reportDriver) {
      reportDriver.innerHTML = '<option value="">الكل</option>';
      allDrivers.forEach(d => { reportDriver.innerHTML += `<option value="${d._id || d.id}">${d.name}</option>`; });
    }

    if (companySelect) {
      companySelect.innerHTML = '<option value="">-- بدون شركة --</option>';
      companies.forEach(c => { companySelect.innerHTML += `<option value="${c._id || c.id}">${c.name}</option>`; });
    }

    if (reportCompany) {
      reportCompany.innerHTML = '<option value="">الكل</option>';
      companies.forEach(c => { reportCompany.innerHTML += `<option value="${c._id || c.id}">${c.name}</option>`; });
    }

    if (filterDriver) {
      filterDriver.innerHTML = '<option value="">الكل</option>';
      allDrivers.forEach(d => { filterDriver.innerHTML += `<option value="${d._id || d.id}">${d.name}</option>`; });
    }

    if (filterCompany) {
      filterCompany.innerHTML = '<option value="">الكل</option>';
      companies.forEach(c => { filterCompany.innerHTML += `<option value="${c._id || c.id}">${c.name}</option>`; });
    }

    if (filterDriver && savedFilterDriver) filterDriver.value = savedFilterDriver;
    if (filterCompany && savedFilterCompany) filterCompany.value = savedFilterCompany;
    if (reportDriver && savedReportDriver) reportDriver.value = savedReportDriver;
    if (reportCompany && savedReportCompany) reportCompany.value = savedReportCompany;
    if (driverSelect && savedDriverSelect) driverSelect.value = savedDriverSelect;
    if (companySelect && savedCompanySelect) companySelect.value = savedCompanySelect;

  } catch (err) {
    console.error('خطأ في loadUsersLists:', err);
  }

  const bulkDriver = document.getElementById('bulkDriverValue');
  const bulkCompany = document.getElementById('bulkCompanyValue');
  if (bulkDriver) {
    bulkDriver.innerHTML = '<option value="">-- اختر سائق --</option>';
    allDrivers.forEach(d => {
      bulkDriver.innerHTML += `<option value="${d._id || d.id}">${d.name}</option>`;
    });
  }
  if (bulkCompany) {
    bulkCompany.innerHTML = '<option value="">-- اختر شركة --</option>';
    companies.forEach(c => {
      bulkCompany.innerHTML += `<option value="${c._id || c.id}">${c.name}</option>`;
    });
  }
}

// ==================== التقارير ====================
async function generateReport() {
  const status = document.getElementById('reportStatus').value;
  const driverId = document.getElementById('reportDriver').value;
  const companyId = document.getElementById('reportCompany').value;
  const startDate = document.getElementById('reportStartDate').value;
  const endDate = document.getElementById('reportEndDate').value;

  let url = '/api/orders/report?';
  if (status) url += `status=${status}&`;
  if (driverId) url += `driverId=${driverId}&`;
  if (companyId) url += `companyId=${companyId}&`;
  if (startDate) url += `startDate=${startDate}&`;
  if (endDate) url += `endDate=${endDate}&`;

  try {
    const res = await apiFetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
    if (!res.ok) throw new Error('فشل جلب التقرير');
    const data = await res.json();

    document.getElementById('totalCount').textContent = data.count || 0;
    document.getElementById('totalPriceSYR_report').textContent = (data.totalSYR ? formatNumber(data.totalSYR) : '0') + ' ل.س';
    document.getElementById('totalPriceUSD_report').textContent = (data.totalUSD ? formatNumber(data.totalUSD) : '0') + ' $';
    document.getElementById('totalRatioAll').textContent = formatNumber(data.totalRatio || 0);

    const tbody = document.getElementById('reportTableBody');
    tbody.innerHTML = '';
    data.orders.forEach((o, index) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${o.serial_number || o.serialNumber}</td>
        <td>${index + 1}</td>
        <td>${o.order_number || o.orderNumber}</td>
        <td class="text-wrap-column">${o.order_contents || '-'}</td>
        <td>${o.customer_name || o.customerName}</td>
        <td>${o.customer_number ? `<a href="tel:${o.customer_number}">${o.customer_number}</a>` : '-'}</td>
        <td>${formatNumber(o.price)} ${o.currency || 'ل.س'}</td>
        <td>${formatNumber(o.ratio || 0)}</td>
        <td>${o.status}</td>
        <td class="text-wrap-column">${o.note || '-'}</td>
        <td>${o.driver_name || o.driverName || '-'}</td>
        <td>${o.company_name || o.companyName || '-'}</td>
      `;
      tbody.appendChild(tr);
    });
  } catch (err) {
    console.error(err);
    alert('❌ خطأ في عرض التقرير');
  }
}

async function exportReport() {
  const status = document.getElementById('reportStatus').value;
  const driverId = document.getElementById('reportDriver').value;
  const companyId = document.getElementById('reportCompany').value;

  // بناء URL لجلب البيانات كـ JSON (بدون export=excel)
  let url = '/api/orders/report?';
  if (status) url += `status=${status}&`;
  if (driverId) url += `driverId=${driverId}&`;
  if (companyId) url += `companyId=${companyId}&`;

  try {
    const res = await apiFetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
    if (!res.ok) throw new Error('فشل جلب البيانات للتصدير');
    const data = await res.json();
    const orders = data.orders || [];

    if (orders.length === 0) {
      alert('لا توجد بيانات للتصدير');
      return;
    }

    // أسماء الأعمدة (بنفس ترتيب العينة)
    const headers = ['الرقم التسلسلي', 'رقم الطلب', 'محتويات الطلب', 'اسم العميل', 'رقم العميل', 'العنوان', 'السعر', 'النسبة', 'الحالة', 'ملاحظة', 'السائق', 'الشركة', 'التاريخ'];

    // بناء صفوف البيانات
    const rows = orders.map((o, index) => {
      const serial = o.serial_number || o.serialNumber || '';
      const orderNumber = o.order_number || o.orderNumber || '';
      const contents = o.order_contents || o.orderContents || '';
      const customerName = o.customer_name || o.customerName || '';
      const customerNumber = o.customer_number || o.customerNumber || '';
      const address = o.address || '';
      const price = formatNumber(o.price) || '0';
      const ratio = formatNumber(o.ratio || 0) || '0';
      const statusVal = o.status || '';
      const note = o.note || '';
      const driver = o.driver_name || o.driverName || '';
      const company = o.company_name || o.companyName || '';
      const date = formatDate(o.created_at || o.createdAt) || '';
      return [serial, orderNumber, contents, customerName, customerNumber, address, price, ratio, statusVal, note, driver, company, date];
    });

    // دالة لتنسيق الحقل لـ CSV (بين علامات اقتباس، وتضاعف علامات الاقتباس الداخلية)
    function escapeCsvField(field) {
      if (field === null || field === undefined) return '""';
      const str = String(field);
      // نضع كل الحقول بين علامات اقتباس لتجنب مشاكل الفواصل والفواصل المنقوطة
      return '"' + str.replace(/"/g, '""') + '"';
    }

    // إنشاء المحتوى النهائي
    const headerRow = headers.map(h => escapeCsvField(h)).join(';');
    const dataRows = rows.map(row => row.map(field => escapeCsvField(field)).join(';'));
    const csvContent = [headerRow, ...dataRows].join('\n');

    // إضافة BOM (علامة ترتيب البايت) لدعم الترميز العربي
    const blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' });

    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `تقرير_الطلبات_${formatDate(new Date()).replace(/\//g, '-')}.csv`;
    a.click();
    showNotification('✅ تم تصدير التقرير بنجاح');
  } catch (err) {
    alert('❌ خطأ في تصدير التقرير: ' + err.message);
  }
}

// ==================== طلبات التعديل ====================
async function fetchEditRequests() {
  try {
    const res = await apiFetch('/api/edit-requests/pending', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const requests = await res.json();
    renderEditRequests(requests);
  } catch (err) {
    console.error('fetchEditRequests error:', err);
  }
}

function renderEditRequests(requests) {
  const container = document.getElementById('editRequestsContainer');
  if (!container) return;
  if (requests.length === 0) {
    container.innerHTML = '<p>لا توجد طلبات تعديل معلقة</p>';
    return;
  }
  container.innerHTML = requests.map(req => {
    const orderNumber = req.order?.order_number || 'غير معروف';
    return `
      <div class="request-card" style="border:1px solid #ddd; padding:15px; margin-bottom:10px;">
        <strong>${req.company_name}</strong> يطلب تعديل الطلب #${orderNumber}<br>
        التغييرات المطلوبة:<br>
        ${Object.entries(req.requested_changes).map(([k, v]) => `<span>${k}: ${v}</span>`).join(' | ')}
        <div style="margin-top:10px;">
          <button class="btn btn-sm btn-success" onclick="acceptEditRequest('${req.id}')">قبول</button>
          <button class="btn btn-sm btn-danger" onclick="rejectEditRequest('${req.id}')">رفض</button>
        </div>
      </div>
    `;
  }).join('');
}

async function acceptEditRequest(id) {
  try {
    const res = await apiFetch(`/api/edit-requests/${id}/accept`, {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!res.ok) throw new Error('فشل القبول');
    fetchEditRequests();
    fetchOrders();
    showNotification('✅ تم قبول طلب التعديل');
  } catch (err) {
    alert(err.message);
  }
}

async function rejectEditRequest(id) {
  const note = prompt('سبب الرفض (اختياري):');
  try {
    const res = await apiFetch(`/api/edit-requests/${id}/reject`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ note })
    });
    if (!res.ok) throw new Error('فشل الرفض');
    fetchEditRequests();
    showNotification('تم رفض الطلب');
  } catch (err) {
    alert(err.message);
  }
}

// ==================== إعدادات المدير ====================
async function loadAdminPhone() {
  try {
    const res = await apiFetch('/api/auth/me', { headers: { 'Authorization': `Bearer ${token}` } });
    if (res.ok) {
      const user = await res.json();
      const phoneInput = document.getElementById('adminPhone');
      if (phoneInput) phoneInput.value = user.phone || '';
    }
  } catch (err) { console.error('فشل تحميل رقم المدير', err); }
}

async function loadMessageTemplate() {
  try {
    const res = await apiFetch('/api/auth/message-template', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (res.ok) {
      const data = await res.json();
      const textarea = document.getElementById('messageTemplate');
      if (textarea) textarea.value = data.template || '';
    }
  } catch (err) { console.error('فشل تحميل القالب', err); }
}

async function saveMessageTemplate() {
  const template = document.getElementById('messageTemplate')?.value || '';
  try {
    const res = await apiFetch('/api/auth/message-template', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ template })
    });
    if (res.ok) {
      showNotification('✅ تم حفظ القالب', 'success');
    }
  } catch (err) { console.error('فشل حفظ القالب', err); }
}

const settingsForm = document.getElementById('adminSettingsForm');
if (settingsForm) {
  settingsForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const phone = document.getElementById('adminPhone').value.trim();
    const msgDiv = document.getElementById('settingsMessage');
    msgDiv.innerHTML = '<div class="loading"></div> جاري الحفظ...';
    try {
      await apiFetch('/api/auth/update-phone', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ phone })
      });
      await saveMessageTemplate();
      msgDiv.textContent = '✅ تم حفظ الإعدادات بنجاح';
      msgDiv.classList.add('success');
    } catch (err) {
      msgDiv.textContent = '❌ ' + err.message;
      msgDiv.classList.add('error');
    }
  });
}

// ==================== إضافة مستخدم ====================
const userForm = document.getElementById('createUserForm');
if (userForm) {
  userForm.addEventListener('submit', async function(e) {
    e.preventDefault();
    const username = document.getElementById('newUsername').value.trim();
    const password = document.getElementById('newPassword').value;
    const name = document.getElementById('newName').value.trim();
    const role = document.getElementById('newRole').value;
    const msgDiv = document.getElementById('userMessage');
    msgDiv.innerHTML = '<div class="loading"></div> جاري الإنشاء...';
    try {
      const response = await apiFetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, role, name })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'فشل إنشاء الحساب');
      msgDiv.textContent = '✅ ' + data.message;
      msgDiv.classList.add('success');
      userForm.reset();
      loadUsersLists();
    } catch (error) {
      msgDiv.textContent = '❌ ' + error.message;
      msgDiv.classList.add('error');
    }
  });
}


// ==================== تهيئة الصفحة ====================
let searchTimeout;

document.addEventListener('DOMContentLoaded', function() {
  const searchInput = document.getElementById('searchInput');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => {
        ordersPage = 1;
        fetchOrders();
      }, 400);
    });
  }

  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');
  const formattedDate = `${yyyy}-${mm}-${dd}`;
  const startDateInput = document.getElementById('filterStartDate');
  const endDateInput = document.getElementById('filterEndDate');
  if (startDateInput) startDateInput.value = formattedDate;
  if (endDateInput) endDateInput.value = formattedDate;

  const companySelect = document.getElementById('companySelect');
  if (companySelect) {
    companySelect.addEventListener('change', loadAutoOrderNumberForCompany);
    loadAutoOrderNumberForCompany();
  }

  document.getElementById('ordersPrevPage')?.addEventListener('click', () => changeOrdersPage(-1));
  document.getElementById('ordersNextPage')?.addEventListener('click', () => changeOrdersPage(1));
});


// ==================== إدارة المستخدمين ====================
async function loadUsersListForManagement() {
  try {
    const res = await apiFetch('/api/auth/users', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const users = await res.json();
    renderUsersTable(users);
  } catch (err) {
    console.error('فشل تحميل المستخدمين', err);
  }
}

function updateOnlineStatus() {
  const offlineBar = document.getElementById('offlineBar');
  if (!navigator.onLine) {
    if (!offlineBar) {
      const bar = document.createElement('div');
      bar.id = 'offlineBar';
      bar.style.cssText = 'background:#f39c12; color:white; text-align:center; padding:8px; margin-bottom:10px; border-radius:8px;';
      bar.textContent = '⚠️ أنت غير متصل بالإنترنت. التغييرات ستحفظ لاحقاً.';
      document.querySelector('.dashboard-header').after(bar);
    }
  } else {
    if (offlineBar) offlineBar.remove();
  }
}
window.addEventListener('online', updateOnlineStatus);
window.addEventListener('offline', updateOnlineStatus);
document.addEventListener('DOMContentLoaded', updateOnlineStatus);

document.addEventListener('DOMContentLoaded', () => {
  if (localStorage.getItem('darkMode') === 'true') {
    document.body.classList.add('dark-mode');
    const btn = document.querySelector('[onclick="toggleDarkMode()"]');
    if (btn) btn.textContent = '☀️';
  }
});

function renderUsersTable(users) {
  const tbody = document.getElementById('usersTableBody');
  if (!tbody) return;
  tbody.innerHTML = '';
  users.forEach(u => {
    const deleteButton = u.role !== 'admin'
      ? `<button class="btn btn-sm btn-danger" onclick="deleteUser('${u.id}')">🗑️ حذف</button>`
      : '<span style="color:#999;">—</span>';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td data-label="اسم المستخدم :">${u.username}</td>
      <td data-label="الاسم الكامل :">${u.name}</td>
      <td data-label="الدور :">${u.role === 'driver' ? 'سائق' : (u.role === 'company' ? 'شركة' : 'مدير')}</td>
      <td>${deleteButton}</td>
    `;
    tbody.appendChild(tr);
  });
}

async function deleteUser(userId) {
  if (!confirm('هل أنت متأكد من حذف هذا المستخدم؟ ستظل الطلبات المرتبطة به موجودة.')) return;
  try {
    const res = await apiFetch(`/api/auth/users/${userId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.message);
    }
    showNotification('✅ تم حذف المستخدم بنجاح');
    loadUsersListForManagement();
    loadUsersLists();
  } catch (err) {
    alert('❌ ' + err.message);
  }
}

// ==================== Bulk Edit ====================
function handleCheckboxChange(checkbox) {
  const orderId = checkbox.value;
  if (checkbox.checked) {
    selectedOrderIds.add(orderId);
  } else {
    selectedOrderIds.delete(orderId);
  }
  updateBulkControls();
}

function toggleSelectAll() {
  const selectAll = document.getElementById('selectAllCheckbox');
  const isChecked = selectAll.checked;
  document.querySelectorAll('.orderCheckbox').forEach(cb => {
    cb.checked = isChecked;
    if (isChecked) {
      selectedOrderIds.add(cb.value);
    } else {
      selectedOrderIds.delete(cb.value);
    }
  });
  updateBulkControls();
}

function updateBulkControls() {
  const checked = document.querySelectorAll('.orderCheckbox:checked');
  const count = checked.length;
  const controls = document.getElementById('bulkEditControls');
  const selectedCount = document.getElementById('selectedCount');
  if (count > 0) {
    controls.style.display = 'flex';
    selectedCount.textContent = `تم تحديد ${count} طلبات`;
  } else {
    controls.style.display = 'none';
  }
}

document.getElementById('bulkAction').addEventListener('change', function() {
  const action = this.value;
  document.getElementById('bulkStatusValue').style.display = (action === 'status') ? 'inline-block' : 'none';
  document.getElementById('bulkDriverValue').style.display = (action === 'driver') ? 'inline-block' : 'none';
  document.getElementById('bulkCompanyValue').style.display = (action === 'company') ? 'inline-block' : 'none';
});

async function applyBulkEdit() {
  const action = document.getElementById('bulkAction').value;
  if (!action) { alert('اختر إجراءً'); return; }

  const checked = document.querySelectorAll('.orderCheckbox:checked');
  const ids = Array.from(checked).map(cb => cb.value);
  if (ids.length === 0) { alert('لم يتم تحديد أي طلب'); return; }

  // --- إجراء الواتساب ---
  if (action === 'whatsapp') {
    sendBulkWhatsApp();
    return;
  }

  // --- إجراء الطباعة ---
  if (action === 'print') {
    printSelectedOrders();
    return;
  }

  // --- إجراء الحذف ---
  if (action === 'delete') {
    if (!confirm(`⚠️ هل أنت متأكد من حذف ${ids.length} طلبات نهائياً؟ لا يمكن التراجع عن هذا الإجراء.`)) return;
    let successCount = 0, failCount = 0;
    for (const id of ids) {
      try {
        const res = await apiFetch(`/api/orders/${id}`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` } });
        if (res.ok) successCount++; else failCount++;
      } catch (e) { failCount++; }
    }
    showNotification(`✅ تم حذف ${successCount} طلب` + (failCount ? `، فشل ${failCount}` : ''), 'success');
    selectedOrderIds.clear();
    fetchOrders();
    document.querySelectorAll('.orderCheckbox').forEach(cb => cb.checked = false);
    document.getElementById('selectAllCheckbox').checked = false;
    updateBulkControls();
    return;
  }

  // --- باقي الإجراءات (status, driver, company) ---
  let updates = {};
  if (action === 'status') {
    const newStatus = document.getElementById('bulkStatusValue').value;
    if (!newStatus) { alert('اختر حالة جديدة'); return; }
    updates.status = newStatus;
  } else if (action === 'driver') {
    const newDriver = document.getElementById('bulkDriverValue').value;
    if (!newDriver) { alert('اختر سائقاً'); return; }
    updates.driverId = newDriver;
  } else if (action === 'company') {
    const newCompany = document.getElementById('bulkCompanyValue').value;
    if (!newCompany) { alert('اختر شركة'); return; }
    updates.companyId = newCompany;
  }

  if (Object.keys(updates).length === 0) {
    alert('❌ لم يتم تحديد تحديثات');
    return;
  }

  if (!confirm(`هل أنت متأكد من تطبيق التغيير على ${ids.length} طلبات؟`)) return;

  try {
    const res = await apiFetch('/api/orders/bulk-update', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ ids, updates })
    });
    if (!res.ok) throw new Error((await res.json()).message || 'فشل التحديث');
    showNotification(`✅ تم تحديث ${ids.length} طلبات بنجاح`, 'success');
    selectedOrderIds.clear();
    fetchOrders();
    document.querySelectorAll('.orderCheckbox').forEach(cb => cb.checked = false);
    document.getElementById('selectAllCheckbox').checked = false;
    updateBulkControls();
  } catch (err) {
    alert('❌ ' + err.message);
  }
}

// ==================== طباعة ====================
function getPrintDeliveryRow(order) {
  const orderType = getOrderType(order);

  if (orderType === 'شحن' || orderType === 'شحن لباب المنزل') {
    return `<div class="detail-row"><span class="detail-label">نوع الطلب:</span><span class="detail-value">${orderType}</span></div>`;
  }

  return '<div class="detail-row"><span class="detail-label">أجور التوصيل:</span><span class="detail-value">ضمن دمشق 20,000 <br> خارج دمشق 40,000</span></div>';
}

function printOrder(orderId) {
  const order = allOrders.find(o => (o.id || o._id) === orderId);
  if (!order) { alert('الطلب غير موجود'); return; }

  const orderNum = order.order_number || order.orderNumber || '-';
  const contents = order.order_contents || order.orderContents || '-';
  const customerName = order.customer_name || order.customerName || '';
  const customerNumber = order.customer_number || order.customerNumber || '';
  const address = order.address || '';
  const price = formatNumber(order.price) || '0';
  const currency = order.currency || 'ل.س';
  const companyName = order.company_name || order.companyName || '-';
  const note = order.note || '-';

  const printWindow = window.open('', '_blank', 'width=600,height=400');
  printWindow.document.write(`
    <!DOCTYPE html>
    <html dir="rtl" lang="ar">
    <head>
      <meta charset="UTF-8">
      <title>طباعة طلب</title>
      <style>
        @page { size: 100mm 150mm; margin: 3mm; }
        body { width: 100mm; font-family: 'Arial', sans-serif; font-size: 15px; font-weight: bold; color: #000; direction: rtl; margin: 0 auto; padding: 0; background: white; }
        .card { border: 2px solid #000; padding: 4mm; page-break-after: avoid; page-break-inside: avoid; }
        .header { text-align: center; margin-left:75px; font-size: 18px; font-weight: bold; margin-bottom: 6px; border-bottom: 2px solid #000; padding-bottom: 4px; color: #000; }
        .detail-row { display: flex; justify-content: flex-start; padding: 4px 0; border-bottom: 1px dotted #555; line-height: 1.6; }
        .detail-label { font-weight: bold; width: 20%; text-align: right; color: #000; }
        .detail-value { width: 60%; text-align: right; color: #000; word-break: break-word; }
        .footer { text-align: center; margin-left:75px; font-size: 11px; margin-top: 8px; border-top: 2px solid #000; padding-top: 4px; font-weight: bold; color: #000; }
        @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="header">WolfOrder</div>
        <div class="detail-row"><span class="detail-label">رقم الطلب:</span><span class="detail-value">${orderNum}</span></div>
        <div class="detail-row"><span class="detail-label">المحتويات:</span><span class="detail-value">${contents}</span></div>
        <div class="detail-row"><span class="detail-label">العميل:</span><span class="detail-value">${customerName}</span></div>
        <div class="detail-row"><span class="detail-label">رقم العميل:</span><span class="detail-value">${customerNumber || '-'}</span></div>
        <div class="detail-row"><span class="detail-label">العنوان:</span><span class="detail-value">${address}</span></div>
        <div class="detail-row"><span class="detail-label">السعر:</span><span class="detail-value">${price} ${currency}</span></div>
        ${getPrintDeliveryRow(order)}
        <div class="detail-row"><span class="detail-label">الشركة:</span><span class="detail-value">${companyName}</span></div>
        <div class="detail-row"><span class="detail-label">ملاحظة:</span><span class="detail-value">${note}</span></div>
        <div class="footer" style="text-align: right;">للشكاوي أو الاستعلام بالنسبة لخدمة التوصيل<br> يرجى التواصل على الرقم: 0997665442</div>
        <div class="footer">شكراً لتعاملكم مع WolfOrder</div>
        </div>
      <script>window.onload = () => { window.print(); setTimeout(() => window.close(), 500); };</script>
    </body>
    </html>
  `);
  printWindow.document.close();
}

async function printSelectedOrders() {
  const checked = document.querySelectorAll('.orderCheckbox:checked');
  const ids = Array.from(checked).map(cb => cb.value);
  if (ids.length === 0) { alert('لم يتم تحديد أي طلب'); return; }

  const ordersToPrint = allOrders.filter(o => ids.includes((o.id || o._id)));
  if (ordersToPrint.length === 0) { alert('الطلبات غير موجودة'); return; }

  let allCardsHtml = '';
  ordersToPrint.forEach(order => {
    const orderNum = order.order_number || order.orderNumber || '-';
    const contents = order.order_contents || order.orderContents || '-';
    const customerName = order.customer_name || order.customerName || '';
    const customerNumber = order.customer_number || order.customerNumber || '';
    const address = order.address || '';
    const price = formatNumber(order.price) || '0';
    const currency = order.currency || 'ل.س';
    const companyName = order.company_name || order.companyName || '-';
    const note = order.note || '-';

    allCardsHtml += `
      <div class="card">
        <div class="header">WolfOrder</div>
        <div class="detail-row"><span class="detail-label">رقم الطلب:</span><span class="detail-value">${orderNum}</span></div>
        <div class="detail-row"><span class="detail-label">المحتويات:</span><span class="detail-value">${contents}</span></div>
        <div class="detail-row"><span class="detail-label">العميل:</span><span class="detail-value">${customerName}</span></div>
        <div class="detail-row"><span class="detail-label">رقم العميل:</span><span class="detail-value">${customerNumber || '-'}</span></div>
        <div class="detail-row"><span class="detail-label">العنوان:</span><span class="detail-value">${address}</span></div>
        <div class="detail-row"><span class="detail-label">السعر:</span><span class="detail-value">${price} ${currency}</span></div>
        ${getPrintDeliveryRow(order)}
        <div class="detail-row"><span class="detail-label">الشركة:</span><span class="detail-value">${companyName}</span></div>
        <div class="detail-row"><span class="detail-label">ملاحظة:</span><span class="detail-value">${note}</span></div>
        <div class="footer" style="text-align: right;">للشكاوي أو الاستعلام بالنسبة لخدمة التوصيل<br> يرجى التواصل على الرقم: 0997665442</div>
        <div class="footer">شكراً لتعاملكم مع WolfOrder</div>
      </div>
    `;
  });

  const printWindow = window.open('', '_blank', 'width=600,height=400');
  printWindow.document.write(`
    <!DOCTYPE html>
    <html dir="rtl" lang="ar">
    <head>
      <meta charset="UTF-8">
      <title>طباعة طلبات متعددة</title>
      <style>
        @page { size: 100mm 150mm; margin: 3mm; }
        body { width: 100mm; font-family: 'Arial', sans-serif; font-size: 15px; font-weight: bold; color: #000; direction: rtl; margin: 0 auto; padding: 0; background: white; }
        .card { border: 2px solid #000; padding: 4mm; page-break-after: always; page-break-inside: avoid; margin-bottom: 5mm; }
        .card:last-child { page-break-after: auto; }
        .header { text-align: center; margin-left:75px; font-size: 18px; font-weight: bold; margin-bottom: 6px; border-bottom: 2px solid #000; padding-bottom: 4px; color: #000; }
        .detail-row { display: flex; justify-content: flex-start; padding: 4px 0; border-bottom: 1px dotted #555; line-height: 1.6; gap: 15px; }
        .detail-label { font-weight: bold; width: 20%; text-align: right; color: #000; white-space: nowrap; }
        .detail-value { width: 60%; text-align: right; color: #000; word-break: break-word; }
        .footer { text-align: center; margin-left:75px; font-size: 11px; margin-top: 8px; border-top: 2px solid #000; padding-top: 4px; font-weight: bold; color: #000; }
        @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
      </style>
    </head>
    <body>
      ${allCardsHtml}
      <script>window.onload = () => { window.print(); setTimeout(() => window.close(), 500); };</script>
    </body>
    </html>
  `);
  printWindow.document.close();

  document.querySelectorAll('.orderCheckbox').forEach(cb => cb.checked = false);
  document.getElementById('selectAllCheckbox').checked = false;
  selectedOrderIds.clear();
  updateBulkControls();
}


// ==================== إرسال واتساب عبر API (آمن) ====================
async function sendBulkWhatsApp() {
  const checked = document.querySelectorAll('.orderCheckbox:checked');
  const ids = Array.from(checked).map(cb => cb.value);
  if (ids.length === 0) { alert('لم يتم تحديد أي طلب'); return; }

  const ordersToSend = allOrders.filter(o => ids.includes(o.id || o._id));
  if (ordersToSend.length === 0) { alert('الطلبات غير موجودة'); return; }

  // ====== تحويل الأرقام إلى الصيغة المطلوبة ======
  const sendList = ordersToSend.map(order => {
    let phone = (order.customer_number || order.customerNumber || '').replace(/\D/g, '');
    if (phone.length < 9) return null; // أقل من 9 أرقام (بدون رمز الدولة)
    if (phone.startsWith('0')) phone = phone.substring(1);
    if (phone.length === 9 && !phone.startsWith('963')) phone = '963' + phone;
    if (phone.length === 10 && !phone.startsWith('963')) phone = '963' + phone;
    
    return {
      name: order.customer_name || order.customerName,
      phone: phone,
      company: order.company_name || order.companyName || '-',
      customerName: order.customer_name || order.customerName || 'عميل',
      orderNumber: order.order_number || order.orderNumber || 'N/A',
      orderContents: order.order_contents || order.orderContents || '',
      currency: order.currency || 'ل.س',
      price: formatNumber(order.price) || '0',
      companyName: order.company_name || order.companyName || 'متجرنا'
    };
  }).filter(item => item !== null);

  if (sendList.length === 0) { alert('لا توجد أرقام صالحة'); return; }

  // ====== تأكيد الإرسال ======
  if (!confirm(`هل أنت متأكد من إرسال رسائل واتساب إلى ${sendList.length} عميل عبر منصة راسل؟`)) {
    return;
  }

  // ====== نافذة التقدم ======
  const w = window.open('', '', 'width=900,height=700');

  w.document.write(`
    <!DOCTYPE html>
    <html dir="rtl" lang="ar">
    <head>
      <meta charset="UTF-8">
      <title>إرسال واتساب عبر راسل</title>
      <style>
        body { font-family: 'Segoe UI', Tahoma, sans-serif; background: #f5f7fa; margin: 0; padding: 20px; }
        .header { background: #25D366; color: white; padding: 20px; border-radius: 8px; margin-bottom: 20px; text-align: center; }
        .toolbar { display: flex; gap: 10px; margin-bottom: 20px; flex-wrap: wrap; justify-content: center; }
        .btn { padding: 10px 30px; border: none; border-radius: 6px; cursor: pointer; font-size: 16px; font-weight: 600; }
        .btn-success { background: #25D366; color: white; }
        .btn-danger { background: #e74c3c; color: white; }
        .btn-warning { background: #f39c12; color: white; }
        .btn:disabled { opacity: 0.6; cursor: not-allowed; }
        .log-container { background: #2d2d2d; color: #0f0; padding: 15px; border-radius: 8px; max-height: 500px; overflow-y: auto; font-family: monospace; font-size: 13px; white-space: pre-wrap; margin-top: 15px; }
        .log-item { padding: 5px 0; border-bottom: 1px solid #444; }
        .log-success { color: #2ecc71; }
        .log-error { color: #e74c3c; }
        .log-pending { color: #f1c40f; }
        .progress-bar { background: #e0e0e0; border-radius: 10px; margin: 15px 0; height: 25px; }
        .progress-fill { background: #25D366; height: 100%; border-radius: 10px; width: 0%; transition: width 0.5s; text-align: center; color: white; font-size: 14px; line-height: 25px; }
        .stats { display: flex; gap: 20px; justify-content: center; margin: 15px 0; font-size: 16px; }
        .stats span { background: white; padding: 8px 20px; border-radius: 20px; box-shadow: 0 2px 5px rgba(0,0,0,0.1); }
      </style>
    </head>
    <body>
      <div class="header">
        <h2>📲 إرسال عبر منصة راسل (Rasel)</h2>
        <p>عدد العملاء: <strong>${sendList.length}</strong></p>
        <div class="progress-bar">
          <div id="progressFill" class="progress-fill" style="width:0%">0 / ${sendList.length}</div>
        </div>
        <div class="stats">
          <span>✅ <span id="successCount">0</span> تم الإرسال</span>
          <span>❌ <span id="errorCount">0</span> فشل</span>
          <span>⏳ <span id="pendingCount">${sendList.length}</span> قيد الانتظار</span>
        </div>
      </div>
      <div class="toolbar">
        <button id="startBtn" class="btn btn-success" onclick="startSending()">🚀 بدء الإرسال</button>
        <button class="btn btn-danger" onclick="stopSending()">⏹️ إيقاف</button>
        <button class="btn btn-warning" onclick="window.close()">✖️ إغلاق</button>
      </div>
      <div id="logContainer" class="log-container">
        📋 جاهز للبدء...
      </div>
      <script>
        const sendList = ${JSON.stringify(sendList)};
        const API_URL = '/api/send-whatsapp';

        let currentIndex = 0;
        let isRunning = false;
        let isStopped = false;
        let successCount = 0;
        let errorCount = 0;

        function updateProgress() {
          const total = sendList.length;
          const percent = Math.round((currentIndex / total) * 100);
          document.getElementById('progressFill').style.width = percent + '%';
          document.getElementById('progressFill').textContent = currentIndex + ' / ' + total;
          document.getElementById('successCount').textContent = successCount;
          document.getElementById('errorCount').textContent = errorCount;
          document.getElementById('pendingCount').textContent = total - currentIndex;
        }

        function addLog(message, type = 'pending') {
          const container = document.getElementById('logContainer');
          const div = document.createElement('div');
          div.className = 'log-item log-' + type;
          const time = new Date().toLocaleTimeString('ar-EG');
          const icons = { success: '✅', error: '❌', pending: '⏳', info: 'ℹ️' };
          div.textContent = \`[\${time}] \${icons[type] || '•'} \${message}\`;
          container.appendChild(div);
          container.scrollTop = container.scrollHeight;
        }

        async function sendSingleMessage(item, index) {
          try {
            addLog(\`\${index + 1}. جاري إرسال رسالة إلى \${item.name} (\${item.phone})...\`, 'pending');
            
            const token = localStorage.getItem('token') || localStorage.getItem('accessToken');
            
            if (!token) {
              addLog(\`❌ \${item.name} - أنت غير مسجل الدخول.\`, 'error');
              errorCount++;
              return false;
            }

            const sessionFetch = window.opener && typeof window.opener.apiFetch === 'function'
              ? window.opener.apiFetch.bind(window.opener)
              : window.fetch.bind(window);
            const response = await sessionFetch(API_URL, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': \`Bearer \${token}\`
              },
              body: JSON.stringify({
                phone: item.phone,
                customerName: item.customerName,
                orderNumber: item.orderNumber,
                orderContents: item.orderContents,
                currency: item.currency,
                price: item.price,
                companyName: item.companyName
              })
            });

            let data;
            const contentType = response.headers.get('content-type');
            if (contentType && contentType.includes('application/json')) {
              data = await response.json();
            } else {
              const text = await response.text();
              throw new Error(text || 'خطأ غير معروف من السيرفر');
            }
            
            if (response.ok && data.success !== false) {
              addLog(\`✅ \${item.name} - تم الإرسال بنجاح\`, 'success');
              successCount++;
              return true;
            } else {
              const errMsg = data.error || data.message || 'فشل الإرسال';
              addLog(\`❌ \${item.name} - فشل: \${errMsg}\`, 'error');
              errorCount++;
              return false;
            }
          } catch (error) {
            addLog(\`❌ \${item.name} - خطأ: \${error.message}\`, 'error');
            errorCount++;
            return false;
          }
        }

        async function startSending() {
          if (isRunning) return;
          if (currentIndex >= sendList.length) {
            addLog('✅ تم إرسال جميع الرسائل!', 'success');
            return;
          }
          
          isRunning = true;
          isStopped = false;
          document.getElementById('startBtn').disabled = true;
          document.getElementById('startBtn').textContent = '⏳ جاري الإرسال...';
          addLog('🚀 بدء عملية الإرسال...', 'info');

          while (currentIndex < sendList.length && !isStopped) {
            const item = sendList[currentIndex];
            await sendSingleMessage(item, currentIndex);
            currentIndex++;
            updateProgress();
          }

          isRunning = false;
          document.getElementById('startBtn').disabled = false;
          if (isStopped) {
            document.getElementById('startBtn').textContent = '▶️ استئناف';
            addLog('⏹️ تم إيقاف الإرسال مؤقتاً', 'info');
          } else {
            document.getElementById('startBtn').textContent = '✅ تم الانتهاء';
            addLog('🎉 اكتمل إرسال جميع الرسائل!', 'success');
          }
          updateProgress();
        }

        function stopSending() {
          if (!isRunning) return;
          isStopped = true;
          isRunning = false;
          document.getElementById('startBtn').disabled = false;
          document.getElementById('startBtn').textContent = '▶️ استئناف';
          addLog('⏹️ تم إيقاف الإرسال... يمكنك استئنافه لاحقاً', 'info');
        }

        addLog('📋 تم تجهيز ' + sendList.length + ' رسالة للعملاء', 'info');
        addLog('🔑 سيتم الإرسال عبر السيرفر (آمن)', 'info');
        addLog('💡 اضغط "بدء الإرسال" لبدء عملية الإرسال', 'info');
      </script>
    </body>
    </html>
  `);
  w.document.close();

  // إعادة تعيين التحديدات
  document.querySelectorAll('.orderCheckbox').forEach(cb => cb.checked = false);
  if (document.getElementById('selectAllCheckbox')) document.getElementById('selectAllCheckbox').checked = false;
  selectedOrderIds.clear();
  updateBulkControls();
  showNotification(`✅ تم تجهيز ${sendList.length} رسالة للإرسال عبر السيرفر`, 'success');
}


// ==================== الترقيم الآلي المطور ====================
function getAutoNumberKeyForCompany(companyId) {
  return `autoOrderNumber_company_${companyId || 'no_company'}`;
}

// مفتاح حالة الترقيم الآلي (هل هو مفعل أم معطل يدوياً لهذه الشركة)
function getAutoToggleKeyForCompany(companyId) {
  return `autoToggle_company_${companyId || 'no_company'}`;
}

function loadAutoOrderNumberForCompany() {
  const companySelect = document.getElementById('companySelect');
  const companyId = companySelect ? companySelect.value : '';
  const input = document.getElementById('orderNumber');
  const manualToggle = document.getElementById('manualOrderToggle'); // زر تفعيل/إلغاء الترقيم الآلي (إن وجد)
  
  if (!input) return;

  const toggleKey = getAutoToggleKeyForCompany(companyId);
  const savedMode = localStorage.getItem(toggleKey);
  const isManual = savedMode === null || savedMode === 'true';

  // إذا كان المستخدم مفعل الوضع اليدوي
  if (manualToggle) manualToggle.checked = isManual;

  if (isManual) {
    input.readOnly = false; // السماح بالكتابة اليدوية الكاملة
    return;
  }

  // وضع الترقيم الآلي
  input.readOnly = true; // جعل الحقل للقراءة فقط لعدم التلاعب بالترقيم الآلي
  const key = getAutoNumberKeyForCompany(companyId);
  const lastNumber = parseInt(localStorage.getItem(key), 10);

  if (!isNaN(lastNumber) && lastNumber > 0) {
    input.value = lastNumber + 1;
  } else {
    // إذا لم يكن هناك رقم مخزن سابقاً، يمكنك تعيين رقم بداية افتراضي (مثلاً يبدأ من 1 أو بناءً على رغبتك)
    input.value = 1; 
  }
}

// دالة لتحديد رقم بداية معين للشركة يدوياً
function setCustomStartNumberForCompany() {
  const companySelect = document.getElementById('companySelect');
  const companyId = companySelect ? companySelect.value : '';
  const input = document.getElementById('orderNumber');
  
  if (!input) return;
  
  const customVal = prompt("أدخل رقم البداية الجديد لهذه الشركة:", input.value || "1");
  const num = parseInt(customVal, 10);
  
  if (!isNaN(num) && num > 0) {
    // نحفظ الرقم السابق للرقم المدخل بحيث لو زاد يعطي الرقم المدخل تماماً
    const key = getAutoNumberKeyForCompany(companyId);
    localStorage.setItem(key, num - 1);
    input.value = num;
  }
}

// تبديل وضع الترقيم (آلي أو يدوي)
function toggleManualOrderInput(checkbox) {
  const companySelect = document.getElementById('companySelect');
  const companyId = companySelect ? companySelect.value : '';
  const input = document.getElementById('orderNumber');
  
  if (!input) return;

  const toggleKey = getAutoToggleKeyForCompany(companyId);
  
  if (checkbox.checked) {
    localStorage.setItem(toggleKey, 'true');
    input.readOnly = false; // السماح بالكتابة اليدوية
    input.value = ''; // تفريغ الحقل لتكتبه يدوياً
    input.focus();
  } else {
    localStorage.setItem(toggleKey, 'false');
    loadAutoOrderNumberForCompany(); // إعادة تحميل الترقيم الآلي
  }
}

function saveLastOrderNumberForCompany(companyId, orderNumber) {
  const num = parseInt(orderNumber, 10);
  if (!isNaN(num) && num > 0) {
    const key = getAutoNumberKeyForCompany(companyId);
    localStorage.setItem(key, num);
  }
}

function resetAutoNumber() {
  const companySelect = document.getElementById('companySelect');
  const companyId = companySelect ? companySelect.value : '';
  const key = getAutoNumberKeyForCompany(companyId);
  localStorage.removeItem(key);
  const input = document.getElementById('orderNumber');
  if (input) {
    input.value = '';
    input.focus();
  }
}

function insertVariable(variable) {
  const textarea = document.getElementById('messageTemplate');
  if (!textarea) return;
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const text = textarea.value;
  textarea.value = text.substring(0, start) + variable + text.substring(end);
  textarea.focus();
  textarea.setSelectionRange(start + variable.length, start + variable.length);
}

// ==================== بدء التشغيل ====================
loadUsersLists();
fetchOrders();
fetchEditRequests();
loadAdminPhone();
loadMessageTemplate();
loadUsersListForManagement();
