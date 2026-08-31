const storefrontState = {
  slug: decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() || ''),
  companyName: '',
  products: [],
  submitting: false,
  idempotencyKey: null,
  nextRowId: 1
};

const storefrontElements = {
  loading: document.getElementById('storefrontLoading'),
  app: document.getElementById('storefrontApp'),
  companyName: document.getElementById('storefrontCompanyName'),
  form: document.getElementById('instagramCustomerOrderForm'),
  items: document.getElementById('storefrontItems'),
  addItem: document.getElementById('addStorefrontItem'),
  total: document.getElementById('storefrontTotal'),
  message: document.getElementById('storefrontMessage'),
  submit: document.getElementById('confirmInstagramOrder'),
  success: document.getElementById('storefrontSuccess'),
  successTitle: document.getElementById('storefrontSuccessTitle')
};

function createUuid() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return window.crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const value = Math.random() * 16 | 0;
    return (char === 'x' ? value : (value & 0x3 | 0x8)).toString(16);
  });
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatMoney(value, currency = 'ل.س') {
  const number = Number(value) || 0;
  return `${number.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${currency}`;
}

function setStorefrontMessage(message = '', type = 'error') {
  storefrontElements.message.innerHTML = message
    ? `<div class="storefront-message ${type}">${escapeHtml(message)}</div>`
    : '';
}

function getProduct(productId) {
  return storefrontState.products.find((product) => product.product_id === productId);
}

function getRowElements(row) {
  return {
    product: row.querySelector('[data-field="product"]'),
    color: row.querySelector('[data-field="color"]'),
    size: row.querySelector('[data-field="size"]'),
    quantity: row.querySelector('[data-field="quantity"]'), // hidden input
    qtyValue: row.querySelector('.qty-value'),               // display span
    unitPrice: row.querySelector('[data-value="unit-price"]'),
    lineTotal: row.querySelector('[data-value="line-total"]')
  };
}

function unique(values) {
  return [...new Set(values)];
}

function updateRowColors(row) {
  const fields = getRowElements(row);
  const product = getProduct(fields.product.value);
  const previous = fields.color.value;
  const colors = product ? unique(product.variants.map((variant) => variant.color)) : [];
  fields.color.innerHTML = '<option value="">اختر اللون</option>'
    + colors.map((color) => `<option value="${escapeHtml(color)}">${escapeHtml(color)}</option>`).join('');
  if (colors.includes(previous)) fields.color.value = previous;
  updateRowSizes(row);
}

function updateRowSizes(row) {
  const fields = getRowElements(row);
  const product = getProduct(fields.product.value);
  const previous = fields.size.value;
  const variants = product
    ? product.variants.filter((variant) => variant.color === fields.color.value)
    : [];
  fields.size.innerHTML = '<option value="">اختر المقاس</option>'
    + variants.map((variant) => `<option value="${escapeHtml(variant.variant_id)}">${escapeHtml(variant.size)}</option>`).join('');
  if (variants.some((variant) => variant.variant_id === previous)) fields.size.value = previous;
  updateRowSummary(row);
}

function updateRowSummary(row) {
  const fields = getRowElements(row);
  const product = getProduct(fields.product.value);
  let quantity = Number(fields.quantity.value) || 1;
  quantity = Math.max(1, Math.min(1000, quantity)); // تطبيق الحدود
  fields.quantity.value = quantity;
  if (fields.qtyValue) fields.qtyValue.textContent = quantity;
  fields.unitPrice.textContent = product ? formatMoney(product.unit_price, product.currency) : '-';
  fields.lineTotal.textContent = product
    ? formatMoney(Number(product.unit_price) * quantity, product.currency)
    : '-';
  updateOrderTotal();
}

function addStorefrontItem() {
  const rowId = storefrontState.nextRowId++;
  const row = document.createElement('div');
  row.className = 'storefront-item';
  row.dataset.rowId = rowId;
  row.innerHTML = `
    <div class="storefront-item-grid">
      <div class="storefront-field"><label>الصنف *</label><select data-field="product" required><option value="">اختر الصنف</option>${storefrontState.products.map((product) => `<option value="${product.product_id}">${escapeHtml(product.name)}</option>`).join('')}</select></div>
      <div class="storefront-field"><label>اللون *</label><select data-field="color" required><option value="">اختر اللون</option></select></div>
      <div class="storefront-field"><label>المقاس *</label><select data-field="size" required><option value="">اختر المقاس</option></select></div>
      <div class="storefront-field">
        <label>الكمية *</label>
        <div class="quantity-stepper">
          <button type="button" class="qty-minus" aria-label="إنقاص الكمية">−</button>
          <span class="qty-value">1</span>
          <button type="button" class="qty-plus" aria-label="زيادة الكمية">+</button>
        </div>
        <input type="hidden" data-field="quantity" value="1" min="1" max="1000">
      </div>
    </div>
    <div class="storefront-item-summary"><span>سعر القطعة: <strong data-value="unit-price">-</strong></span><span>إجمالي الصنف: <strong data-value="line-total">-</strong></span></div>
    <button class="storefront-remove" type="button">حذف الصنف</button>`;

  const fields = getRowElements(row);
  fields.product.addEventListener('change', () => updateRowColors(row));
  fields.color.addEventListener('change', () => updateRowSizes(row));
  fields.size.addEventListener('change', () => updateRowSummary(row));

  // أحداث أزرار الكمية
  row.querySelector('.qty-plus').addEventListener('click', () => {
    const input = fields.quantity;
    input.value = Math.min(1000, Number(input.value) + 1);
    updateRowSummary(row);
  });
  row.querySelector('.qty-minus').addEventListener('click', () => {
    const input = fields.quantity;
    input.value = Math.max(1, Number(input.value) - 1);
    updateRowSummary(row);
  });

  row.querySelector('.storefront-remove').addEventListener('click', () => {
    if (storefrontElements.items.children.length === 1) {
      fields.product.value = '';
      fields.quantity.value = 1;
      updateRowColors(row);
      updateRowSummary(row);
      return;
    }
    row.remove();
    updateOrderTotal();
  });

  storefrontElements.items.appendChild(row);
  updateRowSummary(row);
}

function collectItems() {
  return [...storefrontElements.items.querySelectorAll('.storefront-item')].map((row) => {
    const fields = getRowElements(row);
    const product = getProduct(fields.product.value);
    const variant = product?.variants.find((item) => item.variant_id === fields.size.value);
    return {
      product,
      variantId: variant?.variant_id || '',
      quantity: Number(fields.quantity.value)
    };
  });
}

function updateOrderTotal() {
  const rows = collectItems().filter((item) => item.product);
  const currencies = unique(rows.map((item) => item.product.currency));
  if (!rows.length) {
    storefrontElements.total.textContent = '0';
    return;
  }
  if (currencies.length > 1) {
    storefrontElements.total.textContent = 'عملات مختلفة';
    return;
  }
  const total = rows.reduce((sum, item) => sum + Number(item.product.unit_price) * (item.quantity || 0), 0);
  storefrontElements.total.textContent = formatMoney(total, currencies[0]);
}

async function submitStorefrontOrder(event) {
  event.preventDefault();
  if (storefrontState.submitting) return;

  const customerName = document.getElementById('customerName').value.trim();
  const customerNumber = document.getElementById('customerNumber').value.trim();
  const address = document.getElementById('customerAddress').value.trim();
  const note = document.getElementById('customerNote').value.trim();
  const orderType = document.querySelector('input[name="orderType"]:checked')?.value;
  const selectedItems = collectItems();

  const invalidItems = !selectedItems.length || selectedItems.some((item) => (
    !item.product || !item.variantId || !Number.isInteger(item.quantity) || item.quantity < 1
  ));
  const currencies = unique(selectedItems.filter((item) => item.product).map((item) => item.product.currency));

  if (!customerName || !customerNumber || !address || !orderType || invalidItems || currencies.length > 1) {
    setStorefrontMessage('يرجى التأكد من تعبئة جميع البيانات المطلوبة قبل تأكيد الطلب.');
    return;
  }

  storefrontState.submitting = true;
  storefrontState.idempotencyKey ||= createUuid();
  storefrontElements.submit.disabled = true;
  storefrontElements.submit.textContent = 'جاري تأكيد طلبك...';
  setStorefrontMessage('');

  try {
    const response = await fetch(`/api/instagram/storefront/${encodeURIComponent(storefrontState.slug)}/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customerName,
        customerNumber,
        address,
        note,
        orderType,
        idempotencyKey: storefrontState.idempotencyKey,
        items: selectedItems.map((item) => ({
          variantId: item.variantId,
          quantity: item.quantity
        }))
      })
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || 'تعذر إرسال الطلب حالياً. يرجى المحاولة مرة أخرى.');

    storefrontElements.form.hidden = true;
    storefrontElements.successTitle.textContent = `شكراً لطلبك من ${storefrontState.companyName} ❤️`;
    storefrontElements.success.hidden = false;
    storefrontElements.success.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (error) {
    setStorefrontMessage(error.message || 'تعذر إرسال الطلب حالياً. يرجى المحاولة مرة أخرى.');
    storefrontElements.submit.disabled = false;
    storefrontElements.submit.textContent = 'تأكيد الطلب';
    storefrontState.submitting = false;
  }
}

async function initializeStorefront() {
  try {
    const response = await fetch(`/api/instagram/storefront/${encodeURIComponent(storefrontState.slug)}`, {
      cache: 'no-store'
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || 'رابط الطلب غير موجود أو متوقف');

    storefrontState.companyName = data.company_name;
    storefrontState.products = Array.isArray(data.products) ? data.products : [];
    storefrontElements.companyName.textContent = data.company_name;
    document.title = `اطلب من ${data.company_name}`;
    storefrontElements.loading.hidden = true;
    storefrontElements.app.hidden = false;

    if (!storefrontState.products.length) {
      setStorefrontMessage('لا توجد أصناف متوفرة للطلب حالياً.');
      storefrontElements.addItem.disabled = true;
      storefrontElements.submit.disabled = true;
      return;
    }
    addStorefrontItem();
  } catch (error) {
    storefrontElements.loading.textContent = error.message || 'تعذر تحميل رابط الطلب حالياً';
  }
}

storefrontElements.addItem.addEventListener('click', addStorefrontItem);
storefrontElements.form.addEventListener('submit', submitStorefrontOrder);
initializeStorefront();