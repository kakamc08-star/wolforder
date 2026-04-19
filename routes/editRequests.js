const express = require('express');
const router = express.Router();
const supabase = require('../config/db');
const authenticateToken = require('../middleware/auth');

// 1. الشركة ترسل طلب تعديل
router.post('/', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'company') {
      return res.status(403).json({ message: 'غير مصرح' });
    }

    const { orderId, changes } = req.body;

    // التحقق من وجود الطلب وأنه يخص الشركة
    const { data: order, error: orderError } = await supabase
      .from('orders')
      .select('id, company_id')
      .eq('id', orderId)
      .single();

    if (orderError || !order) {
      return res.status(404).json({ message: 'الطلب غير موجود' });
    }
    if (order.company_id !== req.user.id) {
      return res.status(403).json({ message: 'لا يمكنك تعديل هذا الطلب' });
    }

    // جلب اسم الشركة
    const { data: company } = await supabase
      .from('users')
      .select('name')
      .eq('id', req.user.id)
      .single();

    const { data: editRequest, error } = await supabase
      .from('edit_requests')
      .insert([{
        order_id: orderId,
        company_id: req.user.id,
        company_name: company?.name || '',
        requested_changes: changes,
        status: 'معلق'
      }])
      .select()
      .single();

    if (error) throw error;

    // TODO: إشعار المدير (يمكن إضافته لاحقاً)

    res.status(201).json(editRequest);
  } catch (err) {
    console.error('POST /edit-requests error:', err);
    res.status(500).json({ message: err.message });
  }
});

// 2. المدير يجلب الطلبات المعلقة
router.get('/pending', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'غير مصرح' });
    }

    const { data: requests, error } = await supabase
      .from('edit_requests')
      .select(`
        *,
        order:order_id(order_number)
      `)
      .eq('status', 'معلق')
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json(requests);
  } catch (err) {
    console.error('GET /edit-requests/pending error:', err);
    res.status(500).json({ message: err.message });
  }
});

// 3. المدير يقبل طلب تعديل
router.patch('/:id/accept', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'غير مصرح' });
    }

    const { id } = req.params;

    // جلب طلب التعديل
    const { data: editRequest, error: fetchError } = await supabase
      .from('edit_requests')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchError || !editRequest) {
      return res.status(404).json({ message: 'طلب التعديل غير موجود' });
    }
    if (editRequest.status !== 'معلق') {
      return res.status(400).json({ message: 'تم البت في هذا الطلب مسبقاً' });
    }

    // جلب الطلب الأصلي
    const { data: order, error: orderError } = await supabase
      .from('orders')
      .select('*')
      .eq('id', editRequest.order_id)
      .single();

    if (orderError || !order) {
      return res.status(404).json({ message: 'الطلب الأصلي غير موجود' });
    }

    // تطبيق التغييرات
    const changes = editRequest.requested_changes;
    const updates = { updated_at: new Date() };
    if (changes.orderNumber) updates.order_number = changes.orderNumber;
    if (changes.customerNumber) updates.customer_number = changes.customerNumber;
    if (changes.customerName) updates.customer_name = changes.customerName;
    if (changes.address) updates.address = changes.address;
    if (changes.price) updates.price = changes.price;
    if (changes.currency) updates.currency = changes.currency;

    const { error: updateError } = await supabase
      .from('orders')
      .update(updates)
      .eq('id', editRequest.order_id);

    if (updateError) throw updateError;

    // تحديث حالة طلب التعديل
    const { error: statusError } = await supabase
      .from('edit_requests')
      .update({ status: 'مقبول', responded_at: new Date() })
      .eq('id', id);

    if (statusError) throw statusError;

    res.json({ message: 'تم قبول التعديل' });
  } catch (err) {
    console.error('accept edit-request error:', err);
    res.status(500).json({ message: err.message });
  }
});

// 4. المدير يرفض طلب تعديل
router.patch('/:id/reject', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'غير مصرح' });
    }

    const { id } = req.params;
    const { note } = req.body;

    const { error } = await supabase
      .from('edit_requests')
      .update({
        status: 'مرفوض',
        admin_note: note || '',
        responded_at: new Date()
      })
      .eq('id', id);

    if (error) throw error;

    res.json({ message: 'تم رفض الطلب' });
  } catch (err) {
    console.error('reject edit-request error:', err);
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;