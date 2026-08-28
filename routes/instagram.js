'use strict';

const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const supabase = require('../config/db');
const authenticateToken = require('../middleware/auth');
const {
  ORDER_STATUSES,
  cleanText,
  normalizeDigits,
  parsePagination,
  sanitizeSearch,
  validateProduct,
  validatePublicOrder
} = require('../utils/instagram-validation');
const { buildInventoryWorkbook } = require('../utils/excel-xml');

const router = express.Router();
const publicRateBuckets = new Map();
const PUBLIC_WINDOW_MS = 10 * 60 * 1000;
const PUBLIC_MAX_REQUESTS = 20;

function publicIp(req) {
  return cleanText(req.ip || req.socket.remoteAddress || 'unknown', 200);
}

function hashValue(value) {
  return crypto
    .createHmac('sha256', process.env.IP_HASH_SECRET || process.env.JWT_SECRET)
    .update(String(value))
    .digest('hex');
}

function checkPublicRate(req, slug) {
  const now = Date.now();
  const key = hashValue(`${publicIp(req)}|${slug}`);
  const current = publicRateBuckets.get(key);
  if (!current || current.resetAt <= now) {
    publicRateBuckets.set(key, { count: 1, resetAt: now + PUBLIC_WINDOW_MS });
    return { allowed: true, bucket: key };
  }
  current.count += 1;
  if (publicRateBuckets.size > 5000) {
    for (const [bucket, value] of publicRateBuckets) {
      if (value.resetAt <= now) publicRateBuckets.delete(bucket);
    }
  }
  return { allowed: current.count <= PUBLIC_MAX_REQUESTS, bucket: key };
}

function verifyFormToken(token, slug) {
  try {
    const payload = jwt.verify(token, process.env.FORM_TOKEN_SECRET || process.env.JWT_SECRET);
    return payload && payload.type === 'instagram_form' && payload.slug === slug;
  } catch (error) {
    return false;
  }
}

function issueFormToken(slug) {
  return jwt.sign(
    { type: 'instagram_form', slug, nonce: crypto.randomUUID() },
    process.env.FORM_TOKEN_SECRET || process.env.JWT_SECRET,
    { expiresIn: '30m' }
  );
}

function mapDatabaseError(error) {
  const message = String(error && error.message || 'تعذر تنفيذ العملية');
  if (message.includes('OUT_OF_STOCK')) return { status: 409, message: 'الكمية المطلوبة لم تعد متوفرة. حدّث الصفحة واختر الكمية المتاحة.' };
  if (message.includes('RATE_LIMITED')) return { status: 429, message: 'تم إرسال عدة محاولات. انتظر قليلاً ثم حاول مجدداً.' };
  if (message.includes('INVALID_')) return { status: 400, message: 'بيانات الطلب غير صالحة أو تغيّر المخزون.' };
  return { status: 400, message: 'تعذر حفظ الطلب. تحقق من البيانات وحاول مجدداً.' };
}

async function getCompanyName(companyId) {
  const { data } = await supabase.from('users').select('name').eq('id', companyId).eq('role', 'company').single();
  return data && data.name ? data.name : 'المتجر';
}

async function getViewerCompany(userId) {
  const { data, error } = await supabase
    .from('users')
    .select('role, instagram_company_id')
    .eq('id', userId)
    .single();
  if (error || !data || data.role !== 'instagram_viewer' || !data.instagram_company_id) return null;
  return String(data.instagram_company_id);
}

async function resolveCompanyScope(req, requestedCompanyId) {
  if (req.user.role === 'admin') return cleanText(requestedCompanyId, 80) || null;
  if (req.user.role === 'instagram_viewer') return getViewerCompany(req.user.id);
  return null;
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ message: 'هذه العملية متاحة للمدير فقط' });
  next();
}

function applyOrderFilters(query, params, companyId) {
  if (companyId) query = query.eq('company_id', companyId);
  if (params.status) query = query.eq('status', params.status);
  if (params.orderType) query = query.eq('order_type', params.orderType);
  if (params.driverId) query = query.eq('driver_id', params.driverId);
  if (params.startDate) query = query.gte('created_at', params.startDate);
  if (params.endDate) query = query.lte('created_at', params.endDate);
  const search = sanitizeSearch(params.search);
  if (search) {
    const pattern = `*${search}*`;
    query = query.or([
      `order_number_text.ilike.${pattern}`,
      `customer_name.ilike.${pattern}`,
      `customer_phone.ilike.${pattern}`,
      `address.ilike.${pattern}`,
      `note.ilike.${pattern}`,
      `company_name.ilike.${pattern}`
    ].join(','));
  }
  return query;
}

async function fetchAllRows(table, select, applyFilters, pageSize = 1000) {
  const rows = [];
  for (let from = 0; from < 100000; from += pageSize) {
    let query = supabase.from(table).select(select).range(from, from + pageSize - 1);
    query = applyFilters(query);
    const { data, error } = await query;
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < pageSize) return rows;
  }
  throw new Error('EXPORT_LIMIT_EXCEEDED');
}

// ==================== الصفحة العامة ====================
router.get('/public/:slug/catalog', async (req, res) => {
  try {
    const slug = cleanText(req.params.slug, 100);
    const { data: link, error: linkError } = await supabase
      .from('instagram_company_links')
      .select('company_id')
      .eq('public_slug', slug)
      .eq('is_active', true)
      .single();
    if (linkError || !link) return res.status(404).json({ message: 'رابط الطلب غير موجود أو غير مفعّل' });

    const { data: products, error: productsError } = await supabase
      .from('instagram_products')
      .select('id, name')
      .eq('company_id', link.company_id)
      .eq('is_active', true)
      .order('name');
    if (productsError) throw productsError;

    const productIds = (products || []).map(product => product.id);
    let variants = [];
    if (productIds.length) {
      const { data, error } = await supabase
        .from('instagram_inventory')
        .select('id, product_id, color, size, available_quantity')
        .in('product_id', productIds)
        .eq('is_active', true)
        .gt('available_quantity', 0)
        .order('color');
      if (error) throw error;
      variants = data || [];
    }

    const catalog = (products || []).map(product => ({
      id: product.id,
      name: product.name,
      variants: variants.filter(variant => variant.product_id === product.id)
    })).filter(product => product.variants.length > 0);

    res.set('Cache-Control', 'no-store');
    res.json({ companyName: await getCompanyName(link.company_id), products: catalog, formToken: issueFormToken(slug) });
  } catch (error) {
    console.error('Instagram catalog error:', error.message);
    res.status(500).json({ message: 'تعذر تحميل الأصناف حالياً' });
  }
});

router.post('/public/:slug/orders', async (req, res) => {
  const slug = cleanText(req.params.slug, 100);
  const rate = checkPublicRate(req, slug);
  if (!rate.allowed) return res.status(429).json({ message: 'محاولات كثيرة، انتظر قليلاً ثم حاول مجدداً' });

  const formToken = req.headers['x-instagram-form-token'];
  if (!verifyFormToken(formToken, slug)) return res.status(403).json({ message: 'انتهت صلاحية النموذج. حدّث الصفحة وحاول مجدداً.' });

  const idempotencyKey = cleanText(req.headers['idempotency-key'], 80);
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27,72}$/i.test(idempotencyKey)) {
    return res.status(400).json({ message: 'معرّف الإرسال غير صالح' });
  }

  const validation = validatePublicOrder(req.body);
  if (!validation.valid) return res.status(400).json({ message: validation.errors[0], errors: validation.errors });

  const value = validation.value;
  const fingerprint = hashValue(JSON.stringify({
    slug,
    customerName: value.customerName,
    phone: value.customerPhone,
    address: value.address,
    orderType: value.orderType,
    note: value.note,
    items: value.items
  }));
  try {
    const { data, error } = await supabase.rpc('create_instagram_order', {
      p_public_slug: slug,
      p_customer_name: value.customerName,
      p_customer_phone: value.customerPhone,
      p_address: value.address,
      p_order_type: value.orderType,
      p_note: value.note,
      p_items: value.items.map(item => ({ inventory_id: item.inventoryId, quantity: item.quantity })),
      p_idempotency_key: idempotencyKey,
      p_request_fingerprint: fingerprint,
      p_rate_bucket: rate.bucket
    });
    if (error) throw error;

    const result = typeof data === 'string' ? JSON.parse(data) : data;
    const broadcast = req.app.get('broadcast');
    if (broadcast && !result.duplicate) broadcast({ type: 'INSTAGRAM_ORDER_CREATED' });
    res.status(result.duplicate ? 200 : 201).json({
      message: result.duplicate ? 'تم استلام هذا الطلب مسبقاً' : 'تم إرسال طلبك وهو الآن قيد المتابعة',
      orderNumber: result.order_number,
      duplicate: Boolean(result.duplicate)
    });
  } catch (error) {
    const mapped = mapDatabaseError(error);
    console.error('Instagram public order error:', error.message);
    res.status(mapped.status).json({ message: mapped.message });
  }
});

// ==================== المسارات المحمية ====================
router.use(authenticateToken);
router.use((req, res, next) => {
  if (!['admin', 'instagram_viewer', 'driver'].includes(req.user.role)) {
    return res.status(403).json({ message: 'غير مصرح لهذا الحساب بدخول طلبات إنستغرام' });
  }
  next();
});

router.get('/companies', requireAdmin, async (req, res) => {
  try {
    const [{ data: companies, error: companyError }, { data: links, error: linkError }] = await Promise.all([
      supabase.from('users').select('id, name, username').eq('role', 'company').order('name'),
      supabase.from('instagram_company_links').select('company_id, public_slug, is_active')
    ]);
    if (companyError) throw companyError;
    if (linkError) throw linkError;
    const linksByCompany = new Map((links || []).map(link => [String(link.company_id), link]));
    res.json((companies || []).map(company => ({ ...company, instagramLink: linksByCompany.get(String(company.id)) || null })));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/companies/:companyId/link', requireAdmin, async (req, res) => {
  try {
    const companyId = cleanText(req.params.companyId, 80);
    const { data: company, error: companyError } = await supabase
      .from('users').select('id').eq('id', companyId).eq('role', 'company').single();
    if (companyError || !company) return res.status(404).json({ message: 'الشركة غير موجودة' });

    let { data: link } = await supabase
      .from('instagram_company_links')
      .select('*').eq('company_id', companyId).maybeSingle();
    if (!link) {
      const { data, error } = await supabase
        .from('instagram_company_links')
        .insert({ company_id: companyId })
        .select('*').single();
      if (error) throw error;
      link = data;
    } else if (!link.is_active) {
      const { data, error } = await supabase
        .from('instagram_company_links')
        .update({ is_active: true }).eq('id', link.id).select('*').single();
      if (error) throw error;
      link = data;
    }
    res.json({ ...link, url: `${req.protocol}://${req.get('host')}/instagram/${link.public_slug}` });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.get('/drivers', requireAdmin, async (req, res) => {
  const { data, error } = await supabase.from('users').select('id, name, username').eq('role', 'driver').order('name');
  if (error) return res.status(500).json({ message: error.message });
  res.json(data || []);
});

router.get('/', async (req, res) => {
  try {
    const companyId = await resolveCompanyScope(req, req.query.companyId);
    if (req.user.role === 'instagram_viewer' && !companyId) return res.status(403).json({ message: 'الحساب غير مرتبط بشركة' });
    const { page, limit, from, to } = parsePagination(req.query, 50, 100);
    const select = req.query.productId
      ? '*, items:instagram_order_items!inner(*)'
      : '*, items:instagram_order_items(*)';
    let query = supabase
      .from('instagram_orders')
      .select(select, { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(from, to);
    if (req.user.role === 'driver') {
      query = query.eq('driver_id', String(req.user.id)).eq('order_type', 'توصيل');
    }
    query = applyOrderFilters(query, req.query, companyId);
    if (req.query.productId) query = query.eq('instagram_order_items.product_id', req.query.productId);
    const { data, error, count } = await query;
    if (error) throw error;
    const total = count || 0;
    res.json({ orders: data || [], pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } });
  } catch (error) {
    console.error('Instagram orders list error:', error.message);
    res.status(500).json({ message: 'تعذر تحميل الطلبات' });
  }
});

router.get('/inventory', async (req, res) => {
  try {
    if (!['admin', 'instagram_viewer'].includes(req.user.role)) return res.status(403).json({ message: 'غير مصرح' });
    const companyId = await resolveCompanyScope(req, req.query.companyId);
    if (req.user.role === 'instagram_viewer' && !companyId) return res.status(403).json({ message: 'الحساب غير مرتبط بشركة' });
    const { page, limit, from, to } = parsePagination(req.query, 100, 500);
    let query = supabase.from('instagram_inventory_stats').select('*', { count: 'exact' }).order('product_name').range(from, to);
    if (companyId) query = query.eq('company_id', companyId);
    if (req.query.productId) query = query.eq('product_id', req.query.productId);
    const search = sanitizeSearch(req.query.search);
    if (search) query = query.or(`product_name.ilike.*${search}*,color.ilike.*${search}*,size.ilike.*${search}*`);
    const { data, error, count } = await query;
    if (error) throw error;
    const total = count || 0;
    res.json({ inventory: data || [], pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } });
  } catch (error) {
    console.error('Instagram inventory error:', error.message);
    res.status(500).json({ message: 'تعذر تحميل الجرد' });
  }
});

router.get('/products', requireAdmin, async (req, res) => {
  try {
    let query = supabase
      .from('instagram_products')
      .select('*, variants:instagram_inventory(*)')
      .order('created_at', { ascending: false });
    if (req.query.companyId) query = query.eq('company_id', cleanText(req.query.companyId, 80));
    const { data, error } = await query;
    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

router.post('/products', requireAdmin, async (req, res) => {
  const validation = validateProduct(req.body);
  if (!validation.valid) return res.status(400).json({ message: validation.errors[0], errors: validation.errors });
  try {
    const value = validation.value;
    const { data, error } = await supabase.rpc('create_instagram_product', {
      p_company_id: value.companyId,
      p_name: value.name,
      p_is_active: value.active,
      p_variants: value.variants,
      p_actor_id: String(req.user.id)
    });
    if (error) throw error;
    res.status(201).json(data);
  } catch (error) {
    res.status(400).json({ message: error.message.includes('duplicate') ? 'الصنف أو إحدى التركيبات موجودة مسبقاً' : 'تعذر إنشاء الصنف' });
  }
});

router.patch('/products/:id', requireAdmin, async (req, res) => {
  try {
    const updates = { updated_at: new Date().toISOString() };
    if (req.body.name !== undefined) {
      const name = cleanText(req.body.name, 120);
      if (name.length < 2) return res.status(400).json({ message: 'اسم الصنف غير صالح' });
      updates.name = name;
    }
    if (req.body.active !== undefined) updates.is_active = Boolean(req.body.active);
    const { data, error } = await supabase.from('instagram_products').update(updates).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(400).json({ message: 'تعذر تحديث الصنف' });
  }
});

router.post('/products/:id/variants', requireAdmin, async (req, res) => {
  const color = cleanText(req.body && req.body.color, 60);
  const size = cleanText(req.body && req.body.size, 60);
  const quantity = Number(normalizeDigits(req.body && req.body.quantity));
  if (!color || !size || !Number.isInteger(quantity) || quantity < 0 || quantity > 1000000) {
    return res.status(400).json({ message: 'بيانات اللون أو المقاس أو الكمية غير صالحة' });
  }
  const { data, error } = await supabase.rpc('add_instagram_variant', {
    p_product_id: req.params.id,
    p_color: color,
    p_size: size,
    p_quantity: quantity,
    p_actor_id: String(req.user.id)
  });
  if (error) return res.status(400).json({ message: 'التركيبة موجودة أو بياناتها غير صالحة' });
  res.status(201).json(data);
});

router.post('/inventory/:id/adjust', requireAdmin, async (req, res) => {
  const delta = Number(normalizeDigits(req.body && req.body.delta));
  const reason = cleanText(req.body && req.body.reason, 300);
  if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 1000000 || reason.length < 3) {
    return res.status(400).json({ message: 'أدخل كمية تغيير صحيحة وسبباً واضحاً' });
  }
  const { data, error } = await supabase.rpc('adjust_instagram_inventory', {
    p_inventory_id: req.params.id,
    p_delta: delta,
    p_reason: reason,
    p_actor_id: String(req.user.id)
  });
  if (error) return res.status(409).json({ message: error.message.includes('INSUFFICIENT') ? 'لا يمكن إنقاص كمية محجوزة أو مباعة' : 'تعذر تعديل المخزون' });
  res.json(data);
});

router.patch('/orders/:id/status', requireAdmin, async (req, res) => {
  const status = cleanText(req.body && req.body.status, 30);
  if (!ORDER_STATUSES.has(status)) return res.status(400).json({ message: 'الحالة غير صالحة' });
  const { data, error } = await supabase.rpc('update_instagram_order_state', {
    p_order_id: req.params.id,
    p_new_status: status,
    p_actor_id: String(req.user.id)
  });
  if (error) {
    const mapped = mapDatabaseError(error);
    return res.status(mapped.status).json({ message: mapped.message });
  }
  const broadcast = req.app.get('broadcast');
  if (broadcast) broadcast({ type: 'INSTAGRAM_ORDER_UPDATED' });
  res.json(data);
});

router.patch('/driver-orders/:id/status', async (req, res) => {
  if (req.user.role !== 'driver') return res.status(403).json({ message: 'غير مصرح' });
  const status = cleanText(req.body && req.body.status, 30);
  if (!ORDER_STATUSES.has(status) || status === 'قيد المتابعة') return res.status(400).json({ message: 'الحالة غير صالحة' });
  const { data: order, error: orderError } = await supabase
    .from('instagram_orders')
    .select('id, driver_id, order_type, status')
    .eq('id', req.params.id)
    .eq('driver_id', String(req.user.id))
    .eq('order_type', 'توصيل')
    .single();
  if (orderError || !order) return res.status(404).json({ message: 'الطلب غير موجود أو غير معيّن لك' });
  if (!['قيد المتابعة', 'مؤجل'].includes(order.status)) {
    return res.status(400).json({ message: 'لا يمكن تعديل طلب تم البت بحالته' });
  }
  const { data, error } = await supabase.rpc('update_instagram_order_state', {
    p_order_id: req.params.id,
    p_new_status: status,
    p_actor_id: String(req.user.id)
  });
  if (error) {
    const mapped = mapDatabaseError(error);
    return res.status(mapped.status).json({ message: mapped.message });
  }
  const broadcast = req.app.get('broadcast');
  if (broadcast) broadcast({ type: 'INSTAGRAM_ORDER_UPDATED' });
  res.json(data);
});

router.patch('/orders/:id/assign-driver', requireAdmin, async (req, res) => {
  const driverId = cleanText(req.body && req.body.driverId, 80);
  if (!driverId) return res.status(400).json({ message: 'اختر السائق' });
  const [{ data: driver }, { data: order }] = await Promise.all([
    supabase.from('users').select('id, name').eq('id', driverId).eq('role', 'driver').single(),
    supabase.from('instagram_orders').select('id, order_type').eq('id', req.params.id).single()
  ]);
  if (!driver) return res.status(404).json({ message: 'السائق غير موجود' });
  if (!order) return res.status(404).json({ message: 'الطلب غير موجود' });
  if (order.order_type !== 'توصيل') return res.status(400).json({ message: 'تعيين السائق متاح لطلبات التوصيل فقط' });
  const { data, error } = await supabase.rpc('assign_instagram_order_driver', {
    p_order_id: req.params.id,
    p_driver_id: String(driver.id),
    p_driver_name: driver.name,
    p_actor_id: String(req.user.id)
  });
  if (error) return res.status(400).json({ message: 'تعذر تعيين السائق' });
  const broadcast = req.app.get('broadcast');
  if (broadcast) broadcast({ type: 'INSTAGRAM_ORDER_UPDATED' });
  res.json(data);
});

router.post('/shipping-batches', requireAdmin, async (req, res) => {
  const orderIds = Array.isArray(req.body && req.body.orderIds)
    ? Array.from(new Set(req.body.orderIds.map(value => cleanText(value, 80))))
    : [];
  const partnerName = cleanText(req.body && req.body.partnerName, 120);
  const note = cleanText(req.body && req.body.note, 300);
  if (orderIds.length < 1 || orderIds.length > 500 || orderIds.some(id => !/^[0-9a-f-]{16,80}$/i.test(id)) || partnerName.length < 2) {
    return res.status(400).json({ message: 'اختر طلبات شحن صحيحة وأدخل اسم الشريكة' });
  }
  const { data, error } = await supabase.rpc('create_instagram_shipping_batch', {
    p_order_ids: orderIds,
    p_partner_name: partnerName,
    p_note: note,
    p_actor_id: String(req.user.id)
  });
  if (error) return res.status(409).json({ message: 'تعذر إنشاء الدفعة؛ قد يكون أحد الطلبات مسلّماً أو غير صالح للتجميع' });
  const broadcast = req.app.get('broadcast');
  if (broadcast) broadcast({ type: 'INSTAGRAM_ORDER_UPDATED' });
  res.status(201).json(data);
});

router.post('/viewer-accounts', requireAdmin, async (req, res) => {
  try {
    const username = cleanText(req.body && req.body.username, 80);
    const password = typeof (req.body && req.body.password) === 'string' ? req.body.password : '';
    const name = cleanText(req.body && req.body.name, 120);
    const companyId = cleanText(req.body && req.body.companyId, 80);
    if (!/^[A-Za-z0-9_.-]{3,80}$/.test(username) || password.length < 8 || name.length < 2 || !companyId) {
      return res.status(400).json({ message: 'تحقق من اسم المستخدم وكلمة المرور والاسم والشركة' });
    }
    const { data: company, error: companyError } = await supabase.from('users').select('id').eq('id', companyId).eq('role', 'company').single();
    if (companyError || !company) return res.status(400).json({ message: 'الشركة غير موجودة' });
    const hash = await bcrypt.hash(password, 10);
    const { error } = await supabase.from('users').insert({
      username,
      password: hash,
      name,
      role: 'instagram_viewer',
      instagram_company_id: companyId
    });
    if (error) throw error;
    res.status(201).json({ message: 'تم إنشاء حساب المشاهدة' });
  } catch (error) {
    res.status(400).json({ message: error.message.includes('duplicate') ? 'اسم المستخدم موجود مسبقاً' : 'تعذر إنشاء الحساب' });
  }
});

router.get('/export', requireAdmin, async (req, res) => {
  try {
    const companyId = cleanText(req.query.companyId, 80);
    const productId = cleanText(req.query.productId, 80);
    const applyExportFilters = query => {
      if (companyId) query = query.eq('company_id', companyId);
      if (productId) query = query.eq('product_id', productId);
      if (req.query.orderType) query = query.eq('order_type', req.query.orderType);
      if (req.query.status) query = query.eq('status', req.query.status);
      if (req.query.startDate) query = query.gte('created_at', req.query.startDate);
      if (req.query.endDate) query = query.lte('created_at', req.query.endDate);
      return query.order('created_at', { ascending: false });
    };
    const [rows, inventory] = await Promise.all([
      fetchAllRows('instagram_export_rows', '*', applyExportFilters),
      fetchAllRows('instagram_inventory_stats', '*', query => {
        if (companyId) query = query.eq('company_id', companyId);
        if (productId) query = query.eq('product_id', productId);
        return query.order('product_name');
      })
    ]);

    const filteredCounts = new Map();
    for (const row of rows) {
      const key = String(row.inventory_id);
      const counts = filteredCounts.get(key) || { sold: 0, reserved: 0, postponed: 0, cancelled: 0, returned: 0 };
      const quantity = Number(row.quantity || 0);
      if (row.status === 'تم') counts.sold += quantity;
      else if (row.status === 'قيد المتابعة') counts.reserved += quantity;
      else if (row.status === 'مؤجل') counts.postponed += quantity;
      else if (row.status === 'ملغي') counts.cancelled += quantity;
      else if (row.status === 'مرتجع') counts.returned += quantity;
      filteredCounts.set(key, counts);
    }
    const summaryRows = inventory.map(item => {
      const counts = filteredCounts.get(String(item.inventory_id)) || { sold: 0, reserved: 0, postponed: 0, cancelled: 0, returned: 0 };
      return [
      item.company_name, item.product_name, item.color, item.size,
      Number(item.initial_quantity || 0), counts.sold,
      counts.reserved, counts.postponed, counts.cancelled, counts.returned,
      Number(item.remaining_quantity || 0)
      ];
    });
    const groups = new Map();
    for (const item of inventory) {
      const key = `${item.product_id}|${item.product_name}`;
      if (!groups.has(key)) groups.set(key, { name: item.product_name, rows: [] });
    }
    for (const row of rows) {
      const key = `${row.product_id}|${row.product_name}`;
      if (!groups.has(key)) groups.set(key, { name: row.product_name, rows: [] });
      groups.get(key).rows.push([
        Number(row.order_number), new Date(row.created_at).toLocaleDateString('en-GB'),
        row.customer_name, row.customer_phone, row.address, row.product_name,
        row.color, row.size, Number(row.quantity), row.order_type, row.status, row.company_name
      ]);
    }

    const workbook = buildInventoryWorkbook(summaryRows, Array.from(groups.values()));
    res.set('Cache-Control', 'no-store');
    res.set('Content-Type', 'application/vnd.ms-excel; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="instagram-inventory-${new Date().toISOString().slice(0, 10)}.xls"`);
    res.send(Buffer.from(workbook, 'utf8'));
  } catch (error) {
    console.error('Instagram export error:', error.message);
    res.status(500).json({ message: 'تعذر إنشاء ملف الجرد' });
  }
});

module.exports = router;
