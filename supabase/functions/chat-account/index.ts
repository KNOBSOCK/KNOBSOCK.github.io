import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  // The function requires a valid Supabase bearer token; allowing the local
  // preview origin here lets the same flow be tested before it is published.
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Content-Type': 'application/json'
};
const FIREBASE_PROJECT_ID = 'chat-for-website-efee2';

function response(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders });
}

function field(document: Record<string, unknown>, name: string) {
  const fields = document.fields as Record<string, Record<string, unknown>> | undefined;
  const value = fields && fields[name];
  return value && (value.stringValue ?? value.timestampValue);
}

function validClientId(value: unknown) {
  const clientId = String(value || '').trim();
  if (!/^c_[a-z0-9_-]{8,120}$/i.test(clientId) && !/^[0-9a-f-]{36}$/i.test(clientId)) {
    throw new Error('Invalid browser identity.');
  }
  return clientId;
}

function validUsername(value: unknown) {
  const username = String(value || '').trim();
  if (!username || username.length > 24 || /\s/.test(username)) throw new Error('Invalid chat username.');
  return { username, usernameKey: username.toLowerCase() };
}

function defaultKey(legacyName: string, dictionaryName: string) {
  const legacy = Deno.env.get(legacyName);
  if (legacy) return legacy;
  const dictionary = Deno.env.get(dictionaryName);
  if (!dictionary) return '';
  try {
    const values = Object.values(JSON.parse(dictionary) as Record<string, unknown>);
    return values.find((value): value is string => typeof value === 'string') || '';
  } catch {
    return '';
  }
}

function base64url(value: Uint8Array | string) {
  const binary = typeof value === 'string'
    ? new TextEncoder().encode(value)
    : value;
  let text = '';
  binary.forEach((byte) => { text += String.fromCharCode(byte); });
  return btoa(text).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function pemToBytes(pem: string) {
  const encoded = pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, '');
  const raw = atob(encoded);
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

async function firebaseAccessToken() {
  const rawAccount = Deno.env.get('FIREBASE_SERVICE_ACCOUNT');
  if (!rawAccount) throw new Error('The Firebase service credential is not configured.');
  const account = JSON.parse(rawAccount) as { client_email: string; private_key: string };
  if (!account.client_email || !account.private_key) throw new Error('The Firebase service credential is invalid.');

  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(JSON.stringify({
    iss: account.client_email,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  }));
  const unsigned = `${header}.${claims}`;
  const key = await crypto.subtle.importKey(
    'pkcs8', pemToBytes(account.private_key), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']
  );
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  const grant = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: `${unsigned}.${base64url(new Uint8Array(signature))}`
  });
  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body: grant });
  if (!tokenResponse.ok) throw new Error('Could not authenticate with Firestore.');
  return (await tokenResponse.json()).access_token as string;
}

async function firestore(path: string, init: RequestInit = {}) {
  const token = await firebaseAccessToken();
  const result = await fetch(
    `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/${path}`,
    { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) } }
  );
  if (!result.ok) throw new Error('Could not verify the browser username with Firestore.');
  return result.status === 204 ? null : await result.json();
}

async function writeDevice(clientId: string, fields: Record<string, unknown>) {
  const firestoreFields: Record<string, unknown> = {};
  Object.entries(fields).forEach(([key, value]) => {
    firestoreFields[key] = key.endsWith('At')
      ? { timestampValue: value }
      : { stringValue: value };
  });
  const mask = Object.keys(fields).map((key) => `updateMask.fieldPaths=${encodeURIComponent(key)}`).join('&');
  await firestore(`chat_devices/${encodeURIComponent(clientId)}?${mask}`, {
    method: 'PATCH', body: JSON.stringify({ fields: firestoreFields })
  });
}

async function clearDeviceFields(clientId: string, names: string[]) {
  const mask = names.map((name) => `updateMask.fieldPaths=${encodeURIComponent(name)}`).join('&');
  await firestore(`chat_devices/${encodeURIComponent(clientId)}?${mask}`, {
    method: 'PATCH', body: JSON.stringify({ fields: {} })
  });
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return response({ error: 'Method not allowed.' }, 405);

  try {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader) return response({ error: 'Sign in first.', code: 'unauthenticated' }, 401);
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const publishableKey = defaultKey('SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEYS');
    const serviceRoleKey = defaultKey('SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEYS');
    const userClient = createClient(supabaseUrl, publishableKey, { global: { headers: { Authorization: authHeader } } });
    const { data: { user }, error: userError } = await userClient.auth.getUser();
    if (userError || !user) return response({ error: 'Sign in first.', code: 'unauthenticated' }, 401);
    if (!serviceRoleKey) throw new Error('Supabase service role is not configured.');
    const admin = createClient(supabaseUrl, serviceRoleKey);
    const body = await request.json();
    const clientId = validClientId(body.clientId);

    if (body.action === 'link') {
      const { username, usernameKey } = validUsername(body.username);
      const [device, usernameDoc] = await Promise.all([
        firestore(`chat_devices/${encodeURIComponent(clientId)}`),
        firestore(`chat_usernames/${encodeURIComponent(usernameKey)}`)
      ]);
      if (String(field(device, 'username') || '').toLowerCase() !== usernameKey ||
          String(field(usernameDoc, 'username') || '').toLowerCase() !== usernameKey) {
        return response({ error: 'This browser does not own that username.', code: 'forbidden' }, 403);
      }

      const linked = user.app_metadata?.knobsock_chat as { username?: string; usernameKey?: string } | undefined;
      if (linked?.usernameKey && linked.usernameKey !== usernameKey) {
        return response({ error: 'This email is already linked to another username.', code: 'already-exists' }, 409);
      }
      if (!linked?.usernameKey) {
        const { error: updateError } = await admin.auth.admin.updateUserById(user.id, {
          app_metadata: { ...user.app_metadata, knobsock_chat: { username, usernameKey, linkedAt: new Date().toISOString() } }
        });
        if (updateError) throw updateError;
      }
      await writeDevice(clientId, { accountId: user.id, accountLinkedAt: new Date().toISOString() });
      return response({ username });
    }

    if (body.action === 'restore') {
      const mapping = user.app_metadata?.knobsock_chat as { username?: string; usernameKey?: string } | undefined;
      if (!mapping?.username || !mapping.usernameKey) {
        return response({ error: 'No KNOBSOCK username is linked to this email yet.', code: 'not-found' }, 404);
      }
      await writeDevice(clientId, {
        username: mapping.username,
        accountId: user.id,
        restoredAt: new Date().toISOString(),
        claimedAt: new Date().toISOString()
      });
      return response({ username: mapping.username, usernameKey: mapping.usernameKey });
    }

    if (body.action === 'signout') {
      const device = await firestore(`chat_devices/${encodeURIComponent(clientId)}`);
      if (field(device, 'accountId') !== user.id) {
        return response({ error: 'This browser is not signed in to that account.', code: 'forbidden' }, 403);
      }
      await clearDeviceFields(clientId, ['username', 'accountId', 'accountLinkedAt', 'restoredAt']);
      return response({ ok: true });
    }

    return response({ error: 'Unknown account action.' }, 400);
  } catch (error) {
    console.error(error);
    return response({ error: error instanceof Error ? error.message : 'Account service unavailable.' }, 500);
  }
});
