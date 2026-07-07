// scratch/check_clients_schema.ts
// One-shot script: query live Supabase for actual columns on the clients table.
// Run from project root: npx ts-node --project tsconfig.json scratch/check_clients_schema.ts
//
// NOTE: Never hardcode keys. All credentials loaded from .env via dotenv.

import * as dotenv from 'dotenv';
dotenv.config();

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env');
  process.exit(1);
}

async function main() {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/`, {
    headers: {
      'apikey': SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
    },
  });

  if (!res.ok) {
    console.error('Failed:', res.status, await res.text());
    process.exit(1);
  }

  const spec = await res.json() as any;
  const clientsDef = spec?.definitions?.clients;

  if (!clientsDef) {
    console.error('No "clients" definition found. Keys:', Object.keys(spec?.definitions ?? {}));
    process.exit(1);
  }

  console.log('\n=== ACTUAL COLUMNS ON clients (from live PostgREST OpenAPI) ===\n');
  const props = clientsDef.properties as Record<string, any>;
  const rows = Object.entries(props)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, def]) => ({
      column_name: name,
      type: def.format ?? def.type ?? '?',
      enum: def.enum ? def.enum.join(' | ') : '',
      default: def.default ?? '',
    }));

  console.table(rows);
  console.log(`\nTotal columns: ${rows.length}`);
}

main().catch(err => { console.error(err); process.exit(1); });
