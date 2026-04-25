const express = require('express');
const router = express.Router();
const supabase = require('../config/db');
const authenticateToken = require('../middleware/auth');

// دالة تنسيق الأرقام للتصدير
function formatNumberForExcel(num) {
  if (num === null || num === undefined || isNaN(num)) return '0';
  const rounded = Math.round(num);
  return rounded.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// ==================== المسارات الثابتة (يجب أن تكون أولاً) ====================

// التقارير
router.get('/report', authenticateToken, async (req, res) => {
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
      const headers = ['الرقم التسلسلي', 'رقم الطلب','محتويات الطلب', 'اسم العميل', 'رقم العميل', 'العنوان', 'السعر', 'النسبة', 'الحالة', 'ملاحظة', 'السائق', 'الشركة', 'التاريخ'];
      const rows = orders.map(o => [
        o.serial_number,
        o.order_number,
        o.order_contents || '-', 
        o.customer_name,
        o.customer_number || '-',
        o.address,
        formatNumberForExcel(o.price) + ' ' + (o.currency || 'ل.س'),
        formatNumberForExcel(o.ratio || 0),
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
      const csv = '\uFEFF' + [headers.map(escapeCSV).join(','), ...rows.map(r => r.map(escapeCSV).join(','))].join('\n');
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
router.get('/users-list', authenticateToken, async (req, res) => {
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
router.patch('/bulk-update', authenticateToken, async (req, res) => {
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

    res.json({ message: `تم تحديث ${ids.length} طلب بنجاح` });
  } catch (err) {
    console.error('Bulk update error:', err);
    res.status(500).json({ message: err.message });
  }
});
// ==================== طلبات اليوم (المسار الجذري) ====================
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { role, id } = req.user;
    const { status, startDate, endDate, driverId, companyId } = req.query;

    // 1. بناء استعلام أساسي
    let query = supabase
      .from('orders')
      .select(`
        *,
        driver:driver_id(id, name, username),
        company:company_id(id, name, username)
      `)
      .order('created_at', { ascending: false });

    // 2. فلترة حسب الدور
    if (role === 'driver') {
      query = query.eq('driver_id', id);
    } else if (role === 'company') {
      query = query.eq('company_id', id);
    }
    
  // 3. فلترة حسب التاريخ (إذا وُجد)
if (startDate || endDate) {
  if (startDate) {
    query = query.gte('created_at', startDate);
  }
  if (endDate) {
    query = query.lte('created_at', endDate);
  }
}

    // 4. فلترة حسب الحالة (إذا وُجد)
    if (status) {
      query = query.eq('status', status);
    }

    // 5. فلترة إضافية للمدير
    if (role === 'admin') {
      if (driverId) query = query.eq('driver_id', driverId);
      if (companyId) query = query.eq('company_id', companyId);
    }

    // 6. تنفيذ الاستعلام
    const { data: orders, error } = await query;
    if (error) throw error;

    // 7. الفلترة الافتراضية (إذا لم يتم تحديد نطاق تاريخ)
    let filteredOrders = orders;
    if (!startDate && !endDate) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      
      filteredOrders = orders.filter(o => {
        try {
          // الحالة "قيد المتابعة" تظهر دائمًا
          if (o.status === 'قيد المتابعة') return true;
          
          // الطلبات التي أنشئت اليوم تظهر
          if (o.created_at) {
            const createdAt = new Date(o.created_at);
            if (!isNaN(createdAt.getTime()) && createdAt >= today) return true;
          }
          
          // الطلبات التي عُدلت اليوم تظهر
          if (o.updated_at) {
            const updatedAt = new Date(o.updated_at);
            if (!isNaN(updatedAt.getTime()) && updatedAt >= today) return true;
          }
        } catch (e) {
          // إذا حدث خطأ في تاريخ معين، نتجاهل هذا الشرط
          console.warn('خطأ في فلترة طلب:', e);
        }
        return false;
      });
    }

    res.json(filteredOrders);
  } catch (err) {
    console.error('GET / error:', err);
    res.status(500).json({ message: err.message });
  }
});

// ==================== إنشاء طلب ====================
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { orderNumber, customerNumber, customerName, address, price, currency, ratio, driverId, companyId, orderContents } = req.body;
    const creator = req.user;

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
        status: 'قيد المتابعة'
        
      }])
      .select()
      .single();

    if (error) throw error;

    res.status(201).json(newOrder);
  } catch (err) {
    console.error('POST / error:', err);
    res.status(400).json({ message: err.message });
  }
});

// ==================== المسارات الديناميكية (يجب أن تكون بعد الثابتة) ====================

// تعيين سائق (PATCH /:id/assign-driver) - يجب أن يأتي قبل /:id
router.patch('/:id/assign-driver', authenticateToken, async (req, res) => {
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

    res.json(order);
  } catch (err) {
    console.error('assign-driver error:', err);
    res.status(400).json({ message: err.message });
  }
});

// جلب طلب واحد (GET /:id)
router.get('/:id', authenticateToken, async (req, res) => {
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
router.patch('/:id', authenticateToken, async (req, res) => {
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

    res.json(updatedOrder);
  } catch (err) {
    console.error('PATCH /:id error:', err);
    res.status(400).json({ message: err.message });
  }
});

// تحديث كامل للطلب (PUT /:id)
// تحديث كامل للطلب (PUT /:id)
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'غير مصرح لك بتعديل الطلب' });
    }

    const {
      orderNumber, customerNumber, customerName, address,
      price, currency, ratio, driverId, companyId, status, note, orderContents
    } = req.body;

    // جلب الطلب الحالي لمعرفة الشركة المخزنة
    const { data: currentOrder, error: fetchCurrentError } = await supabase
      .from('orders')
      .select('company_id')
      .eq('id', req.params.id)
      .single();

    if (fetchCurrentError || !currentOrder) {
      return res.status(404).json({ message: 'الطلب غير موجود' });
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

    res.json(updatedOrder);
  } catch (err) {
    console.error('PUT /:id error:', err);
    res.status(400).json({ message: err.message });
  }
});

// حذف طلب (DELETE /:id)
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'غير مصرح' });
    }

    const { error } = await supabase.from('orders').delete().eq('id', req.params.id);
    if (error) throw error;

    res.json({ message: 'تم حذف الطلب بنجاح' });
  } catch (err) {
    console.error('DELETE /:id error:', err);
    res.status(500).json({ message: err.message });
  }
});


module.exports = router;