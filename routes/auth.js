const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const supabase = require('../config/db');
const authenticateToken = require('../middleware/auth'); // ✅ استيراد middleware

console.log('✅ auth.js loaded');

const ALLOWED_ROLES = new Set(['admin', 'company', 'driver', 'instagram_viewer']);
const REGISTER_ROLES = new Set(['admin', 'company', 'driver']);

function sendLoginLock(res, lockedUntil) {
  lockedUntil = new Date(lockedUntil).toISOString();
  const seconds = Math.max(1, Math.ceil((Date.parse(lockedUntil) - Date.now()) / 1000));
  return res.status(429).set('Retry-After', String(seconds)).json({
    code: 'LOGIN_LOCKED',
    message: 'تم تجاوز عدد محاولات تسجيل الدخول المسموحة. يرجى المحاولة بعد 5 دقائق.',
    lockedUntil,
    retryAfterSeconds: seconds
  });
}

// ==================== تسجيل الدخول (بدون توثيق) ====================
router.post('/login', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const { username, password } = req.body;
    if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
      return res.status(400).json({ message: 'أدخل اسم المستخدم وكلمة المرور' });
    }

    const { data: user, error } = await supabase
      .from('users')
      .select('id, username, password, role, name, login_state:wolforder_login_attempts(failed_attempts, locked_until)')
      .eq('username', username)
      .maybeSingle();

    if (error) throw error;
    if (!user) {
      return res.status(400).json({ message: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
    }

    if (!ALLOWED_ROLES.has(user.role)) {
      return res.status(403).json({ message: 'نوع الحساب غير مصرح له بالدخول' });
    }

    const state = Array.isArray(user.login_state) ? user.login_state[0] : user.login_state;
    if (Date.parse(state?.locked_until) > Date.now()) return sendLoginLock(res, state.locked_until);

    const validPass = await bcrypt.compare(password, user.password);
    const { data: attempt, error: attemptError } = await supabase.rpc('record_wolforder_login_attempt', {
      p_user_id: user.id,
      p_expected_password_hash: user.password,
      p_success: validPass
    });
    if (attemptError) throw attemptError;
    if (attempt?.credentials_changed) {
      return res.status(409).json({ message: 'تغيّرت بيانات الحساب. يرجى إعادة المحاولة.' });
    }
    if (attempt?.locked_until) return sendLoginLock(res, attempt.locked_until);
    if (!validPass || !attempt?.allowed) {
      return res.status(400).json({ message: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
    }

    const loginRole = attempt.role || user.role;
    const token = jwt.sign(
      { id: user.id, role: loginRole, name: user.name },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      token,
      user: { id: user.id, username: user.username, role: loginRole, name: user.name }
    });
  } catch (err) {
    console.error('💥 Login exception:', err);
    res.status(503).json({ message: 'تعذر تسجيل الدخول حالياً. يرجى المحاولة لاحقاً.' });
  }
});

async function requireCurrentAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.sendStatus(403);
  try {
    const { data, error } = await supabase.from('users').select('id, role').eq('id', req.user.id).maybeSingle();
    if (error) throw error;
    if (data?.role !== 'admin') return res.sendStatus(403);
    next();
  } catch (error) {
    console.error('Password administration permission check failed:', error.message);
    res.status(500).json({ message: 'تعذر التحقق من صلاحية المدير' });
  }
}

router.get('/password-accounts', authenticateToken, requireCurrentAdmin, async (_req, res) => {
  try {
    const { data, error } = await supabase.from('users')
      .select('id, name, username, role')
      .in('role', [...REGISTER_ROLES])
      .order('name');
    if (error) throw error;
    res.set('Cache-Control', 'no-store');
    res.json(data || []);
  } catch (error) {
    console.error('Password accounts list failed:', error.message);
    res.status(500).json({ message: 'تعذر تحميل الحسابات' });
  }
});

router.patch('/users/:id/password', authenticateToken, requireCurrentAdmin, async (req, res) => {
  const { newPassword, confirmPassword } = req.body;
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(req.params.id)) {
    return res.status(400).json({ message: 'معرف الحساب غير صالح' });
  }
  if (typeof newPassword !== 'string' || newPassword.length < 6
      || Buffer.byteLength(newPassword, 'utf8') > 72) {
    return res.status(400).json({ message: 'استخدم كلمة مرور من 6 أحرف على الأقل وبطول مناسب' });
  }
  if (newPassword !== confirmPassword) {
    return res.status(400).json({ message: 'كلمتا المرور غير متطابقتين' });
  }
  try {
    const password = await bcrypt.hash(newPassword, 10);
    const { data, error } = await supabase.from('users')
      .update({ password })
      .eq('id', req.params.id)
      .in('role', [...REGISTER_ROLES])
      .select('id')
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ message: 'الحساب غير موجود' });
    res.set('Cache-Control', 'no-store');
    res.json({ message: 'تم تغيير كلمة المرور بنجاح' });
  } catch (error) {
    console.error('Password change failed:', error.message);
    res.status(500).json({ message: 'تعذر تغيير كلمة المرور' });
  }
});

// ==================== تسجيل مستخدم جديد (للمدير فقط) ====================
router.post('/register', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.sendStatus(403);
    const { username, password, role, name } = req.body;

    if (!username || !name || !password || password.length < 6 || !REGISTER_ROLES.has(role)) {
      return res.status(400).json({ message: 'بيانات المستخدم أو نوع الحساب غير صالح' });
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
    if (!['company', 'driver'].includes(req.user.role)) return res.sendStatus(403);
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
      .in('role', ['driver', 'company']);

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
