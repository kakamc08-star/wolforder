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
      const headers = ['الرقم التسلسلي', 'رقم الطلب', 'اسم العميل', 'رقم العميل', 'العنوان', 'السعر', 'النسبة', 'الحالة', 'ملاحظة', 'السائق', 'الشركة', 'التاريخ'];
      const rows = orders.map(o => [
        o.serial_number,
        o.order_number,
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

// ==================== طلبات اليوم (المسار الجذري) ====================
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { role, id } = req.user;
    const { status, startDate, endDate, driverId, companyId } = req.query;

    let query = supabase
      .from('orders')
      .select(`
        *,
        driver:driver_id(id, name, username),
        company:company_id(id, name, username)
      `)
      .order('created_at', { ascending: false });

    // فلترة حسب الدور
    if (role === 'driver') {
      query = query.eq('driver_id', id);
    } else if (role === 'company') {
      query = query.eq('company_id', id);
    }

    // فلترة حسب التاريخ
    if (startDate || endDate) {
      if (startDate) query = query.gte('created_at', startDate);
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        query = query.lte('created_at', end.toISOString());
      }
    } else {
      // بدون فلتر تاريخ: طلبات اليوم + المؤجلات
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      query = query.or(`created_at.gte.${today.toISOString()},status.eq.قيد التسليم`);
    }

    // فلترة حسب الحالة
    if (status) {
      query = query.eq('status', status);
    }

    // فلترة إضافية للمدير
    if (role === 'admin') {
      if (driverId) query = query.eq('driver_id', driverId);
      if (companyId) query = query.eq('company_id', companyId);
    }

    const { data: orders, error } = await query;

    if (error) throw error;

    res.json(orders);
  } catch (err) {
    console.error('GET / error:', err);
    res.status(500).json({ message: err.message });
  }
});

// ==================== إنشاء طلب ====================
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { orderNumber, customerNumber, customerName, address, price, currency, ratio, driverId, companyId } = req.body;
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
        status: 'قيد التسليم'
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
      if (order.status !== 'قيد التسليم') {
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
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'غير مصرح لك بتعديل الطلب' });
    }

    const {
      orderNumber, customerNumber, customerName, address,
      price, currency, ratio, driverId, companyId, status, note
    } = req.body;

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