require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws'); // ✅ إضافة مكتبة WebSockets
const authenticateToken = require('./middleware/auth');
const supabase = require('./config/db'); // ✅ اتصال Supabase

const app = express();
const server = http.createServer(app);

// ============================================================
// ⭐ ⭐ ⭐ إعداد WebSockets للاتصال الفوري ⭐ ⭐ ⭐
// ============================================================
const wss = new WebSocket.Server({ server });

// دالة لبث الرسائل لجميع المتصلين
function broadcast(data) {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}

// إتاحة دالة البث لجميع ملفات الراوتر (مثل routes/orders.js)
app.set('broadcast', broadcast);

wss.on('connection', (ws) => {
  console.log('🔗 عميل جديد متصل بلوحة التحكم عبر WebSocket');
});
// ============================================================

app.use(express.json());

// إجبار المتصفح على فحص نسخة Service Worker الجديدة عند كل زيارة.
app.use((req, res, next) => {
  if (req.path === '/sw.js') {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.set('Service-Worker-Allowed', '/');
  }
  next();
});

app.use(express.static('public'));

// ✅ تعطيل Socket.IO مؤقتاً
// const io = socketIo(server);
// app.set('io', io);
// const onlineUsers = new Map();

console.log('✅ Supabase client initialized');

// ✅ مسارات API
app.use('/api/auth', require('./routes/auth'));
app.use('/api/orders', require('./routes/orders'));
app.use('/api/edit-requests', require('./routes/editRequests'));

// ✅ مسار السائقين المتصلين (معدل لـ Supabase)
app.get('/api/online-drivers', authenticateToken, async (req, res) => {
  if (req.user.role !== 'admin') return res.sendStatus(403);
  try {
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
        online = diffSeconds < 35;
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

// ============================================================
// ⭐ ⭐ ⭐ مسار إرسال رسائل واتساب عبر منصة راسل (Rasel) ⭐ ⭐ ⭐
// ============================================================
app.post('/api/send-whatsapp', authenticateToken, async (req, res) => {
  // 1. استقبال البيانات من الواجهة الأمامية
  const { phone, customerName, orderNumber, orderContents, currency, price, companyName, message } = req.body;

  // ====== معالجة الرقم ======
  console.log(`📞 الرقم الخام المستلم: ${phone}`);

  // 1. حذف كل ما ليس رقماً
  let clean = phone ? phone.replace(/\D/g, '') : '';
  console.log(`📞 بعد حذف الأحرف: ${clean}`);

  // 2. التحقق من وجود الرقم
  if (!phone) {
    return res.status(400).json({ success: false, error: 'رقم الهاتف مطلوب' });
  }

  // 3. التحقق من الطول
  if (clean.length < 9) {
    console.error(`❌ رقم غير صالح: ${phone} (الطول: ${clean.length})`);
    return res.status(400).json({ success: false, error: `رقم الهاتف غير صالح (يجب أن يكون 9 أرقام على الأقل)` });
  }

  // 4. إذا بدأ بصفر، احذفه
  if (clean.startsWith('0')) {
    clean = clean.substring(1);
  }

  // 5. إذا كان طوله 9 أرقام، أضف رمز الدولة 963
  if (clean.length === 9) {
    clean = '963' + clean;
  }

  // 6. إذا كان طوله 10 أرقام لكن لا يبدأ بـ 963، أضف 963
  if (clean.length === 10 && !clean.startsWith('963')) {
    clean = '963' + clean;
  }

  // 7. تأكد من أنه يبدأ بـ 963 (للتأكد)
  if (!clean.startsWith('963')) {
    clean = '963' + clean;
  }

  // 8. أضف + في البداية (تنسيق دولي)
  const finalPhone = `+${clean}`;
  console.log(`📞 الرقم النهائي المرسل إلى راسل: ${finalPhone}`);

  // ====== التحقق من مفتاح API ======
  const API_KEY = process.env.RASEL_API_KEY;
  if (!API_KEY) {
    console.error('❌ RASEL_API_KEY غير موجود في ملف .env');
    return res.status(500).json({ success: false, error: 'مفتاح API غير موجود في السيرفر' });
  }

  // ====== عنوان API الخاص بمنصة راسل ======
  const API_URL = 'https://raselsms.com/api/v2/messages/send';

  // ====== القناة (اختر whatsapp أو local_sms حسب احتياجك) ======
  const CHANNEL = 'whatsapp';

  // ====== بناء نص الرسالة ======
  let messageText = message;
  if (!messageText) {
    messageText = `مرحبًا ${customerName || 'عميل'}
يسعدنا إعلامك بأن طلبك رقم : ${orderNumber || 'N/A'} سيصل اليوم
وسيتم التواصل معكم من قبل كابتن التوصيل
محتويات الطلب : ${orderContents || ''}
سعر الطلب بلا اجور توصيل : ${currency || 'ل.س'} ${price || '0'}
يرجى إبقاء الهاتف متاحًا لتسهيل التواصل
شكرًا لتسوقك من ${companyName || 'متجرنا'}
علما ان اجور التوصيل 
ضمن دمشق 20.000 الف
خارج دمشق 40.000 الف
للاستفسار او الشكاوى على (خدمة التوصيل)
التواصل على الرقم 0997665442
يسعدنا خدمتكم 

WolfOrder`;
  }

  // ====== دالة إرسال الطلب مع إعادة المحاولة التلقائية ======
  async function sendWithRetry(retries = 3, delay = 30000) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        console.log(`📤 محاولة ${attempt} من ${retries} - جاري الإرسال إلى ${finalPhone}...`);

        const response = await fetch(API_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-API-Key': API_KEY,
          },
          body: JSON.stringify({
            to: finalPhone,
            channel: CHANNEL,
            messageType: 'free_text',
            content: { text: messageText }
          })
        });

        const rawResponse = await response.text();
        console.log(`📩 محاولة ${attempt} - الرد الخام من راسل:`, rawResponse);

        if (response.status === 502 || response.status === 504 || response.status === 500) {
          console.log(`⚠️ خطأ ${response.status} - إعادة المحاولة بعد ${delay/1000} ثانية...`);
          if (attempt < retries) {
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          }
        }

        let data;
        try {
          data = JSON.parse(rawResponse);
        } catch (e) {
          return { success: false, error: `استجابة غير متوقعة: ${rawResponse.substring(0, 100)}...` };
        }

        if (response.ok && (data.status === 'success' || data.status === 'sent' || data.status === 'queued')) {
          return { success: true, data };
        } else {
          const errorMsg = data.message || data.error || data.status || 'فشل الإرسال';
          return { success: false, error: errorMsg };
        }

      } catch (error) {
        console.error(`❌ محاولة ${attempt} - خطأ في الاتصال:`, error.message);
        if (attempt === retries) {
          return { success: false, error: error.message };
        }
        console.log(`⏳ انتظار ${delay/1000} ثانية قبل إعادة المحاولة...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    return { success: false, error: 'فشل الإرسال بعد عدة محاولات' };
  }

  const result = await sendWithRetry(3, 30000);

  if (result.success) {
    res.json({ success: true, data: result.data });
  } else {
    console.error('❌ فشل الإرسال النهائي:', result.error);
    res.status(500).json({ success: false, error: result.error });
  }
});

// ============================================================
// الصفحة الرئيسية
// ============================================================
app.get('/', (req, res) => res.redirect('/login.html'));

// ============================================================
// تشغيل السيرفر
// ============================================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on http://0.0.0.0:${PORT}`);
});
