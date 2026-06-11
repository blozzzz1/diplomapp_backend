import { createClient, SupabaseClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error('Missing Supabase environment variables. Please check your .env file.');
}

// Verify that we're using Service Role Key (starts with 'eyJ' and is much longer than anon key)
if (!supabaseServiceRoleKey.startsWith('eyJ') || supabaseServiceRoleKey.length < 200) {
  console.warn('⚠️  WARNING: SUPABASE_SERVICE_ROLE_KEY might not be a valid Service Role Key.');
  console.warn('Service Role Key should be much longer than Anon Key.');
  console.warn('Please verify you are using the service_role key from Supabase Dashboard → Settings → API');
}

// Use service role key for backend operations
// Service Role Key should automatically bypass RLS policies
// If RLS is still enforced, we need to use auth.admin methods or direct SQL
export const supabaseAdmin: SupabaseClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
    detectSessionInUrl: false,
  },
  db: {
    schema: 'public',
  },
  global: {
    headers: {
      'x-client-info': 'backend-service',
      'apikey': supabaseServiceRoleKey,
    },
  },
});

// Regular client for user operations (not used in backend, but kept for consistency)
export const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

