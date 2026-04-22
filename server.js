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
    // جلب جميع السائقين مع حقل last_seen من Supabase
    const { data: drivers, error } = await supabase
      .from('users')
      .select('id, name, username, last_seen')
      .eq('role', 'driver');

    if (error) throw error;

    const now = new Date();
    const driversWithStatus = drivers.map(d => {
      let online = false;
      if (d.last_seen) {
        const lastSeen = new Date(d.last_seen);
        const diffSeconds = (now - lastSeen) / 1000;
        online = diffSeconds < 35; // يعتبر متصلاً إذا كان آخر نبض خلال 35 ثانية
      }
      return {
        _id: d.id,
        name: d.name,
        username: d.username,
        online: online
      };
    });

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