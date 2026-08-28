const express = require('express');
const router = express.Router();
const supabase = require('../config/db');
const authenticateToken = require('../middleware/auth');
const { parsePagination, sanitizeSearch } = require('../utils/instagram-validation');

const ORDER_TYPES = ['توصيل', 'شحن', 'شحن لباب المنزل'];
const companySummaryCache = new Map();

function normalizeOrderType(value) {
  const orderType = value || 'توصيل';
  return ORDER_TYPES.includes(orderType) ? orderType : null;
}

router.use(authenticateToken);
router.use((req, res, next) => {
  if (!['admin', 'driver', 'company'].includes(req.user.role)) {
    return res.status(403).json({ message: 'هذا الحساب غير مخوّل للوصول إلى الطلبات الأساسية' });
  }
  next();
});

function applyRoleFilter(query, role, id) {
  if (role === 'driver') return query.eq('driver_id', id);
  if (role === 'company') return query.eq('company_id', id);
  return query;
}

function applyDateFilter(query, startDate, endDate, role) {
  if (startDate) query = query.gte('created_at', startDate);
  if (endDate) query = query.lte('created_at', endDate);
  if (!startDate && !endDate && role !== 'company') {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    query = query.or(`status.eq.قيد المتابعة,created_at.gte.${today.toISOString()},updated_at.gte.${today.toISOString()}`);
  }
  return query;
}

async function getCompanyOrderSummary(companyId, startDate, endDate) {
  const cacheKey = `${companyId}|${startDate || ''}|${endDate || ''}`;
  const cached = companySummaryCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < 15000) return cached.value;
  const countFor = async ({ status, shipping } = {}) => {
    let query = supabase
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId);
    if (startDate) query = query.gte('created_at', startDate);
    if (endDate) query = query.lte('created_at', endDate);
    if (status) query = query.eq('status', status);
    if (shipping) query = query.in('order_type', ['شحن', 'شحن لباب المنزل']);
    const { count, error } = await query;
    if (error) throw error;
    return count || 0;
  };

  const [pending, postponed, done, returned, cancelled, shipping] = await Promise.all([
    countFor({ status: 'قيد المتابعة' }),
    countFor({ status: 'مؤجل' }),
    countFor({ status: 'تم' }),
    countFor({ status: 'مرتجع' }),
    countFor({ status: 'إلغاء' }),
    countFor({ shipping: true })
  ]);
  const value = { pending, postponed, done, returned, cancelled, shipping };
  companySummaryCache.set(cacheKey, { createdAt: Date.now(), value });
  if (companySummaryCache.size > 500) {
    for (const [key, item] of companySummaryCache) {
      if (Date.now() - item.createdAt > 15000) companySummaryCache.delete(key);
    }
  }
  return value;
}

// دالة تنسيق الأرقام للتصدير
function formatNumberForExcel(num) {
  if (num === null || num === undefined || isNaN(num)) return '0';
  const rounded = Math.round(num);
  return rounded.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// ==================== المسارات الثابتة (يجب أن تكون أولاً) ====================

// التقارير
router.get('/report', async (req, res) => {
  try {
    const { role, id } = req.user;
    const { status, driverId, companyId, startDate, endDate } = req.query;

    let query = supabase
      .from('orders')
      .select(`
        *,
        driver:driver_id(id, name),
        company:company_id(id, name)
      `)
      .order('created_at', { ascending: false });

    if (role === 'driver') {
      query = query.eq('driver_id', id);
    } else if (role === 'company') {
      query = query.eq('company_id', id);
    }

    if (startDate) query = query.gte('created_at', startDate);
    if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      query = query.lte('created_at', end.toISOString());
    }
    if (status) query = query.eq('status', status);
    if (role === 'admin') {
      if (driverId) query = query.eq('driver_id', driverId);
      if (companyId) query = query.eq('company_id', companyId);
    }

    const { data: orders, error } = await query;
    if (error) throw error;

    const totalSYR = orders.reduce((sum, o) => o.currency !== 'دولار' ? sum + (o.price || 0) : sum, 0);
    const totalUSD = orders.reduce((sum, o) => o.currency === 'دولار' ? sum + (o.price || 0) : sum, 0);
    const totalRatio = orders.reduce((sum, o) => sum + (o.ratio || 0), 0);

 if (req.query.export === 'excel') {
  const headers = ['الرقم التسلسلي', 'رقم الطلب', 'نوع الطلب', 'محتويات الطلب', 'اسم العميل', 'رقم العميل', 'العنوان', 'السعر', 'النسبة', 'الحالة', 'ملاحظة', 'السائق', 'الشركة', 'التاريخ'];
  
  const rows = orders.map(o => [
    o.serial_number,
    o.order_number,
    o.order_type || 'توصيل',
    o.order_contents || '-', 
    o.customer_name,
    o.customer_number || '-',
    o.address,
    o.price,                   // رقم قابل للجمع (بدون رمز العملة)
    o.ratio || 0,              // رقم قابل للجمع
    o.status,
    o.note || '-',
    o.driver_name || '-',
    o.company_name || '-',
    new Date(o.created_at).toLocaleDateString('en-GB')
  ]);

  const escapeCSV = (val) => {
    const str = String(val);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
  };

  const headerRow = headers.map(escapeCSV).join(',');
  const dataRows = rows.map(r => r.map(escapeCSV).join(','));

  // صف فارغ للفصل
  const emptyRow = new Array(headers.length).fill('').map(escapeCSV).join(',');

  // صف إجمالي المبيعات (ل.س)
  const summarySYR = new Array(headers.length).fill('');
  summarySYR[headers.indexOf('رقم الطلب')] = 'إجمالي المبيعات (ل.س)';
  summarySYR[headers.indexOf('السعر')] = totalSYR;
  const summarySYRRow = summarySYR.map(escapeCSV).join(',');

  // صف إجمالي المبيعات ($)
  const summaryUSD = new Array(headers.length).fill('');
  summaryUSD[headers.indexOf('رقم الطلب')] = 'إجمالي المبيعات ($)';
  summaryUSD[headers.indexOf('السعر')] = totalUSD;
  const summaryUSDRow = summaryUSD.map(escapeCSV).join(',');

  const csv = '\uFEFF' + [headerRow, ...dataRows, emptyRow, summarySYRRow, summaryUSDRow].join('\n');
  
  res.header('Content-Type', 'text/csv; charset=utf-8');
  res.header('Content-Disposition', 'attachment; filename=report.csv');
  return res.send(csv);
}

    res.json({ count: orders.length, totalSYR, totalUSD, totalRatio, orders });
  } catch (err) {
    console.error('report error:', err);
    res.status(500).json({ message: err.message });
  }
});

// قائمة المستخدمين
router.get('/users-list', async (req, res) => {
  if (req.user.role !== 'admin') return res.sendStatus(403);
  try {
    const { data: drivers } = await supabase.from('users').select('id, name, username').eq('role', 'driver');
    const { data: companies } = await supabase.from('users').select('id, name, username').eq('role', 'company');
    res.json({ drivers, companies });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// تحديث جماعي (Bulk Update)
router.patch('/bulk-update', async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'غير مصرح' });
    }
    const { ids, updates } = req.body;
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ message: 'لم يتم تحديد طلبات' });
    }
    if (!updates || Object.keys(updates).length === 0) {
      return res.status(400).json({ message: 'لم يتم تحديد تحديثات' });
    }

    const updateData = { updated_at: new Date() };
    let needDriverName = false;
    let needCompanyName = false;

    if (updates.status) {
      updateData.status = updates.status;
    }
    if (updates.driverId) {
      updateData.driver_id = updates.driverId;
      needDriverName = true;
    }
    if (updates.companyId) {
      updateData.company_id = updates.companyId;
      needCompanyName = true;
    }

    // جلب الأسماء إذا لزم الأمر
    if (needDriverName) {
      const { data: driver } = await supabase.from('users').select('name').eq('id', updates.driverId).single();
      if (driver) updateData.driver_name = driver.name;
    }
    if (needCompanyName) {
      const { data: company } = await supabase.from('users').select('name').eq('id', updates.companyId).single();
      if (company) updateData.company_name = company.name;
    }

    const { error } = await supabase
      .from('orders')
      .update(updateData)
      .in('id', ids);

    if (error) throw error;

    // ✅ إشعار المتصفحات بحدوث تحديث على الطلبات
    const broadcast = req.app.get('broadcast');
    if (broadcast) broadcast({ type: 'ORDER_UPDATED' });

    res.json({ message: `تم تحديث ${ids.length} طلب بنجاح` });
  } catch (err) {
    console.error('Bulk update error:', err);
    res.status(500).json({ message: err.message });
  }
});

// ==================== طلبات اليوم (المسار الجذري) ====================
router.get('/', async (req, res) => {
  try {
    const { role, id } = req.user;
    const { status, startDate, endDate, driverId, companyId, orderType } = req.query;
    const shouldPaginate = String(req.query.paginate || '') === '1';
    const { page, limit, from, to } = parsePagination(req.query, 50, 100);
    const search = sanitizeSearch(req.query.search);
    const sortDirection = req.query.sort === 'asc' ? true : false;

    const normalizedOrderType = orderType ? normalizeOrderType(orderType) : null;
    if (orderType && !normalizedOrderType) {
      return res.status(400).json({ message: 'نوع الطلب غير صالح' });
    }

    const buildQuery = ({ includeCount = false, rangeStart = null, rangeEnd = null } = {}) => {
      let query = supabase
        .from('orders')
        .select(`
          *,
          driver:driver_id(id, name, username),
          company:company_id(id, name, username)
        `, includeCount ? { count: 'exact' } : undefined)
        .order(req.query.sort ? 'order_number' : 'created_at', { ascending: req.query.sort ? sortDirection : false });

      query = applyRoleFilter(query, role, id);
      query = applyDateFilter(query, startDate, endDate, role);
      if (status) query = query.eq('status', status);
      if (normalizedOrderType) query = query.eq('order_type', normalizedOrderType);
      if (String(req.query.shipping || '') === '1') query = query.in('order_type', ['شحن', 'شحن لباب المنزل']);

      if (search) {
        const pattern = `*${search}*`;
        query = query.or([
          `order_number.ilike.${pattern}`,
          `order_contents.ilike.${pattern}`,
          `customer_name.ilike.${pattern}`,
          `customer_number.ilike.${pattern}`,
          `address.ilike.${pattern}`,
          `note.ilike.${pattern}`,
          `company_name.ilike.${pattern}`,
          `driver_name.ilike.${pattern}`
        ].join(','));
      }

      if (role === 'admin') {
        if (driverId) query = query.eq('driver_id', driverId);
        if (companyId) query = query.eq('company_id', companyId);
      }
      if (rangeStart !== null && rangeEnd !== null) query = query.range(rangeStart, rangeEnd);
      return query;
    };

    if (!shouldPaginate) {
      const orders = [];
      const batchSize = 1000;
      for (let rangeStart = 0; rangeStart < 100000; rangeStart += batchSize) {
        const { data, error } = await buildQuery({ rangeStart, rangeEnd: rangeStart + batchSize - 1 });
        if (error) throw error;
        orders.push(...(data || []));
        if (!data || data.length < batchSize) return res.json(orders);
      }
      return res.status(413).json({ message: 'عدد الطلبات كبير جداً للعرض دفعة واحدة؛ استخدم الفلاتر لتضييق النتائج' });
    }

    const { data: orders, error, count } = await buildQuery({ includeCount: true, rangeStart: from, rangeEnd: to });
    if (error) throw error;

    let summary = null;
    if (role === 'company' && String(req.query.includeSummary || '') === '1') {
      summary = await getCompanyOrderSummary(id, startDate, endDate);
    }

    const total = count || 0;
    res.json({
      orders: orders || [],
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
      summary
    });
  } catch (err) {
    console.error('GET / error:', err);
    res.status(500).json({ message: err.message });
  }
});

// ==================== إنشاء طلب ====================
router.post('/', async (req, res) => {
  try {
    const { orderNumber, customerNumber, customerName, address, price, currency, ratio, driverId, companyId, orderContents, orderType, note } = req.body;
    const creator = req.user;
    const normalizedOrderType = normalizeOrderType(orderType);

    if (!normalizedOrderType) {
      return res.status(400).json({ message: 'نوع الطلب غير صالح' });
    }

    if (creator.role !== 'admin' && creator.role !== 'company') {
      return res.status(403).json({ message: 'غير مصرح لك بإنشاء طلب' });
    }

    let company = null;
    let driver = null;
    if (creator.role === 'company') {
      company = creator.id;
    } else if (creator.role === 'admin') {
      company = companyId || null;
      driver = driverId || null;
    }


      // ✅ شرط منع تكرار رقم الطلب لنفس الشركة
    if (company && orderNumber) {
      const { count, error: checkError } = await supabase
      .from('orders')
      .select('*', { count: 'exact', head: true })
      .eq('company_id', company)
      .eq('order_number', orderNumber);

    if (checkError) throw checkError;
    if (count > 0) {
      return res.status(400).json({ message: 'رقم الطلب موجود مسبقاً لهذه الشركة' });
      }
    }

    let companyName = '';
    let driverName = '';
    if (company) {
      const { data: comp } = await supabase.from('users').select('name').eq('id', company).single();
      companyName = comp?.name || '';
    }
    if (driver) {
      const { data: driv } = await supabase.from('users').select('name').eq('id', driver).single();
      driverName = driv?.name || '';
    }

    const { data: newOrder, error } = await supabase
      .from('orders')
      .insert([{
        order_number: orderNumber,
        order_type: normalizedOrderType,
        order_contents: orderContents || '',
        customer_name: customerName,
        customer_number: customerNumber || '',
        address,
        price,
        currency: currency || 'ل.س',
        ratio: ratio || 0,
        driver_id: driver,
        driver_name: driverName,
        company_id: company,
        company_name: companyName,
        status: 'قيد المتابعة',
        note: note || ''
        
      }])
      .select()
      .single();

    if (error) throw error;

    // ✅ إشعار المتصفحات بإنشاء طلب جديد
    const broadcast = req.app.get('broadcast');
    if (broadcast) broadcast({ type: 'ORDER_CREATED' });

    res.status(201).json(newOrder);
  } catch (err) {
    console.error('POST / error:', err);
    res.status(400).json({ message: err.message });
  }
});

// ==================== المسارات الديناميكية (يجب أن تكون بعد الثابتة) ====================

// تعيين سائق (PATCH /:id/assign-driver) - يجب أن يأتي قبل /:id
router.patch('/:id/assign-driver', async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'غير مصرح لك بتعيين سائق' });
    }

    const { driverId, ratio } = req.body;
    if (!driverId) return res.status(400).json({ message: 'يرجى اختيار سائق' });

    const { data: driver } = await supabase.from('users').select('name').eq('id', driverId).single();
    if (!driver) return res.status(400).json({ message: 'السائق غير موجود' });

    const updates = {
      driver_id: driverId,
      driver_name: driver.name,
      updated_at: new Date()
    };
    if (ratio !== undefined) updates.ratio = ratio;

    const { data: order, error } = await supabase
      .from('orders')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;

    // ✅ إشعار المتصفحات بتحديث الطلب (تعيين سائق)
    const broadcast = req.app.get('broadcast');
    if (broadcast) broadcast({ type: 'ORDER_UPDATED' });

    res.json(order);
  } catch (err) {
    console.error('assign-driver error:', err);
    res.status(400).json({ message: err.message });
  }
});

// جلب طلب واحد (GET /:id)
router.get('/:id', async (req, res) => {
  try {
    const { data: order, error } = await supabase
      .from('orders')
      .select(`
        *,
        driver:driver_id(id, name, username),
        company:company_id(id, name, username)
      `)
      .eq('id', req.params.id)
      .single();

    if (error || !order) return res.status(404).json({ message: 'الطلب غير موجود' });

    // التحقق من الصلاحية
    const { role, id } = req.user;
    if (role === 'driver' && order.driver_id !== id) {
      return res.status(403).json({ message: 'غير مصرح' });
    }
    if (role === 'company' && order.company_id !== id) {
      return res.status(403).json({ message: 'غير مصرح' });
    }

    res.json(order);
  } catch (err) {
    console.error('GET /:id error:', err);
    res.status(500).json({ message: err.message });
  }
});

// تحديث حالة الطلب (PATCH /:id)
router.patch('/:id', async (req, res) => {
  try {
    const { status, note } = req.body;
    const currentUser = req.user;

    const { data: order, error: fetchError } = await supabase
      .from('orders')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (fetchError || !order) return res.status(404).json({ message: 'الطلب غير موجود' });

    if (currentUser.role === 'driver') {
      if (order.driver_id !== currentUser.id) {
        return res.status(403).json({ message: 'لا يمكنك تعديل هذا الطلب' });
      }
      if (order.status !== 'قيد المتابعة') {
        return res.status(400).json({ message: 'لا يمكن تعديل طلب تم الانتهاء منه أو إلغاؤه' });
      }
    }

    const updates = { updated_at: new Date() };
    if (status) updates.status = status;
    if (note !== undefined) updates.note = note;

    const { data: updatedOrder, error: updateError } = await supabase
      .from('orders')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .single();

    if (updateError) throw updateError;

    // ✅ إشعار المتصفحات بتغيير حالة الطلب أو الملاحظة
    const broadcast = req.app.get('broadcast');
    if (broadcast) broadcast({ type: 'ORDER_UPDATED' });

    res.json(updatedOrder);
  } catch (err) {
    console.error('PATCH /:id error:', err);
    res.status(400).json({ message: err.message });
  }
});

// تحديث كامل للطلب (PUT /:id)
router.put('/:id', async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'غير مصرح لك بتعديل الطلب' });
    }

    const {
      orderNumber, customerNumber, customerName, address,
      price, currency, ratio, driverId, companyId, status, note, orderContents, orderType
    } = req.body;
    // جلب الطلب الحالي لمعرفة الشركة المخزنة
    const { data: currentOrder, error: fetchCurrentError } = await supabase
      .from('orders')
      .select('company_id, order_type')
      .eq('id', req.params.id)
      .single();

    if (fetchCurrentError || !currentOrder) {
      return res.status(404).json({ message: 'الطلب غير موجود' });
    }

    const normalizedOrderType = normalizeOrderType(orderType || currentOrder.order_type);
    if (!normalizedOrderType) {
      return res.status(400).json({ message: 'نوع الطلب غير صالح' });
    }

    // ✅ التحقق من عدم تكرار رقم الطلب لنفس الشركة عند التعديل
    const targetCompany = companyId || currentOrder.company_id;
    const targetOrderNumber = orderNumber;

    if (targetCompany && targetOrderNumber) {
      const { count, error: dupError } = await supabase
      .from('orders')
      .select('*', { count: 'exact', head: true })
      .eq('company_id', targetCompany)
      .eq('order_number', targetOrderNumber)
      .neq('id', req.params.id);

    if (dupError) throw dupError;
    if (count > 0) {
      return res.status(400).json({ message: 'رقم الطلب موجود مسبقاً لهذه الشركة' });
      }
    }

    let driverName = '';
    let companyName = '';

    if (driverId) {
      const { data: d } = await supabase.from('users').select('name').eq('id', driverId).single();
      driverName = d?.name || '';
    }
    if (companyId) {
      const { data: c } = await supabase.from('users').select('name').eq('id', companyId).single();
      companyName = c?.name || '';
    }

    const updates = {
      order_number: orderNumber,
      order_type: normalizedOrderType,
      order_contents: orderContents || '',
      customer_name: customerName,
      customer_number: customerNumber || '',
      address,
      price,
      currency: currency || 'ل.س',
      ratio: ratio || 0,
      driver_id: driverId || null,
      driver_name: driverName,
      company_id: companyId || null,
      company_name: companyName,
      status,
      note: note || '',
      updated_at: new Date()
    };

    const { data: updatedOrder, error } = await supabase
      .from('orders')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;

    // ✅ إشعار المتصفحات بالتحديث الكامل للطلب
    const broadcast = req.app.get('broadcast');
    if (broadcast) broadcast({ type: 'ORDER_UPDATED' });

    res.json(updatedOrder);
  } catch (err) {
    console.error('PUT /:id error:', err);
    res.status(400).json({ message: err.message });
  }
});

// حذف طلب (DELETE /:id)
router.delete('/:id', async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'غير مصرح' });
    }

    const { error } = await supabase.from('orders').delete().eq('id', req.params.id);
    if (error) throw error;

    // ✅ إشعار المتصفحات بحذف الطلب
    const broadcast = req.app.get('broadcast');
    if (broadcast) broadcast({ type: 'ORDER_DELETED' });

    res.json({ message: 'تم حذف الطلب بنجاح' });
  } catch (err) {
    console.error('DELETE /:id error:', err);
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
