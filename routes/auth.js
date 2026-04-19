const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const supabase = require('../config/db');
const authenticateToken = require('../middleware/auth'); // ✅ استيراد middleware

console.log('✅ auth.js loaded');

// ==================== تسجيل الدخول (بدون توثيق) ====================
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    console.log('🔐 Login attempt for:', username);

    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('username', username)
      .single();

    console.log('📡 Supabase error:', error);
    console.log('👤 User found:', user);

    if (error || !user) {
      return res.status(400).json({ message: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
    }

    const validPass = await bcrypt.compare(password, user.password);
    console.log('✅ Password match:', validPass);

    if (!validPass) {
      return res.status(400).json({ message: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
    }

    const token = jwt.sign(
      { id: user.id, role: user.role, name: user.name },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      token,
      user: { id: user.id, username: user.username, role: user.role, name: user.name }
    });
  } catch (err) {
    console.error('💥 Login exception:', err);
    res.status(500).json({ message: err.message });
  }
});

// ==================== تسجيل مستخدم جديد (يمكن أن يكون بدون توثيق أو مع توثيق مدير حسب الرغبة) ====================
// حاليًا نتركه بدون توثيق (لإنشاء أول مدير)، لكن يمكنك إضافة authenticateToken لاحقًا
router.post('/register', async (req, res) => {
  try {
    const { username, password, role, name } = req.body;

    const { data: existing } = await supabase
      .from('users')
      .select('id')
      .eq('username', username)
      .single();

    if (existing) {
      return res.status(400).json({ message: 'اسم المستخدم موجود مسبقاً' });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const { data: newUser, error } = await supabase
      .from('users')
      .insert([{ username, password: hashedPassword, role, name }])
      .select()
      .single();

    if (error) throw error;

    res.status(201).json({ message: 'تم إنشاء المستخدم بنجاح' });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ message: err.message });
  }
});

// ==================== المسارات المحمية (تتطلب توثيق) ====================

// جلب بيانات المستخدم الحالي
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const { data: user, error } = await supabase
      .from('users')
      .select('id, username, name, role, phone')
      .eq('id', req.user.id)
      .single();

    if (error) throw error;
    res.json(user);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// تحديث رقم هاتف المدير
router.patch('/update-phone', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.sendStatus(403);
    const { phone } = req.body;
    const { error } = await supabase
      .from('users')
      .update({ phone })
      .eq('id', req.user.id);

    if (error) throw error;
    res.json({ message: 'تم تحديث الرقم' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// الحصول على رقم هاتف المدير (للشركة والسائق) - يتطلب توثيق ولكن أي دور
router.get('/admin-phone', authenticateToken, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('phone')
      .eq('role', 'admin')
      .single();

    if (error) throw error;
    res.json({ phone: data?.phone || '' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// حذف مستخدم (للمدير فقط)
router.delete('/users/:id', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.sendStatus(403);
    const { id } = req.params;
    const { error } = await supabase.from('users').delete().eq('id', id);
    if (error) throw error;
    res.json({ message: 'تم حذف المستخدم' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// جلب قائمة المستخدمين (للمدير)
router.get('/users', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.sendStatus(403);
    const { data, error } = await supabase
      .from('users')
      .select('id, username, name, role')
      .neq('role', 'admin');

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;