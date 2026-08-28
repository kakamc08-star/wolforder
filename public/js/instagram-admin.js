(function instagramAdminDashboard() {
  'use strict';

  const user = JSON.parse(localStorage.getItem('user') || 'null');
  if (!user || user.role !== 'admin') return window.location.replace('/login.html');
  document.getElementById('userNameDisplay').textContent = user.name || user.username;

  const ORDER_PAGE_SIZE = 50;
  const ORDER_STATUSES = ['قيد المتابعة', 'تم', 'مؤجل', 'ملغي', 'مرتجع'];
  const state = {
    orderPage: 1,
    orderPages: 1,
    inventoryPage: 1,
    inventoryPages: 1,
    orderType: '',
    orders: [],
    companies: [],
    drivers: [],
    products: [],
    orderController: null
  };
  const selectedOrderIds = new Set();
  let searchTimer = null;
  let refreshTimer = null;

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

  async function requestJson(url, options = {}) {
    const response = await apiFetch(url, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || 'تعذر تنفيذ العملية');
    return data;
  }

  function isoRange(dateValue, end = false) {
    return dateValue ? new Date(`${dateValue}T${end ? '23:59:59.999' : '00:00:00'}`).toISOString() : '';
  }

  function fillCompanySelects() {
    ['instagramCompanyFilter', 'productCompany', 'viewerCompany', 'exportCompany'].forEach(id => {
      const select = document.getElementById(id);
      const first = select.options[0].outerHTML;
      select.innerHTML = first + state.companies.map(company => `<option value="${escapeHtml(company.id)}">${escapeHtml(company.name)}</option>`).join('');
    });
  }

  function fillDriverSelects() {
    const options = state.drivers.map(driver => `<option value="${escapeHtml(driver.id)}">${escapeHtml(driver.name)}</option>`).join('');
    document.getElementById('instagramBulkDriver').innerHTML = '<option value="">-- اختر سائقًا --</option>' + options;
    document.getElementById('instagramAssignDriverSelect').innerHTML = '<option value="">-- اختر سائقًا --</option>' + options;
  }

  async function loadReferenceData() {
    const [companiesResponse, driversResponse] = await Promise.all([
      apiFetch('/api/instagram-orders/companies'),
      apiFetch('/api/instagram-orders/drivers')
    ]);
    if (!companiesResponse.ok || !driversResponse.ok) throw new Error('تعذر تحميل الشركات والسائقين');
    state.companies = await companiesResponse.json();
    state.drivers = await driversResponse.json();
    fillCompanySelects();
    fillDriverSelects();
    renderCompanyLinks();
  }

  function orderParams() {
    const params = new URLSearchParams({ page: String(state.orderPage), limit: String(ORDER_PAGE_SIZE) });
    const values = {
      search: document.getElementById('instagramSearch').value.trim(),
      companyId: document.getElementById('instagramCompanyFilter').value,
      status: document.getElementById('instagramStatusFilter').value,
      startDate: isoRange(document.getElementById('instagramStartDate').value),
      endDate: isoRange(document.getElementById('instagramEndDate').value, true),
      orderType: state.orderType
    };
    Object.entries(values).forEach(([key, value]) => { if (value) params.set(key, value); });
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
      state.orders = data.orders || [];
      state.orderPages = data.pagination?.totalPages || 1;
      if (state.orderPage > state.orderPages) {
        state.orderPage = state.orderPages;
        return loadOrders();
      }
      const visibleIds = new Set(state.orders.map(order => String(order.id)));
      Array.from(selectedOrderIds).forEach(id => { if (!visibleIds.has(id)) selectedOrderIds.delete(id); });
      renderOrders();
      document.getElementById('instagramPageInfo').textContent = `صفحة ${data.pagination?.page || state.orderPage} من ${state.orderPages} — ${data.pagination?.total || 0} طلب`;
      document.getElementById('instagramPrevPage').disabled = state.orderPage <= 1;
      document.getElementById('instagramNextPage').disabled = state.orderPage >= state.orderPages;
      updateBulkControls();
    } catch (error) {
      if (error.name !== 'AbortError') notify(error.message, 'error');
    }
  }

  function itemSummary(items) {
    return (items || []).map(item => `${escapeHtml(item.product_name)} — ${escapeHtml(item.color)} / ${escapeHtml(item.size)} × ${Number(item.quantity)}`).join('<br>') || '—';
  }

  function renderOrders() {
    const body = document.getElementById('instagramOrdersBody');
    body.innerHTML = state.orders.length ? state.orders.map((order, index) => {
      const orderId = String(order.id);
      const checked = selectedOrderIds.has(orderId) ? 'checked' : '';
      const driverLabel = order.order_type === 'توصيل'
        ? escapeHtml(order.driver_name || '—')
        : escapeHtml(order.shipping_partner ? `سُلّم إلى ${order.shipping_partner}` : 'شحن');
      const assignLabel = order.driver_id ? '🚚 تغيير السائق' : '🚚 تعيين سائق';
      return `<tr>
        <td><input type="checkbox" class="instagram-order-checkbox" value="${escapeHtml(orderId)}" ${checked} aria-label="اختيار الطلب ${escapeHtml(order.order_number)}"></td>
        <td>${((state.orderPage - 1) * ORDER_PAGE_SIZE) + index + 1}</td>
        <td>${escapeHtml(order.order_number)}</td><td>${escapeHtml(order.company_name)}</td>
        <td><strong>${escapeHtml(order.customer_name)}</strong><br><a href="tel:${escapeHtml(order.customer_phone)}">${escapeHtml(order.customer_phone)}</a></td>
        <td>${escapeHtml(order.address)}</td><td><span class="order-type-badge ${order.order_type === 'شحن' ? 'order-type-shipping' : 'order-type-delivery'}">${escapeHtml(order.order_type)}</span></td>
        <td class="text-wrap-column">${itemSummary(order.items)}</td>
        <td><span class="status-badge status-${escapeHtml(order.status)}">${escapeHtml(order.status)}</span></td>
        <td>${driverLabel}</td><td>${new Date(order.created_at).toLocaleString('en-GB')}</td>
        <td><div class="instagram-order-actions">
          ${order.order_type === 'توصيل' ? `<button class="btn btn-sm btn-primary" data-instagram-action="assign" data-id="${escapeHtml(orderId)}">${assignLabel}</button>` : ''}
          <button class="btn btn-sm btn-secondary" data-instagram-action="edit" data-id="${escapeHtml(orderId)}">✏️ تعديل</button>
          <button class="btn btn-sm btn-info" data-instagram-action="print" data-id="${escapeHtml(orderId)}">🖨️ طباعة</button>
          <button class="btn btn-sm btn-danger" data-instagram-action="delete" data-id="${escapeHtml(orderId)}">🗑️ حذف</button>
        </div></td>
      </tr>`;
    }).join('') : '<tr><td colspan="12">لا توجد طلبات مطابقة.</td></tr>';
  }

  function updateBulkControls() {
    const controls = document.getElementById('instagramBulkControls');
    controls.style.display = selectedOrderIds.size ? 'flex' : 'none';
    document.getElementById('instagramSelectedCount').textContent = selectedOrderIds.size ? `تم تحديد ${selectedOrderIds.size} طلبات` : '';
    const selectAll = document.getElementById('selectAllInstagramOrders');
    selectAll.checked = state.orders.length > 0 && state.orders.every(order => selectedOrderIds.has(String(order.id)));
    selectAll.indeterminate = selectedOrderIds.size > 0 && !selectAll.checked;
  }

  async function updateOrderStatus(orderId, status) {
    return requestJson(`/api/instagram-orders/orders/${orderId}/status`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status })
    });
  }

  async function assignOrderDriver(orderId, driverId) {
    return requestJson(`/api/instagram-orders/orders/${orderId}/assign-driver`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ driverId })
    });
  }

  async function deleteOrder(orderId) {
    return requestJson(`/api/instagram-orders/orders/${orderId}`, { method: 'DELETE' });
  }

  function printableItems(order) {
    return (order.items || []).map(item => `${escapeHtml(item.product_name)} — ${escapeHtml(item.color)} / ${escapeHtml(item.size)} × ${Number(item.quantity)}`).join('<br>') || '—';
  }

  function printOrders(orders) {
    if (!orders.length) return notify('لم يتم العثور على طلبات للطباعة', 'error');
    const cards = orders.map(order => `<div class="card"><div class="header">WolfOrder</div><div class="detail-row"><span>رقم الطلب:</span><strong>${escapeHtml(order.order_number)}</strong></div><div class="detail-row"><span>النوع:</span><strong>${escapeHtml(order.order_type)}</strong></div><div class="detail-row"><span>الأصناف:</span><strong>${printableItems(order)}</strong></div><div class="detail-row"><span>الزبون:</span><strong>${escapeHtml(order.customer_name)}</strong></div><div class="detail-row"><span>الهاتف:</span><strong>${escapeHtml(order.customer_phone)}</strong></div><div class="detail-row"><span>العنوان:</span><strong>${escapeHtml(order.address)}</strong></div><div class="detail-row"><span>الشركة:</span><strong>${escapeHtml(order.company_name)}</strong></div><div class="detail-row"><span>ملاحظة:</span><strong>${escapeHtml(order.note || '—')}</strong></div><div class="footer">شكرًا لتعاملكم مع WolfOrder</div></div>`).join('');
    const printWindow = window.open('', '_blank', 'width=650,height=600');
    if (!printWindow) return notify('اسمح بفتح النوافذ المنبثقة لإتمام الطباعة', 'error');
    printWindow.document.write(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>طباعة طلبات إنستغرام</title><style>@page{size:100mm 150mm;margin:3mm}body{width:100mm;margin:0 auto;font-family:Arial,sans-serif;font-size:15px;font-weight:700;color:#000}.card{border:2px solid #000;padding:4mm;page-break-after:always}.card:last-child{page-break-after:auto}.header,.footer{text-align:center;border-bottom:2px solid #000;padding:5px}.footer{border-top:2px solid #000;border-bottom:0;margin-top:8px}.detail-row{display:grid;grid-template-columns:28% 1fr;gap:8px;border-bottom:1px dotted #555;padding:5px 0}.detail-row strong{overflow-wrap:anywhere}</style></head><body>${cards}<script>window.onload=()=>{window.print();setTimeout(()=>window.close(),500)};<\/script></body></html>`);
    printWindow.document.close();
  }

  async function applyBulkAction() {
    const action = document.getElementById('instagramBulkAction').value;
    if (!action) return notify('اختر إجراءً جماعيًا', 'error');
    const selectedOrders = state.orders.filter(order => selectedOrderIds.has(String(order.id)));
    if (!selectedOrders.length) return notify('حدد طلبًا واحدًا على الأقل', 'error');
    if (action === 'print') return printOrders(selectedOrders);
    if (action === 'driver' && !document.getElementById('instagramBulkDriver').value) return notify('اختر السائق أولًا', 'error');

    if (action === 'delete' && !confirm(`هل أنت متأكد من حذف ${selectedOrders.length} طلبات نهائيًا؟ ستُعاد كمياتها إلى المخزون.`)) return;
    if (action !== 'delete' && !confirm(`هل تريد تطبيق الإجراء على ${selectedOrders.length} طلبات؟`)) return;

    let success = 0;
    let failed = 0;
    for (const order of selectedOrders) {
      try {
        if (action === 'delete') await deleteOrder(order.id);
        if (action === 'status') await updateOrderStatus(order.id, document.getElementById('instagramBulkStatus').value);
        if (action === 'driver') {
          if (order.order_type !== 'توصيل') throw new Error('طلب شحن');
          await assignOrderDriver(order.id, document.getElementById('instagramBulkDriver').value);
        }
        success += 1;
      } catch (error) { failed += 1; }
    }
    notify(`تم تنفيذ الإجراء على ${success} طلب${failed ? `، وتعذر على ${failed}` : ''}`, failed ? 'warning' : 'success');
    selectedOrderIds.clear();
    await Promise.all([loadOrders(), loadInventory()]);
  }

  function openAssignModal(order) {
    document.getElementById('instagramAssignOrderId').value = order.id;
    document.getElementById('instagramAssignDriverSelect').value = order.driver_id || '';
    document.getElementById('instagramAssignDriverModal').style.display = 'flex';
  }

  function openEditModal(order) {
    document.getElementById('instagramEditOrderId').value = order.id;
    document.getElementById('instagramEditCustomerName').value = order.customer_name || '';
    document.getElementById('instagramEditCustomerPhone').value = order.customer_phone || '';
    document.getElementById('instagramEditAddress').value = order.address || '';
    document.getElementById('instagramEditStatus').value = order.status || 'قيد المتابعة';
    document.getElementById('instagramEditNote').value = order.note || '';
    document.getElementById('instagramEditOrderModal').style.display = 'flex';
  }

  async function createShippingBatch() {
    const eligible = state.orders.filter(order => selectedOrderIds.has(String(order.id)) && order.order_type === 'شحن' && !order.shipping_batch_id && ['قيد المتابعة', 'مؤجل'].includes(order.status));
    if (!eligible.length) return notify('حدد طلب شحن واحدًا على الأقل غير مسلّم', 'error');
    const partnerName = (prompt('اسم شريكة الشحن التي ستستلم الدفعة:') || '').trim();
    if (partnerName.length < 2) return notify('أدخل اسم الشريكة', 'error');
    const note = (prompt('ملاحظة الدفعة (اختياري):') || '').trim();
    const button = document.getElementById('createShippingBatch');
    button.disabled = true;
    try {
      const data = await requestJson('/api/instagram-orders/shipping-batches', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderIds: eligible.map(order => order.id), partnerName, note })
      });
      selectedOrderIds.clear();
      notify(`تم إنشاء دفعة الشحن رقم ${data.batch_number} وتسليمها إلى ${data.partner_name}`, 'success');
      await Promise.all([loadOrders(), loadInventory()]);
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
    try {
      state.products = await requestJson(url);
      renderProducts();
      document.getElementById('exportProduct').innerHTML = '<option value="">كل الأصناف</option>' + state.products.map(product => `<option value="${escapeHtml(product.id)}">${escapeHtml(product.name)}</option>`).join('');
    } catch (error) { notify(error.message, 'error'); }
  }

  function renderProducts() {
    document.getElementById('instagramProductsList').innerHTML = state.products.length ? state.products.map(product => `<article class="instagram-product-card"><div><strong>${escapeHtml(product.name)}</strong><small>${product.is_active ? 'مفعّل' : 'متوقف'} · ${(product.variants || []).length} تركيبة</small></div><div class="product-card-actions"><button class="btn btn-secondary btn-sm add-instagram-variant" data-id="${escapeHtml(product.id)}">+ لون/مقاس</button><button class="btn btn-sm ${product.is_active ? 'btn-danger' : 'btn-primary'} toggle-instagram-product" data-id="${escapeHtml(product.id)}" data-active="${product.is_active}">${product.is_active ? 'إيقاف' : 'تفعيل'}</button><button class="btn btn-danger btn-sm delete-instagram-product" data-id="${escapeHtml(product.id)}" data-name="${escapeHtml(product.name)}">حذف الصنف</button></div></article>`).join('') : '<p>لا توجد أصناف بعد.</p>';
  }

  async function loadInventory() {
    const params = new URLSearchParams({ page: String(state.inventoryPage), limit: '100' });
    const companyId = document.getElementById('instagramCompanyFilter').value;
    const orderType = document.getElementById('inventoryOrderType').value;
    if (companyId) params.set('companyId', companyId);
    if (orderType) params.set('orderType', orderType);
    try {
      const data = await requestJson(`/api/instagram-orders/inventory?${params}`);
      state.inventoryPages = data.pagination?.totalPages || 1;
      document.getElementById('inventoryPageInfo').textContent = `صفحة ${data.pagination?.page || state.inventoryPage} من ${state.inventoryPages} — ${data.pagination?.total || 0} تركيبة`;
      document.getElementById('inventoryPrevPage').disabled = state.inventoryPage <= 1;
      document.getElementById('inventoryNextPage').disabled = state.inventoryPage >= state.inventoryPages;
      document.getElementById('pendingShippingOrdersCount').textContent = Number(data.shippingSummary?.orderCount || 0).toLocaleString('en-US');
      document.getElementById('pendingShippingPiecesCount').textContent = Number(data.shippingSummary?.pieceCount || 0).toLocaleString('en-US');
      document.getElementById('instagramInventoryBody').innerHTML = (data.inventory || []).map(item => `<tr><td>${escapeHtml(item.company_name)}</td><td>${escapeHtml(item.product_name)}</td><td>${escapeHtml(item.color)}</td><td>${escapeHtml(item.size)}</td><td>${Number(item.initial_quantity)}</td><td>${Number(item.sold_quantity)}</td><td>${Number(item.reserved_quantity)}</td><td>${Number(item.postponed_quantity)}</td><td>${Number(item.cancelled_quantity)}</td><td>${Number(item.returned_quantity)}</td><td><strong>${Number(item.remaining_quantity)}</strong></td><td><div class="instagram-order-actions"><button class="btn btn-secondary btn-sm adjust-instagram-stock" data-id="${escapeHtml(item.inventory_id)}" data-label="${escapeHtml(item.product_name)} / ${escapeHtml(item.color)} / ${escapeHtml(item.size)}">تعديل</button><button class="btn btn-danger btn-sm delete-instagram-stock" data-id="${escapeHtml(item.inventory_id)}" data-label="${escapeHtml(item.product_name)} / ${escapeHtml(item.color)} / ${escapeHtml(item.size)}">حذف</button></div></td></tr>`).join('') || '<tr><td colspan="12">لا توجد بيانات جرد.</td></tr>';
    } catch (error) { notify(error.message, 'error'); }
  }

  function renderCompanyLinks() {
    document.getElementById('instagramCompanyLinks').innerHTML = state.companies.map(company => {
      const link = company.instagramLink;
      const url = link ? `${location.origin}/instagram/${link.public_slug}` : '';
      if (!url) return `<article class="instagram-link-card"><div><strong>${escapeHtml(company.name)}</strong><small>لم يتم إنشاء رابط بعد</small></div><button class="btn btn-primary btn-sm create-instagram-link" data-id="${escapeHtml(company.id)}">إنشاء الرابط</button></article>`;
      return `<article class="instagram-link-card instagram-link-entry" data-url="${escapeHtml(url)}" tabindex="0" role="link"><div><strong>${escapeHtml(company.name)}</strong><small>اضغط على البطاقة للدخول إلى رابط الطلب</small></div><div class="instagram-link-actions"><button class="btn btn-primary btn-sm open-instagram-link" data-url="${escapeHtml(url)}">دخول</button><button class="btn btn-secondary btn-sm copy-instagram-link" data-url="${escapeHtml(url)}">نسخ</button></div></article>`;
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
      startDate: isoRange(document.getElementById('exportStartDate').value),
      endDate: isoRange(document.getElementById('exportEndDate').value, true),
      orderType: document.getElementById('exportOrderType').value,
      status: document.getElementById('exportStatus').value,
      companyId: document.getElementById('exportCompany').value,
      productId: document.getElementById('exportProduct').value
    };
    Object.entries(values).forEach(([key, value]) => { if (value) params.set(key, value); });
    const response = await apiFetch(`/api/instagram-orders/export?${params}`);
    if (!response.ok) return notify('تعذر إنشاء ملف Excel', 'error');
    const blob = await response.blob();
    const anchor = document.createElement('a');
    anchor.href = URL.createObjectURL(blob);
    anchor.download = `instagram-inventory-${new Date().toISOString().slice(0, 10)}.xls`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(anchor.href), 1000);
  }

  document.addEventListener('click', async event => {
    const close = event.target.closest('[data-close-instagram-modal]');
    if (close) return document.getElementById(close.dataset.closeInstagramModal).style.display = 'none';

    const action = event.target.closest('[data-instagram-action]');
    if (action) {
      const order = state.orders.find(item => String(item.id) === String(action.dataset.id));
      if (!order) return notify('الطلب غير موجود في القائمة الحالية', 'error');
      if (action.dataset.instagramAction === 'assign') return openAssignModal(order);
      if (action.dataset.instagramAction === 'edit') return openEditModal(order);
      if (action.dataset.instagramAction === 'print') return printOrders([order]);
      if (action.dataset.instagramAction === 'delete') {
        if (!confirm(`هل أنت متأكد من حذف الطلب رقم ${order.order_number}؟ ستُعاد كمياته إلى المخزون.`)) return;
        try { await deleteOrder(order.id); notify('تم حذف الطلب وإعادة المخزون', 'success'); await Promise.all([loadOrders(), loadInventory()]); }
        catch (error) { notify(error.message, 'error'); }
        return;
      }
    }

    const createLink = event.target.closest('.create-instagram-link');
    if (createLink) { try { await requestJson(`/api/instagram-orders/companies/${createLink.dataset.id}/link`, { method: 'POST' }); await loadReferenceData(); notify('تم إنشاء الرابط', 'success'); } catch (error) { notify(error.message, 'error'); } return; }
    const copy = event.target.closest('.copy-instagram-link');
    if (copy) { await navigator.clipboard.writeText(copy.dataset.url); notify('تم نسخ الرابط', 'success'); return; }
    const open = event.target.closest('.open-instagram-link');
    if (open) { window.open(open.dataset.url, '_blank', 'noopener'); return; }
    const linkCard = event.target.closest('.instagram-link-entry');
    if (linkCard) { window.open(linkCard.dataset.url, '_blank', 'noopener'); return; }

    const toggle = event.target.closest('.toggle-instagram-product');
    if (toggle) { try { await requestJson(`/api/instagram-orders/products/${toggle.dataset.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: toggle.dataset.active !== 'true' }) }); await loadProducts(); notify('تم تحديث الصنف', 'success'); } catch (error) { notify(error.message, 'error'); } return; }
    const deleteProduct = event.target.closest('.delete-instagram-product');
    if (deleteProduct) { if (!confirm(`حذف الصنف ${deleteProduct.dataset.name} من القوائم والجرد؟ ستبقى الطلبات السابقة محفوظة.`)) return; try { await requestJson(`/api/instagram-orders/products/${deleteProduct.dataset.id}`, { method: 'DELETE' }); notify('تم حذف الصنف', 'success'); await Promise.all([loadProducts(), loadInventory()]); } catch (error) { notify(error.message, 'error'); } return; }
    const addVariant = event.target.closest('.add-instagram-variant');
    if (addVariant) {
      const color = prompt('اللون الجديد:') || '';
      const size = prompt('المقاس الجديد:') || '';
      const quantity = Number(prompt('الكمية الأساسية:', '0'));
      if (!color.trim() || !size.trim() || !Number.isInteger(quantity) || quantity < 0) return notify('بيانات التركيبة غير صالحة', 'error');
      try { await requestJson(`/api/instagram-orders/products/${addVariant.dataset.id}/variants`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ color, size, quantity }) }); notify('تمت إضافة اللون والمقاس', 'success'); await Promise.all([loadProducts(), loadInventory()]); } catch (error) { notify(error.message, 'error'); }
      return;
    }
    const adjust = event.target.closest('.adjust-instagram-stock');
    if (adjust) { const delta = Number(prompt(`التغيير على ${adjust.dataset.label}\nاكتب رقمًا موجبًا للزيادة أو سالبًا للنقصان:`)); if (!Number.isInteger(delta) || delta === 0) return; const reason = prompt('سبب التعديل:') || ''; try { await requestJson(`/api/instagram-orders/inventory/${adjust.dataset.id}/adjust`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ delta, reason }) }); notify('تم تعديل المخزون', 'success'); await loadInventory(); } catch (error) { notify(error.message, 'error'); } return; }
    const deleteStock = event.target.closest('.delete-instagram-stock');
    if (deleteStock) { if (!confirm(`حذف ${deleteStock.dataset.label} من الجرد؟`)) return; try { await requestJson(`/api/instagram-orders/inventory/${deleteStock.dataset.id}`, { method: 'DELETE' }); notify('تم حذف التركيبة من الجرد', 'success'); await Promise.all([loadProducts(), loadInventory()]); } catch (error) { notify(error.message, 'error'); } }
  });

  document.addEventListener('change', event => {
    if (event.target.matches('.instagram-order-checkbox')) {
      if (event.target.checked) selectedOrderIds.add(String(event.target.value));
      else selectedOrderIds.delete(String(event.target.value));
      updateBulkControls();
    }
  });

  document.getElementById('selectAllInstagramOrders').addEventListener('change', event => {
    state.orders.forEach(order => event.target.checked ? selectedOrderIds.add(String(order.id)) : selectedOrderIds.delete(String(order.id)));
    renderOrders();
    updateBulkControls();
  });
  document.getElementById('instagramBulkAction').addEventListener('change', event => {
    document.getElementById('instagramBulkStatus').style.display = event.target.value === 'status' ? 'inline-block' : 'none';
    document.getElementById('instagramBulkDriver').style.display = event.target.value === 'driver' ? 'inline-block' : 'none';
  });
  document.getElementById('applyInstagramBulkAction').addEventListener('click', applyBulkAction);

  document.getElementById('instagramAssignDriverForm').addEventListener('submit', async event => {
    event.preventDefault();
    try {
      await assignOrderDriver(document.getElementById('instagramAssignOrderId').value, document.getElementById('instagramAssignDriverSelect').value);
      document.getElementById('instagramAssignDriverModal').style.display = 'none';
      notify('تم تعيين السائق', 'success');
      await loadOrders();
    } catch (error) { notify(error.message, 'error'); }
  });

  document.getElementById('instagramEditOrderForm').addEventListener('submit', async event => {
    event.preventDefault();
    const orderId = document.getElementById('instagramEditOrderId').value;
    const previous = state.orders.find(order => String(order.id) === String(orderId));
    try {
      await requestJson(`/api/instagram-orders/orders/${orderId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
          customerName: document.getElementById('instagramEditCustomerName').value,
          customerPhone: document.getElementById('instagramEditCustomerPhone').value,
          address: document.getElementById('instagramEditAddress').value,
          note: document.getElementById('instagramEditNote').value
        })
      });
      const status = document.getElementById('instagramEditStatus').value;
      if (previous && previous.status !== status) await updateOrderStatus(orderId, status);
      document.getElementById('instagramEditOrderModal').style.display = 'none';
      notify('تم تعديل الطلب', 'success');
      await Promise.all([loadOrders(), loadInventory()]);
    } catch (error) { notify(error.message, 'error'); }
  });

  document.getElementById('instagramProductForm').addEventListener('submit', async event => {
    event.preventDefault();
    const variants = Array.from(document.querySelectorAll('.instagram-variant-row')).map(row => ({ color: row.querySelector('.variant-color').value, size: row.querySelector('.variant-size').value, quantity: Number(row.querySelector('.variant-quantity').value) }));
    try {
      await requestJson('/api/instagram-orders/products', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ companyId: document.getElementById('productCompany').value, name: document.getElementById('productName').value, active: document.getElementById('productActive').checked, variants }) });
      notify('تم إنشاء الصنف والمخزون', 'success');
      event.target.reset();
      document.getElementById('variantRows').innerHTML = '';
      addVariantRow();
      await Promise.all([loadProducts(), loadInventory()]);
    } catch (error) { notify(error.message, 'error'); }
  });

  document.getElementById('instagramViewerForm').addEventListener('submit', async event => {
    event.preventDefault();
    try {
      const data = await requestJson('/api/instagram-orders/viewer-accounts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: document.getElementById('viewerUsername').value, password: document.getElementById('viewerPassword').value, name: document.getElementById('viewerName').value, companyId: document.getElementById('viewerCompany').value }) });
      notify(data.message || 'تم إنشاء الحساب', 'success');
      event.target.reset();
    } catch (error) { notify(error.message, 'error'); }
  });

  document.querySelectorAll('[data-instagram-type]').forEach(button => button.addEventListener('click', () => {
    state.orderType = button.dataset.instagramType;
    selectedOrderIds.clear();
    document.getElementById('createShippingBatch').hidden = state.orderType !== 'شحن';
    document.querySelectorAll('[data-instagram-type]').forEach(item => { item.className = `btn btn-sm ${item === button ? 'btn-primary' : 'btn-secondary'}`; });
    loadOrders({ reset: true });
  }));
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
  document.getElementById('inventoryOrderType').addEventListener('change', () => { state.inventoryPage = 1; loadInventory(); });
  document.getElementById('exportPeriod').addEventListener('change', setExportRange);
  document.getElementById('exportInstagramExcel').addEventListener('click', exportExcel);
  document.getElementById('createShippingBatch').addEventListener('click', createShippingBatch);

  (async () => {
    try {
      addVariantRow();
      setExportRange();
      await loadReferenceData();
      await Promise.all([loadOrders(), loadProducts(), loadInventory()]);
      refreshTimer = setInterval(() => { if (!document.hidden) loadOrders(); }, 30000);
    } catch (error) { notify(error.message, 'error'); }
  })();
  window.addEventListener('beforeunload', () => { if (refreshTimer) clearInterval(refreshTimer); if (state.orderController) state.orderController.abort(); });
})();
