import { GoogleAuth } from 'google-auth-library';
import { readFileSync } from 'node:fs';

const keyFile = process.argv[2];
const hoursBack = parseInt(process.argv[3] || '24', 10);

if (!keyFile) {
  console.error('usage: node scripts/diag-read-metrics.mjs <path-to-service-account.json> [hoursBack]');
  process.exit(1);
}

const key = JSON.parse(readFileSync(keyFile, 'utf8'));
const project = key.project_id;

const auth = new GoogleAuth({
  keyFile,
  scopes: ['https://www.googleapis.com/auth/monitoring.read']
});

const end = new Date();
const start = new Date(end.getTime() - hoursBack * 3600 * 1000);

async function series(client, metric, groupBy) {
  const params = new URLSearchParams();
  params.set('filter', `metric.type="${metric}"`);
  params.set('interval.startTime', start.toISOString());
  params.set('interval.endTime', end.toISOString());
  params.set('aggregation.alignmentPeriod', '3600s');
  params.set('aggregation.perSeriesAligner', 'ALIGN_SUM');
  params.set('aggregation.crossSeriesReducer', 'REDUCE_SUM');
  for (const g of groupBy) params.append('aggregation.groupByFields', g);

  const url = `https://monitoring.googleapis.com/v3/projects/${project}/timeSeries?${params}`;
  const res = await client.request({ url });
  return res.data.timeSeries || [];
}

function label(ts, groupBy) {
  const parts = [];
  for (const g of groupBy) {
    const short = g.split('.').pop();
    const v = (ts.metric && ts.metric.labels && ts.metric.labels[short]) ||
              (ts.resource && ts.resource.labels && ts.resource.labels[short]);
    if (v) parts.push(short + '=' + v);
  }
  return parts.join(' ') || '(all)';
}

function report(title, list, groupBy) {
  console.log('\n======== ' + title + ' ========');
  if (!list.length) { console.log('  no data returned'); return; }

  const byLabel = new Map();
  const byHour = new Map();
  for (const ts of list) {
    const lbl = label(ts, groupBy);
    let sum = 0;
    for (const p of ts.points || []) {
      const v = Number(p.value.int64Value ?? p.value.doubleValue ?? 0);
      sum += v;
      const hour = p.interval.endTime.slice(0, 13) + ':00Z';
      byHour.set(hour, (byHour.get(hour) || 0) + v);
    }
    byLabel.set(lbl, (byLabel.get(lbl) || 0) + sum);
  }

  console.log('-- totals by label over last ' + hoursBack + 'h --');
  for (const [k, v] of [...byLabel.entries()].sort((a, b) => b[1] - a[1])) {
    console.log('   ' + String(Math.round(v)).padStart(9) + '  ' + k);
  }

  console.log('-- hourly totals (UTC) --');
  const hours = [...byHour.entries()].sort();
  const max = Math.max(...hours.map((h) => h[1]), 1);
  for (const [h, v] of hours) {
    const bar = '#'.repeat(Math.round((v / max) * 45));
    console.log('   ' + h + ' ' + String(Math.round(v)).padStart(8) + ' ' + bar);
  }
  const grand = [...byLabel.values()].reduce((a, b) => a + b, 0);
  console.log('   GRAND TOTAL: ' + Math.round(grand));
}

const client = await auth.getClient();
console.log('project: ' + project);
console.log('window : ' + start.toISOString() + '  ->  ' + end.toISOString());

try {
  report('DOCUMENT READS  (firestore document/read_count)',
    await series(client, 'firestore.googleapis.com/document/read_count', ['metric.label.type']),
    ['metric.label.type']);
} catch (e) {
  console.log('read_count failed: ' + (e.response?.data?.error?.message || e.message));
}

try {
  report('API CALLS BY METHOD  (firestore api/request_count)',
    await series(client, 'firestore.googleapis.com/api/request_count', ['metric.label.api_method', 'metric.label.response_code']),
    ['metric.label.api_method', 'metric.label.response_code']);
} catch (e) {
  console.log('request_count failed: ' + (e.response?.data?.error?.message || e.message));
}

try {
  report('ACTIVE LISTENERS  (firestore network/active_connections)',
    await series(client, 'firestore.googleapis.com/network/active_connections', []),
    []);
} catch (e) {
  console.log('active_connections failed: ' + (e.response?.data?.error?.message || e.message));
}
