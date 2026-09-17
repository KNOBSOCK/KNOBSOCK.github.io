import admin from 'firebase-admin';
import { readFileSync } from 'node:fs';

const keyFile = process.argv[2];
if (!keyFile) {
  console.error('usage: node scripts/diag-firestore-inventory.mjs <path-to-service-account.json>');
  process.exit(1);
}

const key = JSON.parse(readFileSync(keyFile, 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(key) });
const db = admin.firestore();

const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();

console.log('project: ' + key.project_id);
console.log('NOTE: count() aggregations bill 1 read per 1000 matched docs, so this is cheap.\n');

const cols = await db.listCollections();
console.log('======== COLLECTION SIZES ========');
const sizes = [];
for (const col of cols) {
  try {
    const snap = await col.count().get();
    const n = snap.data().count;
    sizes.push([col.id, n]);
  } catch (e) {
    sizes.push([col.id, 'ERR ' + e.message.slice(0, 40)]);
  }
}
sizes.sort((a, b) => (typeof b[1] === 'number' ? b[1] : 0) - (typeof a[1] === 'number' ? a[1] : 0));
for (const [id, n] of sizes) console.log('   ' + String(n).padStart(9) + '  ' + id);

console.log('\n======== RECENT ACTIVITY (is anyone actually on the site?) ========');

async function countWhere(colId, field, op, value, tag) {
  try {
    const snap = await db.collection(colId).where(field, op, value).count().get();
    console.log('   ' + String(snap.data().count).padStart(9) + '  ' + colId + ' ' + tag);
  } catch (e) {
    console.log('   [skip] ' + colId + ' ' + tag + ': ' + e.message.slice(0, 80));
  }
}

await countWhere('chat_presence', 'lastSeen', '>', now - 10 * 60 * 1000, 'seen in last 10 min');
await countWhere('chat_presence', 'lastSeen', '>', now - 60 * 60 * 1000, 'seen in last hour');
await countWhere('chat_presence', 'lastSeen', '>', now - DAY, 'seen in last 24h');
await countWhere('chat_messages', 'ts', '>', now - DAY, 'messages in last 24h');
await countWhere('chat_devices', 'lastTapInAt', '>', now - DAY, 'tap-ins in last 24h');

console.log('\n======== NEWEST chat_presence ROWS ========');
try {
  const snap = await db.collection('chat_presence').orderBy('lastSeen', 'desc').limit(15).get();
  for (const d of snap.docs) {
    const ls = d.data().lastSeen;
    const agoMin = Math.round((now - ls) / 60000);
    console.log('   ' + d.id.slice(0, 20).padEnd(22) + ' lastSeen ' + agoMin + ' min ago');
  }
} catch (e) {
  console.log('   failed: ' + e.message.slice(0, 120));
}

console.log('\n======== chat_ip_log RECENT ========');
try {
  const snap = await db.collection('chat_ip_log').orderBy('ts', 'desc').limit(10).get();
  console.log('   newest ' + snap.size + ' rows:');
  for (const d of snap.docs) {
    const t = d.data().ts;
    console.log('     ' + new Date(t).toISOString() + '  ' + Math.round((now - t) / 60000) + ' min ago');
  }
} catch (e) {
  console.log('   (no ts index/field, skipping): ' + e.message.slice(0, 100));
}

process.exit(0);
