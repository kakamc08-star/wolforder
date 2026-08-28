(function instagramAdminDashboard() {
  'use strict';

  const user = JSON.parse(localStorage.getItem('user') || 'null');
  if (!user || user.role !== 'admin') return window.location.replace('/login.html');
  document.getElementById('userNameDisplay').textContent = user.name || user.username;

  const state = { orderPage: 1, orderPages: 1, inventoryPage: 1, inventoryPages: 1, orderType: '', companies: [], drivers: [], products: [], orderController: null };
  let searchTimer = null;
  let refreshTimer = null;
  const selectedShippingOrders = new Set();

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
  }

  function notify(text, type = 'info') {
    const area = document.getElementById('notificationArea');
    const item = document.createElement('div');
    item.className = `toast-notification toast-${type}`;
    item.textContent = text;
    area.appendChild(item);
    setTimeout(() => item.remove(), 4500);
  }

  function isoRange(dateValue, end = false) {
    return dateValue ? new Date(`${dateValue}T${end ? '23:59:59.999' : '00:00:00'}`).toISOString() : '';
  }

  function fillCompanySelects() {
    const ids = ['instagramCompanyFilter', 'productCompany', 'viewerCompany', 'exportCompany'];
    ids.forEach(id => {
      const select = document.getElementById(id);
      const first = select.options[0].outerHTML;
      select.innerHTML = first + state.companies.map(company => `<option value="${escapeHtml(company.id)}">${escapeHtml(company.name)}</option>`).join('');
    });
  }

  async function loadReferenceData() {
    const [companiesResponse, driversResponse] = await Promise.all([apiFetch('/api/instagram-orders/companies'), apiFetch('/api/instagram-orders/drivers')]);
    if (!companiesResponse.ok || !driversResponse.ok) throw new Error('تعذر تحميل الشركات والسائقين');
    state.companies = await companiesResponse.json();
    state.drivers = await driversResponse.json();
    fillCompanySelects();
    renderCompanyLinks();
  }

  function orderParams() {
    const params = new URLSearchParams({ page: state.orderPage, limit: 50 });
    const map = {
      search: document.getElementById('instagramSearch').value.trim(),
      companyId: document.getElementById('instagramCompanyFilter').value,
      status: document.getElementById('instagramStatusFilter').value,
      startDate: isoRange(document.getElementById('instagramStartDate').value),
      endDate: isoRange(document.getElementById('instagramEndDate').value, true),
      orderType: state.orderType
    };
    Object.entries(map).forEach(([key, value]) => { if (value) params.set(key, value); });
    return params;
  }

  async function loadOrders({ reset = false } = {}) {
    if (reset) state.orderPage = 1;
    if (state.orderController) state.orderController.abort();
    state.orderController = new AbortController();
    try {
      const response = await apiFetch(`/api/instagram-orders?${orderParams()}`, { signal: state.orderController.signal });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || 'تعذر تحميل الطلبات');
      state.orderPages = data.pagination.totalPages;
      renderOrders(data.orders || []);
      document.getElementById('instagramPageInfo').textContent = `صفحة ${data.pagination.page} من ${data.pagination.totalPages} — ${data.pagination.total} طلب`;
      document.getElementById('instagramPrevPage').disabled = state.orderPage <= 1;
      document.getElementById('instagramNextPage').disabled = state.orderPage >= state.orderPages;
    } catch (error) {
      if (error.name !== 'AbortError') notify(error.message, 'error');
    }
  }

  function itemSummary(items) {
    return (items || []).map(item => `${escapeHtml(item.product_name)} — ${escapeHtml(item.color)} / ${escapeHtml(item.size)} × ${Number(item.quantity)}`).join('<br>');
  }

  function renderOrders(orders) {
    const body = document.getElementById('instagramOrdersBody');
    body.innerHTML = orders.length ? orders.map(order => {
      const driverOptions = `<option value="">اختر</option>` + state.drivers.map(driver => `<option value="${escapeHtml(driver.id)}" ${String(driver.id) === String(order.driver_id) ? 'selected' : ''}>${escapeHtml(driver.name)}</option>`).join('');
      const statusOptions = ['قيد المتابعة', 'تم', 'مؤجل', 'ملغي', 'مرتجع'].map(status => `<option ${status === order.status ? 'selected' : ''}>${status}</option>`).join('');
      const canBatch = state.orderType === 'شحن' && order.order_type === 'شحن' && !order.shipping_batch_id && ['قيد المتابعة', 'مؤجل'].includes(order.status);
      const shippingBatchControl = order.shipping_batch_id
        ? `<span>سُلّم إلى ${escapeHtml(order.shipping_partner || 'الشريكة')}</span>`
        : (canBatch ? '<span>بانتظار التجميع</span>' : '<span>غير متاح للتجميع</span>');
      return `<tr>
        <td>${canBatch ? `<input type="checkbox" class="shipping-order-checkbox" value="${order.id}" ${selectedShippingOrders.has(String(order.id)) ? 'checked' : ''} aria-label="اختيار طلب الشحن ${escapeHtml(order.order_number)}">` : Number(order.order_number)}</td><td>${escapeHtml(order.order_number)}</td><td>${escapeHtml(order.company_name)}</td>
        <td><strong>${escapeHtml(order.customer_name)}</strong><br><a href="tel:${escapeHtml(order.customer_phone)}">${escapeHtml(order.customer_phone)}</a></td>
        <td>${escapeHtml(order.address)}</td><td>${escapeHtml(order.order_type)}</td><td class="text-wrap-column">${itemSummary(order.items)}</td>
        <td><select class="instagram-row-status" data-id="${order.id}">${statusOptions}</select></td>
        <td>${order.order_type === 'توصيل' ? `<select class="instagram-row-driver" data-id="${order.id}">${driverOptions}</select>` : shippingBatchControl}</td>
        <td>${new Date(order.created_at).toLocaleString('ar')}</td>
        <td><button class="btn btn-primary btn-sm save-instagram-order" data-id="${order.id}">حفظ</button></td>
      </tr>`;
    }).join('') : '<tr><td colspan="11">لا توجد طلبات مطابقة.</td></tr>';
  }

  async function saveOrder(rowButton) {
    const id = rowButton.dataset.id;
    const status = document.querySelector(`.instagram-row-status[data-id="${id}"]`).value;
    rowButton.disabled = true;
    try {
      const statusResponse = await apiFetch(`/api/instagram-orders/orders/${id}/status`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) });
      const statusData = await statusResponse.json().catch(() => ({}));
      if (!statusResponse.ok) throw new Error(statusData.message || 'تعذر تغيير الحالة');
      const driver = document.querySelector(`.instagram-row-driver[data-id="${id}"]`);
      if (driver && driver.value) {
        const driverResponse = await apiFetch(`/api/instagram-orders/orders/${id}/assign-driver`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ driverId: driver.value }) });
        const driverData = await driverResponse.json().catch(() => ({}));
        if (!driverResponse.ok) throw new Error(driverData.message || 'تعذر تعيين السائق');
      }
      notify('تم تحديث الطلب', 'success');
      await Promise.all([loadOrders(), loadInventory()]);
    } catch (error) {
      notify(error.message, 'error');
    } finally { rowButton.disabled = false; }
  }

  async function createShippingBatch() {
    if (!selectedShippingOrders.size) return notify('اختر طلب شحن واحداً على الأقل', 'error');
    const partnerName = (prompt('اسم شريكة الشحن التي ستستلم الدفعة:') || '').trim();
    if (partnerName.length < 2) return notify('أدخل اسم الشريكة', 'error');
    const note = (prompt('ملاحظة الدفعة (اختياري):') || '').trim();
    const button = document.getElementById('createShippingBatch');
    button.disabled = true;
    try {
      const response = await apiFetch('/api/instagram-orders/shipping-batches', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderIds: Array.from(selectedShippingOrders), partnerName, note })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || 'تعذر إنشاء دفعة الشحن');
      selectedShippingOrders.clear();
      notify(`تم إنشاء دفعة الشحن رقم ${data.batch_number} وتسليمها إلى ${data.partner_name}`, 'success');
      await loadOrders();
    } catch (error) { notify(error.message, 'error'); }
    finally { button.disabled = false; }
  }

  function addVariantRow() {
    const row = document.createElement('div');
    row.className = 'instagram-variant-row';
    row.innerHTML = '<div class="form-group"><label>اللون</label><input class="variant-color" required maxlength="60"></div><div class="form-group"><label>المقاس</label><input class="variant-size" required maxlength="60"></div><div class="form-group"><label>الكمية</label><input class="variant-quantity" type="number" min="0" value="0" required></div><button class="btn btn-danger btn-sm" type="button">حذف</button>';
    document.getElementById('variantRows').appendChild(row);
    row.querySelector('button').addEventListener('click', () => { if (document.getElementById('variantRows').children.length > 1) row.remove(); });
  }

  async function loadProducts() {
    const companyId = document.getElementById('productCompany').value;
    const url = companyId ? `/api/instagram-orders/products?companyId=${encodeURIComponent(companyId)}` : '/api/instagram-orders/products';
    const response = await apiFetch(url);
    if (!response.ok) return notify('تعذر تحميل الأصناف', 'error');
    state.products = await response.json();
    renderProducts();
    document.getElementById('exportProduct').innerHTML = '<option value="">كل الأصناف</option>' + state.products.map(product => `<option value="${product.id}">${escapeHtml(product.name)}</option>`).join('');
  }

  function renderProducts() {
    document.getElementById('instagramProductsList').innerHTML = state.products.length ? state.products.map(product => `<article class="instagram-product-card"><div><strong>${escapeHtml(product.name)}</strong><small>${product.is_active ? 'مفعّل' : 'متوقف'} · ${(product.variants || []).length} تركيبة</small></div><div class="product-card-actions"><button class="btn btn-secondary btn-sm add-instagram-variant" data-id="${product.id}">+ لون/مقاس</button><button class="btn btn-sm ${product.is_active ? 'btn-danger' : 'btn-primary'} toggle-instagram-product" data-id="${product.id}" data-active="${product.is_active}">${product.is_active ? 'إيقاف' : 'تفعيل'}</button></div></article>`).join('') : '<p>لا توجد أصناف بعد.</p>';
  }

  async function loadInventory() {
    const params = new URLSearchParams({ page: state.inventoryPage, limit: 100 });
    const companyId = document.getElementById('instagramCompanyFilter').value;
    if (companyId) params.set('companyId', companyId);
    const response = await apiFetch(`/api/instagram-orders/inventory?${params}`);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return notify(data.message || 'تعذر تحميل الجرد', 'error');
    state.inventoryPages = data.pagination.totalPages;
    document.getElementById('inventoryPageInfo').textContent = `صفحة ${data.pagination.page} من ${data.pagination.totalPages} — ${data.pagination.total} تركيبة`;
    document.getElementById('inventoryPrevPage').disabled = state.inventoryPage <= 1;
    document.getElementById('inventoryNextPage').disabled = state.inventoryPage >= state.inventoryPages;
    document.getElementById('instagramInventoryBody').innerHTML = (data.inventory || []).map(item => `<tr><td>${escapeHtml(item.company_name)}</td><td>${escapeHtml(item.product_name)}</td><td>${escapeHtml(item.color)}</td><td>${escapeHtml(item.size)}</td><td>${item.initial_quantity}</td><td>${item.sold_quantity}</td><td>${item.reserved_quantity}</td><td>${item.postponed_quantity}</td><td>${item.cancelled_quantity}</td><td>${item.returned_quantity}</td><td><strong>${item.remaining_quantity}</strong></td><td><button class="btn btn-secondary btn-sm adjust-instagram-stock" data-id="${item.inventory_id}" data-label="${escapeHtml(item.product_name)} / ${escapeHtml(item.color)} / ${escapeHtml(item.size)}">تعديل</button></td></tr>`).join('');
  }

  async function renderCompanyLinks() {
    document.getElementById('instagramCompanyLinks').innerHTML = state.companies.map(company => {
      const link = company.instagramLink;
      const url = link ? `${location.origin}/instagram/${link.public_slug}` : '';
      return `<article class="instagram-link-card"><div><strong>${escapeHtml(company.name)}</strong><small>${url ? escapeHtml(url) : 'لم يتم إنشاء رابط بعد'}</small></div>${url ? `<button class="btn btn-secondary btn-sm copy-instagram-link" data-url="${escapeHtml(url)}">نسخ الرابط</button>` : `<button class="btn btn-primary btn-sm create-instagram-link" data-id="${company.id}">إنشاء الرابط</button>`}</article>`;
    }).join('');
  }

  function setExportRange() {
    const period = document.getElementById('exportPeriod').value;
    if (period === 'custom') return;
    const now = new Date();
    const start = new Date(now);
    if (period === 'week') start.setDate(now.getDate() - ((now.getDay() + 6) % 7));
    if (period === 'month') start.setDate(1);
    const date = value => `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
    document.getElementById('exportStartDate').value = date(start);
    document.getElementById('exportEndDate').value = date(now);
  }

  async function exportExcel() {
    const params = new URLSearchParams();
    const values = {
      startDate: isoRange(document.getElementById('exportStartDate').value), endDate: isoRange(document.getElementById('exportEndDate').value, true),
      orderType: document.getElementById('exportOrderType').value, status: document.getElementById('exportStatus').value,
      companyId: document.getElementById('exportCompany').value, productId: document.getElementById('exportProduct').value
    };
    Object.entries(values).forEach(([key, value]) => { if (value) params.set(key, value); });
    const response = await apiFetch(`/api/instagram-orders/export?${params}`);
    if (!response.ok) return notify('تعذر إنشاء ملف Excel', 'error');
    const blob = await response.blob();
    const anchor = document.createElement('a'); anchor.href = URL.createObjectURL(blob); anchor.download = `instagram-inventory-${new Date().toISOString().slice(0, 10)}.xls`; anchor.click();
    setTimeout(() => URL.revokeObjectURL(anchor.href), 1000);
  }

  document.addEventListener('click', async event => {
    const save = event.target.closest('.save-instagram-order'); if (save) return saveOrder(save);
    const createLink = event.target.closest('.create-instagram-link');
    if (createLink) { const response = await apiFetch(`/api/instagram-orders/companies/${createLink.dataset.id}/link`, { method: 'POST' }); if (response.ok) { await loadReferenceData(); notify('تم إنشاء الرابط', 'success'); } return; }
    const copy = event.target.closest('.copy-instagram-link'); if (copy) { await navigator.clipboard.writeText(copy.dataset.url); notify('تم نسخ الرابط', 'success'); return; }
    const toggle = event.target.closest('.toggle-instagram-product');
    if (toggle) { const response = await apiFetch(`/api/instagram-orders/products/${toggle.dataset.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: toggle.dataset.active !== 'true' }) }); if (response.ok) { await loadProducts(); notify('تم تحديث الصنف', 'success'); } return; }
    const addVariant = event.target.closest('.add-instagram-variant');
    if (addVariant) {
      const color = prompt('اللون الجديد:') || ''; const size = prompt('المقاس الجديد:') || ''; const quantity = Number(prompt('الكمية الأساسية:', '0'));
      if (!color.trim() || !size.trim() || !Number.isInteger(quantity) || quantity < 0) return notify('بيانات التركيبة غير صالحة', 'error');
      const response = await apiFetch(`/api/instagram-orders/products/${addVariant.dataset.id}/variants`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ color, size, quantity }) });
      const data = await response.json().catch(() => ({})); notify(response.ok ? 'تمت إضافة اللون والمقاس' : (data.message || 'تعذر الإضافة'), response.ok ? 'success' : 'error'); if (response.ok) await Promise.all([loadProducts(), loadInventory()]); return;
    }
    const adjust = event.target.closest('.adjust-instagram-stock');
    if (adjust) { const delta = Number(prompt(`التغيير على ${adjust.dataset.label}\nاكتب رقماً موجباً للزيادة أو سالباً للنقصان:`)); if (!Number.isInteger(delta) || delta === 0) return; const reason = prompt('سبب التعديل:') || ''; const response = await apiFetch(`/api/instagram-orders/inventory/${adjust.dataset.id}/adjust`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ delta, reason }) }); const data = await response.json().catch(() => ({})); notify(response.ok ? 'تم تعديل المخزون' : (data.message || 'تعذر التعديل'), response.ok ? 'success' : 'error'); if (response.ok) loadInventory(); }
  });

  document.addEventListener('change', event => {
    const checkbox = event.target.closest('.shipping-order-checkbox');
    if (!checkbox) return;
    if (checkbox.checked) selectedShippingOrders.add(String(checkbox.value));
    else selectedShippingOrders.delete(String(checkbox.value));
  });

  document.getElementById('instagramProductForm').addEventListener('submit', async event => {
    event.preventDefault();
    const variants = Array.from(document.querySelectorAll('.instagram-variant-row')).map(row => ({ color: row.querySelector('.variant-color').value, size: row.querySelector('.variant-size').value, quantity: Number(row.querySelector('.variant-quantity').value) }));
    const response = await apiFetch('/api/instagram-orders/products', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ companyId: document.getElementById('productCompany').value, name: document.getElementById('productName').value, active: document.getElementById('productActive').checked, variants }) });
    const data = await response.json().catch(() => ({}));
    notify(response.ok ? 'تم إنشاء الصنف والمخزون' : (data.message || 'تعذر إنشاء الصنف'), response.ok ? 'success' : 'error');
    if (response.ok) { event.target.reset(); document.getElementById('variantRows').innerHTML = ''; addVariantRow(); await Promise.all([loadProducts(), loadInventory()]); }
  });

  document.getElementById('instagramViewerForm').addEventListener('submit', async event => {
    event.preventDefault();
    const response = await apiFetch('/api/instagram-orders/viewer-accounts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: document.getElementById('viewerUsername').value, password: document.getElementById('viewerPassword').value, name: document.getElementById('viewerName').value, companyId: document.getElementById('viewerCompany').value }) });
    const data = await response.json().catch(() => ({})); notify(data.message || (response.ok ? 'تم إنشاء الحساب' : 'تعذر إنشاء الحساب'), response.ok ? 'success' : 'error'); if (response.ok) event.target.reset();
  });

  document.querySelectorAll('[data-instagram-type]').forEach(button => button.addEventListener('click', () => { state.orderType = button.dataset.instagramType; selectedShippingOrders.clear(); document.getElementById('createShippingBatch').hidden = state.orderType !== 'شحن'; document.querySelectorAll('[data-instagram-type]').forEach(item => { item.className = `btn btn-sm ${item === button ? 'btn-primary' : 'btn-secondary'}`; }); loadOrders({ reset: true }); }));
  document.getElementById('instagramSearch').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => loadOrders({ reset: true }), 400); });
  document.getElementById('applyInstagramFilters').addEventListener('click', () => loadOrders({ reset: true }));
  document.getElementById('clearInstagramFilters').addEventListener('click', () => { ['instagramSearch', 'instagramCompanyFilter', 'instagramStatusFilter', 'instagramStartDate', 'instagramEndDate'].forEach(id => { document.getElementById(id).value = ''; }); loadOrders({ reset: true }); });
  document.getElementById('refreshInstagramOrders').addEventListener('click', () => loadOrders());
  document.getElementById('refreshInstagramInventory').addEventListener('click', loadInventory);
  document.getElementById('instagramPrevPage').addEventListener('click', () => { if (state.orderPage > 1) { state.orderPage -= 1; loadOrders(); } });
  document.getElementById('instagramNextPage').addEventListener('click', () => { if (state.orderPage < state.orderPages) { state.orderPage += 1; loadOrders(); } });
  document.getElementById('inventoryPrevPage').addEventListener('click', () => { if (state.inventoryPage > 1) { state.inventoryPage -= 1; loadInventory(); } });
  document.getElementById('inventoryNextPage').addEventListener('click', () => { if (state.inventoryPage < state.inventoryPages) { state.inventoryPage += 1; loadInventory(); } });
  document.getElementById('addVariantRow').addEventListener('click', addVariantRow);
  document.getElementById('productCompany').addEventListener('change', loadProducts);
  document.getElementById('instagramCompanyFilter').addEventListener('change', () => { state.inventoryPage = 1; loadInventory(); });
  document.getElementById('exportPeriod').addEventListener('change', setExportRange);
  document.getElementById('exportInstagramExcel').addEventListener('click', exportExcel);
  document.getElementById('createShippingBatch').addEventListener('click', createShippingBatch);

  (async () => {
    try {
      addVariantRow(); setExportRange(); await loadReferenceData(); await Promise.all([loadOrders(), loadProducts(), loadInventory()]);
      refreshTimer = setInterval(() => { if (!document.hidden) loadOrders(); }, 30000);
    }
    catch (error) { notify(error.message, 'error'); }
  })();
  window.addEventListener('beforeunload', () => { if (refreshTimer) clearInterval(refreshTimer); if (state.orderController) state.orderController.abort(); });
})();
