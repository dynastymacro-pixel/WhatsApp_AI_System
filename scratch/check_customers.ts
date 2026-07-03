import { getSupabaseClient } from '../src/db/supabase';

async function run() {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('customers')
    .select('*')
    .limit(10);
  
  if (error) {
    console.error('Error fetching customers:', error);
    return;
  }
  
  console.log('=== CUSTOMERS ===');
  console.log(JSON.stringify(data, null, 2));
}

run();
