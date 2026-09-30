const express = require('express');
const bcrypt = require('bcryptjs');
const { randomUUID } = require('crypto');
const supabase = require('../config/db');
const authenticateToken = require('../middleware/auth');
const { normalizePhone } = require('../utils/instagram-validation');
const { validateInstagramEditChanges } = require('../utils/instagram-edit-validation');

const router = express.Router();
const INSTAGRAM_ORDER_TYPE_ALIASES = Object.freeze({
  'توصيل': 'توصيل',
  delivery: 'توصيل',
  'شحن': 'شحن',
  shipping: 'شحن'
});
const INSTAGRAM_ORDER_TYPES = new Set(['توصيل', 'شحن']);
const INSTAGRAM_SHIPPING_FEE = 10000;
const INSTAGRAM_STATUSES = new Set(['قيد المتابعة', 'تم', 'مؤجل', 'مرتجع', 'إلغاء']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const publicOrderAttempts = new Map();

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ message: 'غير مصرح لك بتنفيذ هذه العملية' });
    }
    next();
  };
}

function broadcastInstagramUpdate(req, type = 'INSTAGRAM_ORDER_UPDATED') {
  const broadcast = req.app.get('broadcast');
  if (broadcast) broadcast({ type, source: 'instagram' });
}

function cleanText(value, maxLength = 500) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function normalizeInstagramSearch(value) {
  return cleanText(value, 200)
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
    instagramStatusLabel(order),
    ...itemValues
  ];
}

function parseNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeInstagramPhone(value) {
  return normalizePhone(value);
}

function normalizeInstagramOrderType(value, fallback = '') {
  const key = cleanText(value, 20).toLocaleLowerCase('en-US');
  const normalized = INSTAGRAM_ORDER_TYPE_ALIASES[key] || '';
  return INSTAGRAM_ORDER_TYPES.has(normalized) ? normalized : fallback;
}

function instagramOrderType(order) {
  return normalizeInstagramOrderType(order?.order_type, 'توصيل');
}

function isInstagramShippingOrder(order) {
  return instagramOrderType(order) === 'شحن';
}

function instagramStatusLabel(order) {
  return isInstagramShippingOrder(order)
    ? (order.shipping_delivery_status === 'delivered' ? 'تم التسليم' : 'لم يتم التسليم')
    : order.status;
}

function applyInstagramStatusFilter(query, status, shippingDeliveryStatus = '') {
  const shippingStatus = status === 'تم التسليم' ? 'delivered' : status === 'لم يتم التسليم' ? 'pending' : shippingDeliveryStatus;
  if (shippingStatus) {
    if (!['pending', 'delivered'].includes(shippingStatus)) {
      const error = new Error('حالة تسليم الشحن غير صالحة'); error.status = 400; throw error;
    }
    return query.eq('order_type', 'شحن').eq('shipping_delivery_status', shippingStatus);
  }
  if (!status) return query;
  if (!INSTAGRAM_STATUSES.has(status)) {
    const error = new Error('حالة الطلب غير صالحة'); error.status = 400; throw error;
  }
  // General delivery filters must never classify shipping by its legacy status.
  return query.or('order_type.eq.توصيل,order_type.is.null').eq('status', status);
}

async function assertInstagramDeliveryOrders(orderIds, message = 'لا يمكن تعيين سائق لطلب شحن') {
  const { data, error } = await supabase
    .from('instagram_orders')
    .select('id, order_type')
    .in('id', orderIds);
  if (error) throw error;
  if ((data || []).some((order) => isInstagramShippingOrder(order))) {
    const error = new Error(message);
    error.status = 400;
    throw error;
  }
}

function isUuid(value) {
  return UUID_PATTERN.test(String(value || ''));
}

function validIdList(value, maxLength = 500) {
  return Array.isArray(value)
    && value.length > 0
    && value.length <= maxLength
    && value.every(isUuid);
}

function publicRateLimit(req, res, next) {
  const now = Date.now();
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  const current = publicOrderAttempts.get(key);

  if (!current || current.expiresAt <= now) {
    publicOrderAttempts.set(key, { count: 1, expiresAt: now + 5 * 60 * 1000 });
    return next();
  }

  current.count += 1;
  if (current.count > 60) {
    return res.status(429).json({
      message: 'عدد المحاولات كبير، يرجى الانتظار قليلاً ثم المحاولة مجدداً'
    });
  }

  next();
}

function instagramCreateOrderError(error) {
  const raw = [error?.message, error?.details, error?.hint]
    .filter(Boolean)
    .join(' ');

  if (/PGRST202|create_instagram_order_atomic|schema cache|column .* does not exist|order_number|next_order_number|line_total|generated column|non-DEFAULT value|instagram_inventory_movement_type_check|check constraint/i.test(raw)) {
    return {
      status: 503,
      message: 'قاعدة بيانات Instagram تحتاج إلى تشغيل Migration الشحن المحدّث قبل إنشاء الطلب.'
    };
  }
  if (/المخزون|غير متوفر|الكمية|OUT_OF_STOCK/i.test(raw)) {
    return {
      status: 409,
      message: 'عذراً، الكمية المطلوبة غير متوفرة حالياً. يرجى تقليل الكمية والمحاولة مرة أخرى.'
    };
  }
  if (/الليرة|العملة/i.test(raw)) {
    return { status: 400, message: 'طلبات الشحن متاحة بالليرة السورية فقط.' };
  }
  if (/رابط Instagram غير صالح|متوقف/i.test(raw)) {
    return { status: 400, message: 'رابط Instagram غير صالح أو متوقف.' };
  }
  if (/الصنف المحدد غير موجود|الصنف أو الكمية غير صالحة/i.test(raw)) {
    return { status: 400, message: 'الصنف المحدد غير متوفر أو لم تعد تركيبته صالحة.' };
  }
  return { status: 400, message: 'تعذر إرسال الطلب حالياً. يرجى المحاولة مرة أخرى.' };
}

async function getViewerCompanyId(userId) {
  const { data, error } = await supabase
    .from('instagram_viewer_companies')
    .select('company_id')
    .eq('viewer_user_id', userId)
    .maybeSingle();

  if (error) throw error;
  return data?.company_id || null;
}

function summarizeItems(items = []) {
  return items
    .map((item) => {
      const productName = item.product_name || item.variant?.product?.name || 'غير معروف';
      const color = item.color || item.variant?.color || '';
      const size = item.size || item.variant?.size || '';
      const quantity = item.quantity || 0;
      return `${productName} - ${color}/${size} × ${quantity}`;
    })
    .join('، ');
}

function normalizeInstagramOrder(order) {
  const items = Array.isArray(order.items) ? order.items : [];
  const {
    shipping_approved_by: _shippingApprovedBy,
    shipping_approval_status: _shippingApprovalStatus,
    shipping_approved_at: _shippingApprovedAt,
    shipping_delivered_by: _shippingDeliveredBy,
    ...safeOrder
  } = order;
  const orderType = instagramOrderType(order);
  const totalPrice = Number(order.total_price) || 0;
  const shippingFee = Number(order.shipping_fee) || 0;
  const hasItemsTotal = order.items_total !== undefined && order.items_total !== null;
  const itemsTotal = hasItemsTotal
    ? Number(order.items_total) || 0
    : Math.max(0, totalPrice - shippingFee);
  return {
    ...safeOrder,
    items,
    order_type: orderType,
    status_label: instagramStatusLabel(order),
    shipping_delivery_status: order.shipping_delivery_status === 'delivered' ? 'delivered' : 'pending',
    shipping_fee: shippingFee,
    items_total: itemsTotal,
    final_total: totalPrice,
    order_source: 'instagram',
    price: totalPrice,
    order_contents: summarizeItems(items)
  };
}

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function inventoryToExcelXml(rows) {
  const columns = [
    ['company_name', 'الشركة'],
    ['product_name', 'الصنف'],
    ['color', 'اللون'],
    ['size', 'المقاس'],
    ['quantity_total', 'الكمية الكلية'],
    ['reserved_delivery', 'المحجوزة من التوصيل'],
    ['reserved_shipping', 'المحجوزة من الشحن'],
    ['sold', 'المباعة'],
    ['shipping_delivered', 'الشحن المُسلَّم'],
    ['postponed', 'المؤجلة'],
    ['returned', 'المرتجع'],
    ['cancelled', 'الإلغاء'],
    ['remaining', 'المتبقية']
  ];

  const header = columns
    .map(([, label]) => `<Cell><Data ss:Type="String">${escapeXml(label)}</Data></Cell>`)
    .join('');

  const body = rows.map((row) => {
    const cells = columns.map(([key], index) => {
      const numeric = index >= 4;
      const type = numeric ? 'Number' : 'String';
      const value = numeric ? parseNumber(row[key], 0) : row[key];
      return `<Cell><Data ss:Type="${type}">${escapeXml(value)}</Data></Cell>`;
    }).join('');
    return `<Row>${cells}</Row>`;
  }).join('');

  return `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
 <Worksheet ss:Name="جرد Instagram"><Table><Row>${header}</Row>${body}</Table></Worksheet>
</Workbook>`;
}

async function loadInventoryForUser(user, filters = {}) {
  let companyId = filters.companyId || null;

  if (user.role === 'instagram_viewer') {
    companyId = await getViewerCompanyId(user.id);
    if (!companyId) throw new Error('حساب المشاهدة غير مربوط بشركة');
  } else if (user.role !== 'admin') {
    const error = new Error('لا تملك صلاحية مشاهدة جرد Instagram');
    error.status = 403;
    throw error;
  }

  let query = supabase
    .from('instagram_inventory_summary')
    .select('*')
    .order('company_name')
    .order('product_name')
    .order('color')
    .order('size');

  if (companyId) query = query.eq('company_id', companyId);
  if (filters.productId) query = query.eq('product_id', filters.productId);

  const { data, error } = await query;
  if (error) throw error;
  let totalsQuery = supabase.from('instagram_inventory_delivery_totals').select('*');
  if (companyId) totalsQuery = totalsQuery.eq('company_id', companyId);
  if (filters.productId) totalsQuery = totalsQuery.eq('product_id', filters.productId);
  const { data: totals, error: totalsError } = await totalsQuery;
  if (totalsError) throw totalsError;
  const rowKey = (row) => JSON.stringify([row.company_id, row.product_id, row.color, row.size]);
  const totalsByVariant = new Map((totals || []).map((row) => [rowKey(row), row]));
  return (data || []).map((row) => {
    const total = totalsByVariant.get(rowKey(row)) || {};
    return {
      ...row,
      reserved_delivery: Number(row.reserved_delivery) || 0,
      reserved_shipping: Number(total.reserved_shipping) || 0,
      sold: Number(total.sold_delivery) || 0,
      shipping_delivered: Number(total.shipping_delivered) || 0
    };
  });
}

// =========================================================
// Public storefront routes (no login)
// =========================================================

router.get('/storefront/:slug', async (req, res) => {
  try {
    const { data, error } = await supabase.rpc('get_instagram_storefront_catalog_filtered', {
      p_slug: req.params.slug
    });

    if (error) {
      console.error('Instagram storefront error:', error.message);
      return res.status(404).json({ message: 'رابط الطلب غير موجود أو متوقف' });
    }

    if (!data) {
      return res.status(404).json({ message: 'رابط الطلب غير موجود أو متوقف' });
    }

    res.set('Cache-Control', 'no-store');
    res.json(data);
  } catch (error) {
    console.error('Instagram storefront exception:', error);
    res.status(500).json({ message: 'تعذر تحميل رابط الطلب حالياً' });
  }
});

router.post('/storefront/:slug/orders', publicRateLimit, async (req, res) => {
  try {
    const customerName = cleanText(req.body.customerName, 100);
    const customerNumber = normalizeInstagramPhone(req.body.customerNumber);
    const address = cleanText(req.body.address, 300);
    const note = cleanText(req.body.note, 1000);
    const requestedOrderType = cleanText(req.body.orderType, 20);
    const orderType = normalizeInstagramOrderType(requestedOrderType || 'توصيل');
    const idempotencyKey = cleanText(req.body.idempotencyKey, 50);
    const items = Array.isArray(req.body.items) ? req.body.items : [];

    if (!/^[0-9]{10}$/.test(customerNumber)) {
      return res.status(400).json({ message: 'رقم العميل يجب أن يتكون من 10 أرقام' });
    }

    const nameParts = customerName.split(/\s+/).filter(Boolean);
    if (!customerName
      || (requestedOrderType && !orderType)
      || (orderType === 'شحن' && nameParts.length < 3)) {
      return res.status(400).json({
        message: orderType === 'شحن' && nameParts.length < 3
          ? 'لطلبات الشحن يجب إدخال الاسم الثلاثي (3 أجزاء على الأقل).'
          : 'يرجى التأكد من تعبئة جميع البيانات المطلوبة قبل تأكيد الطلب.'
      });
    }

    if (!isUuid(idempotencyKey) || items.length === 0 || items.length > 50) {
      return res.status(400).json({
        message: 'يرجى التأكد من تعبئة جميع البيانات المطلوبة قبل تأكيد الطلب.'
      });
    }

    const quantityByVariant = new Map();
    items.forEach((item) => {
      const variantId = cleanText(item.variantId, 50);
      const quantity = Number(item.quantity);
      quantityByVariant.set(variantId, (quantityByVariant.get(variantId) || 0) + quantity);
    });
    const normalizedItems = [...quantityByVariant].map(([variant_id, quantity]) => ({
      variant_id,
      quantity
    }));

    if (normalizedItems.some((item) => !isUuid(item.variant_id)
      || !Number.isInteger(item.quantity)
      || item.quantity < 1
      || item.quantity > 1000)) {
      return res.status(400).json({
        message: 'يرجى التأكد من تعبئة جميع البيانات المطلوبة قبل تأكيد الطلب.'
      });
    }

    const { data, error } = await supabase.rpc('create_instagram_order_atomic', {
      p_slug: req.params.slug,
      p_customer_name: customerName,
      p_customer_number: customerNumber,
      p_address: address,
      p_order_type: orderType,
      p_items: normalizedItems,
      p_idempotency_key: idempotencyKey,
      p_note: note
    });

    if (error) {
      console.error('Create Instagram order error:', error.message);
      const failure = instagramCreateOrderError(error);
      return res.status(failure.status).json({ message: failure.message });
    }

    broadcastInstagramUpdate(req, 'INSTAGRAM_ORDER_CREATED');
    res.status(201).json({
      ...data,
      message: orderType === 'شحن'
        ? 'تم تسجيل طلب الشحن بنجاح ويظهر مباشرة لدى الشركة.'
        : 'تم استلام طلب التوصيل.'
    });
  } catch (error) {
    console.error('Create Instagram order exception:', error);
    const failure = instagramCreateOrderError(error);
    res.status(failure.status === 400 ? 500 : failure.status).json({ message: failure.message });
  }
});

// All routes below require a WolfOrder login.
router.use(authenticateToken);

// =========================================================
// Bootstrap and lists
// =========================================================

router.get('/admin/bootstrap', requireRole('admin'), async (req, res) => {
  try {
    const [companiesResult, driversResult, linksResult, viewersResult, mappingsResult] = await Promise.all([
      supabase.from('users').select('id, name, username').eq('role', 'company').order('name'),
      supabase.from('users').select('id, name, username').eq('role', 'driver').order('name'),
      supabase.from('instagram_company_links').select('*').order('created_at'),
      supabase.from('users').select('id, name, username').eq('role', 'instagram_viewer').order('name'),
      supabase.from('instagram_viewer_companies').select('*')
    ]);

    const failure = [companiesResult, driversResult, linksResult, viewersResult, mappingsResult]
      .find((result) => result.error);
    if (failure) throw failure.error;

    res.json({
      companies: companiesResult.data || [],
      drivers: driversResult.data || [],
      links: linksResult.data || [],
      viewers: viewersResult.data || [],
      viewerMappings: mappingsResult.data || []
    });
  } catch (error) {
    console.error('Instagram bootstrap error:', error);
    res.status(500).json({ message: error.message });
  }
});

// =========================================================
// Orders
// =========================================================

router.get('/orders', requireRole('admin', 'instagram_viewer', 'driver'), async (req, res) => {
  try {
    const { status, shippingDeliveryStatus, orderType, companyId, driverId, startDate, endDate, search, productId } = req.query;
    const normalizedOrderType = orderType ? normalizeInstagramOrderType(orderType) : '';
    if (orderType && !normalizedOrderType) {
      return res.status(400).json({ message: 'نوع الطلب غير صالح' });
    }

    let query = supabase
      .from('instagram_orders')
      .select('*, items:instagram_order_items(*)')
      .eq('is_archived', false)
      .order('created_at', { ascending: false });

    if (req.user.role === 'instagram_viewer') {
      const allowedCompanyId = await getViewerCompanyId(req.user.id);
      if (!allowedCompanyId) return res.status(403).json({ message: 'حساب المشاهدة غير مربوط بشركة' });
      query = query.eq('company_id', allowedCompanyId);
    } else if (req.user.role === 'driver') {
      query = query.eq('driver_id', req.user.id).eq('order_type', 'توصيل');
    } else {
      if (companyId) query = query.eq('company_id', companyId);
      if (driverId === 'unassigned') query = query.is('driver_id', null);
      else if (driverId) query = query.eq('driver_id', driverId);
    }

    query = applyInstagramStatusFilter(query, status, shippingDeliveryStatus);
    if (normalizedOrderType === 'شحن') {
      query = query.eq('order_type', 'شحن');
    } else if (normalizedOrderType === 'توصيل') {
      // NULL is a legacy delivery record until the migration backfills it.
      query = query.or('order_type.eq.توصيل,order_type.is.null');
    }
    if (startDate) query = query.gte('created_at', startDate);
    if (endDate) query = query.lte('created_at', `${endDate}T23:59:59.999Z`);

    const { data, error } = await query.limit(2000);
    if (error) throw error;

    const term = normalizeInstagramSearch(search);
    const visible = (data || []).filter((order) => !productId || (order.items || []).some((item) => item.product_id === productId));
    const typeFiltered = normalizedOrderType
      ? visible.filter((order) => instagramOrderType(order) === normalizedOrderType)
      : visible;
    const filtered = term
      ? typeFiltered.filter((order) => [
          ...instagramOrderSearchValues(order)
        ].some((value) => normalizeInstagramSearch(value).includes(term)))
      : typeFiltered;

    res.json(filtered.map(normalizeInstagramOrder));
  } catch (error) {
    console.error('Instagram orders error:', error);
    res.status(500).json({ message: error.message });
  }
});

// =========================================================
// Reports and export (must be before dynamic /orders/:id)
// =========================================================

router.get('/orders/report', requireRole('admin'), async (req, res) => {
  try {
    const { companyId, productId, orderType, startDate, endDate, status, shippingDeliveryStatus } = req.query;
    const normalizedOrderType = orderType ? normalizeInstagramOrderType(orderType) : '';
    if (orderType && !normalizedOrderType) {
      return res.status(400).json({ message: 'نوع الطلب غير صالح' });
    }

    let query = supabase
      .from('instagram_orders')
      .select(`
        *,
        items:instagram_order_items(
          quantity,
          variant:instagram_variants(
            color,
            size,
            product:instagram_products(id, name)
          )
        )
      `)
      .eq('is_archived', false)
      .order('created_at', { ascending: false });

    if (companyId) query = query.eq('company_id', companyId);
    query = applyInstagramStatusFilter(query, status, shippingDeliveryStatus);
    if (normalizedOrderType === 'شحن') query = query.eq('order_type', 'شحن');
    if (normalizedOrderType === 'توصيل') query = query.or('order_type.eq.توصيل,order_type.is.null');
    if (startDate) query = query.gte('created_at', startDate);
    if (endDate) query = query.lte('created_at', `${endDate}T23:59:59.999Z`);

    let { data: orders, error } = await query;
    if (error) throw error;

    orders = orders || [];
    if (normalizedOrderType) {
      orders = orders.filter((order) => instagramOrderType(order) === normalizedOrderType);
    }

    if (productId) {
      orders = orders.filter(order =>
        order.items.some(item => item.variant?.product?.id === productId)
      );
    }

    let totalSYR = 0;
    let totalUSD = 0;
    let totalRatio = 0;

    const reportOrders = orders.map(order => {
      const price = Number(order.total_price) || 0;
      if (order.currency === 'دولار') {
        totalUSD += price;
      } else {
        totalSYR += price;
      }
      totalRatio += Number(order.ratio) || 0;

      const itemsSummary = (order.items || []).map(item => {
        const productName = item.variant?.product?.name || 'غير معروف';
        const color = item.variant?.color || '';
        const size = item.variant?.size || '';
        const qty = item.quantity || 0;
        return `${productName} - ${color}/${size} × ${qty}`;
      }).join('، ');

      return {
        id: order.id,
        order_number: order.order_number,
        created_at: order.created_at,
        company_name: order.company_name,
        order_type: instagramOrderType(order),
        customer_name: order.customer_name,
        customer_number: order.customer_number,
        address: order.address,
        items_summary: itemsSummary,
        items_total: Number(order.items_total) || Math.max(0, price - (Number(order.shipping_fee) || 0)),
        shipping_fee: Number(order.shipping_fee) || 0,
        total_price: price,
        currency: order.currency || 'ل.س',
        ratio: order.ratio || 0,
        status: instagramStatusLabel(order),
        note: order.note
      };
    });

    res.json({
      count: reportOrders.length,
      totalSYR,
      totalUSD,
      totalRatio,
      orders: reportOrders
    });
  } catch (error) {
    console.error('Instagram report error:', error);
    res.status(400).json({ message: error.message });
  }
});

router.get('/orders/export', requireRole('admin'), async (req, res) => {
  try {
    const { companyId, productId, orderType, startDate, endDate, status, shippingDeliveryStatus } = req.query;
    const normalizedOrderType = orderType ? normalizeInstagramOrderType(orderType) : '';
    if (orderType && !normalizedOrderType) {
      return res.status(400).json({ message: 'نوع الطلب غير صالح' });
    }

    let query = supabase
      .from('instagram_orders')
      .select(`
        *,
        items:instagram_order_items(
          quantity,
          variant:instagram_variants(
            color,
            size,
            product:instagram_products(id, name)
          )
        )
      `)
      .eq('is_archived', false)
      .order('created_at', { ascending: false });

    if (companyId) query = query.eq('company_id', companyId);
    query = applyInstagramStatusFilter(query, status, shippingDeliveryStatus);
    if (normalizedOrderType === 'شحن') query = query.eq('order_type', 'شحن');
    if (normalizedOrderType === 'توصيل') query = query.or('order_type.eq.توصيل,order_type.is.null');
    if (startDate) query = query.gte('created_at', startDate);
    if (endDate) query = query.lte('created_at', `${endDate}T23:59:59.999Z`);

    let { data: orders, error } = await query;
    if (error) throw error;

    orders = orders || [];
    if (normalizedOrderType) {
      orders = orders.filter((order) => instagramOrderType(order) === normalizedOrderType);
    }

    if (productId) {
      orders = orders.filter(order =>
        order.items.some(item => item.variant?.product?.id === productId)
      );
    }

    const headers = ['رقم الطلب', 'التاريخ', 'الشركة', 'النوع', 'الزبون', 'الأصناف', 'قيمة الأصناف', 'أجور الشحن', 'الإجمالي النهائي', 'العملة', 'النسبة', 'الحالة', 'ملاحظة'];
    const rows = orders.map(order => {
      const itemsSummary = (order.items || []).map(item => {
        const productName = item.variant?.product?.name || 'غير معروف';
        const color = item.variant?.color || '';
        const size = item.variant?.size || '';
        const qty = item.quantity || 0;
        return `${productName} - ${color}/${size} × ${qty}`;
      }).join('، ');

      return [
        order.order_number,
        new Date(order.created_at).toLocaleDateString('en-GB'),
        order.company_name || '',
        instagramOrderType(order),
        order.customer_name || '',
        itemsSummary,
        Number(order.items_total) || Math.max(0, (Number(order.total_price) || 0) - (Number(order.shipping_fee) || 0)),
        Number(order.shipping_fee) || 0,
        order.total_price || 0,
        order.currency || 'ل.س',
        order.ratio || 0,
        instagramStatusLabel(order) || '',
        order.note || ''
      ];
    });

    if (rows.length === 0) {
      return res.status(404).json({ message: 'لا توجد بيانات للتصدير' });
    }

    const escape = val => `"${String(val).replace(/"/g, '""')}"`;
    const csv = '\uFEFF' + [headers.map(escape).join(';'), ...rows.map(row => row.map(escape).join(';'))].join('\n');

    res.header('Content-Type', 'text/csv; charset=utf-8');
    res.header('Content-Disposition', 'attachment; filename=instagram-report.csv');
    res.send(csv);
  } catch (error) {
    console.error('Instagram export error:', error);
    res.status(400).json({ message: error.message });
  }
});

router.get('/orders/:id', requireRole('admin', 'instagram_viewer', 'driver'), async (req, res) => {
  try {
    let query = supabase
      .from('instagram_orders')
      .select('*, items:instagram_order_items(*)')
      .eq('id', req.params.id)
      .eq('is_archived', false);

    if (req.user.role === 'instagram_viewer') {
      const companyId = await getViewerCompanyId(req.user.id);
      if (!companyId) return res.status(403).json({ message: 'حساب المشاهدة غير مربوط بشركة' });
      query = query.eq('company_id', companyId);
    } else if (req.user.role === 'driver') {
      query = query.eq('driver_id', req.user.id).eq('order_type', 'توصيل');
    }

    const { data, error } = await query.maybeSingle();
    if (error) throw error;
    if (!data) {
      return res.status(404).json({ message: 'الطلب غير موجود أو غير مصرح' });
    }
    res.json(normalizeInstagramOrder(data));
  } catch (error) {
    console.error('Instagram order details error:', error);
    res.status(500).json({ message: error.message });
  }
});

// حذف نهائي لطلب Instagram مع إعادة المخزون
router.delete('/orders/:id', requireRole('admin'), async (req, res) => {
  try {
    if (!isUuid(req.params.id)) {
      return res.status(400).json({ message: 'معرف الطلب غير صالح' });
    }

    const { data, error } = await supabase.rpc('delete_instagram_order_atomic', {
      p_order_id: req.params.id,
      p_actor_user_id: req.user.id
    });

    if (error) {
      console.error('Delete order atomic error:', error.message);
      return res.status(400).json({ message: error.message });
    }

    broadcastInstagramUpdate(req, 'INSTAGRAM_ORDER_DELETED');
    broadcastInstagramUpdate(req, 'INSTAGRAM_INVENTORY_UPDATED');
    res.json({ success: true, message: 'تم حذف الطلب نهائياً وإعادة المخزون' });
  } catch (error) {
    console.error('Delete Instagram order exception:', error);
    res.status(400).json({ message: error.message });
  }
});

router.patch('/orders/bulk-status', requireRole('admin'), async (req, res) => {
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
    const status = cleanText(req.body.status, 30);
    if (!validIdList(ids) || !INSTAGRAM_STATUSES.has(status)) {
      return res.status(400).json({ message: 'الطلبات أو الحالة غير صالحة' });
    }

    await assertInstagramDeliveryOrders(ids, 'طلبات الشحن تستخدم حالة تم التسليم أو لم يتم التسليم فقط');
    const { data, error } = await supabase.rpc('change_instagram_orders_status_atomic', {
      p_order_ids: ids,
      p_new_status: status,
      p_actor_user_id: req.user.id,
      p_note: cleanText(req.body.note, 1000) || null
    });
    if (error) throw error;
    broadcastInstagramUpdate(req);
    broadcastInstagramUpdate(req, 'INSTAGRAM_INVENTORY_UPDATED');
    res.json(data);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// تعيين شركة لعدة طلبات
router.patch('/orders/bulk-company', requireRole('admin'), async (req, res) => {
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
    if (!validIdList(ids) || !isUuid(req.body.companyId)) {
      return res.status(400).json({ message: 'يرجى تحديد الطلبات والشركة' });
    }
    const { data: selectedOrders, error: selectedOrdersError } = await supabase
      .from('instagram_orders')
      .select('id, order_type')
      .in('id', ids);
    if (selectedOrdersError) throw selectedOrdersError;
    if ((selectedOrders || []).length !== ids.length) {
      return res.status(400).json({ message: 'يوجد طلب Instagram غير موجود ضمن التحديد' });
    }
    if ((selectedOrders || []).some(isInstagramShippingOrder)) {
      return res.status(400).json({ message: 'لا يمكن تغيير الشركة المرتبطة بطلب شحن' });
    }
    const { data: company } = await supabase
      .from('users')
      .select('name')
      .eq('id', req.body.companyId)
      .eq('role', 'company')
      .single();
    if (!company) return res.status(400).json({ message: 'الشركة المحددة غير موجودة' });
    const { error } = await supabase
      .from('instagram_orders')
      .update({ company_id: req.body.companyId, company_name: company.name })
      .in('id', ids);
    if (error) throw error;
    broadcastInstagramUpdate(req);
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// حذف عدة طلبات نهائياً
router.post('/orders/bulk-delete', requireRole('admin'), async (req, res) => {
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
    if (!validIdList(ids)) return res.status(400).json({ message: 'لم يتم تحديد طلبات صالحة' });
    const { data, error } = await supabase.rpc('delete_instagram_orders_atomic', {
      p_order_ids: ids,
      p_actor_user_id: req.user.id
    });
    if (error) throw error;
    broadcastInstagramUpdate(req, 'INSTAGRAM_ORDER_DELETED');
    broadcastInstagramUpdate(req, 'INSTAGRAM_INVENTORY_UPDATED');
    res.json(data || { success: true, deleted_count: ids.length });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

router.patch('/orders/assign-driver', requireRole('admin'), async (req, res) => {
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
    if (!validIdList(ids) || !isUuid(req.body.driverId)) {
      return res.status(400).json({ message: 'يرجى تحديد الطلبات والسائق' });
    }

    await assertInstagramDeliveryOrders(ids);

    const ratio = req.body.ratio === null || req.body.ratio === undefined || req.body.ratio === ''
      ? null
      : parseNumber(req.body.ratio, -1);
    if (ratio !== null && ratio < 0) return res.status(400).json({ message: 'النسبة غير صالحة' });

    const { data, error } = await supabase.rpc('assign_instagram_orders_driver_atomic', {
      p_order_ids: ids,
      p_driver_id: req.body.driverId,
      p_actor_user_id: req.user.id,
      p_ratio: ratio
    });
    if (error) throw error;
    broadcastInstagramUpdate(req);
    res.json(data);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

router.patch('/orders/unassign-driver', requireRole('admin'), async (req, res) => {
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
    if (!validIdList(ids)) return res.status(400).json({ message: 'لم يتم تحديد طلبات صالحة' });
    await assertInstagramDeliveryOrders(ids);
    const { data, error } = await supabase.rpc('unassign_instagram_orders_driver_atomic', {
      p_order_ids: ids,
      p_actor_user_id: req.user.id
    });
    if (error) throw error;
    broadcastInstagramUpdate(req);
    res.json(data);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

router.patch('/orders/archive', requireRole('admin'), async (req, res) => {
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
    if (!validIdList(ids)) return res.status(400).json({ message: 'لم يتم تحديد طلبات صالحة' });
    const { data, error } = await supabase.rpc('archive_instagram_orders_atomic', {
      p_order_ids: ids,
      p_archived: Boolean(req.body.archived),
      p_actor_user_id: req.user.id
    });
    if (error) throw error;
    broadcastInstagramUpdate(req);
    res.json(data);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

router.patch('/orders/:id/status', requireRole('admin', 'driver'), async (req, res) => {
  try {
    if (!isUuid(req.params.id)) return res.status(400).json({ message: 'معرف الطلب غير صالح' });
    const status = cleanText(req.body.status, 30);
    if (!INSTAGRAM_STATUSES.has(status)) {
      return res.status(400).json({ message: 'حالة الطلب غير صالحة' });
    }

    await assertInstagramDeliveryOrders([req.params.id], 'طلبات الشحن تستخدم حالة تم التسليم أو لم يتم التسليم فقط');
    if (req.user.role === 'driver') {
      const { data: assignedOrder, error: ownershipError } = await supabase
        .from('instagram_orders')
        .select('id, status')
        .eq('id', req.params.id)
        .eq('driver_id', req.user.id)
        .eq('order_type', 'توصيل')
        .eq('is_archived', false)
        .maybeSingle();

      if (ownershipError) throw ownershipError;
      if (!assignedOrder) {
        return res.status(403).json({ message: 'الطلب غير معيّن لهذا السائق' });
      }
      if (assignedOrder.status !== 'قيد المتابعة') {
        return res.status(400).json({ message: 'لا يمكن تعديل طلب تم الانتهاء منه أو إلغاؤه' });
      }
    }

    const { data, error } = await supabase.rpc('change_instagram_order_status_atomic', {
      p_order_id: req.params.id,
      p_new_status: status,
      p_actor_user_id: req.user.id,
      p_note: req.body.note === undefined ? null : cleanText(req.body.note, 1000)
    });
    if (error) throw error;
    broadcastInstagramUpdate(req);
    broadcastInstagramUpdate(req, 'INSTAGRAM_INVENTORY_UPDATED');
    res.json(data);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// تسجيل تسليم الشحن للمدير فقط. الدالة الذرية تتجاهل التوصيل والطلبات غير
// التي سُجل تسليمها مسبقاً، وتربط كل طلب باسم شركته الفعلي.
router.patch('/orders/shipping-delivered', requireRole('admin'), async (req, res) => {
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
    if (!validIdList(ids)) return res.status(400).json({ message: 'لم يتم تحديد طلبات صالحة' });

    const { data, error } = await supabase.rpc('mark_instagram_shipping_delivered_atomic', {
      p_order_ids: ids,
      p_actor_user_id: req.user.id
    });
    if (error) throw error;
    if (!data || Number(data.delivered_count || 0) < 1) {
      return res.status(409).json({ message: 'لا توجد طلبات شحن غير مسلّمة ضمن التحديد' });
    }
    broadcastInstagramUpdate(req, 'INSTAGRAM_ORDER_UPDATED');
    broadcastInstagramUpdate(req, 'INSTAGRAM_INVENTORY_UPDATED');
    res.json(data);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

router.patch('/orders/:id/shipping-deliver', requireRole('admin'), async (req, res) => {
  try {
    if (!isUuid(req.params.id)) return res.status(400).json({ message: 'معرف الطلب غير صالح' });
    const { data, error } = await supabase.rpc('mark_instagram_shipping_delivered_atomic', {
      p_order_ids: [req.params.id],
      p_actor_user_id: req.user.id
    });
    if (error) throw error;
    if (!data || Number(data.delivered_count || 0) < 1) {
      return res.status(409).json({ message: 'الطلب ليس طلب شحن أو تم تسليمه مسبقاً' });
    }
    broadcastInstagramUpdate(req, 'INSTAGRAM_ORDER_UPDATED');
    broadcastInstagramUpdate(req, 'INSTAGRAM_INVENTORY_UPDATED');
    res.json(data);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

router.patch('/orders/:id/shipping-status', requireRole('admin'), async (req, res) => {
  try {
    if (!isUuid(req.params.id) || !['pending', 'delivered'].includes(req.body.shipping_delivery_status)) {
      return res.status(400).json({ message: 'الطلب أو حالة تسليم الشحن غير صالحة' });
    }
    const { data, error } = await supabase.rpc('set_instagram_shipping_delivery_status_atomic', {
      p_order_ids: [req.params.id],
      p_delivery_status: req.body.shipping_delivery_status,
      p_actor_user_id: req.user.id
    });
    if (error) throw error;
    if (!data || (!Number(data.changed_count) && !Number(data.duplicate_count))) {
      return res.status(404).json({ message: 'طلب الشحن غير موجود' });
    }
    broadcastInstagramUpdate(req);
    broadcastInstagramUpdate(req, 'INSTAGRAM_INVENTORY_UPDATED');
    res.json(data);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

router.patch('/orders/shipping-status', requireRole('admin'), async (req, res) => {
  try {
    if (!validIdList(req.body.ids) || !['pending', 'delivered'].includes(req.body.shipping_delivery_status)) {
      return res.status(400).json({ message: 'الطلبات أو حالة تسليم الشحن غير صالحة' });
    }
    const { data, error } = await supabase.rpc('set_instagram_shipping_delivery_status_atomic', {
      p_order_ids: req.body.ids,
      p_delivery_status: req.body.shipping_delivery_status,
      p_actor_user_id: req.user.id
    });
    if (error) throw error;
    broadcastInstagramUpdate(req);
    broadcastInstagramUpdate(req, 'INSTAGRAM_INVENTORY_UPDATED');
    res.json(data);
  } catch (error) { res.status(400).json({ message: error.message }); }
});

// حساب المشاهدة يرسل مقترحاً فقط؛ تطبيق التعديل محصور بقرار الأدمن الذري.
router.get('/edit-options', requireRole('instagram_viewer'), async (req, res) => {
  try {
    const companyId = await getViewerCompanyId(req.user.id);
    if (!companyId) return res.status(403).json({ message: 'حساب المشاهدة غير مربوط بشركة' });
    const { data, error } = await supabase.from('instagram_products')
      .select('id, name, currency, unit_price, status, variants:instagram_variants(id, color, size, stock_available, is_active)')
      .eq('company_id', companyId).order('name');
    if (error) throw error;
    res.set('Cache-Control', 'no-store');
    res.json(data || []);
  } catch (error) { res.status(500).json({ message: error.message }); }
});

router.get('/edit-requests', requireRole('admin', 'instagram_viewer'), async (req, res) => {
  try {
    let query = supabase.from('instagram_order_edit_requests')
      .select('*, order:instagram_orders(order_number, order_type, customer_name, company_name), requester:users!requested_by_user_id(name)')
      .order('created_at', { ascending: false });
    if (req.user.role === 'instagram_viewer') {
      const companyId = await getViewerCompanyId(req.user.id);
      if (!companyId) return res.status(403).json({ message: 'حساب المشاهدة غير مربوط بشركة' });
      query = query.eq('company_id', companyId);
    }
    if (req.query.status) {
      if (!['معلق', 'مقبول', 'مرفوض'].includes(req.query.status)) return res.status(400).json({ message: 'حالة طلب التعديل غير صالحة' });
      query = query.eq('status', req.query.status);
    }
    const { data, error } = await query.limit(1000);
    if (error) throw error;
    res.set('Cache-Control', 'no-store');
    res.json(data || []);
  } catch (error) { res.status(500).json({ message: error.message }); }
});

router.post('/orders/:id/edit-requests', requireRole('instagram_viewer'), async (req, res) => {
  try {
    if (!isUuid(req.params.id)) return res.status(400).json({ message: 'معرف الطلب غير صالح' });
    const companyId = await getViewerCompanyId(req.user.id);
    if (!companyId) return res.status(403).json({ message: 'حساب المشاهدة غير مربوط بشركة' });
    const { data: order, error: orderError } = await supabase.from('instagram_orders')
      .select('*').eq('id', req.params.id).eq('company_id', companyId).eq('is_archived', false).maybeSingle();
    if (orderError) throw orderError;
    if (!order) return res.status(404).json({ message: 'الطلب غير موجود أو غير مصرح' });
    const changes = validateInstagramEditChanges(req.body.changes, order);
    const { data, error } = await supabase.rpc('create_instagram_order_edit_request_atomic', {
      p_order_id: order.id,
      p_actor_user_id: req.user.id,
      p_changes: changes,
      p_reason: cleanText(req.body.reason, 1000)
    });
    if (error) throw error;
    broadcastInstagramUpdate(req, 'INSTAGRAM_EDIT_REQUEST_UPDATED');
    res.status(201).json(data);
  } catch (error) {
    res.status(error.code === '23505' || /طلب تعديل معلق/.test(error.message || '') ? 409 : error.status || 400)
      .json({ message: error.message });
  }
});

router.patch('/edit-requests/:id/:decision', requireRole('admin'), async (req, res) => {
  try {
    if (!isUuid(req.params.id) || !['accept', 'reject'].includes(req.params.decision)) {
      return res.status(400).json({ message: 'طلب التعديل أو القرار غير صالح' });
    }
    const { data, error } = await supabase.rpc('decide_instagram_order_edit_request_atomic', {
      p_request_id: req.params.id,
      p_actor_user_id: req.user.id,
      p_approve: req.params.decision === 'accept',
      p_admin_note: cleanText(req.body.note, 1000)
    });
    if (error) throw error;
    broadcastInstagramUpdate(req, 'INSTAGRAM_EDIT_REQUEST_UPDATED');
    if (req.params.decision === 'accept') {
      broadcastInstagramUpdate(req);
      broadcastInstagramUpdate(req, 'INSTAGRAM_INVENTORY_UPDATED');
    }
    res.json(data);
  } catch (error) { res.status(400).json({ message: error.message }); }
});

// تعديل تفاصيل الطلب والأصناف في معاملة واحدة (للمدير فقط).
router.patch('/orders/:id', requireRole('admin'), async (req, res) => {
  try {
    const orderId = req.params.id;
    if (!isUuid(orderId)) {
      return res.status(400).json({ message: 'معرف الطلب غير صالح' });
    }

    const hasOwn = (field) => Object.prototype.hasOwnProperty.call(req.body, field);
    const hasItems = hasOwn('items');
    const editableFields = [
      'order_number', 'customer_name', 'customer_number', 'address',
      'driver_id', 'company_id', 'total_price', 'ratio', 'note', 'status', 'order_type', 'shipping_delivery_status'
    ];
    if (!hasItems && !editableFields.some(hasOwn)) {
      return res.status(400).json({ message: 'لم يتم إرسال أي تعديل' });
    }

    const { data: currentOrder, error: currentOrderError } = await supabase
      .from('instagram_orders')
      .select('*')
      .eq('id', orderId)
      .eq('is_archived', false)
      .maybeSingle();
    if (currentOrderError) throw currentOrderError;
    if (!currentOrder) return res.status(404).json({ message: 'طلب Instagram غير موجود' });

    if (hasOwn('order_type') && !['شحن', 'توصيل'].includes(req.body.order_type)) {
      return res.status(400).json({ message: 'نوع الطلب غير صالح' });
    }
    const orderType = req.body.order_type || instagramOrderType(currentOrder);
    if ((hasOwn('status') && orderType === 'شحن') || (hasOwn('shipping_delivery_status')
      && (orderType !== 'شحن' || !['pending', 'delivered'].includes(req.body.shipping_delivery_status)))) {
      return res.status(400).json({ message: 'حالة الطلب غير صالحة لنوعه' });
    }

    const companyId = hasOwn('company_id') && isUuid(req.body.company_id)
      ? req.body.company_id
      : currentOrder.company_id;
    const driverId = hasOwn('driver_id')
      ? (req.body.driver_id && isUuid(req.body.driver_id) ? req.body.driver_id : null)
      : (currentOrder.driver_id || null);

    if (!isUuid(companyId) || (driverId && !isUuid(driverId))) {
      return res.status(400).json({ message: 'الشركة أو السائق المحدد غير صالح' });
    }

    let orderNumber = null;
    if (hasOwn('order_number') && String(req.body.order_number ?? '').trim() !== '') {
      const rawOrderNumber = String(req.body.order_number).trim();
      if (!/^\d+$/.test(rawOrderNumber)) {
        return res.status(400).json({ message: 'رقم الطلب غير صالح' });
      }
      orderNumber = Number(rawOrderNumber);
      if (!Number.isSafeInteger(orderNumber) || orderNumber < 1) {
        return res.status(400).json({ message: 'رقم الطلب غير صالح' });
      }
    }

    const totalPrice = hasOwn('total_price') && req.body.total_price !== '' && req.body.total_price !== null
      ? parseNumber(req.body.total_price, -1)
      : null;
    const ratio = hasOwn('ratio') && req.body.ratio !== '' && req.body.ratio !== null
      ? parseNumber(req.body.ratio, -1)
      : (hasOwn('ratio') ? 0 : null);
    if ((totalPrice !== null && totalPrice < 0) || (ratio !== null && ratio < 0)) {
      return res.status(400).json({ message: 'السعر أو النسبة غير صالح' });
    }

    let items = null;
    if (hasItems) {
      if (!Array.isArray(req.body.items) || req.body.items.length < 1 || req.body.items.length > 50) {
        return res.status(400).json({ message: 'يجب أن يحتوي الطلب على صنف واحد على الأقل' });
      }

      const quantityByVariant = new Map();
      for (const item of req.body.items) {
        const variantId = cleanText(item?.variant_id ?? item?.variantId, 50);
        const quantity = Number(item?.quantity);
        if (!isUuid(variantId) || !Number.isInteger(quantity) || quantity < 1 || quantity > 1000) {
          return res.status(400).json({ message: 'الصنف أو الكمية غير صالحة' });
        }
        const mergedQuantity = (quantityByVariant.get(variantId) || 0) + quantity;
        if (mergedQuantity > 1000) {
          return res.status(400).json({ message: 'إجمالي كمية الصنف الواحد يتجاوز الحد المسموح' });
        }
        quantityByVariant.set(variantId, mergedQuantity);
      }
      items = [...quantityByVariant].map(([variant_id, quantity]) => ({ variant_id, quantity }));
    }

    const changes = {};
    if (orderNumber !== null) changes.order_number = orderNumber;
    for (const [field, length] of [['customer_name', 100], ['customer_number', 50], ['address', 300], ['note', 1000], ['status', 30]]) {
      if (hasOwn(field)) changes[field] = cleanText(req.body[field], length);
    }
    if (hasOwn('customer_number')) changes.customer_number = normalizePhone(req.body.customer_number);
    if (totalPrice !== null) changes.total_price = totalPrice;
    if (ratio !== null) changes.ratio = ratio;
    if (hasOwn('driver_id')) changes.driver_id = driverId;
    if (hasOwn('company_id')) changes.company_id = companyId;
    if (hasOwn('order_type')) changes.order_type = orderType;
    if (hasOwn('shipping_delivery_status')) changes.shipping_delivery_status = req.body.shipping_delivery_status;
    if (hasItems) {
      changes.items = items;
      if (hasOwn('recalculate_total_price') && typeof req.body.recalculate_total_price !== 'boolean') {
        return res.status(400).json({ message: 'خيار إعادة حساب السعر غير صالح' });
      }
      changes.recalculate_total_price = Boolean(req.body.recalculate_total_price);
    }
    const { data, error } = await supabase.rpc('edit_instagram_order_atomic', {
      p_order_id: orderId, p_actor_user_id: req.user.id, p_changes: changes
    });

    if (error) throw error;

    broadcastInstagramUpdate(req);
    if (hasItems || hasOwn('status') || hasOwn('order_type') || hasOwn('shipping_delivery_status')) broadcastInstagramUpdate(req, 'INSTAGRAM_INVENTORY_UPDATED');
    res.json(data);
  } catch (error) {
    console.error('Update Instagram order details error:', error);
    res.status(400).json({ message: error.message });
  }
});

router.post('/orders/:id/restock', requireRole('admin'), async (req, res) => {
  try {
    const { data, error } = await supabase.rpc('restock_instagram_return_atomic', {
      p_order_id: req.params.id,
      p_actor_user_id: req.user.id,
      p_note: cleanText(req.body.note, 1000) || null
    });
    if (error) throw error;
    broadcastInstagramUpdate(req, 'INSTAGRAM_INVENTORY_UPDATED');
    res.json(data);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// =========================================================
// Products and variants
// =========================================================

router.get('/products', requireRole('admin'), async (req, res) => {
  try {
    let query = supabase
      .from('instagram_products')
      .select('*, variants:instagram_variants(*)')
      .order('created_at', { ascending: false });
    if (req.query.companyId) query = query.eq('company_id', req.query.companyId);
    const { data, error } = await query;
    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/products', requireRole('admin'), async (req, res) => {
  try {
    const companyId = cleanText(req.body.companyId, 50);
    const name = cleanText(req.body.name, 200);
    const unitPrice = Number(req.body.unitPrice);
    const variants = Array.isArray(req.body.variants)
      ? req.body.variants.map((variant) => ({
          color: cleanText(variant.color, 100),
          size: cleanText(variant.size, 100),
          stock_total: Number(variant.stockTotal)
        }))
      : [];

    const invalidVariant = variants.some((variant) => !variant.color
      || !variant.size
      || !Number.isInteger(variant.stock_total)
      || variant.stock_total < 0);
    if (!isUuid(companyId) || !name || !Number.isFinite(unitPrice) || unitPrice < 0
      || variants.length === 0 || variants.length > 500 || invalidVariant) {
      return res.status(400).json({ message: 'بيانات الصنف أو الألوان والمقاسات غير صالحة' });
    }

    const { data, error } = await supabase.rpc('create_instagram_product_atomic', {
      p_product_id: randomUUID(),
      p_company_id: companyId,
      p_name: name,
      p_unit_price: unitPrice,
      p_variants: variants,
      p_actor_user_id: req.user.id,
      p_currency: cleanText(req.body.currency, 20) || 'ل.س'
    });
    if (error) throw error;
    broadcastInstagramUpdate(req, 'INSTAGRAM_INVENTORY_UPDATED');
    res.status(201).json(data);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

router.patch('/products/:id', requireRole('admin'), async (req, res) => {
  try {
    const { data, error } = await supabase.rpc('update_instagram_product_atomic', {
      p_product_id: req.params.id,
      p_actor_user_id: req.user.id,
      p_name: req.body.name === undefined ? null : cleanText(req.body.name, 200),
      p_unit_price: req.body.unitPrice === undefined ? null : parseNumber(req.body.unitPrice, -1),
      p_currency: req.body.currency === undefined ? null : cleanText(req.body.currency, 20),
      p_status: req.body.status === undefined ? null : cleanText(req.body.status, 20)
    });
    if (error) throw error;
    broadcastInstagramUpdate(req, 'INSTAGRAM_INVENTORY_UPDATED');
    res.json(data);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

router.delete('/products/:id', requireRole('admin'), async (req, res) => {
  try {
    const { data, error } = await supabase.rpc('delete_instagram_product_safe', {
      p_product_id: req.params.id,
      p_actor_user_id: req.user.id
    });
    if (error) throw error;
    broadcastInstagramUpdate(req, 'INSTAGRAM_INVENTORY_UPDATED');
    res.json(data);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

router.post('/products/:id/variants', requireRole('admin'), async (req, res) => {
  try {
    const color = cleanText(req.body.color, 100);
    const size = cleanText(req.body.size, 100);
    const stockTotal = Number(req.body.stockTotal);
    if (!isUuid(req.params.id) || !color || !size || !Number.isInteger(stockTotal) || stockTotal < 0) {
      return res.status(400).json({ message: 'بيانات اللون أو المقاس أو المخزون غير صالحة' });
    }
    const { data, error } = await supabase.rpc('add_instagram_variant_atomic', {
      p_variant_id: randomUUID(),
      p_product_id: req.params.id,
      p_color: color,
      p_size: size,
      p_stock_total: stockTotal,
      p_actor_user_id: req.user.id
    });
    if (error) throw error;
    broadcastInstagramUpdate(req, 'INSTAGRAM_INVENTORY_UPDATED');
    res.status(201).json(data);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

router.patch('/variants/:id', requireRole('admin'), async (req, res) => {
  try {
    if (!isUuid(req.params.id)) return res.status(400).json({ message: 'معرف التركيبة غير صالح' });
    let metadataResult = null;
    let stockResult = null;
    const hasMetadata = req.body.color !== undefined
      || req.body.size !== undefined
      || req.body.isActive !== undefined;

    if ((req.body.color !== undefined && !cleanText(req.body.color, 100))
      || (req.body.size !== undefined && !cleanText(req.body.size, 100))) {
      return res.status(400).json({ message: 'اللون والمقاس مطلوبان' });
    }
    if (req.body.stockTotal !== undefined) {
      const stockTotal = Number(req.body.stockTotal);
      if (!Number.isInteger(stockTotal) || stockTotal < 0) {
        return res.status(400).json({ message: 'المخزون يجب أن يكون رقماً صحيحاً غير سالب' });
      }
    }

    if (hasMetadata) {
      const metadataResponse = await supabase.rpc('update_instagram_variant_atomic', {
        p_variant_id: req.params.id,
        p_actor_user_id: req.user.id,
        p_color: req.body.color === undefined ? null : cleanText(req.body.color, 100),
        p_size: req.body.size === undefined ? null : cleanText(req.body.size, 100),
        p_is_active: req.body.isActive === undefined ? null : Boolean(req.body.isActive)
      });
      if (metadataResponse.error) throw metadataResponse.error;
      metadataResult = metadataResponse.data;
    }

    if (req.body.stockTotal !== undefined) {
      const stockResponse = await supabase.rpc('adjust_instagram_variant_stock_atomic', {
        p_variant_id: req.params.id,
        p_new_stock_total: Number(req.body.stockTotal),
        p_actor_user_id: req.user.id,
        p_idempotency_key: randomUUID(),
        p_note: cleanText(req.body.note, 500) || null
      });
      if (stockResponse.error) throw stockResponse.error;
      stockResult = stockResponse.data;
    }

    if (!hasMetadata && req.body.stockTotal === undefined) {
      return res.status(400).json({ message: 'لم يتم إرسال أي تعديل' });
    }

    broadcastInstagramUpdate(req, 'INSTAGRAM_INVENTORY_UPDATED');
    res.json({ success: true, metadata: metadataResult, stock: stockResult });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

router.delete('/variants/:id', requireRole('admin'), async (req, res) => {
  try {
    const { data, error } = await supabase.rpc('delete_instagram_variant_safe', {
      p_variant_id: req.params.id,
      p_actor_user_id: req.user.id
    });
    if (error) throw error;
    broadcastInstagramUpdate(req, 'INSTAGRAM_INVENTORY_UPDATED');
    res.json(data);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// =========================================================
// Inventory and Excel
// =========================================================

router.get('/inventory/export', requireRole('admin', 'instagram_viewer'), async (req, res) => {
  try {
    const rows = await loadInventoryForUser(req.user, {
      companyId: req.query.companyId,
      productId: req.query.productId
    });
    const xml = inventoryToExcelXml(rows);
    res.set('Content-Type', 'application/vnd.ms-excel; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="instagram-inventory.xls"');
    res.send(xml);
  } catch (error) {
    res.status(error.status || 500).json({ message: error.message });
  }
});

router.get('/inventory', requireRole('admin', 'instagram_viewer'), async (req, res) => {
  try {
    const rows = await loadInventoryForUser(req.user, {
      companyId: req.query.companyId,
      productId: req.query.productId
    });
    res.set('Cache-Control', 'no-store');
    res.json(rows);
  } catch (error) {
    res.status(error.status || 500).json({ message: error.message });
  }
});

router.get('/inventory/shipping-delivered', requireRole('admin', 'instagram_viewer'), async (req, res) => {
  try {
    let companyId = req.query.companyId;
    if (req.user.role === 'instagram_viewer') {
      companyId = await getViewerCompanyId(req.user.id);
      if (!companyId) return res.status(403).json({ message: 'حساب المشاهدة غير مربوط بشركة' });
    }
    let query = supabase.from('instagram_orders').select('*, items:instagram_order_items(*)')
      .eq('order_type', 'شحن').eq('shipping_delivery_status', 'delivered').eq('is_archived', false)
      .order('shipping_delivered_at', { ascending: false }).order('id');
    if (companyId) query = query.eq('company_id', companyId);
    const page = Math.max(0, Math.floor(Number(req.query.page) || 0));
    const { data, error } = await query.range(page * 1000, page * 1000 + 999);
    if (error) throw error;
    const rows = (data || []).filter((order) => !req.query.productId || (order.items || []).some((item) => item.product_id === req.query.productId));
    res.set('Cache-Control', 'no-store');
    res.json({ orders: rows.map(normalizeInstagramOrder), has_more: (data || []).length === 1000 });
  } catch (error) { res.status(500).json({ message: error.message }); }
});

// =========================================================
// Links and viewer accounts
// =========================================================

router.post('/links', requireRole('admin'), async (req, res) => {
  try {
    const { data, error } = await supabase.rpc('upsert_instagram_company_link_atomic', {
      p_company_id: req.body.companyId,
      p_slug: cleanText(req.body.slug, 100),
      p_actor_user_id: req.user.id,
      p_is_active: req.body.isActive === undefined ? true : Boolean(req.body.isActive)
    });
    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});


router.post('/links/order-start', requireRole('admin'), async (req, res) => {
  try {
    const { companyId, nextOrderNumber } = req.body;
    if (!isUuid(companyId) || !Number.isInteger(nextOrderNumber) || nextOrderNumber < 1) {
      return res.status(400).json({ message: 'بيانات غير صالحة' });
    }
    const { error } = await supabase
      .from('instagram_company_links')
      .update({ next_order_number: nextOrderNumber })
      .eq('company_id', companyId);
    if (error) throw error;
    broadcastInstagramUpdate(req);
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

router.post('/viewers', requireRole('admin'), async (req, res) => {
  let createdUserId = null;
  try {
    const username = cleanText(req.body.username, 100);
    const password = String(req.body.password || '');
    const name = cleanText(req.body.name, 200);
    const companyId = cleanText(req.body.companyId, 50);

    if (!username || !name || password.length < 6 || !isUuid(companyId)) {
      return res.status(400).json({ message: 'يرجى إدخال الاسم واسم المستخدم وكلمة مرور من 6 محارف والشركة' });
    }

    const { data: existing } = await supabase
      .from('users')
      .select('id')
      .eq('username', username)
      .maybeSingle();
    if (existing) return res.status(409).json({ message: 'اسم المستخدم موجود مسبقاً' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const { data: newUser, error: userError } = await supabase
      .from('users')
      .insert([{ username, password: hashedPassword, role: 'instagram_viewer', name }])
      .select('id, username, name, role')
      .single();
    if (userError) throw userError;
    createdUserId = newUser.id;

    const { error: mappingError } = await supabase.rpc('upsert_instagram_viewer_company_atomic', {
      p_viewer_user_id: newUser.id,
      p_company_id: companyId,
      p_actor_user_id: req.user.id
    });
    if (mappingError) throw mappingError;

    res.status(201).json(newUser);
  } catch (error) {
    if (createdUserId) await supabase.from('users').delete().eq('id', createdUserId);
    res.status(400).json({ message: error.message });
  }
});

router.patch('/viewers/:id/company', requireRole('admin'), async (req, res) => {
  try {
    const { data, error } = await supabase.rpc('upsert_instagram_viewer_company_atomic', {
      p_viewer_user_id: req.params.id,
      p_company_id: req.body.companyId,
      p_actor_user_id: req.user.id
    });
    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

router.delete('/viewers/:id', requireRole('admin'), async (req, res) => {
  try {
    const { data: viewer, error: viewerError } = await supabase
      .from('users')
      .select('id, role')
      .eq('id', req.params.id)
      .maybeSingle();
    if (viewerError) throw viewerError;
    if (!viewer || viewer.role !== 'instagram_viewer') {
      return res.status(404).json({ message: 'حساب المشاهدة غير موجود' });
    }

    const { error } = await supabase.from('users').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

module.exports = router;
