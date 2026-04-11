// One-shot env probe — verifies the Phase 2 vars made it into
// .env.local without printing any secret values. Run with:
//   node scripts/check-env.mjs
import { config } from 'dotenv';
config({ path: '.env.local' });

const need = [
  'PITCH_RECEIVE_ADDRESS',
  'PITCH_MIN_SATS',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'BSV_PRIVATE_KEY',
  'BSV_LEECHER_KEY',
];

let missing = 0;
for (const key of need) {
  const v = process.env[key];
  if (!v) {
    console.log(`  ✗ ${key.padEnd(28)} MISSING`);
    missing++;
  } else if (key.endsWith('KEY') || key.endsWith('WIF')) {
    console.log(`  ✓ ${key.padEnd(28)} set (${v.length} chars)`);
  } else {
    console.log(`  ✓ ${key.padEnd(28)} ${v}`);
  }
}

console.log('');
if (missing === 0) {
  console.log('All required env vars present.');
} else {
  console.log(`${missing} var(s) missing — add them to .env.local before launching the swarm.`);
  process.exit(1);
}
