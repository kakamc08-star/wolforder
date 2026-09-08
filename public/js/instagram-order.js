const storefrontState = {
  slug: decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() || ''),
  companyName: '',
  products: [],
  submitting: false,
  idempotencyKey: null,
  nextRowId: 1,
  catalogRefreshing: false
};

const storefrontElements = {
  loading: document.getElementById('storefrontLoading'),
  app: document.getElementById('storefrontApp'),
  companyName: document.getElementById('storefrontCompanyName'),
  form: document.getElementById('instagramCustomerOrderForm'),
  items: document.getElementById('storefrontItems'),
  addItem: document.getElementById('addStorefrontItem'),
  total: document.getElementById('storefrontTotal'),
  deliveryTotal: document.getElementById('storefrontDeliveryTotal'),
  shippingSummary: document.getElementById('storefrontShippingSummary'),
  itemsTotal: document.getElementById('storefrontItemsTotal'),
  shippingFee: document.getElementById('storefrontShippingFee'),
  finalTotal: document.getElementById('storefrontFinalTotal'),
  shippingNotice: document.getElementById('shippingNotice'),
  customerNameLabel: document.getElementById('customerNameLabel'),
  customerNameHint: document.getElementById('customerNameHint'),
  message: document.getElementById('storefrontMessage'),
  submit: document.getElementById('confirmInstagramOrder'),
  success: document.getElementById('storefrontSuccess'),
  successTitle: document.getElementById('storefrontSuccessTitle'),
  successDescription: document.getElementById('storefrontSuccessDescription')
};

const INSTAGRAM_SHIPPING_FEE = 10000;
const INSTAGRAM_NOTE_MAX_LENGTH = 85;

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

function normalizeCustomerNumber(value) {
  const digits = String(value ?? '')
    .replace(/[٠-٩]/g, (digit) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))
    .replace(/[۰-۹]/g, (digit) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)))
    .replace(/[^0-9]/g, '');
  for (const prefix of ['00963', '963']) {
    if (!digits.startsWith(prefix)) continue;
    const localPart = digits.slice(prefix.length);
    if (localPart.length === 9) return `0${localPart}`;
    if (localPart.length === 10 && localPart.startsWith('0')) return localPart;
  }
  return digits.length === 9 && digits.startsWith('9') ? `0${digits}` : digits;
}

function normalizeCustomerNumberField() {
  const input = document.getElementById('customerNumber');
  if (!input) return '';
  const normalized = normalizeCustomerNumber(input.value);
  input.dataset.phoneTooLong = normalized.length > 10 ? 'true' : 'false';
  const limited = normalized.slice(0, 10);
  if (input.value !== limited) input.value = limited;
  return limited;
}

function normalizeCustomerNoteField() {
  const input = document.getElementById('customerNote');
  if (!input) return '';
  const limited = Array.from(input.value || '').slice(0, INSTAGRAM_NOTE_MAX_LENGTH).join('');
  if (input.value !== limited) input.value = limited;
  const counter = document.getElementById('customerNoteCounter');
  if (counter) counter.textContent = `${Array.from(limited).length} / ${INSTAGRAM_NOTE_MAX_LENGTH}`;
  return limited;
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

function getSelectedOrderType() {
  return document.querySelector('input[name="orderType"]:checked')?.value || 'توصيل';
}

function updateShippingUi() {
  const isShipping = getSelectedOrderType() === 'شحن';
  if (storefrontElements.shippingNotice) storefrontElements.shippingNotice.hidden = !isShipping;
  if (storefrontElements.shippingSummary) storefrontElements.shippingSummary.hidden = !isShipping;
  if (storefrontElements.deliveryTotal) storefrontElements.deliveryTotal.hidden = isShipping;
  if (storefrontElements.customerNameHint) storefrontElements.customerNameHint.hidden = !isShipping;
  if (storefrontElements.customerNameLabel) {
    storefrontElements.customerNameLabel.textContent = isShipping ? 'الاسم الثلاثي *' : 'الاسم *';
  }
  updateOrderTotal();
}

function updateOrderTotal() {
  const isShipping = getSelectedOrderType() === 'شحن';
  const rows = collectItems().filter((item) => item.product);
  const currencies = unique(rows.map((item) => item.product.currency));
  if (!rows.length) {
    storefrontElements.total.textContent = '0';
    if (storefrontElements.itemsTotal) storefrontElements.itemsTotal.textContent = isShipping ? '0' : '';
    if (storefrontElements.shippingFee) storefrontElements.shippingFee.textContent = isShipping ? formatMoney(INSTAGRAM_SHIPPING_FEE, 'ل.س') : '';
    if (storefrontElements.finalTotal) storefrontElements.finalTotal.textContent = isShipping ? '0' : '';
    return;
  }
  if (currencies.length > 1) {
    storefrontElements.total.textContent = 'عملات مختلفة';
    if (storefrontElements.itemsTotal) storefrontElements.itemsTotal.textContent = isShipping ? 'عملات مختلفة' : '';
    if (storefrontElements.shippingFee) storefrontElements.shippingFee.textContent = isShipping ? formatMoney(INSTAGRAM_SHIPPING_FEE, 'ل.س') : '';
    if (storefrontElements.finalTotal) storefrontElements.finalTotal.textContent = isShipping ? 'غير متاح' : '';
    return;
  }
  const total = rows.reduce((sum, item) => sum + Number(item.product.unit_price) * (item.quantity || 0), 0);
  const currency = currencies[0];
  storefrontElements.total.textContent = formatMoney(total, currency);
  if (storefrontElements.itemsTotal) storefrontElements.itemsTotal.textContent = isShipping ? formatMoney(total, currency) : '';
  if (storefrontElements.shippingFee) storefrontElements.shippingFee.textContent = isShipping ? formatMoney(INSTAGRAM_SHIPPING_FEE, 'ل.س') : '';
  if (storefrontElements.finalTotal) {
    storefrontElements.finalTotal.textContent = !isShipping
      ? ''
      : currency === 'ل.س'
        ? formatMoney(total + INSTAGRAM_SHIPPING_FEE, currency)
        : 'غير متاح';
  }
  if (isShipping && currency !== 'ل.س') {
    setStorefrontMessage('أجور الشحن محددة بالليرة السورية، لذلك يجب اختيار أصناف مسعّرة بالليرة السورية.', 'error');
  } else if (storefrontElements.message.querySelector('.storefront-message')?.textContent?.includes('أجور الشحن محددة')) {
    setStorefrontMessage('');
  }
}

async function submitStorefrontOrder(event) {
  event.preventDefault();
  if (storefrontState.submitting) return;

  const customerName = document.getElementById('customerName').value.trim();
  const customerNumber = normalizeCustomerNumberField();
  const address = document.getElementById('customerAddress').value.trim();
  const note = normalizeCustomerNoteField().trim();
  const orderType = getSelectedOrderType();
  const selectedItems = collectItems();

  if (customerNumberInput.dataset.phoneTooLong === 'true' || !/^0\d{9}$/.test(customerNumber)) {
    setStorefrontMessage('رقم العميل يجب أن يتكون من 10 أرقام ويبدأ بالرقم 0');
    return;
  }
  if (address.length < 3) {
    setStorefrontMessage('العنوان مطلوب ويجب أن يتكون من 3 محارف على الأقل');
    return;
  }

  const invalidItems = !selectedItems.length || selectedItems.some((item) => (
    !item.product || !item.variantId || !Number.isInteger(item.quantity) || item.quantity < 1
  ));
  const currencies = unique(selectedItems.filter((item) => item.product).map((item) => item.product.currency));

  const nameParts = customerName.split(/\s+/).filter(Boolean);
  if (orderType === 'شحن' && nameParts.length < 3) {
    setStorefrontMessage('لطلبات الشحن يجب إدخال الاسم الثلاثي (3 أجزاء على الأقل).');
    return;
  }
  if (orderType === 'شحن' && currencies[0] !== 'ل.س') {
    setStorefrontMessage('أجور الشحن محددة بالليرة السورية، لذلك يجب اختيار أصناف مسعّرة بالليرة السورية.');
    return;
  }
  if (!customerName || invalidItems || currencies.length > 1) {
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
    if (storefrontElements.successDescription) {
      storefrontElements.successDescription.textContent = orderType === 'شحن'
        ? 'تم استلام طلب الشحن، وهو بانتظار موافقة الشركة قبل اعتماده.'
        : 'تم استلام طلب التوصيل بنجاح، وسيتم التواصل معك لمتابعة الطلب.';
    }
    storefrontElements.success.hidden = false;
    storefrontElements.success.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (error) {
    setStorefrontMessage(error.message || 'تعذر إرسال الطلب حالياً. يرجى المحاولة مرة أخرى.');
    storefrontElements.submit.disabled = false;
    storefrontElements.submit.textContent = 'تأكيد الطلب';
    storefrontState.submitting = false;
  }
}

function storefrontProductOptions(selectedProductId = '') {
  return '<option value="">اختر الصنف</option>'
    + storefrontState.products.map((product) => `<option value="${escapeHtml(product.product_id)}" ${product.product_id === selectedProductId ? 'selected' : ''}>${escapeHtml(product.name)}</option>`).join('');
}

function refreshStorefrontProductSelectors() {
  storefrontElements.items.querySelectorAll('.storefront-item').forEach((row) => {
    const fields = getRowElements(row);
    const selectedProductId = fields.product.value;
    fields.product.innerHTML = storefrontProductOptions(selectedProductId);
    updateRowColors(row);
  });
}

function applyStorefrontCatalog(data, initial = false) {
  const previousProducts = storefrontState.products;
  const nextProducts = Array.isArray(data.products) ? data.products : [];
  const hadProducts = previousProducts.length > 0;

  storefrontState.companyName = data.company_name || '';
  storefrontState.products = nextProducts;
  storefrontElements.companyName.textContent = storefrontState.companyName;
  document.title = `اطلب من ${storefrontState.companyName}`;
  storefrontElements.loading.hidden = true;
  storefrontElements.app.hidden = false;

  if (!nextProducts.length) {
    if (initial || hadProducts) setStorefrontMessage('لا توجد أصناف متوفرة للطلب حالياً.');
    storefrontElements.addItem.disabled = true;
    storefrontElements.submit.disabled = true;
    return;
  }

  storefrontElements.addItem.disabled = false;
  if (!storefrontElements.items.children.length) addStorefrontItem();
  else if (initial || JSON.stringify(previousProducts) !== JSON.stringify(nextProducts)) refreshStorefrontProductSelectors();

  const currentMessage = storefrontElements.message.querySelector('.storefront-message')?.textContent || '';
  if (currentMessage === 'لا توجد أصناف متوفرة للطلب حالياً.') setStorefrontMessage('');
  if (!storefrontState.submitting) storefrontElements.submit.disabled = false;
}

async function fetchStorefrontCatalog() {
  const response = await fetch(`/api/instagram/storefront/${encodeURIComponent(storefrontState.slug)}`, {
    cache: 'no-store'
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || 'رابط الطلب غير موجود أو متوقف');
  return data;
}

async function refreshStorefrontCatalog(initial = false) {
  if (storefrontState.catalogRefreshing || storefrontElements.success.hidden === false) return;
  storefrontState.catalogRefreshing = true;
  try {
    const data = await fetchStorefrontCatalog();
    applyStorefrontCatalog(data, initial);
  } catch (error) {
    if (initial) throw error;
    console.warn('Storefront catalog refresh failed:', error.message);
  } finally {
    storefrontState.catalogRefreshing = false;
  }
}

let storefrontSocket;
function connectStorefrontSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  storefrontSocket = new WebSocket(`${protocol}//${window.location.host}`);
  storefrontSocket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.source === 'instagram' && ['INSTAGRAM_ORDER_CREATED', 'INSTAGRAM_ORDER_UPDATED', 'INSTAGRAM_ORDER_DELETED', 'INSTAGRAM_INVENTORY_UPDATED'].includes(data.type)) {
        refreshStorefrontCatalog();
      }
    } catch (error) {
      console.warn('Storefront WebSocket message error:', error);
    }
  };
  storefrontSocket.onclose = () => window.setTimeout(connectStorefrontSocket, 5000);
  storefrontSocket.onerror = () => storefrontSocket.close();
}

async function initializeStorefront() {
  try {
    await refreshStorefrontCatalog(true);
    connectStorefrontSocket();
    window.setInterval(() => refreshStorefrontCatalog(), 30000);
  } catch (error) {
    storefrontElements.loading.textContent = error.message || 'تعذر تحميل رابط الطلب حالياً';
  }
}

storefrontElements.addItem.addEventListener('click', addStorefrontItem);
storefrontElements.form.addEventListener('submit', submitStorefrontOrder);
document.querySelectorAll('input[name="orderType"]').forEach((input) => {
  input.addEventListener('change', updateShippingUi);
});
const customerNumberInput = document.getElementById('customerNumber');
customerNumberInput.addEventListener('input', normalizeCustomerNumberField);
customerNumberInput.addEventListener('blur', normalizeCustomerNumberField);
customerNumberInput.addEventListener('paste', (event) => {
  event.preventDefault();
  const pastedText = event.clipboardData?.getData('text') || '';
  customerNumberInput.value = normalizeCustomerNumber(pastedText);
  customerNumberInput.dispatchEvent(new Event('input', { bubbles: true }));
  if (customerNumberInput.dataset.phoneTooLong === 'true') {
    setStorefrontMessage('رقم العميل يجب أن يتكون من 10 أرقام ويبدأ بالرقم 0');
  }
});
document.getElementById('customerNote').addEventListener('input', normalizeCustomerNoteField);
normalizeCustomerNoteField();
updateShippingUi();
initializeStorefront();
