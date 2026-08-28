const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const supabase = require('../config/db');
const authenticateToken = require('../middleware/auth'); // ✅ استيراد middleware

console.log('✅ auth.js loaded');

const ALLOWED_ROLES = new Set(['admin', 'driver', 'company', 'instagram_viewer']);

function cleanCredential(value, maxLength = 100) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function buildUserPayload(user) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    name: user.name,
    instagramCompanyId: user.instagram_company_id || null
  };
}

function issueTokens(user) {
  const payload = {
    id: user.id,
    role: user.role,
    name: user.name,
    instagramCompanyId: user.instagram_company_id || null
  };
  const token = jwt.sign({ ...payload, tokenType: 'access' }, process.env.JWT_SECRET, { expiresIn: '30m' });
  const refreshToken = jwt.sign({ ...payload, tokenType: 'refresh' }, process.env.REFRESH_TOKEN_SECRET || process.env.JWT_SECRET, { expiresIn: '7d' });
  return { token, refreshToken };
}

function optionalToken(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return next();
  jwt.verify(token, process.env.JWT_SECRET, (error, user) => {
    if (!error && user && user.tokenType !== 'refresh') req.user = user;
    next();
  });
}

// ==================== تسجيل الدخول (بدون توثيق) ====================
router.post('/login', async (req, res) => {
  try {
    const username = cleanCredential(req.body && req.body.username, 80);
    const password = typeof (req.body && req.body.password) === 'string' ? req.body.password : '';

    if (!username || password.length < 6 || password.length > 200) {
      return res.status(400).json({ message: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
    }

    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('username', username)
      .single();

    if (error || !user) {
      return res.status(400).json({ message: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
    }

    const validPass = await bcrypt.compare(password, user.password);
    if (!validPass) {
      return res.status(400).json({ message: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
    }

    if (!ALLOWED_ROLES.has(user.role)) {
      return res.status(403).json({ message: 'نوع الحساب غير صالح' });
    }

    const tokens = issueTokens(user);

    res.json({
      ...tokens,
      user: buildUserPayload(user)
    });
  } catch (err) {
    console.error('💥 Login exception:', err);
    res.status(500).json({ message: err.message });
  }
});

router.post('/refresh', async (req, res) => {
  try {
    const refreshToken = req.body && req.body.refreshToken;
    if (typeof refreshToken !== 'string' || !refreshToken) {
      return res.status(401).json({ code: 'REFRESH_REQUIRED', message: 'تعذر تجديد الجلسة' });
    }

    let decoded;
    try {
      decoded = jwt.verify(refreshToken, process.env.REFRESH_TOKEN_SECRET || process.env.JWT_SECRET);
    } catch (error) {
      return res.status(401).json({ code: 'REFRESH_INVALID', message: 'انتهت جلسة الدخول، سجل الدخول مجدداً' });
    }
    if (!decoded || decoded.tokenType !== 'refresh') {
      return res.status(401).json({ code: 'REFRESH_INVALID', message: 'تعذر تجديد الجلسة' });
    }

    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('id', decoded.id)
      .single();
    if (error || !user || !ALLOWED_ROLES.has(user.role)) {
      return res.status(401).json({ code: 'USER_NOT_FOUND', message: 'الحساب غير متاح' });
    }

    res.json({ ...issueTokens(user), user: buildUserPayload(user) });
  } catch (error) {
    console.error('Refresh error:', error.message);
    res.status(500).json({ message: 'تعذر تجديد الجلسة' });
  }
});

// ==================== تسجيل مستخدم جديد (يمكن أن يكون بدون توثيق أو مع توثيق مدير حسب الرغبة) ====================
// حاليًا نتركه بدون توثيق (لإنشاء أول مدير)، لكن يمكنك إضافة authenticateToken لاحقًا
router.post('/register', optionalToken, async (req, res) => {
  try {
    const username = cleanCredential(req.body && req.body.username, 80);
    const password = typeof (req.body && req.body.password) === 'string' ? req.body.password : '';
    const role = cleanCredential(req.body && req.body.role, 30);
    const name = cleanCredential(req.body && req.body.name, 120);
    const instagramCompanyId = cleanCredential(req.body && req.body.instagramCompanyId, 80);

    const { count: usersCount, error: countError } = await supabase
      .from('users')
      .select('id', { count: 'exact', head: true });
    if (countError) throw countError;

    const isBootstrap = usersCount === 0;
    if (!isBootstrap && (!req.user || req.user.role !== 'admin')) {
      return res.status(403).json({ message: 'إنشاء الحسابات متاح للمدير فقط' });
    }
    if (isBootstrap && role !== 'admin') {
      return res.status(403).json({ message: 'أول حساب يجب أن يكون حساب مدير' });
    }
    if (!ALLOWED_ROLES.has(role) || (!isBootstrap && role === 'admin')) {
      return res.status(400).json({ message: 'نوع الحساب غير صالح' });
    }
    if (!/^[A-Za-z0-9_.-]{3,80}$/.test(username)) {
      return res.status(400).json({ message: 'اسم المستخدم يجب أن يكون 3 أحرف على الأقل ومن دون مسافات' });
    }
    if (password.length < 8 || password.length > 200) {
      return res.status(400).json({ message: 'كلمة المرور يجب أن تكون 8 أحرف على الأقل' });
    }
    if (name.length < 2) {
      return res.status(400).json({ message: 'الاسم الكامل مطلوب' });
    }

    if (role === 'instagram_viewer') {
      if (!instagramCompanyId) return res.status(400).json({ message: 'يجب اختيار الشركة المرتبطة بالحساب' });
      const { data: company, error: companyError } = await supabase
        .from('users')
        .select('id, role')
        .eq('id', instagramCompanyId)
        .eq('role', 'company')
        .single();
      if (companyError || !company) return res.status(400).json({ message: 'الشركة المختارة غير موجودة' });
    }

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

    const userRow = { username, password: hashedPassword, role, name };
    if (role === 'instagram_viewer') userRow.instagram_company_id = instagramCompanyId;

    const { error } = await supabase
      .from('users')
      .insert([userRow]);

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
      .select('id, username, name, role, phone, instagram_company_id')
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
    if (!['admin', 'company', 'driver'].includes(req.user.role)) return res.sendStatus(403);
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
      .select('id, username, name, role, instagram_company_id')
      .neq('role', 'admin');

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});



// ==================== تحديث نبضات القلب (Heartbeat) ====================
// هذا المسار يُستدعى من قبل السائق كل 25 ثانية لتحديث وقت آخر نشاط له
router.patch('/heartbeat', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'driver') return res.sendStatus(403);
    // الحصول على id المستخدم من التوكن (الذي تم التحقق منه في authenticateToken)
    const userId = req.user.id;
    
    // تحديث حقل last_seen في جدول users إلى الوقت الحالي
    const { error } = await supabase
      .from('users')
      .update({ last_seen: new Date().toISOString() })
      .eq('id', userId);

    if (error) throw error;
    
    // إرسال استجابة 200 (OK) بدون محتوى
    res.sendStatus(200);
  } catch (err) {
    console.error('Heartbeat error:', err);
    res.status(500).json({ message: err.message });
  }
});

// جلب قالب الرسالة (للمدير)
router.get('/message-template', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') return res.sendStatus(403);
  const { data: user, error } = await supabase
    .from('users')
    .select('message_template')
    .eq('id', req.user.id)
    .single();
  if (error) return res.status(500).json({ message: error.message });
  res.json({ template: user?.message_template || '' });
});

// تحديث قالب الرسالة (للمدير)
router.patch('/message-template', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') return res.sendStatus(403);
  const { template } = req.body;
  const { error } = await supabase
    .from('users')
    .update({ message_template: template })
    .eq('id', req.user.id);
  if (error) return res.status(500).json({ message: error.message });
  res.json({ message: 'تم تحديث القالب' });
});


module.exports = router;
