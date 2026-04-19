require('dotenv').config();
const express = require('express');
const http = require('http');
const authenticateToken = require('./middleware/auth');
const supabase = require('./config/db'); // ✅ اتصال Supabase

const app = express();
const server = http.createServer(app);

app.use(express.json());
app.use(express.static('public'));

// ✅ تعطيل Socket.IO مؤقتاً (سنعيده لاحقاً مع Supabase Realtime)
// const io = socketIo(server);
// app.set('io', io);
// const onlineUsers = new Map();

console.log('✅ Supabase client initialized');

// ✅ مسارات API
app.use('/api/auth', require('./routes/auth'));
app.use('/api/orders', require('./routes/orders'));
app.use('/api/edit-requests', require('./routes/editRequests')); // سيحتاج لتحويل لاحقاً

// ✅ مسار السائقين المتصلين (معدل لـ Supabase)
app.get('/api/online-drivers', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') return res.sendStatus(403);
  try {
    // جلب جميع السائقين من Supabase
    const { data: drivers, error } = await supabase
      .from('users')
      .select('id, name, username')
      .eq('role', 'driver');

    if (error) throw error;

    // حالياً لا يوجد تتبع للاتصال (onlineUsers)، لذا نجعل الكل offline
    const driversWithStatus = drivers.map(d => ({
      ...d,
      online: false // يمكنك لاحقاً إضافة تتبع الاتصال عبر جدول presence
    }));

    res.json(driversWithStatus);
  } catch (err) {
    console.error('online-drivers error:', err);
    res.status(500).json({ message: err.message });
  }
});

app.get('/', (req, res) => res.redirect('/login.html'));

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on http://0.0.0.0:${PORT}`);
});