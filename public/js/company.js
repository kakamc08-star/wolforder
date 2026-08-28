// ==================== التحقق من الجلسة ====================
const token = localStorage.getItem('token');
const userStr = localStorage.getItem('user');
if (!token || !userStr) window.location.href = 'login.html';
const user = JSON.parse(userStr);
if (user.role !== 'company') window.location.href = 'login.html';
document.getElementById('userNameDisplay').textContent = user.name || user.username;

// ==================== تعريف معرف الشركة مرة واحدة (ثابت) ====================
const COMPANY_ID = user.id || 'default_company';
console.log('[Company ID]', COMPANY_ID);

// ==================== دوال الترقيم (تعتمد على COMPANY_ID الثابت) ====================
function getAutoNumberKey() {
    return `autoOrderNumber_company_${COMPANY_ID}`;
}

function getAutoToggleKey() {
    return `autoToggle_company_${COMPANY_ID}`;
}

function isManualNumbering() {
    const savedMode = localStorage.getItem(getAutoToggleKey());
    // عند عدم وجود إعداد محفوظ نبدأ بالترقيم اليدوي، ويمكن للمستخدم تفعيل التلقائي لاحقاً.
    return savedMode === null || savedMode === 'true';
}

function updateNumberingModeUI(isManual) {
    const autoButton = document.getElementById('autoNumberModeBtn');
    const manualButton = document.getElementById('manualNumberModeBtn');
    const hint = document.getElementById('numberingModeHint');

    autoButton?.classList.toggle('is-active', !isManual);
    manualButton?.classList.toggle('is-active', isManual);
    autoButton?.setAttribute('aria-pressed', String(!isManual));
    manualButton?.setAttribute('aria-pressed', String(isManual));

    if (hint) {
        hint.textContent = isManual
            ? 'الوضع اليدوي مفعّل: اكتب رقم كل طلب بنفسك.'
            : 'الوضع التلقائي مفعّل: سيزداد الرقم تلقائياً بعد إنشاء الطلب.';
    }
}

function loadAutoOrderNumber() {
    const input = document.getElementById('orderNumber');
    if (!input) return;

    const isManual = isManualNumbering();
    updateNumberingModeUI(isManual);

    if (isManual) {
        input.readOnly = false;
        input.placeholder = 'اكتب رقم الطلب يدوياً';
        return;
    }

    input.readOnly = true;
    input.placeholder = '';
    const key = getAutoNumberKey();
    const lastNumber = parseInt(localStorage.getItem(key), 10);
    console.log(`[loadAutoOrderNumber] المفتاح: ${key}, القيمة المخزنة: ${localStorage.getItem(key)}`);

    if (!isNaN(lastNumber) && lastNumber > 0) {
        input.value = lastNumber + 1;
    } else {
        input.value = 1;
    }
    console.log(`[loadAutoOrderNumber] الرقم المعروض: ${input.value}`);
}

function openAutoNumberDialog() {
    const modal = document.getElementById('autoNumberModal');
    const startInput = document.getElementById('autoNumberStart');
    const orderInput = document.getElementById('orderNumber');
    if (!modal || !startInput) return;

    const savedNumber = parseInt(localStorage.getItem(getAutoNumberKey()), 10);
    const suggestedNumber = !isNaN(savedNumber) && savedNumber > 0
        ? savedNumber + 1
        : parseInt(orderInput?.value, 10) || 1;

    startInput.value = suggestedNumber;
    modal.style.display = 'flex';
    modal.setAttribute('aria-hidden', 'false');
    setTimeout(() => {
        startInput.focus();
        startInput.select();
    }, 0);
}

function closeAutoNumberDialog() {
    const modal = document.getElementById('autoNumberModal');
    if (!modal) return;
    modal.style.display = 'none';
    modal.setAttribute('aria-hidden', 'true');
}

function enableManualNumbering() {
    const input = document.getElementById('orderNumber');
    if (!input) return;

    localStorage.setItem(getAutoToggleKey(), 'true');
    input.readOnly = false;
    input.value = '';
    input.placeholder = 'اكتب رقم الطلب يدوياً';
    updateNumberingModeUI(true);
    input.focus();
    showNotification('تم تفعيل الترقيم اليدوي', 'info');
}

// إبقاء الاسم القديم متاحاً لأي نسخة مخزنة من الصفحة.
function setCustomStartNumberForCompany() {
    openAutoNumberDialog();
}

function toggleManualOrderInput(checkbox) {
    if (checkbox?.checked) enableManualNumbering();
    else openAutoNumberDialog();
}

function saveLastOrderNumber(orderNumber) {
    const num = parseInt(orderNumber, 10);
    if (!isNaN(num) && num > 0) {
        const key = getAutoNumberKey();
        localStorage.setItem(key, num);
        console.log(`[saveLastOrderNumber] تم حفظ: ${num} في المفتاح ${key}`);
    } else {
        console.warn(`[saveLastOrderNumber] رقم غير صالح: ${orderNumber}`);
    }
}

function resetAutoNumber() {
    openAutoNumberDialog();
}

// ==================== دوال مساعدة ====================
let previousOrderIds = new Set();
let autoRefresh = null;
let allOrders = [];
let orderSummary = null;
let adminPhone = '';
let currentSort = 'default';
let suppressNewOrderNotifications = false;
let activeOrderCategory = '';
let ordersLoadingTimer = null;
let ordersPage = 1;
let ordersTotalPages = 1;
let ordersFetchController = null;
let companySearchTimer = null;
const ORDERS_PAGE_SIZE = 50;

function startCompanyPolling() {
    if (autoRefresh) return;
    autoRefresh = setInterval(() => {
        if (!document.hidden && navigator.onLine) fetchOrders();
    }, 30000);
}

window.addEventListener('beforeunload', () => {
    if (autoRefresh) clearInterval(autoRefresh);
    if (ordersFetchController) ordersFetchController.abort();
});

const categoryLabels = {
    pending: 'طلبات قيد المتابعة',
    postponed: 'الطلبات المؤجلة',
    done: 'الطلبات المكتملة',
    returned: 'الطلبات المرتجعة',
    cancelled: 'الطلبات الملغاة',
    shipping: 'طلبات الشحن'
};

function showCompanyView(viewName) {
    const homeSection = document.getElementById('companyHomeSection');
    const createSection = document.getElementById('createOrderSection');
    const ordersSection = document.getElementById('ordersSection');
    const sections = { home: homeSection, create: createSection, orders: ordersSection };
    const selectedSection = sections[viewName] || homeSection;

    Object.values(sections).forEach(section => {
        if (section) section.hidden = section !== selectedSection;
    });

    document.querySelectorAll('.sidebar-nav [data-company-view]').forEach(link => {
        link.classList.toggle('active', link.dataset.companyView === viewName);
    });

    if (viewName === 'orders') {
        fetchOrders();
    } else if (viewName === 'create') {
        setTimeout(() => document.getElementById('orderNumber')?.focus(), 0);
    }

    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function getOrderType(order) {
    return order.order_type || order.orderType || 'توصيل';
}

function getOrderTypeClass(orderType) {
    if (orderType === 'شحن') return 'order-type-shipping';
    if (orderType === 'شحن لباب المنزل') return 'order-type-home-shipping';
    return 'order-type-delivery';
}

function matchesOrderCategory(order, category) {
    if (!category) return true;
    if (category === 'pending') return order.status === 'قيد المتابعة';
    if (category === 'postponed') return order.status === 'مؤجل';
    if (category === 'done') return order.status === 'تم';
    if (category === 'returned') return order.status === 'مرتجع';
    if (category === 'cancelled') return order.status === 'إلغاء';
    if (category === 'shipping') return ['شحن', 'شحن لباب المنزل'].includes(getOrderType(order));
    return true;
}

function updateStatusCards() {
    const counts = orderSummary || {
        pending: allOrders.filter(order => matchesOrderCategory(order, 'pending')).length,
        postponed: allOrders.filter(order => matchesOrderCategory(order, 'postponed')).length,
        done: allOrders.filter(order => matchesOrderCategory(order, 'done')).length,
        returned: allOrders.filter(order => matchesOrderCategory(order, 'returned')).length,
        cancelled: allOrders.filter(order => matchesOrderCategory(order, 'cancelled')).length,
        shipping: allOrders.filter(order => matchesOrderCategory(order, 'shipping')).length
    };

    const countElements = {
        pending: 'pendingOrdersCount',
        postponed: 'postponedOrdersCount',
        done: 'doneOrdersCount',
        returned: 'returnedOrdersCount',
        cancelled: 'cancelledOrdersCount',
        shipping: 'shippingOrdersCount'
    };

    Object.entries(countElements).forEach(([category, elementId]) => {
        const element = document.getElementById(elementId);
        if (element) element.textContent = counts[category];
    });

    const homePendingCount = document.getElementById('homePendingOrdersCount');
    if (homePendingCount) homePendingCount.textContent = `${counts.pending} قيد المتابعة`;
}

function setOrdersLoading(isLoading) {
    const indicator = document.getElementById('ordersLoadingIndicator');
    const ordersSection = document.getElementById('ordersSection');
    if (!indicator || !ordersSection) return;

    clearTimeout(ordersLoadingTimer);
    ordersSection.setAttribute('aria-busy', String(isLoading));
    if (isLoading) {
        ordersLoadingTimer = setTimeout(() => {
            indicator.hidden = false;
        }, 180);
    } else {
        indicator.hidden = true;
    }
}

function setCreateOrderSubmitting(isSubmitting) {
    const button = document.getElementById('createOrderSubmitBtn');
    if (!button) return;
    if (isSubmitting) {
        const summary = document.getElementById('createdOrderSummary');
        if (summary) summary.hidden = true;
    }
    button.disabled = isSubmitting;
    button.classList.toggle('is-loading', isSubmitting);
    button.textContent = isSubmitting ? 'جاري إنشاء الطلب...' : 'إنشاء الطلب';
}

function showCreatedOrderSummary(createdOrder, fallbackData) {
    const summary = document.getElementById('createdOrderSummary');
    if (!summary) return;

    const orderNumber = createdOrder?.order_number || createdOrder?.orderNumber || fallbackData.orderNumber;
    const orderType = createdOrder?.order_type || createdOrder?.orderType || fallbackData.orderType;
    const customerName = createdOrder?.customer_name || createdOrder?.customerName || fallbackData.customerName;

    document.getElementById('createdOrderNumber').textContent = orderNumber || '-';
    document.getElementById('createdOrderType').textContent = orderType || 'توصيل';
    document.getElementById('createdCustomerName').textContent = customerName || '-';
    summary.hidden = false;
}

function selectOrderCategory(category = '') {
    activeOrderCategory = category;
    document.querySelectorAll('[data-order-category]').forEach(card => {
        const isActive = card.dataset.orderCategory === category;
        card.classList.toggle('is-active', isActive);
        card.setAttribute('aria-pressed', String(isActive));
    });

    const label = document.getElementById('activeCategoryLabel');
    if (label) label.textContent = categoryLabels[category] || 'جميع الطلبات';
    ordersPage = 1;
    fetchOrders();
}

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

function validateCustomerName(name) {
    if (!name || name.trim() === '') return true;
    return /[^\d]/.test(name.trim());
}

function validateCustomerNumber(number) {
    if (!number || number.trim() === '') return true;
    return /^\d{10}$/.test(number.trim());
}

function formatNumber(num) {
    if (num === null || num === undefined || isNaN(num)) return '0';
    const rounded = Math.round(num);
    return rounded.toLocaleString('en-US');
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

// تحويل الأرقام العربية والفارسية إلى أرقام إنكليزية
function convertToEnglishDigits(value) {
    return String(value)
        .replace(/[٠-٩]/g, digit => '٠١٢٣٤٥٦٧٨٩'.indexOf(digit))
        .replace(/[۰-۹]/g, digit => '۰۱۲۳۴۵۶۷۸۹'.indexOf(digit))
        .replace(/٫/g, '.')
        .replace(/٬/g, '');
}

// التحويل مباشرة أثناء الكتابة في لوحة الشركة
document.addEventListener('input', function (event) {
    const input = event.target;

    if (!input.matches('input, textarea')) return;

    const convertedValue = convertToEnglishDigits(input.value);

    if (input.value !== convertedValue) {
        input.value = convertedValue;
    }
});

// ==================== حالة الاتصال ====================
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

// ==================== جلب الطلبات ====================
async function fetchOrders() {
    if (ordersFetchController) ordersFetchController.abort();
    ordersFetchController = new AbortController();
    setOrdersLoading(true);
    try {
        const startDateEl = document.getElementById('startDate');
        const endDateEl = document.getElementById('endDate');
        const searchEl = document.getElementById('searchInput');

        const startDateInput = startDateEl ? startDateEl.value : '';
        const endDateInput = endDateEl ? endDateEl.value : '';
        const searchInput = searchEl ? searchEl.value : '';

        let startDate = '';
        let endDate = '';
        if (startDateInput) {
            startDate = new Date(startDateInput + 'T00:00:00').toISOString();
        }
        if (endDateInput) {
            endDate = new Date(endDateInput + 'T23:59:59').toISOString();
        }

        const params = new URLSearchParams({
            paginate: '1',
            page: String(ordersPage),
            limit: String(ORDERS_PAGE_SIZE),
            includeSummary: '1'
        });
        if (startDate) params.set('startDate', startDate);
        if (endDate) params.set('endDate', endDate);
        if (searchInput.trim()) params.set('search', searchInput.trim());
        if (activeOrderCategory === 'shipping') params.set('shipping', '1');
        const statusByCategory = { pending: 'قيد المتابعة', postponed: 'مؤجل', done: 'تم', returned: 'مرتجع', cancelled: 'إلغاء' };
        if (statusByCategory[activeOrderCategory]) params.set('status', statusByCategory[activeOrderCategory]);
        if (currentSort === 'asc' || currentSort === 'desc') params.set('sort', currentSort);

        const res = await apiFetch(`/api/orders?${params}`, {
            headers: { 'Authorization': `Bearer ${token}` },
            signal: ordersFetchController.signal
        });
        if (!res.ok) throw new Error('فشل جلب الطلبات');
        const data = await res.json();
        const orders = data.orders || [];
        orderSummary = data.summary || orderSummary;
        ordersTotalPages = data.pagination?.totalPages || 1;
        if (ordersPage > ordersTotalPages) {
            ordersPage = ordersTotalPages;
            return fetchOrders();
        }

        const filterKey = `${activeOrderCategory}|${startDateInput}|${endDateInput}|${searchInput}`;
        if (window._lastFilterKey !== filterKey) {
            previousOrderIds.clear();
            window._lastFilterKey = filterKey;
        }

        const newOrders = orders.filter(o => !previousOrderIds.has(o.id || o._id));
        let showAlerts = true;
        if (suppressNewOrderNotifications) {
            showAlerts = false;
            suppressNewOrderNotifications = false;
        }
        if (showAlerts && newOrders.length > 0 && previousOrderIds.size > 0) {
            newOrders.forEach(order => {
                showNotification(`🚚 طلب جديد #${order.order_number || order.orderNumber}`, 'success');
                if (typeof notificationSound !== 'undefined') notificationSound.play().catch(() => {});
            });
        }

        previousOrderIds = new Set(orders.map(o => o.id || o._id));
        allOrders = orders;
        updateStatusCards();
        applyFiltersAndRender();
        updateOrdersPagination(data.pagination || {});

        if (startDateEl && startDateEl.value !== startDateInput) startDateEl.value = startDateInput;
        if (endDateEl && endDateEl.value !== endDateInput) endDateEl.value = endDateInput;
        if (searchEl && searchEl.value !== searchInput) searchEl.value = searchInput;

        document.getElementById('lastUpdateTime').textContent = `آخر تحديث: ${new Date().toLocaleTimeString('ar')}`;
    } catch (err) {
        if (err.name !== 'AbortError') console.error('fetchOrders error:', err);
    } finally {
        setOrdersLoading(false);
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
    fetchOrders();
}

function applyFiltersAndRender() {
    let filtered = [...allOrders];
    filtered = filtered.filter(order => matchesOrderCategory(order, activeOrderCategory));
    const searchText = document.getElementById('searchInput')?.value || '';
    filtered = filterOrdersBySearch(filtered, searchText);

    if (currentSort === 'asc') {
        filtered.sort((a, b) => (a.order_number || '').localeCompare(b.order_number || '', 'ar', { numeric: true }));
    } else if (currentSort === 'desc') {
        filtered.sort((a, b) => (b.order_number || '').localeCompare(a.order_number || '', 'ar', { numeric: true }));
    }
    renderTable(filtered);
}

function clearFilters() {
    document.getElementById('startDate').value = '';
    document.getElementById('endDate').value = '';
    document.getElementById('searchInput').value = '';
    ordersPage = 1;
    selectOrderCategory('');
}

// ==================== عرض الجدول ====================
function renderTable(orders) {
    const tbody = document.getElementById('ordersTableBody');
    if (!tbody) return;
    tbody.innerHTML = '';
    let totalSYR = 0, totalUSD = 0;

    if (orders.length === 0) {
        tbody.innerHTML = '<tr><td colspan="12" class="company-empty-orders">لا توجد طلبات ضمن هذا التصنيف.</td></tr>';
    }

    orders.forEach((order, index) => {
        const price = Number(order.price) || 0;
        if (order.currency === 'دولار') {
            totalUSD += price;
        } else {
            totalSYR += price;
        }

        const tr = document.createElement('tr');
        const orderId = order.id || order._id;
        const orderNumber = order.order_number || order.orderNumber;
        const customerName = order.customer_name || order.customerName;
        const customerNumber = order.customer_number || order.customerNumber;
        const address = order.address;
        const priceVal = order.price;
        const currency = order.currency || 'ل.س';
        const status = order.status;
        const note = order.note || '';
        const createdAt = order.created_at || order.createdAt;
        tr.innerHTML = `
            <td data-label="عداد الطلبات :">${((ordersPage - 1) * ORDERS_PAGE_SIZE) + index + 1}</td>
            <td data-label="رقم الطلب :">${orderNumber}</td>
            <td data-label="نوع الطلب :"><span class="order-type-badge ${getOrderTypeClass(getOrderType(order))}">${getOrderType(order)}</span></td>
            <td class="text-wrap-column" data-label="محتويات الطلب :">${order.order_contents || order.orderContents || '-'}</td>
            <td data-label="اسم العميل :">${customerName}</td>
            <td data-label="رقم العميل :">${customerNumber ? `<a href="tel:${customerNumber}">${customerNumber}</a>` : '-'}</td>
            <td data-label="العنوان :">${address}</td>
            <td data-label="السعر :">${formatNumber(priceVal)} ${currency}</td>
            <td data-label="الحالة :"><span class="status-badge status-${status}">${status}</span></td>
            <td class="text-wrap-column" data-label="ملاحظة :">${note || '-'}</td>
            <td data-label="التاريخ :">${formatDate(createdAt)}</td>
            <td data-label="">
                <button class="btn btn-sm btn-warning" onclick='openEditRequestModal("${orderId}")'>✏️ طلب تعديل</button>
            </td>
        `;
        tbody.appendChild(tr);
    });

    document.getElementById('totalPriceSYR').textContent = formatNumber(totalSYR) + ' ل.س';
    document.getElementById('totalPriceUSD').textContent = formatNumber(totalUSD) + ' $';
}

function toggleDarkMode(event) {
    document.body.classList.toggle('dark-mode');
    const isDark = document.body.classList.contains('dark-mode');
    localStorage.setItem('darkMode', isDark);
    const btn = event.currentTarget;
    btn.textContent = isDark ? '☀️' : '🌙';
}

// ==================== فلترة وبحث ====================
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

// ==================== إنشاء طلب ====================
document.getElementById('createOrderForm').addEventListener('submit', async (e) => {
    e.preventDefault();

    const orderNumberInput = document.getElementById('orderNumber');
    const customerNumberInput = document.getElementById('customerNumber');
    const customerNameInput = document.getElementById('customerName');
    const addressInput = document.getElementById('address');
    const priceInput = document.getElementById('price');
    const currencyInput = document.getElementById('currency');

    if (!orderNumberInput || !customerNameInput || !addressInput || !priceInput) {
        alert('خطأ: بعض الحقول المطلوبة غير موجودة في الصفحة');
        return;
    }

    const orderNumber = orderNumberInput.value.trim();
    const customerNumber = customerNumberInput ? customerNumberInput.value.trim() : '';
    const customerName = customerNameInput.value.trim();
    const address = addressInput.value.trim();
    const price = parseFloat(priceInput.value);
    const currency = currencyInput ? currencyInput.value : 'ل.س';

    if (!orderNumber || !customerName || !address || isNaN(price)) {
        alert('يرجى ملء جميع الحقول المطلوبة');
        return;
    }

    if (!validateCustomerName(customerName)) {
        alert('❌ اسم العميل يجب أن يحتوي على أحرف');
        return;
    }

    if (customerNumber && !validateCustomerNumber(customerNumber)) {
        alert('❌ رقم العميل يجب أن يتكون من 10 أرقام بالضبط');
        return;
    }

    const data = {
        orderNumber,
        orderContents: document.getElementById('orderContents')?.value || '',
        customerNumber,
        customerName,
        address,
        price,
        currency,
        ratio: 0,
        orderType: document.getElementById('orderType')?.value || 'توصيل',
        note: document.getElementById('orderNote')?.value || ''
    };

    setCreateOrderSubmitting(true);
    try {
        const res = await apiFetch('/api/orders', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify(data)
        });

        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.message || 'فشل إنشاء الطلب');
        }

        const createdOrder = await res.json();

        // حفظ العداد فقط في الوضع التلقائي؛ الرقم اليدوي لا يغيّر تسلسل العداد.
        const orderNumInput = document.getElementById('orderNumber');
        if (!isManualNumbering() && orderNumInput && orderNumInput.value) {
            saveLastOrderNumber(orderNumInput.value);
        }

        document.getElementById('createOrderForm').reset();
        // إعادة رقم الطلب التالي بعد reset حتى لا يبقى الحقل فارغاً.
        loadAutoOrderNumber();
        suppressNewOrderNotifications = true;
        fetchOrders();
        showCreatedOrderSummary(createdOrder, data);
        showNotification('✅ تم إنشاء الطلب بنجاح');
    } catch (err) {
        alert('❌ ' + err.message);
    } finally {
        setCreateOrderSubmitting(false);
    }
});

// ==================== طلبات التعديل ====================
function openEditRequestModal(orderId) {
    const order = allOrders.find(o => (o.id || o._id) === orderId);
    if (!order) return alert('الطلب غير موجود');

    document.getElementById('requestOrderId').value = orderId;
    document.getElementById('reqOrderNumber').value = order.order_number || order.orderNumber;
    document.getElementById('reqOrderType').value = getOrderType(order);
    document.getElementById('reqOrderContents').value = order.order_contents || order.orderContents || '';
    document.getElementById('reqCustomerNumber').value = order.customer_number || order.customerNumber || '';
    document.getElementById('reqCustomerName').value = order.customer_name || order.customerName;
    document.getElementById('reqAddress').value = order.address;
    document.getElementById('reqPrice').value = order.price;
    document.getElementById('reqCurrency').value = order.currency || 'ل.س';
    document.getElementById('editRequestModal').style.display = 'flex';
}

function closeEditRequestModal() {
    document.getElementById('editRequestModal').style.display = 'none';
}

document.getElementById('editRequestForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const orderId = document.getElementById('requestOrderId').value;
    const changes = {
        orderNumber: document.getElementById('reqOrderNumber').value,
        orderType: document.getElementById('reqOrderType').value,
        orderContents: document.getElementById('reqOrderContents').value,
        customerNumber: document.getElementById('reqCustomerNumber').value,
        customerName: document.getElementById('reqCustomerName').value,
        address: document.getElementById('reqAddress').value,
        price: parseFloat(document.getElementById('reqPrice').value),
        currency: document.getElementById('reqCurrency').value,
        note: document.getElementById('reqNote')?.value || ''
    };

    try {
        const res = await apiFetch('/api/edit-requests', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ orderId, changes })
        });
        if (!res.ok) throw new Error('فشل إرسال الطلب');
        closeEditRequestModal();
        showNotification('✅ تم إرسال طلب التعديل إلى المدير');
    } catch (err) {
        alert(err.message);
    }
});

// ==================== مراسلة المدير ====================
async function loadAdminPhone() {
    try {
        const res = await apiFetch('/api/auth/admin-phone', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (res.ok) {
            const data = await res.json();
            adminPhone = data.phone || '';
        }
    } catch (err) {
        console.warn('تعذر جلب رقم المدير');
    }
}

// ==================== تهيئة الصفحة ====================
document.addEventListener('DOMContentLoaded', function() {
    document.querySelectorAll('[data-company-view]').forEach(control => {
        control.addEventListener('click', function(event) {
            event.preventDefault();
            showCompanyView(control.dataset.companyView);
        });
    });

    document.querySelectorAll('[data-order-category]').forEach(card => {
        card.setAttribute('aria-pressed', 'false');
        card.addEventListener('click', () => selectOrderCategory(card.dataset.orderCategory));
    });

    document.getElementById('showAllOrdersBtn')?.addEventListener('click', () => selectOrderCategory(''));
    document.getElementById('closeCreatedOrderSummary')?.addEventListener('click', () => {
        const summary = document.getElementById('createdOrderSummary');
        if (summary) summary.hidden = true;
    });

    const autoNumberForm = document.getElementById('autoNumberForm');
    if (autoNumberForm) {
        autoNumberForm.addEventListener('submit', function(event) {
            event.preventDefault();
            const startInput = document.getElementById('autoNumberStart');
            const startNumber = Number(startInput?.value);

            if (!Number.isInteger(startNumber) || startNumber < 1) {
                showNotification('أدخل رقم بداية صحيحاً أكبر من صفر', 'error');
                startInput?.focus();
                return;
            }

            localStorage.setItem(getAutoNumberKey(), String(startNumber - 1));
            localStorage.setItem(getAutoToggleKey(), 'false');
            loadAutoOrderNumber();
            closeAutoNumberDialog();
            showNotification(`تم بدء الترقيم التلقائي من ${startNumber}`, 'success');
        });
    }

    const autoNumberModal = document.getElementById('autoNumberModal');
    autoNumberModal?.addEventListener('click', function(event) {
        if (event.target === autoNumberModal) closeAutoNumberDialog();
    });

    document.addEventListener('keydown', function(event) {
        if (event.key === 'Escape' && autoNumberModal?.style.display === 'flex') {
            closeAutoNumberDialog();
        }
    });

    // ربط البحث
    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
        searchInput.addEventListener('input', () => {
            clearTimeout(companySearchTimer);
            companySearchTimer = setTimeout(() => {
                ordersPage = 1;
                fetchOrders();
            }, 400);
        });
    }

    document.getElementById('ordersPrevPage')?.addEventListener('click', () => changeOrdersPage(-1));
    document.getElementById('ordersNextPage')?.addEventListener('click', () => changeOrdersPage(1));

    // زر مراسلة المدير
    const contactBtn = document.getElementById('contactAdminBtn');
    if (contactBtn) {
        contactBtn.addEventListener('click', function() {
            if (!adminPhone) {
                alert('رقم المدير غير متاح حالياً');
                return;
            }
            const message = 'مرحبًا، لدي استفسار بخصوص الطلبات.';
            const whatsappUrl = `https://wa.me/${adminPhone}?text=${encodeURIComponent(message)}`;
            window.open(whatsappUrl, '_blank');
        });
    }

    // تحميل رقم المدير
    loadAdminPhone();

    // تحميل وضع الترقيم؛ اليدوي هو الافتراضي ما لم يُحفظ اختيار آخر.
    loadAutoOrderNumber();

    showCompanyView('home');

    // تفعيل الوضع الداكن إن كان محفوظاً
    if (localStorage.getItem('darkMode') === 'true') {
        document.body.classList.add('dark-mode');
        const btn = document.querySelector('[onclick="toggleDarkMode()"]');
        if (btn) btn.textContent = '☀️';
    }
});




// ==================== بدء التطبيق ====================
fetchOrders();
startCompanyPolling();
