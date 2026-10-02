import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import nta from '../_shared/nyc-nta.json' with { type: 'json' };

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json; charset=utf-8'
};
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: cors });
const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

function publishableKey() {
  const legacy = Deno.env.get('SUPABASE_ANON_KEY');
  if (legacy) return legacy;
  try {
    const keys = JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') || '{}') as Record<string, unknown>;
    return Object.values(keys).find((value): value is string => typeof value === 'string') || '';
  } catch {
    return '';
  }
}

function jwtPayload(authHeader: string) {
  try {
    const part = authHeader.replace(/^Bearer\s+/i, '').split('.')[1] || '';
    const decoded = atob(part.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((part.length + 3) % 4));
    return JSON.parse(decoded) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function authorized(req: Request) {
  const header = req.headers.get('authorization') || '';
  if (!/^Bearer\s+/i.test(header) || jwtPayload(header).aal !== 'aal2') return false;
  const key = publishableKey();
  if (!key) return false;
  try {
    const accessToken = header.replace(/^Bearer\s+/i, '').trim();
    const userClient = createClient(Deno.env.get('SUPABASE_URL')!, key, {
      global: { headers: { Authorization: header } }
    });
    const { data: { user }, error } = await userClient.auth.getUser(accessToken);
    if (error || !user?.email) return false;
    const admins = JSON.parse(Deno.env.get('KNOBSOCK_ADMINS') || '{}') as Record<string, unknown>;
    return typeof admins[user.email.trim().toLowerCase()] === 'string' && !!admins[user.email.trim().toLowerCase()];
  } catch {
    return false;
  }
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
function displayName(name: string, code: string) {
  if (code === 'MN0501') return 'Flatiron District';
  const simple = name.replace(/\s*\((East|West|North|South|Central)\)$/i, '').trim();
  if (simple.startsWith('Bedford-Stuyvesant')) return 'Bedford-Stuyvesant';
  if (code === 'BK0771') return 'Green-Wood Cemetery';
  return simple.split('-')[0].trim();
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
    const area = nta.features.find((feature) => feature.properties.nta2020 === data.nta_code);
    const neighborhood = area ? displayName(area.properties.ntaname, area.properties.nta2020) : data.neighborhood;
    return json({ ntaCode: data.nta_code, neighborhood, borough: data.borough, updatedAt: data.updated_at });
  }
  if (req.method !== 'POST' && req.method !== 'DELETE') return json({ error: 'Method not allowed.' }, 405);
  if (!await authorized(req)) return json({ error: 'A verified KNOBSOCK admin session is required.' }, 401);

  if (req.method === 'DELETE') {
    const { error } = await db.from('stream_location').delete().eq('id', 1);
    if (error) return json({ error: 'Could not clear the shared location.' }, 503);
    return json({ ok: true });
  }

  let payload: Record<string, unknown>;
  try { payload = await req.json(); } catch { return json({ error: 'Invalid JSON.' }, 400); }
  const lat = Number(payload.lat), lon = Number(payload.lon), accuracy = Number(payload.acc ?? payload.accuracy ?? 0);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < 40.45 || lat > 41.05 || lon < -74.3 || lon > -73.65) return json({ error: 'Location is outside the NYC service area.' }, 422);
  if (accuracy > 3000) return json({ error: 'Location is too imprecise to identify a neighborhood.' }, 422);
  const area = findArea(lon, lat);
  if (!area) return json({ error: 'No neighborhood boundary matched.' }, 422);
  const row = { id: 1, nta_code: area.nta2020, neighborhood: displayName(area.ntaname, area.nta2020), borough: area.boroname, updated_at: new Date().toISOString() };
  const { error } = await db.from('stream_location').upsert(row, { onConflict: 'id' });
  if (error) return json({ error: 'Could not save the neighborhood.' }, 503);
  return json({ ok: true });
});
