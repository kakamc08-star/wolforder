(function instagramViewerDashboard() {
  'use strict';
  const user = JSON.parse(localStorage.getItem('user') || 'null');
  if (!user || user.role !== 'instagram_viewer') return window.location.replace('/instagram-login.html');
  document.getElementById('viewerNameDisplay').textContent = user.name || user.username;
  let page = 1; let totalPages = 1; let inventoryPage = 1; let inventoryTotalPages = 1; let controller = null; let searchTimer = null;
  let refreshTimer = null;

  function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char])); }
  function iso(value, end = false) { return value ? new Date(`${value}T${end ? '23:59:59.999' : '00:00:00'}`).toISOString() : ''; }
  function params() { const result = new URLSearchParams({ page, limit: 50 }); const values = { search: document.getElementById('viewerSearch').value.trim(), status: document.getElementById('viewerStatus').value, orderType: document.getElementById('viewerType').value, startDate: iso(document.getElementById('viewerStartDate').value), endDate: iso(document.getElementById('viewerEndDate').value, true) }; Object.entries(values).forEach(([key, value]) => { if (value) result.set(key, value); }); return result; }

  async function loadOrders(reset = false) {
    if (reset) page = 1; if (controller) controller.abort(); controller = new AbortController();
    try {
      const response = await apiFetch(`/api/instagram-orders?${params()}`, { signal: controller.signal }); const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.message || 'تعذر تحميل الطلبات');
      totalPages = data.pagination.totalPages; document.getElementById('viewerPageInfo').textContent = `صفحة ${page} من ${totalPages} — ${data.pagination.total} طلب`; document.getElementById('viewerPrevPage').disabled = page <= 1; document.getElementById('viewerNextPage').disabled = page >= totalPages;
      document.getElementById('viewerOrdersBody').innerHTML = (data.orders || []).map(order => `<tr><td>${order.order_number}</td><td>${escapeHtml(order.customer_name)}</td><td><a href="tel:${escapeHtml(order.customer_phone)}">${escapeHtml(order.customer_phone)}</a></td><td>${escapeHtml(order.address)}</td><td>${escapeHtml(order.order_type)}</td><td class="text-wrap-column">${(order.items || []).map(item => `${escapeHtml(item.product_name)} — ${escapeHtml(item.color)} / ${escapeHtml(item.size)} × ${item.quantity}`).join('<br>')}</td><td>${escapeHtml(order.status)}</td><td>${new Date(order.created_at).toLocaleString('ar')}</td></tr>`).join('') || '<tr><td colspan="8">لا توجد طلبات.</td></tr>';
    } catch (error) { if (error.name !== 'AbortError') console.error(error); }
  }

  async function loadInventory() {
    const response = await apiFetch(`/api/instagram-orders/inventory?page=${inventoryPage}&limit=100`); const data = await response.json().catch(() => ({})); if (!response.ok) return;
    inventoryTotalPages = data.pagination.totalPages;
    document.getElementById('viewerInventoryPageInfo').textContent = `صفحة ${data.pagination.page} من ${data.pagination.totalPages} — ${data.pagination.total} تركيبة`;
    document.getElementById('viewerInventoryPrevPage').disabled = inventoryPage <= 1;
    document.getElementById('viewerInventoryNextPage').disabled = inventoryPage >= inventoryTotalPages;
    document.getElementById('viewerInventoryBody').innerHTML = (data.inventory || []).map(item => `<tr><td>${escapeHtml(item.product_name)}</td><td>${escapeHtml(item.color)}</td><td>${escapeHtml(item.size)}</td><td>${item.initial_quantity}</td><td>${item.sold_quantity}</td><td>${item.reserved_quantity}</td><td>${item.postponed_quantity}</td><td>${item.cancelled_quantity}</td><td>${item.returned_quantity}</td><td><strong>${item.remaining_quantity}</strong></td></tr>`).join('');
  }

  document.getElementById('viewerSearch').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => loadOrders(true), 400); });
  document.getElementById('viewerApplyFilters').addEventListener('click', () => loadOrders(true));
  document.getElementById('viewerPrevPage').addEventListener('click', () => { if (page > 1) { page -= 1; loadOrders(); } });
  document.getElementById('viewerNextPage').addEventListener('click', () => { if (page < totalPages) { page += 1; loadOrders(); } });
  document.getElementById('viewerInventoryPrevPage').addEventListener('click', () => { if (inventoryPage > 1) { inventoryPage -= 1; loadInventory(); } });
  document.getElementById('viewerInventoryNextPage').addEventListener('click', () => { if (inventoryPage < inventoryTotalPages) { inventoryPage += 1; loadInventory(); } });
  document.getElementById('viewerLogout').addEventListener('click', () => { clearWolfSession(); window.location.replace('/instagram-login.html'); });
  loadOrders(); loadInventory();
  refreshTimer = setInterval(() => { if (!document.hidden) { loadOrders(); loadInventory(); } }, 30000);
  window.addEventListener('beforeunload', () => { if (refreshTimer) clearInterval(refreshTimer); if (controller) controller.abort(); });
})();
