import { createClient } from '@supabase/supabase-js';
import { config } from './config.js';

let client = null;

export function supabase() {
  if (!client) {
    if (!config.supabaseUrl || !config.supabaseKey) {
      throw new Error('Supabase 未配置:请设置 SUPABASE_URL 和 SUPABASE_SERVICE_ROLE_KEY');
    }
    client = createClient(config.supabaseUrl, config.supabaseKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}
