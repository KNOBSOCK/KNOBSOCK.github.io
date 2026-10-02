import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import nta from '../_shared/nyc-nta.geojson' with { type: 'json' };

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json; charset=utf-8'
};
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: cors });
const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

function constantTimeEqual(a: string, b: string) {
  const aa = new TextEncoder().encode(a), bb = new TextEncoder().encode(b);
  let diff = aa.length ^ bb.length;
  const len = Math.max(aa.length, bb.length);
  for (let i = 0; i < len; i++) diff |= (aa[i % (aa.length || 1)] || 0) ^ (bb[i % (bb.length || 1)] || 0);
  return diff === 0;
}
function authorized(req: Request) {
  const header = req.headers.get('authorization') || '';
  if (!header.startsWith('Basic ')) return false;
  let decoded = '';
  try { decoded = atob(header.slice(6)); } catch { return false; }
  const split = decoded.indexOf(':');
  if (split < 0) return false;
  const user = Deno.env.get('LOCATION_INGEST_USERNAME') || '';
  const pass = Deno.env.get('LOCATION_INGEST_PASSWORD') || '';
  return !!user && !!pass && constantTimeEqual(decoded.slice(0, split), user) && constantTimeEqual(decoded.slice(split + 1), pass);
}
function inRing(point: [number, number], ring: number[][]) {
  const [x, y] = point; let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (((yi > y) !== (yj > y)) && x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-20) + xi) inside = !inside;
  }
  return inside;
}
function pointInPolygon(point: [number, number], rings: number[][][]) {
  return inRing(point, rings[0]) && !rings.slice(1).some((ring) => inRing(point, ring));
}
function findArea(lon: number, lat: number) {
  for (const feature of nta.features) {
    const g = feature.geometry;
    const polygons = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
    if (polygons.some((rings) => pointInPolygon([lon, lat], rings))) return feature.properties;
  }
  return null;
}
function displayName(name: string) {
  return name.replace(/\s*\((East|West|North|South)\)$/i, '').replace(/-/g, '–');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method === 'GET') {
    const { data, error } = await db.from('stream_location').select('nta_code,neighborhood,borough,updated_at').eq('id', 1).maybeSingle();
    if (error) return json({ error: 'Location is not configured.' }, 503);
    if (!data?.updated_at) return json({ neighborhood: null, borough: null, updatedAt: null });
    if (Date.now() - Date.parse(data.updated_at) > 15 * 60 * 1000) {
      await db.from('stream_location').delete().eq('id', 1);
      return json({ neighborhood: null, borough: null, updatedAt: null });
    }
    return json({ ntaCode: data.nta_code, neighborhood: data.neighborhood, borough: data.borough, updatedAt: data.updated_at });
  }
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
  if (!authorized(req)) return json({ error: 'Unauthorized.' }, 401);

  let payload: Record<string, unknown>;
  try { payload = await req.json(); } catch { return json({ error: 'Invalid JSON.' }, 400); }
  const lat = Number(payload.lat), lon = Number(payload.lon), accuracy = Number(payload.acc ?? payload.accuracy ?? 0);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < 40.45 || lat > 41.05 || lon < -74.3 || lon > -73.65) return json({ error: 'Location is outside the NYC service area.' }, 422);
  if (accuracy > 3000) return json({ error: 'Location is too imprecise to identify a neighborhood.' }, 422);
  const area = findArea(lon, lat);
  if (!area) return json({ error: 'No neighborhood boundary matched.' }, 422);
  const row = { id: 1, nta_code: area.nta2020, neighborhood: displayName(area.ntaname), borough: area.boroname, updated_at: new Date().toISOString() };
  const { error } = await db.from('stream_location').upsert(row, { onConflict: 'id' });
  if (error) return json({ error: 'Could not save the neighborhood.' }, 503);
  return json({ ok: true });
});
