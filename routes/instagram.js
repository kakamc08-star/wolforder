const express = require('express');
const bcrypt = require('bcryptjs');
const { randomUUID } = require('crypto');
const supabase = require('../config/db');
const authenticateToken = require('../middleware/auth');

const router = express.Router();
const INSTAGRAM_ORDER_TYPES = new Set(['توصيل', 'شحن']);
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
    order.status,
    ...itemValues
  ];
}

function parseNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
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
  return {
    ...order,
    items,
    order_source: 'instagram',
    price: order.total_price,
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
  return data || [];
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
    const customerName = cleanText(req.body.customerName, 200);
    const customerNumber = cleanText(req.body.customerNumber, 50);
    const address = cleanText(req.body.address, 500);
    const note = cleanText(req.body.note, 1000);
    const orderType = cleanText(req.body.orderType, 20);
    const idempotencyKey = cleanText(req.body.idempotencyKey, 50);
    const items = Array.isArray(req.body.items) ? req.body.items : [];

    if (!customerName || !customerNumber || !address || !INSTAGRAM_ORDER_TYPES.has(orderType)) {
      return res.status(400).json({
        message: 'يرجى التأكد من تعبئة جميع البيانات المطلوبة قبل تأكيد الطلب.'
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
      const stockError = /المخزون|غير متوفر|الكمية/i.test(error.message || '');
      return res.status(stockError ? 409 : 400).json({
        message: stockError
          ? 'عذراً، الكمية المطلوبة غير متوفرة حالياً. يرجى تقليل الكمية والمحاولة مرة أخرى.'
          : 'تعذر إرسال الطلب حالياً. يرجى المحاولة مرة أخرى.'
      });
    }

    broadcastInstagramUpdate(req, 'INSTAGRAM_ORDER_CREATED');
    res.status(201).json(data);
  } catch (error) {
    console.error('Create Instagram order exception:', error);
    res.status(500).json({
      message: 'تعذر إرسال الطلب حالياً. يرجى المحاولة مرة أخرى.'
    });
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
    const { status, orderType, companyId, driverId, startDate, endDate, search } = req.query;
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
      if (driverId) query = query.eq('driver_id', driverId);
    }

    if (status) {
      if (!INSTAGRAM_STATUSES.has(status)) return res.status(400).json({ message: 'حالة الطلب غير صالحة' });
      query = query.eq('status', status);
    }
    if (orderType) {
      if (!INSTAGRAM_ORDER_TYPES.has(orderType)) return res.status(400).json({ message: 'نوع الطلب غير صالح' });
      query = query.eq('order_type', orderType);
    }
    if (startDate) query = query.gte('created_at', startDate);
    if (endDate) query = query.lte('created_at', `${endDate}T23:59:59.999Z`);

    const { data, error } = await query.limit(2000);
    if (error) throw error;

    const term = normalizeInstagramSearch(search);
    const filtered = term
      ? (data || []).filter((order) => [
          ...instagramOrderSearchValues(order)
        ].some((value) => normalizeInstagramSearch(value).includes(term)))
      : (data || []);

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
    const { companyId, productId, startDate, endDate } = req.query;

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
    if (startDate) query = query.gte('created_at', startDate);
    if (endDate) query = query.lte('created_at', `${endDate}T23:59:59.999Z`);

    let { data: orders, error } = await query;
    if (error) throw error;

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
        order_type: order.order_type,
        customer_name: order.customer_name,
        customer_number: order.customer_number,
        address: order.address,
        items_summary: itemsSummary,
        total_price: price,
        currency: order.currency || 'ل.س',
        ratio: order.ratio || 0,
        status: order.status,
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
    const { companyId, productId, startDate, endDate } = req.query;

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
    if (startDate) query = query.gte('created_at', startDate);
    if (endDate) query = query.lte('created_at', `${endDate}T23:59:59.999Z`);

    let { data: orders, error } = await query;
    if (error) throw error;

    if (productId) {
      orders = orders.filter(order =>
        order.items.some(item => item.variant?.product?.id === productId)
      );
    }

    const headers = ['رقم الطلب', 'التاريخ', 'الشركة', 'النوع', 'الزبون', 'الأصناف', 'الإجمالي', 'العملة', 'النسبة', 'الحالة', 'ملاحظة'];
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
        order.order_type || '',
        order.customer_name || '',
        itemsSummary,
        order.total_price || 0,
        order.currency || 'ل.س',
        order.ratio || 0,
        order.status || '',
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
    if (!data) return res.status(404).json({ message: 'الطلب غير موجود أو غير مصرح' });
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

    const { data, error } = await supabase.rpc('change_instagram_orders_status_atomic', {
      p_order_ids: ids,
      p_new_status: status,
      p_actor_user_id: req.user.id,
      p_note: cleanText(req.body.note, 1000) || null
    });
    if (error) throw error;
    broadcastInstagramUpdate(req);
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
    let successCount = 0;
    for (const id of ids) {
      const { error } = await supabase.rpc('delete_instagram_order_atomic', {
        p_order_id: id,
        p_actor_user_id: req.user.id
      });
      if (!error) successCount++;
    }
    broadcastInstagramUpdate(req, 'INSTAGRAM_ORDER_DELETED');
    res.json({ success: true, deleted_count: successCount });
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

router.patch('/orders/shipping-delivered', requireRole('admin'), async (req, res) => {
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
    if (!validIdList(ids)) return res.status(400).json({ message: 'لم يتم تحديد طلبات شحن صالحة' });
    const { data, error } = await supabase.rpc('mark_instagram_shipping_delivered_atomic', {
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
    res.json(data);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// ✅ المسار الجديد: تعديل تفاصيل الطلب (للمدير فقط)
router.patch('/orders/:id', requireRole('admin'), async (req, res) => {
  try {
    const orderId = req.params.id;
    if (!isUuid(orderId)) {
      return res.status(400).json({ message: 'معرف الطلب غير صالح' });
    }

    // الحقول المسموح بتعديلها مباشرة
    const allowedFields = [
      'order_number', 'customer_name', 'customer_number', 'address',
      'driver_id', 'company_id', 'total_price', 'ratio', 'note'
    ];
    const updates = {};
    allowedFields.forEach(field => {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    });

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ message: 'لم يتم إرسال أي تعديل' });
    }

    // إذا تم تغيير السائق، اجلب اسمه
    if (updates.driver_id) {
      const { data: driver } = await supabase
        .from('users')
        .select('name')
        .eq('id', updates.driver_id)
        .eq('role', 'driver')
        .single();
      if (!driver) return res.status(400).json({ message: 'السائق المحدد غير موجود' });
      updates.driver_name = driver.name;
    } else if (updates.driver_id === null) {
      updates.driver_name = null;
    }

    // إذا تم تغيير الشركة، اجلب اسمها
    if (updates.company_id) {
      const { data: company } = await supabase
        .from('users')
        .select('name')
        .eq('id', updates.company_id)
        .eq('role', 'company')
        .single();
      if (!company) return res.status(400).json({ message: 'الشركة المحددة غير موجودة' });
      updates.company_name = company.name;
    } else if (updates.company_id === null) {
      updates.company_name = null;
    }

    const { data, error } = await supabase
      .from('instagram_orders')
      .update(updates)
      .eq('id', orderId)
      .select()
      .single();

    if (error) throw error;

    broadcastInstagramUpdate(req);
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
    res.json(rows);
  } catch (error) {
    res.status(error.status || 500).json({ message: error.message });
  }
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
