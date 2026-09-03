const igToken = localStorage.getItem('token');
const igUser = JSON.parse(localStorage.getItem('user') || 'null');
if (!igToken || !igUser || igUser.role !== 'admin') location.href = 'login.html';

const igState = {
  bootstrap: { companies: [], drivers: [], links: [], viewers: [], viewerMappings: [] },
  orders: [],
  allOrders: [],
  reportTotals: { count: 0, totalSYR: 0, totalUSD: 0, totalRatio: 0 },
  products: [],
  inventoryProducts: [],
  inventory: [],
  reports: [],
  orderEditProducts: [],
  selectedOrders: new Set(),
  loadedSections: new Set(['orders']),
  previousOrderIds: new Set()
};

// ====== الاتصال الفوري (WebSocket) ======
let igSocket;

function connectInstagramSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  igSocket = new WebSocket(`${protocol}//${window.location.host}`);

  igSocket.onopen = () => {
    console.log('🟢 Instagram admin WebSocket connected');
  };

  igSocket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'INSTAGRAM_ORDER_CREATED' || data.type === 'INSTAGRAM_ORDER_UPDATED' || data.type === 'INSTAGRAM_ORDER_DELETED') {
        console.log('🔄 تحديث فوري لطلبات Instagram...');
        if (typeof loadInstagramOrders === 'function') loadInstagramOrders(true); // تمييز الجديد فقط
      }
    } catch (error) {
      console.error('❌ WebSocket message error:', error);
    }
  };

  igSocket.onclose = () => {
    console.log('⚠️ انقطع اتصال Instagram WebSocket، إعادة المحاولة بعد 5 ثوان...');
    setTimeout(connectInstagramSocket, 5000);
  };

  igSocket.onerror = (error) => {
    console.error('❌ Instagram WebSocket error:', error);
    igSocket.close();
  };
}

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
  ['igOrderDriver'].forEach((id) => fillSelect(id, drivers, 'كل السائقين'));
  fillSelect('igBulkDriver', drivers, 'اختر السائق');
  fillSelect('igBulkCompany', companies, 'اختر الشركة');
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
    ['companyId', 'igOrderCompany'], ['status', 'igOrderStatus'],
    ['driverId', 'igOrderDriver'], ['startDate', 'igOrderStart'], ['endDate', 'igOrderEnd']
  ];
  mapping.forEach(([key, id]) => {
    const value = document.getElementById(id)?.value;
    if (value) params.set(key, value);
  });
  return params.toString();
}

function normalizeInstagramSearch(value) {
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

function instagramOrderSearchValues(order) {
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
    order.driver_name,
    order.order_type,
    order.status,
    ...itemValues
  ];
}

function matchesInstagramOrderSearch(order, value) {
  const term = normalizeInstagramSearch(value);
  if (!term) return true;
  return instagramOrderSearchValues(order)
    .some((field) => normalizeInstagramSearch(field).includes(term));
}

function applyInstagramOrderSearch() {
  igState.orders = igState.allOrders.filter((order) => (
    matchesInstagramOrderSearch(order, document.getElementById('igOrderSearch')?.value)
  ));
  igState.selectedOrders.clear();
  renderInstagramOrders();
}

async function loadInstagramOrders(markNewOrders = false) {
  try {
    const fetchedOrders = await igApi(`/api/instagram/orders?${getOrderFilterQuery()}`);
    const newOrders = fetchedOrders.filter((order) => (
      matchesInstagramOrderSearch(order, document.getElementById('igOrderSearch')?.value)
    ));
    let newOrderIds = new Set();

    if (markNewOrders && igState.previousOrderIds.size > 0) {
      fetchedOrders.forEach(order => {
        if (!igState.previousOrderIds.has(order.id)) {
          newOrderIds.add(order.id);
        }
      });
    }

    // تحديث مجموعة المعرفات السابقة
    igState.previousOrderIds = new Set(fetchedOrders.map(o => o.id));

    igState.allOrders = fetchedOrders;
    igState.orders = newOrders;
    igState.selectedOrders.clear();
    renderInstagramOrders(newOrderIds);
  } catch (error) {
    igNotify(error.message, 'error');
  }
}

function renderInstagramStats() {
  const total = igState.orders.length.toLocaleString('en-US');
  document.getElementById('instagramOrderStats').innerHTML = `
    <div class="ig-stat"><span>إجمالي المعروض</span><strong>${total}</strong><small>بعد تطبيق الفلاتر الحالية</small></div>`;
}

function orderItemsHtml(items = []) {
  const safeItems = Array.isArray(items) ? items : [];
  return `<ul class="ig-order-items">${safeItems.map((item) => (
    `<li>${igEscape(item.product_name)} — ${igEscape(item.color)} / ${igEscape(item.size)} × ${item.quantity}</li>`
  )).join('')}</ul>`;
}

function orderActionHtml(order) {
  const assignBtn = !order.driver_id
    ? `<button class="btn btn-sm btn-secondary" data-action="assign">تعيين</button>`
    : '';
  const editBtn = `<button class="btn btn-sm btn-primary" data-action="edit">تعديل</button>`;
  const printBtn = `<button class="btn btn-sm btn-ghost" data-action="print">طباعة</button>`;
  const deleteBtn = `<button class="btn btn-sm btn-danger" data-action="delete">حذف نهائي</button>`;
  return `<div class="ig-actions-vertical">${assignBtn}${editBtn}${printBtn}${deleteBtn}</div>`;
}

function updateInstagramTotals() {
  let totalSYR = 0;
  let totalUSD = 0;
  let totalRatio = 0;

  igState.orders.forEach(order => {
    const price = Number(order.total_price) || 0;
    if (order.currency === 'دولار') {
      totalUSD += price;
    } else {
      totalSYR += price;
    }
    totalRatio += Number(order.ratio) || 0;
  });

  const elSYR = document.getElementById('igTotalSYR');
  const elUSD = document.getElementById('igTotalUSD');
  const elRatio = document.getElementById('igTotalRatio');
  if (elSYR) elSYR.textContent = `${igFormatNumber(totalSYR)} ل.س`;
  if (elUSD) elUSD.textContent = `${igFormatNumber(totalUSD)} $`;
  if (elRatio) elRatio.textContent = igFormatNumber(totalRatio);
}

function renderInstagramOrders(newOrderIds = new Set()) {
  renderInstagramStats();
  const body = document.getElementById('instagramOrdersBody');
  if (!igState.orders.length) {
    body.innerHTML = '<tr><td colspan="17">لا توجد طلبات مطابقة.</td></tr>';
    updateBulkBar();
    updateInstagramTotals();
    return;
  }
  body.innerHTML = igState.orders.map((order, index) => `
    <tr data-order-id="${order.id}" class="${newOrderIds.has(order.id) ? 'highlight-new' : ''}">
      <td data-label="تحديد"><input type="checkbox" class="ig-order-check" ${igState.selectedOrders.has(order.id) ? 'checked' : ''}></td>
      <td data-label="الرقم التسلسلي">${igEscape(order.serial_number || order.serialNumber || '')}</td>
      <td data-label="العداد">${index + 1}</td>
      <td data-label="رقم الطلب"><span class="ig-order-number">#${igEscape(order.order_number)}</span></td>
      <td data-label="نوع الطلب"><span class="order-type-badge order-type-delivery">توصيل</span></td>
      <td class="text-wrap-column" data-label="محتويات الطلب">${orderItemsHtml(order.items)}</td>
      <td data-label="اسم العميل">${igEscape(order.customer_name)}</td>
      <td data-label="رقم العميل"><a href="tel:${igEscape(order.customer_number)}">${igEscape(order.customer_number)}</a></td>
      <td data-label="العنوان">${igEscape(order.address)}</td>
      <td data-label="السعر">${igFormatNumber(order.total_price)} ${igEscape(order.currency)}</td>
      <td data-label="نسبة">${order.ratio ? igFormatNumber(order.ratio) : '-'}</td>
      <td data-label="الحالة"><span class="status-badge status-${igEscape(order.status)}">${igEscape(order.status)}</span></td>
      <td class="text-wrap-column" data-label="ملاحظة">${igEscape(order.note || '-')}</td>
      <td data-label="السائق">${igEscape(order.driver_name || 'بدون سائق')}</td>
      <td data-label="الشركة">${igEscape(order.company_name)}</td>
      <td data-label="التاريخ">${igFormatDate(order.created_at, true)}</td>
      <td data-label="إجراء">${orderActionHtml(order)}</td>
    </tr>`).join('');

  if (newOrderIds.size > 0) {
    setTimeout(() => {
      document.querySelectorAll('#instagramOrdersBody tr.highlight-new').forEach(tr => {
        tr.classList.remove('highlight-new');
      });
    }, 10000);
  }

  updateBulkBar();
  updateInstagramTotals();
}

function updateBulkBar() {
  const bar = document.getElementById('igBulkBar');
  bar.hidden = igState.selectedOrders.size === 0;
  document.getElementById('igSelectedCount').textContent = `${igState.selectedOrders.size} محدد`;
  document.getElementById('igSelectAll').checked = igState.orders.length > 0 && igState.selectedOrders.size === igState.orders.length;
  updateBulkActionOptions();
}

function updateBulkActionOptions() {
  const action = document.getElementById('igBulkAction').value;
  document.getElementById('igBulkStatusGroup').style.display = action === 'status' ? 'inline-block' : 'none';
  document.getElementById('igBulkDriverGroup').style.display = action === 'driver' ? 'inline-block' : 'none';
  document.getElementById('igBulkCompanyGroup').style.display = action === 'company' ? 'inline-block' : 'none';
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
  await loadInstagramOrders(false);
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
      await openEditOrderModal(order);
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
          throw new Error(errorMessage);
        }

        igNotify('تم حذف الطلب نهائياً');
        await loadInstagramOrders(false);
        if (igState.loadedSections.has('inventory')) {
          await loadInstagramInventory();
        }
      } catch (error) {
        igNotify(error.message, 'error');
      }
    }
  } catch (error) {
    igNotify(error.message, 'error');
  }
});

// ===== دوال المودالات =====
function closeModal(modal) { modal.hidden = true; }

document.querySelectorAll('[data-close-modal]').forEach(btn => {
  btn.addEventListener('click', () => {
    const modal = btn.closest('.modal-overlay');
    if (modal) closeModal(modal);
  });
});

function getEditableInstagramVariants() {
  return igState.orderEditProducts.flatMap((product) => (
    (product.variants || []).map((variant) => ({
      ...variant,
      product_id: product.id,
      product_name: product.name,
      unit_price: product.unit_price,
      currency: product.currency || 'ل.س',
      product_status: product.status
    }))
  ));
}

function getEditableInstagramVariant(variantId) {
  return getEditableInstagramVariants().find((variant) => variant.id === variantId) || null;
}

function editableVariantOptions(selectedId = '', snapshot = {}) {
  const variants = getEditableInstagramVariants();
  const selectedExists = variants.some((variant) => variant.id === selectedId);
  const legacyOption = selectedId && !selectedExists
    ? `<option value="${igEscape(selectedId)}" selected>${igEscape(snapshot.product_name || 'الصنف الحالي')} — ${igEscape(snapshot.color || '')} / ${igEscape(snapshot.size || '')}</option>`
    : '';
  return `<option value="">اختر الصنف واللون والمقاس</option>${legacyOption}${variants.map((variant) => (
    `<option value="${igEscape(variant.id)}" ${variant.id === selectedId ? 'selected' : ''}>${igEscape(variant.product_name)} — ${igEscape(variant.color)} / ${igEscape(variant.size)}${variant.is_active ? '' : ' (متوقف)'}</option>`
  )).join('')}`;
}

function addEditItemRow(item = {}) {
  const container = document.getElementById('igEditItems');
  const row = document.createElement('div');
  row.className = 'ig-edit-item-row';
  row.innerHTML = `
    <div class="form-group ig-edit-item-variant-group">
      <label>الصنف والاختيار</label>
      <select class="ig-edit-item-variant">${editableVariantOptions(item.variant_id || '', item)} </select>
    </div>
    <div class="form-group ig-edit-item-quantity-group">
      <label>الكمية</label>
      <div class="ig-edit-quantity-stepper">
        <button type="button" data-item-action="decrease" aria-label="إنقاص الكمية">−</button>
        <input class="ig-edit-item-quantity" type="number" min="1" max="1000" step="1" value="${Math.max(1, Number(item.quantity) || 1)}" inputmode="numeric">
        <button type="button" data-item-action="increase" aria-label="زيادة الكمية">+</button>
      </div>
    </div>
    <div class="ig-edit-item-summary">
      <span>سعر القطعة: <strong data-edit-item-unit-price>-</strong></span>
      <span>الإجمالي: <strong data-edit-item-line-total>-</strong></span>
    </div>
    <button type="button" class="btn btn-danger btn-sm ig-edit-item-remove" data-item-action="remove">حذف الصنف</button>`;
  container.appendChild(row);
  updateEditItemsSummary();
}

function renderEditItems(items = []) {
  const container = document.getElementById('igEditItems');
  container.innerHTML = '';
  (items.length ? items : [{}]).forEach((item) => addEditItemRow(item));
}

function updateEditItemsSummary() {
  const priceInput = document.getElementById('igEditTotalPrice');
  const rows = [...document.querySelectorAll('#igEditItems .ig-edit-item-row')];
  let total = 0;
  let currency = '';
  let mixedCurrency = false;

  rows.forEach((row) => {
    const variant = getEditableInstagramVariant(row.querySelector('.ig-edit-item-variant')?.value);
    const quantityInput = row.querySelector('.ig-edit-item-quantity');
    const quantity = Math.max(1, Math.min(1000, Number(quantityInput?.value) || 1));
    if (quantityInput) quantityInput.value = quantity;
    const unitPrice = Number(variant?.unit_price) || 0;
    const rowCurrency = variant?.currency || '';
    if (variant) {
      if (currency && currency !== rowCurrency) mixedCurrency = true;
      currency ||= rowCurrency;
      total += unitPrice * quantity;
    }
    const unitPriceElement = row.querySelector('[data-edit-item-unit-price]');
    const lineTotalElement = row.querySelector('[data-edit-item-line-total]');
    if (unitPriceElement) unitPriceElement.textContent = variant ? `${igFormatNumber(unitPrice)} ${rowCurrency}` : '-';
    if (lineTotalElement) lineTotalElement.textContent = variant ? `${igFormatNumber(unitPrice * quantity)} ${rowCurrency}` : '-';
  });

  if (priceInput?.dataset.autoTotal === 'true' && (mixedCurrency || !currency)) {
    priceInput.dataset.autoTotal = 'false';
  }
  if (priceInput?.dataset.autoTotal === 'true' && !mixedCurrency && currency) {
    priceInput.value = Number.isInteger(total) ? String(total) : total.toFixed(2);
  }
}

function collectEditItems() {
  const quantityByVariant = new Map();
  for (const row of document.querySelectorAll('#igEditItems .ig-edit-item-row')) {
    const variantId = row.querySelector('.ig-edit-item-variant')?.value || '';
    const quantity = Number(row.querySelector('.ig-edit-item-quantity')?.value);
    if (!variantId) {
      igNotify('اختر الصنف لكل سطر قبل الحفظ', 'error');
      return null;
    }
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1000) {
      igNotify('الكمية يجب أن تكون بين 1 و1000', 'error');
      return null;
    }
    const mergedQuantity = (quantityByVariant.get(variantId) || 0) + quantity;
    if (mergedQuantity > 1000) {
      igNotify('إجمالي كمية الصنف الواحد يتجاوز الحد المسموح', 'error');
      return null;
    }
    quantityByVariant.set(variantId, mergedQuantity);
  }
  return [...quantityByVariant].map(([variant_id, quantity]) => ({ variant_id, quantity }));
}

async function openEditOrderModal(order) {
  igState.orderEditProducts = await igApi('/api/instagram/products');
  document.getElementById('igEditOrderId').value = order.id;
  document.getElementById('igEditOrderNumber').value = order.order_number || '';
  document.getElementById('igEditCustomerName').value = order.customer_name || '';
  document.getElementById('igEditCustomerNumber').value = order.customer_number || '';
  document.getElementById('igEditAddress').value = order.address || '';
  document.getElementById('igEditTotalPrice').value = order.total_price || 0;
  document.getElementById('igEditRatio').value = order.ratio ?? 0;
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

  renderEditItems(order.items || []);
  const originalItemsTotal = (order.items || []).reduce((sum, item) => (
    sum + (Number(item.unit_price) || 0) * (Number(item.quantity) || 0)
  ), 0);
  const originalCurrencies = new Set((order.items || []).map((item) => (
    item.currency || getEditableInstagramVariant(item.variant_id)?.currency
  )).filter(Boolean));
  const autoTotal = originalCurrencies.size <= 1
    && (order.items || []).length > 0
    && Math.abs((Number(order.total_price) || 0) - originalItemsTotal) < 0.01;
  document.getElementById('igEditTotalPrice').dataset.autoTotal = autoTotal ? 'true' : 'false';
  updateEditItemsSummary();
  document.getElementById('igEditModal').hidden = false;
}

document.getElementById('igEditItems').addEventListener('change', updateEditItemsSummary);
document.getElementById('igEditItems').addEventListener('input', updateEditItemsSummary);
document.getElementById('igEditItems').addEventListener('click', (event) => {
  const button = event.target.closest('[data-item-action]');
  if (!button) return;
  const row = button.closest('.ig-edit-item-row');
  const input = row?.querySelector('.ig-edit-item-quantity');
  if (!row || !input) return;
  const action = button.dataset.itemAction;
  if (action === 'remove') {
    const rows = document.querySelectorAll('#igEditItems .ig-edit-item-row');
    if (rows.length <= 1) return igNotify('لا يمكن حذف جميع أصناف الطلب', 'error');
    row.remove();
  } else if (action === 'increase') {
    input.value = Math.min(1000, Number(input.value) + 1);
  } else if (action === 'decrease') {
    input.value = Math.max(1, Number(input.value) - 1);
  }
  updateEditItemsSummary();
});

document.getElementById('igAddEditItem').addEventListener('click', () => addEditItemRow());
document.getElementById('igEditTotalPrice').addEventListener('input', (event) => {
  event.target.dataset.autoTotal = 'false';
});

document.getElementById('igSaveEditOrder').addEventListener('click', async () => {
  const id = document.getElementById('igEditOrderId').value;
  const originalOrder = igState.orders.find(o => o.id === id);
  const items = collectEditItems();
  if (!items) return;
  const totalPrice = Number(document.getElementById('igEditTotalPrice').value);
  const ratio = Number(document.getElementById('igEditRatio').value || 0);
  if (!Number.isFinite(totalPrice) || totalPrice < 0 || !Number.isFinite(ratio) || ratio < 0) {
    return igNotify('السعر أو النسبة غير صالح', 'error');
  }

  const saveButton = document.getElementById('igSaveEditOrder');
  const body = {
    order_number: document.getElementById('igEditOrderNumber').value,
    customer_name: document.getElementById('igEditCustomerName').value,
    customer_number: document.getElementById('igEditCustomerNumber').value,
    address: document.getElementById('igEditAddress').value,
    total_price: totalPrice,
    ratio,
    note: document.getElementById('igEditNote').value,
    status: document.getElementById('igEditStatus').value,
    driver_id: document.getElementById('igEditDriverId').value || null,
    company_id: document.getElementById('igEditCompanyId').value || originalOrder?.company_id || null,
    items,
    recalculate_total_price: document.getElementById('igEditTotalPrice').dataset.autoTotal === 'true'
  };

  saveButton.disabled = true;
  try {
    await igApi(`/api/instagram/orders/${id}`, { method: 'PATCH', body });
    igNotify('تم حفظ تعديلات الطلب والأصناف');
    closeModal(document.getElementById('igEditModal'));
    await loadInstagramOrders(false);
    if (igState.loadedSections.has('inventory')) await loadInstagramInventory();
  } catch (error) {
    igNotify(error.message, 'error');
  } finally {
    saveButton.disabled = false;
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
      body: { ids: [orderId], driverId, ratio: percentage ? Number(percentage) : null }
    });
    igNotify('تم تعيين السائق');
    closeModal(document.getElementById('igAssignModal'));
    await loadInstagramOrders(false);
  } catch (error) { igNotify(error.message, 'error'); }
});

document.querySelectorAll('.ig-type-tab').forEach((button) => button.addEventListener('click', () => {
  document.querySelectorAll('.ig-type-tab').forEach((item) => item.classList.remove('active'));
  button.classList.add('active');
  loadInstagramOrders(false);
}));

document.getElementById('refreshInstagramOrders').addEventListener('click', () => loadInstagramOrders(false));
document.getElementById('applyInstagramOrderFilters').addEventListener('click', () => {
  if (igState.allOrders.length) applyInstagramOrderSearch();
  loadInstagramOrders(false);
});
const igSearchInput = document.getElementById('igOrderSearch');
let igSearchTimer;
igSearchInput.addEventListener('input', () => {
  window.clearTimeout(igSearchTimer);
  igSearchTimer = window.setTimeout(applyInstagramOrderSearch, 180);
});
igSearchInput.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  window.clearTimeout(igSearchTimer);
  applyInstagramOrderSearch();
});
document.getElementById('clearInstagramOrderFilters').addEventListener('click', () => {
  ['igOrderSearch', 'igOrderCompany', 'igOrderStatus', 'igOrderDriver', 'igOrderStart', 'igOrderEnd'].forEach((id) => { document.getElementById(id).value = ''; });
  document.querySelectorAll('.ig-type-tab').forEach((item) => item.classList.toggle('active', item.dataset.type === ''));
  loadInstagramOrders(false);
});

// ===== الإجراءات الجماعية =====
document.getElementById('igBulkAction').addEventListener('change', updateBulkActionOptions);

document.getElementById('igApplyBulkAction').addEventListener('click', async () => {
  const action = document.getElementById('igBulkAction').value;
  if (!action) return igNotify('اختر إجراءً أولاً', 'error');
  const ids = [...igState.selectedOrders];
  if (!ids.length) return igNotify('لم يتم تحديد طلبات', 'error');

  try {
    if (action === 'print') {
      printInstagramOrders(igState.orders.filter(o => igState.selectedOrders.has(o.id)));
      return;
    }
    if (action === 'status') {
      const status = document.getElementById('igBulkStatus').value;
      if (!status) return igNotify('اختر الحالة', 'error');
      await performOrderAction('/api/instagram/orders/bulk-status', { ids, status }, 'تم تحديث حالات الطلبات');
    } else if (action === 'driver') {
      const driverId = document.getElementById('igBulkDriver').value;
      if (!driverId) return igNotify('اختر السائق', 'error');
      const deliveryIds = igState.orders.filter(o => igState.selectedOrders.has(o.id) && o.order_type === 'توصيل').map(o => o.id);
      if (!deliveryIds.length) return igNotify('حدد طلب توصيل واحداً على الأقل', 'error');
      await performOrderAction('/api/instagram/orders/assign-driver', { ids: deliveryIds, driverId }, 'تم تعيين السائق لطلبات التوصيل المحددة');
    } else if (action === 'company') {
      const companyId = document.getElementById('igBulkCompany').value;
      if (!companyId) return igNotify('اختر الشركة', 'error');
      await igApi('/api/instagram/orders/bulk-company', { method: 'PATCH', body: { ids, companyId } });
      igNotify('تم تعيين الشركة');
      await loadInstagramOrders(false);
    } else if (action === 'delete') {
      if (!confirm(`هل أنت متأكد من حذف ${ids.length} طلبات نهائياً؟`)) return;
      await igApi('/api/instagram/orders/bulk-delete', { method: 'POST', body: { ids } });
      igNotify('تم حذف الطلبات');
      await loadInstagramOrders(false);
      if (igState.loadedSections.has('inventory')) await loadInstagramInventory();
    }
  } catch (error) {
    igNotify(error.message, 'error');
  }
});

function printInstagramOrders(orders) {
  if (!orders.length) return igNotify('لم يتم تحديد طلبات للطباعة', 'error');

  const printWindow = window.open('', '_blank', 'width=600,height=400');

  const cardsHtml = orders.map((order) => {
    const contentsPlain = order.order_contents || (order.items || []).map(item =>
      `${item.product_name} - ${item.color}/${item.size} × ${item.quantity}`
    ).join('، ');

    return `
    <div class="card">
      <div class="header">Wolf Order</div>
      <div class="detail-row"><span class="detail-label">رقم الطلب:</span><span class="detail-value">${order.order_number}</span></div>
      <div class="detail-row"><span class="detail-label">المحتويات:</span><span class="detail-value">${contentsPlain}</span></div>
      <div class="detail-row"><span class="detail-label">العميل:</span><span class="detail-value">${igEscape(order.customer_name)}</span></div>
      <div class="detail-row"><span class="detail-label">رقم العميل:</span><span class="detail-value">${igEscape(order.customer_number || '-')}</span></div>
      <div class="detail-row"><span class="detail-label">العنوان:</span><span class="detail-value">${igEscape(order.address)}</span></div>
      <div class="detail-row"><span class="detail-label">السعر:</span><span class="detail-value">${igFormatNumber(order.total_price)} ${igEscape(order.currency)}</span></div>
      <div class="detail-row"><span class="detail-label">نوع الطلب:</span><span class="detail-value">توصيل</span></div>
      <div class="detail-row"><span class="detail-label">اسم الشركة:</span><span class="detail-value">${igEscape(order.company_name || '-')}</span></div>
      <div class="detail-row"><span class="detail-label">ملاحظة:</span><span class="detail-value">${igEscape(order.note || '-')}</span></div>
      <div class="footer">
        للشكاوي أو الاستعلام بالنسبة لخدمة التوصيل<br>
        يرجى التواصل على الرقم: 0997665442
      </div>
      <div class="footer thank">شكرًا لتعاملكم مع Wolf Order</div>
    </div>`;
  }).join('');

  printWindow.document.write(`
    <!DOCTYPE html>
    <html dir="rtl" lang="ar">
    <head>
      <meta charset="UTF-8">
      <title>طباعة طلب</title>
      <style>
        @page { size: 100mm 150mm; margin: 3mm; }
        body { width: 100mm; font-family: 'Arial', sans-serif; font-size: 15px; font-weight: bold; color: #000; direction: rtl; margin: 0 auto; padding: 0; background: white; }
        .card { border: 2px solid #000; padding: 4mm; page-break-after: always; page-break-inside: avoid; }
        .card:last-child { page-break-after: auto; }
        .header { text-align: center; font-size: 20px; font-weight: bold; margin-bottom: 8px; border-bottom: 2px solid #000; padding-bottom: 5px; }
        .detail-row { display: flex; justify-content: flex-start; padding: 5px 0; border-bottom: 1px dotted #555; line-height: 1.6; gap: 10px; }
        .detail-label { font-weight: bold; width: 25%; text-align: right; color: #000; white-space: nowrap; }
        .detail-value { width: 70%; text-align: right; color: #000; word-break: break-word; }
        .footer { text-align: center; font-size: 11px; margin-top: 10px; border-top: 2px solid #000; padding-top: 5px; font-weight: bold; }
        .thank { margin-top: 5px; border-top: none; }
        @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
      </style>
    </head>
    <body>
      ${cardsHtml}
      <script>window.onload = () => { window.print(); setTimeout(() => window.close(), 500); };</script>
    </body>
    </html>
  `);
  printWindow.document.close();
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
    document.getElementById('instagramInventoryBody').innerHTML = igState.inventory.length ? igState.inventory.map((row) => `<tr><td data-label="الشركة">${igEscape(row.company_name)}</td><td data-label="الصنف">${igEscape(row.product_name)}</td><td data-label="اللون">${igEscape(row.color)}</td><td data-label="المقاس">${igEscape(row.size)}</td><td data-label="الكلية">${row.quantity_total}</td><td data-label="محجوز التوصيل">${row.reserved_delivery}</td><td data-label="المباعة">${row.sold}</td><td data-label="المؤجلة">${row.postponed}</td><td data-label="المرتجع">${row.returned}</td><td data-label="الإلغاء">${row.cancelled}</td><td data-label="المتبقية"><strong>${row.remaining}</strong></td></tr>`).join('') : '<tr><td colspan="11">لا توجد بيانات جرد.</td></tr>';
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
    const nextOrderNumber = link?.next_order_number || 1;
    const isActive = link?.is_active ?? false;

    return `<article class="ig-mini-card link-card" data-company-id="${company.id}">
      <h3>${igEscape(company.name)}</h3>
      <div class="form-group">
        <label>الرابط</label>
        <input class="link-slug" dir="ltr" value="${igEscape(slug)}">
      </div>
      <div class="form-group">
        <label>بداية ترقيم الطلبات</label>
        <input class="link-order-start" type="number" min="1" value="${nextOrderNumber}">
      </div>
      <div class="link-status">
        <span>الحالة: <strong>${isActive ? 'مفعل' : 'غير مفعل'}</strong></span>
      </div>
      <p class="link-preview">${location.origin}/o/${igEscape(slug)}</p>
      <div class="link-actions">
        <button class="btn btn-${isActive ? 'danger' : 'success'} btn-sm" data-link-action="toggle">${isActive ? 'إيقاف' : 'تفعيل'}</button>
        <button class="btn btn-primary btn-sm" data-link-action="save">حفظ الرابط</button>
        <button class="btn btn-secondary btn-sm" data-link-action="save-order-start">حفظ بداية الترقيم</button>
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
      // حفظ الرابط كما في السابق
      await igApi('/api/instagram/links', { method: 'POST', body: { companyId: card.dataset.companyId, slug, isActive: currentActive } });
      igNotify('تم حفظ رابط الشركة');
      await loadInstagramBootstrap();
    } else if (button.dataset.linkAction === 'toggle') {
      await igApi('/api/instagram/links', { method: 'POST', body: { companyId: card.dataset.companyId, slug, isActive: !currentActive } });
      igNotify(currentActive ? 'تم إيقاف الرابط' : 'تم تفعيل الرابط');
      await loadInstagramBootstrap();
    } else if (button.dataset.linkAction === 'save-order-start') {
      const nextOrderNumber = card.querySelector('.link-order-start').value;
      await igApi('/api/instagram/links/order-start', { method: 'POST', body: { companyId: card.dataset.companyId, nextOrderNumber: Number(nextOrderNumber) } });
      igNotify('تم حفظ بداية الترقيم');
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
    const response = await fetch(`/api/instagram/orders/export?${params}`, { headers: { Authorization: `Bearer ${igToken}` } });
    if (!response.ok) {
      let errorMessage = 'تعذر التصدير';
      try {
        const data = await response.json();
        if (data && data.message) errorMessage = data.message;
      } catch (e) {}
      throw new Error(errorMessage);
    }

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
    connectInstagramSocket();
    await loadInstagramBootstrap();
    addVariantBuilderRow();
    await loadInstagramOrders(false);
  } catch (error) { igNotify(error.message, 'error'); }
}

initializeInstagramAdmin();
