const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY; // نستخدم مفتاح الخدمة للصلاحيات الكاملة

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ Supabase URL or Service Role Key is missing in .env file');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

module.exports = supabase;