const igToken = localStorage.getItem('token');
const igUser = JSON.parse(localStorage.getItem('user') || 'null');
if (!igToken || !igUser || igUser.role !== 'admin') location.href = 'login.html';

const igState = {
  bootstrap: { companies: [], drivers: [], links: [], viewers: [], viewerMappings: [] },
  orders: [],
  reportTotals: { count: 0, totalSYR: 0, totalUSD: 0, totalRatio: 0 },
  products: [],
  inventoryProducts: [],
  inventory: [],
  reports: [],
  selectedOrders: new Set(),
  orderType: '',
  loadedSections: new Set(['orders'])
};

function igEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function igFormatNumber(value) {
  return (Number(value) || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function igFormatDate(value, withTime = false) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString('en-GB', withTime
    ? { dateStyle: 'short', timeStyle: 'short' }
    : { dateStyle: 'short' });
}

function igNotify(message, type = 'success') {
  const area = document.getElementById('notificationArea');
  const item = document.createElement('div');
  item.className = `toast-notification toast-${type}`;
  item.textContent = message;
  area.appendChild(item);
  setTimeout(() => item.remove(), 4500);
}

async function igApi(url, options = {}) {
  const headers = { Authorization: `Bearer ${igToken}`, ...(options.headers || {}) };
  if (options.body && typeof options.body !== 'string') {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(options.body);
  }
  const response = await fetch(url, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || 'تعذر تنفيذ العملية');
  return data;
}

function optionList(items, placeholder, selected = '') {
  return `<option value="">${placeholder}</option>` + items.map((item) => (
    `<option value="${item.id}" ${item.id === selected ? 'selected' : ''}>${igEscape(item.name)}</option>`
  )).join('');
}

function fillSelect(id, items, placeholder) {
  const element = document.getElementById(id);
  if (element) element.innerHTML = optionList(items, placeholder);
}

async function loadInstagramBootstrap() {
  igState.bootstrap = await igApi('/api/instagram/admin/bootstrap');
  const { companies, drivers } = igState.bootstrap;
  ['igOrderCompany', 'productCompanyFilter', 'inventoryCompany', 'reportCompany'].forEach((id) => fillSelect(id, companies, 'كل الشركات'));
  ['productCompany', 'viewerCompany'].forEach((id) => fillSelect(id, companies, 'اختر الشركة'));
  ['igOrderDriver', 'igBulkDriver'].forEach((id) => fillSelect(id, drivers, id === 'igBulkDriver' ? 'اختر السائق' : 'كل السائقين'));
  fillSelect('igAssignDriver', drivers, 'اختر السائق');
  renderInstagramLinks();
  renderInstagramViewers();
}

async function showInstagramSection(section) {
  document.querySelectorAll('[data-section-panel]').forEach((panel) => {
    panel.hidden = panel.dataset.sectionPanel !== section;
  });
  document.querySelectorAll('#instagramAdminNav [data-section]').forEach((button) => {
    button.classList.toggle('active', button.dataset.section === section);
  });
  const titles = { orders: 'طلبات الإنستغرام', products: 'إدارة الأصناف', inventory: 'الجرد والمبيعات', links: 'روابط طلبات الشركات', viewers: 'حسابات مشاهدة الشركات', reports: 'التقارير' };
  document.getElementById('instagramPageTitle').textContent = titles[section] || 'طلبات الإنستغرام';

  if (section === 'products' && !igState.loadedSections.has(section)) loadInstagramProducts();
  if (section === 'inventory' && !igState.loadedSections.has(section)) loadInstagramInventory();
  if (section === 'reports') {
    if (!igState.loadedSections.has(section)) {
      await loadReportProductOptions();
      await loadInstagramReports();
      igState.loadedSections.add(section);
    }
  }
  if (section === 'links' || section === 'viewers') loadInstagramBootstrap().catch((error) => igNotify(error.message, 'error'));
  
  document.body.classList.remove('sidebar-open');
}

document.getElementById('instagramAdminNav').addEventListener('click', (event) => {
  const button = event.target.closest('[data-section]');
  if (button) showInstagramSection(button.dataset.section);
});

function getOrderFilterQuery() {
  const params = new URLSearchParams();
  const mapping = [
    ['search', 'igOrderSearch'], ['companyId', 'igOrderCompany'], ['status', 'igOrderStatus'],
    ['driverId', 'igOrderDriver'], ['startDate', 'igOrderStart'], ['endDate', 'igOrderEnd']
  ];
  mapping.forEach(([key, id]) => {
    const value = document.getElementById(id)?.value;
    if (value) params.set(key, value);
  });
  if (igState.orderType) params.set('orderType', igState.orderType);
  return params.toString();
}

async function loadInstagramOrders() {
  try {
    igState.orders = await igApi(`/api/instagram/orders?${getOrderFilterQuery()}`);
    igState.selectedOrders.clear();
    renderInstagramOrders();
  } catch (error) {
    igNotify(error.message, 'error');
  }
}

function renderInstagramStats() {
  const counts = {
    all: igState.orders.length,
    delivery: igState.orders.filter((order) => order.order_type === 'توصيل').length,
    shipping: igState.orders.filter((order) => order.order_type === 'شحن').length,
    pending: igState.orders.filter((order) => order.status === 'قيد المتابعة').length
  };
  document.getElementById('instagramOrderStats').innerHTML = `
    <div class="ig-stat"><span>إجمالي المعروض</span><strong>${counts.all}</strong></div>
    <div class="ig-stat"><span>طلبات التوصيل</span><strong>${counts.delivery}</strong></div>
    <div class="ig-stat"><span>طلبات الشحن</span><strong>${counts.shipping}</strong></div>
    <div class="ig-stat"><span>قيد المتابعة</span><strong>${counts.pending}</strong></div>`;
}

function orderItemsHtml(items = []) {
  return `<ul class="ig-order-items">${items.map((item) => (
    `<li>${igEscape(item.product_name)} — ${igEscape(item.color)} / ${igEscape(item.size)} × ${item.quantity}</li>`
  )).join('')}</ul>`;
}

function orderActionHtml(order) {
  const assignBtn = (order.order_type === 'توصيل' && !order.driver_id)
    ? `<button class="btn btn-sm btn-secondary" data-action="assign">تعيين</button>`
    : '';
  const editBtn = `<button class="btn btn-sm btn-primary" data-action="edit">تعديل</button>`;
  const printBtn = `<button class="btn btn-sm btn-ghost" data-action="print">طباعة</button>`;
  const deleteBtn = `<button class="btn btn-sm btn-danger" data-action="delete">حذف نهائي</button>`;
  return `<div class="ig-actions-vertical">${assignBtn}${editBtn}${printBtn}${deleteBtn}</div>`;
}

function renderInstagramOrders() {
  renderInstagramStats();
  const body = document.getElementById('instagramOrdersBody');
  if (!igState.orders.length) {
    body.innerHTML = '<tr><td colspan="15">لا توجد طلبات مطابقة.</td></tr>';
    updateBulkBar();
    return;
  }
  body.innerHTML = igState.orders.map((order) => `
    <tr data-order-id="${order.id}">
      <td data-label="تحديد"><input type="checkbox" class="ig-order-check" ${igState.selectedOrders.has(order.id) ? 'checked' : ''}></td>
      <td data-label="رقم الطلب">#${order.order_number}</td>
      <td data-label="النوع"><span class="order-type-badge ${order.order_type === 'توصيل' ? 'order-type-delivery' : 'order-type-shipping'}">${order.order_type}</span></td>
      <td data-label="الزبون">${igEscape(order.customer_name)}</td>
      <td data-label="الموبايل"><a href="tel:${igEscape(order.customer_number)}">${igEscape(order.customer_number)}</a></td>
      <td data-label="العنوان">${igEscape(order.address)}</td>
      <td data-label="الأصناف">${orderItemsHtml(order.items)}</td>
      <td data-label="الإجمالي">${igFormatNumber(order.total_price)} ${igEscape(order.currency)}</td>
      <td data-label="نسبة">${order.ratio ? igFormatNumber(order.ratio) : '-'}</td>
      <td data-label="الحالة"><span class="status-badge status-${igEscape(order.status)}">${igEscape(order.status)}</span></td>
      <td data-label="السائق/التسليم">${order.order_type === 'توصيل' ? igEscape(order.driver_name || 'بدون سائق') : (order.shipping_delivery_status === 'delivered' ? `تم التسليم لـ ${igEscape(order.company_name)}<br>${igFormatDate(order.shipping_delivered_at, true)}` : 'بانتظار التسليم للشركة')}</td>
      <td data-label="الشركة">${igEscape(order.company_name)}</td>
      <td data-label="ملاحظة">${igEscape(order.note || '')}</td>
      <td data-label="التاريخ">${igFormatDate(order.created_at, true)}</td>
      <td data-label="الإجراءات">${orderActionHtml(order)}</td>
    </tr>`).join('');
  updateBulkBar();
}

function updateBulkBar() {
  const bar = document.getElementById('igBulkBar');
  bar.hidden = igState.selectedOrders.size === 0;
  document.getElementById('igSelectedCount').textContent = `${igState.selectedOrders.size} محدد`;
  document.getElementById('igSelectAll').checked = igState.orders.length > 0 && igState.selectedOrders.size === igState.orders.length;
}

document.getElementById('instagramOrdersBody').addEventListener('change', (event) => {
  if (!event.target.classList.contains('ig-order-check')) return;
  const id = event.target.closest('tr').dataset.orderId;
  if (event.target.checked) igState.selectedOrders.add(id); else igState.selectedOrders.delete(id);
  updateBulkBar();
});

document.getElementById('igSelectAll').addEventListener('change', (event) => {
  igState.selectedOrders.clear();
  if (event.target.checked) igState.orders.forEach((order) => igState.selectedOrders.add(order.id));
  renderInstagramOrders();
});

async function performOrderAction(url, body, successMessage) {
  await igApi(url, { method: 'PATCH', body });
  igNotify(successMessage);
  await loadInstagramOrders();
  if (igState.loadedSections.has('inventory')) {
    await loadInstagramInventory();
  }
}

document.getElementById('instagramOrdersBody').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const row = button.closest('tr');
  const id = row.dataset.orderId;
  const order = igState.orders.find((item) => item.id === id);
  try {
    if (button.dataset.action === 'assign') {
      openAssignModal(order);
    } else if (button.dataset.action === 'edit') {
      openEditOrderModal(order);
    } else if (button.dataset.action === 'print') {
      printInstagramOrders([order]);
    } else if (button.dataset.action === 'delete') {
      if (!confirm('هل أنت متأكد من حذف هذا الطلب نهائياً؟')) return;
      try {
        const response = await fetch(`/api/instagram/orders/${id}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${igToken}` }
        });

        if (!response.ok) {
          let errorMessage = `فشل الحذف - الحالة: ${response.status} ${response.statusText}`;
          try {
            const data = await response.json();
            if (data && data.message) errorMessage = data.message;
          } catch (jsonError) {
            try {
              const text = await response.text();
              if (text) errorMessage += ` - ${text.slice(0, 200)}`;
            } catch (textError) {}
          }
          console.error('Delete order failed:', {
            status: response.status,
            statusText: response.statusText,
            message: errorMessage
          });
          throw new Error(errorMessage);
        }

        igNotify('تم حذف الطلب نهائياً');
        await loadInstagramOrders();
        if (igState.loadedSections.has('inventory')) {
          await loadInstagramInventory();
        }
      } catch (error) {
        console.error('Delete order error:', error);
        igNotify(error.message, 'error');
      }
    }
  } catch (error) {
    igNotify(error.message, 'error');
  }
});

// ===== دوال المودالات =====
function closeModal(modal) {
  modal.hidden = true;
}

document.querySelectorAll('[data-close-modal]').forEach(btn => {
  btn.addEventListener('click', () => {
    const modal = btn.closest('.modal-overlay');
    if (modal) closeModal(modal);
  });
});

function openEditOrderModal(order) {
  document.getElementById('igEditOrderId').value = order.id;
  document.getElementById('igEditOrderNumber').value = order.order_number || '';
  document.getElementById('igEditCustomerName').value = order.customer_name || '';
  document.getElementById('igEditCustomerNumber').value = order.customer_number || '';
  document.getElementById('igEditAddress').value = order.address || '';
  document.getElementById('igEditOrderContents').value = order.order_contents || '';
  document.getElementById('igEditTotalPrice').value = order.total_price || 0;
  document.getElementById('igEditRatio').value = order.ratio || '';
  document.getElementById('igEditNote').value = order.note || '';
  document.getElementById('igEditStatus').value = order.status || 'قيد المتابعة';

  const driverSelect = document.getElementById('igEditDriverId');
  driverSelect.innerHTML = '<option value="">بدون سائق</option>' +
    igState.bootstrap.drivers.map(driver =>
      `<option value="${driver.id}" ${driver.id === order.driver_id ? 'selected' : ''}>${igEscape(driver.name)}</option>`
    ).join('');

  const companySelect = document.getElementById('igEditCompanyId');
  companySelect.innerHTML = '<option value="">بدون شركة</option>' +
    igState.bootstrap.companies.map(company =>
      `<option value="${company.id}" ${company.id === order.company_id ? 'selected' : ''}>${igEscape(company.name)}</option>`
    ).join('');

  document.getElementById('igEditModal').hidden = false;
}

document.getElementById('igSaveEditOrder').addEventListener('click', async () => {
  const id = document.getElementById('igEditOrderId').value;
  const originalOrder = igState.orders.find(o => o.id === id);
  const newStatus = document.getElementById('igEditStatus').value;
  const driverId = document.getElementById('igEditDriverId').value;
  const companyId = document.getElementById('igEditCompanyId').value;
  const ratioValue = document.getElementById('igEditRatio').value;

  const body = {
    order_number: document.getElementById('igEditOrderNumber').value,
    customer_name: document.getElementById('igEditCustomerName').value,
    customer_number: document.getElementById('igEditCustomerNumber').value,
    address: document.getElementById('igEditAddress').value,
    total_price: Number(document.getElementById('igEditTotalPrice').value) || 0,
    note: document.getElementById('igEditNote').value,
    driver_id: driverId || null,
    company_id: companyId || null,
    ratio: ratioValue ? Number(ratioValue) : null
  };

  try {
    await igApi(`/api/instagram/orders/${id}`, { method: 'PATCH', body });

    if (newStatus !== (originalOrder?.status || '')) {
      await igApi(`/api/instagram/orders/${id}/status`, {
        method: 'PATCH',
        body: {
          status: newStatus,
          note: body.note || null
        }
      });
    }

    igNotify('تم تعديل الطلب');
    closeModal(document.getElementById('igEditModal'));
    await loadInstagramOrders();
    if (igState.loadedSections.has('inventory')) {
      await loadInstagramInventory();
    }
  } catch (error) {
    console.error('Update order error:', error);
    igNotify(error.message, 'error');
  }
});

function openAssignModal(order) {
  document.getElementById('igAssignOrderId').value = order.id;
  document.getElementById('igAssignPercentage').value = order.ratio || '';
  const driverSelect = document.getElementById('igAssignDriver');
  driverSelect.innerHTML = optionList(igState.bootstrap.drivers, 'اختر السائق', order.driver_id || '');
  if (order.driver_id) driverSelect.value = order.driver_id;
  document.getElementById('igAssignModal').hidden = false;
}

document.getElementById('igConfirmAssign').addEventListener('click', async () => {
  const orderId = document.getElementById('igAssignOrderId').value;
  const driverId = document.getElementById('igAssignDriver').value;
  const percentage = document.getElementById('igAssignPercentage').value;
  if (!driverId) return igNotify('اختر السائق أولاً', 'error');
  try {
    await igApi('/api/instagram/orders/assign-driver', {
      method: 'PATCH',
      body: {
        ids: [orderId],
        driverId,
        ratio: percentage ? Number(percentage) : null
      }
    });
    igNotify('تم تعيين السائق');
    closeModal(document.getElementById('igAssignModal'));
    await loadInstagramOrders();
  } catch (error) {
    igNotify(error.message, 'error');
  }
});

document.querySelectorAll('.ig-type-tab').forEach((button) => button.addEventListener('click', () => {
  document.querySelectorAll('.ig-type-tab').forEach((item) => item.classList.remove('active'));
  button.classList.add('active');
  igState.orderType = button.dataset.type;
  loadInstagramOrders();
}));

document.getElementById('refreshInstagramOrders').addEventListener('click', loadInstagramOrders);
document.getElementById('applyInstagramOrderFilters').addEventListener('click', loadInstagramOrders);
document.getElementById('clearInstagramOrderFilters').addEventListener('click', () => {
  ['igOrderSearch', 'igOrderCompany', 'igOrderStatus', 'igOrderDriver', 'igOrderStart', 'igOrderEnd'].forEach((id) => { document.getElementById(id).value = ''; });
  igState.orderType = '';
  document.querySelectorAll('.ig-type-tab').forEach((item) => item.classList.toggle('active', item.dataset.type === ''));
  loadInstagramOrders();
});

// الإجراءات الجماعية
document.getElementById('igApplyBulkStatus').addEventListener('click', async () => {
  const status = document.getElementById('igBulkStatus').value;
  if (!status) return igNotify('اختر الحالة', 'error');
  try { await performOrderAction('/api/instagram/orders/bulk-status', { ids: [...igState.selectedOrders], status }, 'تم تحديث الطلبات المحددة'); } catch (error) { igNotify(error.message, 'error'); }
});
document.getElementById('igApplyBulkDriver').addEventListener('click', async () => {
  const driverId = document.getElementById('igBulkDriver').value;
  if (!driverId) return igNotify('اختر السائق', 'error');
  const ids = igState.orders
    .filter((order) => igState.selectedOrders.has(order.id) && order.order_type === 'توصيل')
    .map((order) => order.id);
  if (!ids.length) return igNotify('حدد طلب توصيل واحداً على الأقل', 'error');
  try { await performOrderAction('/api/instagram/orders/assign-driver', { ids, driverId }, 'تم تعيين السائق لطلبات التوصيل المحددة'); } catch (error) { igNotify(error.message, 'error'); }
});
document.getElementById('igBulkShippingDelivered').addEventListener('click', async () => {
  const ids = igState.orders
    .filter((order) => igState.selectedOrders.has(order.id) && order.order_type === 'شحن')
    .map((order) => order.id);
  if (!ids.length) return igNotify('حدد طلب شحن واحداً على الأقل', 'error');
  try { await performOrderAction('/api/instagram/orders/shipping-delivered', { ids }, 'تم تسجيل تسليم طلبات الشحن المحددة'); } catch (error) { igNotify(error.message, 'error'); }
});
document.getElementById('igArchiveSelected').addEventListener('click', async () => {
  if (!confirm('أرشفة الطلبات المحددة؟ ستبقى البيانات محفوظة.')) return;
  try { await performOrderAction('/api/instagram/orders/archive', { ids: [...igState.selectedOrders], archived: true }, 'تمت أرشفة الطلبات'); } catch (error) { igNotify(error.message, 'error'); }
});
document.getElementById('igPrintSelected').addEventListener('click', () => printInstagramOrders(igState.orders.filter((order) => igState.selectedOrders.has(order.id))));

function printInstagramOrders(orders) {
  if (!orders.length) return igNotify('لم يتم تحديد طلبات للطباعة', 'error');
  const popup = window.open('', '_blank');
  popup.document.write(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>طباعة طلبات Instagram</title><style>body{font-family:Arial;padding:20px}.order{border:2px solid #222;border-radius:12px;padding:14px;margin:0 0 16px;page-break-inside:avoid}h2{margin:0 0 10px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:7px}li{margin:4px}@media print{button{display:none}}</style></head><body><button onclick="print()">طباعة</button>${orders.map((order) => `<div class="order"><h2>طلب Instagram #${order.order_number}</h2><div class="grid"><div><b>الشركة:</b> ${igEscape(order.company_name)}</div><div><b>النوع:</b> ${order.order_type}</div><div><b>الزبون:</b> ${igEscape(order.customer_name)}</div><div><b>الموبايل:</b> ${igEscape(order.customer_number)}</div><div><b>العنوان:</b> ${igEscape(order.address)}</div><div><b>الإجمالي:</b> ${igFormatNumber(order.total_price)} ${igEscape(order.currency)}</div><div><b>نسبة السائق:</b> ${order.ratio ? igFormatNumber(order.ratio) : '-'}</div><div><b>ملاحظة:</b> ${igEscape(order.note || '')}</div></div>${orderItemsHtml(order.items)}</div>`).join('')}</body></html>`);
  popup.document.close();
  popup.onload = () => popup.print();
}

// ========== Products ==========
function addVariantBuilderRow(values = {}) {
  const row = document.createElement('div');
  row.className = 'variant-builder-row';
  row.innerHTML = `<div class="form-group"><label>اللون</label><input class="builder-color" value="${igEscape(values.color || '')}" required></div><div class="form-group"><label>المقاس</label><input class="builder-size" value="${igEscape(values.size || '')}" required></div><div class="form-group"><label>المخزون</label><input class="builder-stock" type="number" min="0" value="${values.stockTotal ?? 0}" required></div><button type="button" class="btn btn-danger btn-sm builder-remove">حذف</button>`;
  row.querySelector('.builder-remove').addEventListener('click', () => {
    if (document.querySelectorAll('.variant-builder-row').length > 1) row.remove();
  });
  document.getElementById('productVariantBuilder').appendChild(row);
}
document.getElementById('addProductVariantRow').addEventListener('click', () => addVariantBuilderRow());

document.getElementById('createInstagramProductForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const variants = [...document.querySelectorAll('.variant-builder-row')].map((row) => ({
    color: row.querySelector('.builder-color').value,
    size: row.querySelector('.builder-size').value,
    stockTotal: Number(row.querySelector('.builder-stock').value)
  }));
  try {
    await igApi('/api/instagram/products', { method: 'POST', body: { companyId: document.getElementById('productCompany').value, name: document.getElementById('productName').value, unitPrice: document.getElementById('productPrice').value, currency: document.getElementById('productCurrency').value, variants } });
    igNotify('تم إنشاء الصنف');
    event.target.reset();
    document.getElementById('productVariantBuilder').innerHTML = '';
    addVariantBuilderRow();
    await loadInstagramProducts();
  } catch (error) { igNotify(error.message, 'error'); }
});

async function loadInstagramProducts() {
  try {
    const companyId = document.getElementById('productCompanyFilter').value;
    igState.products = await igApi(`/api/instagram/products${companyId ? `?companyId=${companyId}` : ''}`);
    igState.inventoryProducts = [];
    igState.loadedSections.add('products');
    renderInstagramProducts();
    updateInventoryProductOptions();
  } catch (error) { igNotify(error.message, 'error'); }
}

async function loadReportProductOptions() {
  try {
    if (!igState.inventoryProducts.length) {
      igState.inventoryProducts = await igApi('/api/instagram/products');
    }
    fillSelect('reportProduct', igState.inventoryProducts.map((product) => ({ id: product.id, name: product.name })), 'كل الأصناف');
  } catch (error) {
    console.error('Failed to load report products:', error);
  }
}

function statusOptions(selected) {
  return [['active', 'فعال'], ['stopped', 'متوقف'], ['archived', 'مؤرشف']].map(([value, label]) => `<option value="${value}" ${value === selected ? 'selected' : ''}>${label}</option>`).join('');
}

function renderInstagramProducts() {
  const grid = document.getElementById('instagramProductsGrid');
  if (!igState.products.length) { grid.innerHTML = '<div class="ig-mini-card">لا توجد أصناف.</div>'; return; }
  grid.innerHTML = igState.products.map((product) => {
    const company = igState.bootstrap.companies.find((item) => item.id === product.company_id);
    return `<article class="ig-mini-card product-admin-card" data-product-id="${product.id}">
      <div class="product-admin-head"><div class="form-group"><label>اسم الصنف</label><input class="edit-product-name" value="${igEscape(product.name)}"></div><div class="form-group"><label>السعر</label><input class="edit-product-price" type="number" min="0" value="${product.unit_price}"></div><div class="form-group"><label>الحالة</label><select class="edit-product-status">${statusOptions(product.status)}</select></div><div><small>${igEscape(company?.name || '')}</small><div class="link-actions"><button class="btn btn-primary btn-sm" data-product-action="save">حفظ</button><button class="btn btn-danger btn-sm" data-product-action="delete">حذف نهائي</button></div></div></div>
      <div class="product-variants-list">${(product.variants || []).map((variant) => `<div class="product-variant-line" data-variant-id="${variant.id}"><input class="variant-color" value="${igEscape(variant.color)}"><input class="variant-size" value="${igEscape(variant.size)}"><input class="variant-stock" type="number" min="0" value="${variant.stock_total}"><label><input class="variant-active" type="checkbox" ${variant.is_active ? 'checked' : ''}> فعال</label><div class="variant-actions"><button class="btn btn-primary btn-sm" data-variant-action="save">حفظ</button><button class="btn btn-danger btn-sm" data-variant-action="delete">حذف</button></div></div>`).join('')}</div>
      <div class="product-add-variant"><strong>إضافة لون ومقاس</strong><div class="variant-edit-row"><input class="new-variant-color" placeholder="اللون"><input class="new-variant-size" placeholder="المقاس"><input class="new-variant-stock" type="number" min="0" value="0" placeholder="المخزون"><button class="btn btn-secondary btn-sm" data-product-action="add-variant">إضافة</button></div></div>
    </article>`;
  }).join('');
}

document.getElementById('instagramProductsGrid').addEventListener('click', async (event) => {
  const productButton = event.target.closest('[data-product-action]');
  const variantButton = event.target.closest('[data-variant-action]');
  const card = event.target.closest('[data-product-id]');
  if (!card) return;
  try {
    if (productButton?.dataset.productAction === 'save') {
      await igApi(`/api/instagram/products/${card.dataset.productId}`, { method: 'PATCH', body: { name: card.querySelector('.edit-product-name').value, unitPrice: card.querySelector('.edit-product-price').value, status: card.querySelector('.edit-product-status').value } });
      igNotify('تم تعديل الصنف'); await loadInstagramProducts();
    } else if (productButton?.dataset.productAction === 'delete') {
      if (!confirm('حذف الصنف نهائياً؟ لا يمكن الحذف إذا استُخدم في طلب.')) return;
      await igApi(`/api/instagram/products/${card.dataset.productId}`, { method: 'DELETE' });
      igNotify('تم حذف الصنف'); await loadInstagramProducts();
    } else if (productButton?.dataset.productAction === 'add-variant') {
      await igApi(`/api/instagram/products/${card.dataset.productId}/variants`, { method: 'POST', body: { color: card.querySelector('.new-variant-color').value, size: card.querySelector('.new-variant-size').value, stockTotal: card.querySelector('.new-variant-stock').value } });
      igNotify('تمت إضافة اللون والمقاس'); await loadInstagramProducts();
    } else if (variantButton) {
      const line = variantButton.closest('[data-variant-id]');
      if (variantButton.dataset.variantAction === 'save') {
        await igApi(`/api/instagram/variants/${line.dataset.variantId}`, { method: 'PATCH', body: { color: line.querySelector('.variant-color').value, size: line.querySelector('.variant-size').value, stockTotal: line.querySelector('.variant-stock').value, isActive: line.querySelector('.variant-active').checked } });
        igNotify('تم تعديل التركيبة'); await loadInstagramProducts();
      } else if (variantButton.dataset.variantAction === 'delete') {
        if (!confirm('حذف اللون والمقاس نهائياً؟ يجب أن يكون المخزون صفراً وألا يكون مستخدماً.')) return;
        await igApi(`/api/instagram/variants/${line.dataset.variantId}`, { method: 'DELETE' });
        igNotify('تم حذف التركيبة'); await loadInstagramProducts();
      }
    }
  } catch (error) { igNotify(error.message, 'error'); }
});
document.getElementById('loadInstagramProducts').addEventListener('click', loadInstagramProducts);

// ========== Inventory ==========
function updateInventoryProductOptions() {
  const companyId = document.getElementById('inventoryCompany').value;
  const products = companyId
    ? igState.inventoryProducts.filter((product) => product.company_id === companyId)
    : igState.inventoryProducts;
  fillSelect('inventoryProduct', products.map((product) => ({ id: product.id, name: product.name })), 'كل الأصناف');
}
document.getElementById('inventoryCompany').addEventListener('change', updateInventoryProductOptions);

async function loadInstagramInventory() {
  try {
    if (!igState.inventoryProducts.length) {
      igState.inventoryProducts = await igApi('/api/instagram/products');
      updateInventoryProductOptions();
    }
    const params = new URLSearchParams();
    if (document.getElementById('inventoryCompany').value) params.set('companyId', document.getElementById('inventoryCompany').value);
    if (document.getElementById('inventoryProduct').value) params.set('productId', document.getElementById('inventoryProduct').value);
    igState.inventory = await igApi(`/api/instagram/inventory?${params}`);
    igState.loadedSections.add('inventory');
    document.getElementById('instagramInventoryBody').innerHTML = igState.inventory.length ? igState.inventory.map((row) => `<tr><td data-label="الشركة">${igEscape(row.company_name)}</td><td data-label="الصنف">${igEscape(row.product_name)}</td><td data-label="اللون">${igEscape(row.color)}</td><td data-label="المقاس">${igEscape(row.size)}</td><td data-label="الكلية">${row.quantity_total}</td><td data-label="محجوز توصيل">${row.reserved_delivery}</td><td data-label="محجوز شحن">${row.reserved_shipping}</td><td data-label="المباعة">${row.sold}</td><td data-label="المؤجلة">${row.postponed}</td><td data-label="المرتجع">${row.returned}</td><td data-label="الإلغاء">${row.cancelled}</td><td data-label="المتبقية"><strong>${row.remaining}</strong></td></tr>`).join('') : '<tr><td colspan="12">لا توجد بيانات جرد.</td></tr>';
  } catch (error) { igNotify(error.message, 'error'); }
}
document.getElementById('loadInstagramInventory').addEventListener('click', loadInstagramInventory);
document.getElementById('exportInstagramInventory').addEventListener('click', async () => {
  try {
    const params = new URLSearchParams();
    if (document.getElementById('inventoryCompany').value) params.set('companyId', document.getElementById('inventoryCompany').value);
    if (document.getElementById('inventoryProduct').value) params.set('productId', document.getElementById('inventoryProduct').value);
    const response = await fetch(`/api/instagram/inventory/export?${params}`, { headers: { Authorization: `Bearer ${igToken}` } });
    if (!response.ok) throw new Error('تعذر تصدير الجرد');
    const blob = await response.blob();
    const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = 'instagram-inventory.xls'; link.click(); URL.revokeObjectURL(link.href);
  } catch (error) { igNotify(error.message, 'error'); }
});

// ========== Links ==========
function renderInstagramLinks() {
  const links = new Map(igState.bootstrap.links.map((link) => [link.company_id, link]));
  document.getElementById('instagramLinksGrid').innerHTML = igState.bootstrap.companies.map((company) => {
    const link = links.get(company.id);
    const usernameSlug = String(company.username || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const slug = link?.slug || usernameSlug || `company-${String(company.id).slice(0, 8)}`;
    const isActive = link?.is_active ?? false;
    return `<article class="ig-mini-card link-card" data-company-id="${company.id}">
      <h3>${igEscape(company.name)}</h3>
      <div class="form-group">
        <label>الرابط</label>
        <input class="link-slug" dir="ltr" value="${igEscape(slug)}">
      </div>
      <div class="link-status">
        <span>الحالة: <strong>${isActive ? 'مفعل' : 'غير مفعل'}</strong></span>
      </div>
      <p class="link-preview">${location.origin}/o/${igEscape(slug)}</p>
      <div class="link-actions">
        <button class="btn btn-${isActive ? 'danger' : 'success'} btn-sm" data-link-action="toggle">
          ${isActive ? 'إيقاف' : 'تفعيل'}
        </button>
        <button class="btn btn-primary btn-sm" data-link-action="save">حفظ الرابط</button>
        <button class="btn btn-secondary btn-sm" data-link-action="copy">نسخ الرابط</button>
        <a class="btn btn-ghost btn-sm" target="_blank" href="/o/${encodeURIComponent(slug)}">دخول للرابط</a>
      </div>
    </article>`;
  }).join('');
}

document.getElementById('instagramLinksGrid').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-link-action]');
  if (!button) return;
  const card = button.closest('[data-company-id]');
  const slug = card.querySelector('.link-slug').value;
  const currentActive = card.querySelector('[data-link-action="toggle"]').textContent.includes('إيقاف');

  try {
    if (button.dataset.linkAction === 'save') {
      await igApi('/api/instagram/links', {
        method: 'POST',
        body: { companyId: card.dataset.companyId, slug, isActive: currentActive }
      });
      igNotify('تم حفظ رابط الشركة');
      await loadInstagramBootstrap();
    } else if (button.dataset.linkAction === 'toggle') {
      await igApi('/api/instagram/links', {
        method: 'POST',
        body: { companyId: card.dataset.companyId, slug, isActive: !currentActive }
      });
      igNotify(currentActive ? 'تم إيقاف الرابط' : 'تم تفعيل الرابط');
      await loadInstagramBootstrap();
    } else if (button.dataset.linkAction === 'copy') {
      await navigator.clipboard.writeText(`${location.origin}/o/${slug}`);
      igNotify('تم نسخ الرابط');
    }
  } catch (error) {
    igNotify(error.message, 'error');
  }
});

// ========== Viewers ==========
function renderInstagramViewers() {
  const mappings = new Map(igState.bootstrap.viewerMappings.map((mapping) => [mapping.viewer_user_id, mapping.company_id]));
  document.getElementById('instagramViewersGrid').innerHTML = igState.bootstrap.viewers.length ? igState.bootstrap.viewers.map((viewer) => `<article class="ig-mini-card viewer-card" data-viewer-id="${viewer.id}"><h3>${igEscape(viewer.name)}</h3><p>@${igEscape(viewer.username)}</p><div class="form-group"><label>الشركة</label><select class="viewer-company-select">${optionList(igState.bootstrap.companies, 'اختر الشركة', mappings.get(viewer.id))}</select></div><div class="link-actions"><button class="btn btn-primary btn-sm" data-viewer-action="save">حفظ الربط</button><button class="btn btn-danger btn-sm" data-viewer-action="delete">حذف الحساب</button></div></article>`).join('') : '<div class="ig-mini-card">لا توجد حسابات مشاهدة.</div>';
}
document.getElementById('createInstagramViewerForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await igApi('/api/instagram/viewers', { method: 'POST', body: { name: document.getElementById('viewerName').value, username: document.getElementById('viewerUsername').value, password: document.getElementById('viewerPassword').value, companyId: document.getElementById('viewerCompany').value } });
    igNotify('تم إنشاء حساب المشاهدة'); event.target.reset(); await loadInstagramBootstrap();
  } catch (error) { igNotify(error.message, 'error'); }
});
document.getElementById('instagramViewersGrid').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-viewer-action]'); if (!button) return;
  const card = button.closest('[data-viewer-id]');
  try {
    if (button.dataset.viewerAction === 'save') {
      await igApi(`/api/instagram/viewers/${card.dataset.viewerId}/company`, { method: 'PATCH', body: { companyId: card.querySelector('.viewer-company-select').value } }); igNotify('تم تحديث الشركة');
    } else if (confirm('حذف حساب المشاهدة نهائياً؟')) {
      await igApi(`/api/instagram/viewers/${card.dataset.viewerId}`, { method: 'DELETE' }); igNotify('تم حذف الحساب');
    }
    await loadInstagramBootstrap();
  } catch (error) { igNotify(error.message, 'error'); }
});

// ========== Reports ==========
async function loadInstagramReports() {
  const params = new URLSearchParams();
  const companyId = document.getElementById('reportCompany').value;
  const productId = document.getElementById('reportProduct').value;
  const start = document.getElementById('reportStart').value;
  const end = document.getElementById('reportEnd').value;
  if (companyId) params.set('companyId', companyId);
  if (productId) params.set('productId', productId);
  if (start) params.set('startDate', start);
  if (end) params.set('endDate', end);

  try {
    const data = await igApi(`/api/instagram/orders/report?${params}`);
    igState.reportTotals = {
      count: data.count || 0,
      totalSYR: data.totalSYR || 0,
      totalUSD: data.totalUSD || 0,
      totalRatio: data.totalRatio || 0
    };
    igState.reports = data.orders || [];
    igState.loadedSections.add('reports');
    renderInstagramReports();
  } catch (error) {
    console.error('Report error:', error);
    igNotify(error.message, 'error');
  }
}

function renderInstagramReports() {
  const totals = igState.reportTotals || { count: 0, totalSYR: 0, totalUSD: 0, totalRatio: 0 };
  document.getElementById('igReportCount').textContent = totals.count;
  document.getElementById('igReportTotalSYR').textContent = igFormatNumber(totals.totalSYR) + ' ل.س';
  document.getElementById('igReportTotalUSD').textContent = igFormatNumber(totals.totalUSD) + ' $';
  document.getElementById('igReportTotalRatio').textContent = igFormatNumber(totals.totalRatio);

  const body = document.getElementById('instagramReportsBody');
  if (!igState.reports.length) {
    body.innerHTML = '<tr><td colspan="10">لا توجد بيانات.</td></tr>';
    return;
  }
  body.innerHTML = igState.reports.map(row => `
    <tr>
      <td>#${row.order_number}</td>
      <td>${igFormatDate(row.created_at, true)}</td>
      <td>${igEscape(row.company_name)}</td>
      <td>${row.order_type}</td>
      <td>${igEscape(row.customer_name)}</td>
      <td>${igEscape(row.items_summary || '')}</td>
      <td>${igFormatNumber(row.total_price)} ${igEscape(row.currency)}</td>
      <td>${igFormatNumber(row.ratio || 0)}</td>
      <td>${igEscape(row.status)}</td>
      <td>${igEscape(row.note || '')}</td>
    </tr>
  `).join('');
}

document.getElementById('loadInstagramReports').addEventListener('click', loadInstagramReports);
document.getElementById('exportInstagramOrdersReport').addEventListener('click', async () => {
  const params = new URLSearchParams();
  const companyId = document.getElementById('reportCompany').value;
  const productId = document.getElementById('reportProduct').value;
  const start = document.getElementById('reportStart').value;
  const end = document.getElementById('reportEnd').value;
  if (companyId) params.set('companyId', companyId);
  if (productId) params.set('productId', productId);
  if (start) params.set('startDate', start);
  if (end) params.set('endDate', end);

  try {
    const response = await fetch(`/api/instagram/orders/export?${params}`, {
      headers: { Authorization: `Bearer ${igToken}` }
    });

    if (!response.ok) {
      let errorMessage = 'تعذر التصدير';
      try {
        const data = await response.json();
        if (data && data.message) errorMessage = data.message;
      } catch (e) {}
      throw new Error(errorMessage);
    }

    // الحصول على البيانات كنص CSV
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'instagram-report.csv';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  } catch (error) {
    console.error('Export error:', error);
    igNotify(error.message, 'error');
  }
});

// ========== Initialize ==========
async function initializeInstagramAdmin() {
  try {
    await loadInstagramBootstrap();
    addVariantBuilderRow();
    await loadInstagramOrders();
  } catch (error) { igNotify(error.message, 'error'); }
}

initializeInstagramAdmin();