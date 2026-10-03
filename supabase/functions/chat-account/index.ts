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

function serviceAccount(envName = 'FIREBASE_SERVICE_ACCOUNT') {
  const rawAccount = Deno.env.get(envName);
  if (!rawAccount) throw new Error('The Firebase service credential is not configured.');
  const account = JSON.parse(rawAccount) as { client_email: string; private_key: string };
  if (!account.client_email || !account.private_key) throw new Error('The Firebase service credential is invalid.');
  return account;
}

async function signServiceJwt(payload: Record<string, unknown>, account = serviceAccount()) {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(JSON.stringify({ iss: account.client_email, ...payload }));
  const unsigned = `${header}.${claims}`;
  const key = await crypto.subtle.importKey(
    'pkcs8', pemToBytes(account.private_key), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']
  );
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${base64url(new Uint8Array(signature))}`;
}

async function firebaseAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  const grant = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: await signServiceJwt({
      scope: 'https://www.googleapis.com/auth/datastore',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600
    })
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

const ADMIN_SESSION_MS = 12 * 60 * 60 * 1000;
const ADMIN_TOTP_FRESH_SECONDS = 10 * 60;

function totpVerifiedAt(authHeader: string) {
  const amr = jwtPayload(authHeader).amr;
  if (!Array.isArray(amr)) return 0;
  return amr.reduce((latest: number, entry: unknown) => {
    const claim = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {};
    return claim.method === 'totp' ? Math.max(latest, Number(claim.timestamp) || 0) : latest;
  }, 0);
}

function adminUidFor(email: string | undefined) {
  const raw = Deno.env.get('KNOBSOCK_ADMINS');
  if (!raw || !email) return null;
  try {
    const admins = JSON.parse(raw) as Record<string, string>;
    const uid = admins[email.trim().toLowerCase()];
    return typeof uid === 'string' && uid ? uid : null;
  } catch {
    return null;
  }
}

function jwtPayload(authHeader: string) {
  try {
    const part = authHeader.replace(/^Bearer\s+/i, '').split('.')[1] || '';
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((part.length + 3) % 4));
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function firebaseAdminToken(uid: string) {
  const now = Math.floor(Date.now() / 1000);
  const until = Date.now() + ADMIN_SESSION_MS;
  const customToken = (account: { client_email: string; private_key: string }) => signServiceJwt({
    sub: account.client_email,
    aud: 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',
    iat: now,
    exp: now + 3600,
    uid,
    claims: { admin2faUntil: until }
  }, account);
  const token = await customToken(serviceAccount());
  const liveToken = Deno.env.get('LIVE_FIREBASE_SERVICE_ACCOUNT')
    ? await customToken(serviceAccount('LIVE_FIREBASE_SERVICE_ACCOUNT'))
    : null;
  return { token, liveToken, until };
}

class InvalidProfile extends Error {}

function cleanText(value: unknown, max: number) {
  return String(value ?? '').trim().slice(0, max);
}

function cleanHex(value: unknown, fallback: string) {
  const hex = String(value ?? '');
  return /^#[0-9a-f]{6}$/i.test(hex) ? hex.toLowerCase() : fallback;
}

function cleanPhoto(value: unknown) {
  const photo = String(value ?? '');
  if (!photo) return '';
  if (photo.length > 60000 || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(photo)) {
    throw new InvalidProfile('That photo is too large or is not an image.');
  }
  return photo;
}

const SOUNDCLOUD_RESERVED_USERS = ['discover', 'search', 'stream', 'you', 'upload', 'charts', 'pages', 'settings', 'messages', 'notifications', 'people', 'tags', 'terms-of-use', 'mobile', 'imprint', 'jobs', 'popular', 'signin', 'logout', 'feed', 'player'];
const SOUNDCLOUD_RESERVED_PAGES = ['likes', 'tracks', 'reposts', 'popular-tracks', 'followers', 'following', 'comments', 'spotlight', 'toptracks', 'playlists'];
const SOUNDCLOUD_SLUG = /^[A-Za-z0-9_-]+$/;

function cleanSong(value: unknown) {
  let raw = String(value ?? '').trim();
  if (!raw) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = 'https://' + raw;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new InvalidProfile('That isn’t a SoundCloud link. Paste a link like soundcloud.com/artist/song.');
  }
  const host = url.hostname.toLowerCase();
  if (host === 'on.soundcloud.com' || host === 'soundcloud.app.goo.gl') {
    throw new InvalidProfile('Short share links (on.soundcloud.com/…) don’t work. Open the link in your browser and copy the full soundcloud.com/artist/song address instead.');
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') ||
      (host !== 'soundcloud.com' && host !== 'www.soundcloud.com' && host !== 'm.soundcloud.com')) {
    throw new InvalidProfile('That isn’t a SoundCloud link. Paste a link like soundcloud.com/artist/song.');
  }
  const parts = url.pathname.split('/').filter(Boolean);
  const page = String(parts[1] || '').toLowerCase();
  if (page === 'sets' || page === 'albums') {
    throw new InvalidProfile('That’s a playlist or album. Paste a link to a single song.');
  }
  if ((parts.length !== 2 && parts.length !== 3) ||
      !parts.slice(0, 2).every((part) => SOUNDCLOUD_SLUG.test(part)) ||
      (parts[2] && !/^s-[A-Za-z0-9]+$/.test(parts[2])) ||
      SOUNDCLOUD_RESERVED_USERS.includes(parts[0].toLowerCase()) ||
      SOUNDCLOUD_RESERVED_PAGES.includes(page)) {
    throw new InvalidProfile('That link doesn’t go to a song. Paste a link like soundcloud.com/artist/song.');
  }
  return 'https://soundcloud.com/' + parts.join('/');
}

const SOCIAL_LABELS: Record<string, string> = { instagram: 'Instagram', youtube: 'YouTube', tiktok: 'TikTok' };

function cleanSocial(kind: string, value: unknown) {
  let text = String(value ?? '').trim();
  if (!text) return '';
  text = text.replace(/^https?:\/\//i, '').replace(/^(www\.|m\.)/i, '');
  let cleaned: string | null = null;
  if (kind === 'instagram') {
    text = text.replace(/\/+$/, '');
    if (text.includes('/') && !/^instagram\.com\//i.test(text)) throw new InvalidProfile('That Instagram username or link doesn’t look right.');
    text = text.replace(/^instagram\.com\//i, '').replace(/^@/, '').split(/[/?#]/)[0];
    cleaned = /^[A-Za-z0-9._]{1,30}$/.test(text) ? text : null;
  } else if (kind === 'tiktok') {
    text = text.replace(/\/+$/, '');
    if (text.includes('/') && !/^tiktok\.com\//i.test(text)) throw new InvalidProfile('That TikTok username or link doesn’t look right.');
    text = text.replace(/^tiktok\.com\//i, '').replace(/^@/, '').split(/[/?#]/)[0];
    cleaned = /^[A-Za-z0-9._]{2,24}$/.test(text) ? text : null;
  } else if (kind === 'youtube') {
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)+\//i.test(text) && !/^youtube\.com\//i.test(text)) throw new InvalidProfile('That YouTube username or link doesn’t look right.');
    text = text.replace(/^youtube\.com\//i, '').split(/[?#]/)[0].replace(/\/+$/, '');
    if (/^@[A-Za-z0-9._-]{3,30}$/.test(text)) cleaned = text;
    else if (/^[A-Za-z0-9._-]{3,30}$/.test(text)) cleaned = '@' + text;
    else {
      const match = text.match(/^(channel\/UC[A-Za-z0-9_-]{22}|c\/[A-Za-z0-9._-]{1,100}|user\/[A-Za-z0-9._-]{1,100})$/);
      cleaned = match ? match[1] : null;
    }
  }
  if (cleaned === null) throw new InvalidProfile(`That ${SOCIAL_LABELS[kind] || 'social'} username or link doesn’t look right.`);
  return cleaned;
}

async function writeProfile(usernameKey: string, profile: Record<string, string | number>) {
  const fields: Record<string, unknown> = {};
  Object.entries(profile).forEach(([key, value]) => {
    fields[key] = typeof value === 'number' ? { integerValue: String(value) } : { stringValue: value };
  });
  await firestore(`chat_usernames/${encodeURIComponent(usernameKey)}?updateMask.fieldPaths=profile&currentDocument.exists=true`, {
    method: 'PATCH', body: JSON.stringify({ fields: { profile: { mapValue: { fields } } } })
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

    if (body.action === 'adminToken') {
      const uid = adminUidFor(user.email);
      if (!uid) return response({ error: 'This email is not an admin.', code: 'forbidden' }, 403);
      if (jwtPayload(authHeader).aal !== 'aal2') {
        return response({ error: 'Finish the authenticator code step first.', code: 'mfa-required' }, 403);
      }
      if (Date.now() / 1000 - totpVerifiedAt(authHeader) > ADMIN_TOTP_FRESH_SECONDS) {
        return response({ error: 'Enter a fresh authenticator code.', code: 'mfa-required' }, 403);
      }
      return response(await firebaseAdminToken(uid));
    }

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

    if (body.action === 'saveProfile') {
      const mapping = user.app_metadata?.knobsock_chat as { username?: string; usernameKey?: string } | undefined;
      if (!mapping?.username || !mapping.usernameKey) {
        return response({ error: 'Link your email to your username before editing your profile.', code: 'not-linked' }, 403);
      }
      if (String(body.username || '').trim().toLowerCase() !== mapping.usernameKey) {
        return response({ error: 'This email is linked to a different username.', code: 'forbidden' }, 403);
      }
      const input = (body.profile || {}) as Record<string, unknown>;
      let profile: Record<string, string | number>;
      try {
        profile = {
          photo: cleanPhoto(input.photo),
          favoriteColor: cleanText(input.favoriteColor, 30),
          song: cleanSong(input.song),
          about: cleanText(input.about, 4000),
          cardColor: cleanHex(input.cardColor, '#2a0a4a'),
          borderColor: cleanHex(input.borderColor, '#ffff00'),
          instagram: cleanSocial('instagram', input.instagram),
          youtube: cleanSocial('youtube', input.youtube),
          tiktok: cleanSocial('tiktok', input.tiktok),
          updatedAt: Date.now()
        };
      } catch (error) {
        if (error instanceof InvalidProfile) return response({ error: error.message, code: 'invalid' }, 400);
        throw error;
      }
      await writeProfile(mapping.usernameKey, profile);
      return response({ username: mapping.username, profile });
    }

    return response({ error: 'Unknown account action.' }, 400);
  } catch (error) {
    console.error(error);
    return response({ error: error instanceof Error ? error.message : 'Account service unavailable.' }, 500);
  }
});
