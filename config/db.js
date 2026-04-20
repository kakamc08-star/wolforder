const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

console.log('🔧 SUPABASE_URL:', supabaseUrl);
console.log('🔧 SUPABASE_KEY (first 10 chars):', supabaseKey?.substring(0, 10) + '...');

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ Missing Supabase URL or Key');
  process.exit(1);
}

// خيارات إضافية لتحسين الاتصال مع Render
const options = {
  auth: {
    persistSession: false,
  },
  global: {
    headers: {
      Authorization: `Bearer ${supabaseKey}`,
    },
  },
  // إجبار استخدام IPv4
  fetch: (url, init) => {
    // نضبط خيارات الطلب لتفضيل IPv4
    return fetch(url, { ...init, family: 4 });
  },
};

const supabase = createClient(supabaseUrl, supabaseKey, options);

// اختبار الاتصال فورًا
(async () => {
  try {
    const { data, error } = await supabase.from('users').select('count', { count: 'exact', head: true });
    if (error) {
      console.error('❌ Supabase connection test failed:', error);
    } else {
      console.log('✅ Supabase connection test successful');
    }
  } catch (err) {
    console.error('❌ Supabase connection test exception:', err.message);
  }
})();

module.exports = supabase;