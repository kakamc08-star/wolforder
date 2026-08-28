(function instagramPublicOrder() {
  'use strict';

  const slug = decodeURIComponent(window.location.pathname.split('/').filter(Boolean).pop() || '');
  const form = document.getElementById('instagramOrderForm');
  const itemsContainer = document.getElementById('instagramItems');
  const submitButton = document.getElementById('submitInstagramOrder');
  const message = document.getElementById('submitMessage');
  let catalog = [];
  let companyName = 'المتجر';
  let formToken = '';
  let submitting = false;
  let idempotencyKey = crypto.randomUUID();

  function showMessage(text, type = 'info') {
    message.textContent = text;
    message.className = `instagram-alert ${type}`;
    message.hidden = false;
  }

  function setSelectOptions(select, values, label, valueFactory = value => value) {
    select.innerHTML = `<option value="">${label}</option>`;
    values.forEach(value => {
      const option = document.createElement('option');
      option.value = valueFactory(value);
      option.textContent = typeof value === 'string' ? value : value.name;
      select.appendChild(option);
    });
  }

  function addItemRow() {
    const row = document.createElement('div');
    row.className = 'instagram-item-row';
    row.innerHTML = `
      <div class="form-group"><label>الصنف *</label><select class="item-product" required></select></div>
      <div class="form-group"><label>اللون *</label><select class="item-color" required disabled></select></div>
      <div class="form-group"><label>المقاس *</label><select class="item-size" required disabled></select></div>
      <div class="form-group"><label>الكمية *</label><input class="item-quantity" type="number" min="1" max="1" value="1" inputmode="numeric" required disabled><small class="stock-hint"></small></div>`;
    itemsContainer.appendChild(row);

    const productSelect = row.querySelector('.item-product');
    const colorSelect = row.querySelector('.item-color');
    const sizeSelect = row.querySelector('.item-size');
    const quantityInput = row.querySelector('.item-quantity');
    setSelectOptions(productSelect, catalog, '-- اختر الصنف --', product => product.id);

    productSelect.addEventListener('change', () => {
      const product = catalog.find(item => item.id === productSelect.value);
      const colors = product ? Array.from(new Set(product.variants.map(variant => variant.color))) : [];
      setSelectOptions(colorSelect, colors, '-- اختر اللون --');
      colorSelect.disabled = !colors.length;
      setSelectOptions(sizeSelect, [], '-- اختر المقاس --');
      sizeSelect.disabled = true;
      quantityInput.disabled = true;
    });

    colorSelect.addEventListener('change', () => {
      const product = catalog.find(item => item.id === productSelect.value);
      const variants = product ? product.variants.filter(variant => variant.color === colorSelect.value && variant.available_quantity > 0) : [];
      const sizes = variants.map(variant => ({ name: `${variant.size} — متوفر ${variant.available_quantity}`, id: variant.id }));
      setSelectOptions(sizeSelect, sizes, '-- اختر المقاس --', size => size.id);
      sizeSelect.disabled = !sizes.length;
      quantityInput.disabled = true;
    });

    sizeSelect.addEventListener('change', () => {
      const product = catalog.find(item => item.id === productSelect.value);
      const variant = product && product.variants.find(item => item.id === sizeSelect.value);
      quantityInput.disabled = !variant;
      quantityInput.max = variant ? String(variant.available_quantity) : '1';
      quantityInput.value = '1';
      row.querySelector('.stock-hint').textContent = variant ? `المتوفر: ${variant.available_quantity}` : '';
    });

  }

  function collectItems() {
    return Array.from(itemsContainer.querySelectorAll('.instagram-item-row')).map(row => ({
      inventoryId: row.querySelector('.item-size').value,
      quantity: Number(row.querySelector('.item-quantity').value)
    }));
  }

  async function loadCatalog() {
    try {
      const response = await fetch(`/api/instagram-orders/public/${encodeURIComponent(slug)}/catalog`, { cache: 'no-store' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || 'تعذر تحميل المتجر');
      catalog = data.products || [];
      formToken = data.formToken;
      companyName = data.companyName || 'المتجر';
      document.getElementById('storeName').textContent = companyName;
      if (!catalog.length) throw new Error('لا توجد أصناف متوفرة حالياً');
      form.hidden = false;
      addItemRow();
    } catch (error) {
      const alert = document.getElementById('catalogError');
      alert.textContent = error.message;
      alert.hidden = false;
    }
  }

  document.getElementById('addInstagramItem').addEventListener('click', () => {
    if (itemsContainer.children.length >= 20) return showMessage('الحد الأقصى 20 صنفاً في الطلب', 'error');
    addItemRow();
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (submitting || !form.reportValidity()) return;
    submitting = true;
    submitButton.disabled = true;
    submitButton.textContent = 'جاري تثبيت الحجز...';
    message.hidden = true;
    try {
      const payload = {
        customerName: document.getElementById('customerName').value,
        customerPhone: document.getElementById('customerPhone').value,
        address: document.getElementById('customerAddress').value,
        orderType: document.getElementById('instagramOrderType').value,
        note: document.getElementById('instagramNote').value,
        website: document.getElementById('website').value,
        items: collectItems()
      };
      const response = await fetch(`/api/instagram-orders/public/${encodeURIComponent(slug)}/orders`, {
        method: 'POST',
        cache: 'no-store',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
          'X-Instagram-Form-Token': formToken
        },
        body: JSON.stringify(payload)
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || 'تعذر إرسال الطلب');
      const confirmedCompanyName = data.companyName || companyName;
      showMessage(`تم إنشاء الطلب وهو الآن قيد المتابعة.\nشكرًا لطلبكم من ${confirmedCompanyName}.`, 'success');
      form.querySelectorAll('input, select, textarea, button').forEach(element => { element.disabled = true; });
    } catch (error) {
      showMessage(error.message, 'error');
      submitting = false;
      submitButton.disabled = false;
      submitButton.textContent = 'إرسال الطلب';
      if (/انتهت صلاحية النموذج/.test(error.message)) window.location.reload();
    }
  });

  loadCatalog();
})();
