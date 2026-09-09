#!/usr/bin/env node
/**
 * Firestore -> static per-video permalink pages, for Hamburger News.
 *
 * Same idea as build-articles.mjs, but the source is Firestore instead of
 * WordPress, read via the Admin SDK (same service-account access
 * purge-expired-ip-logs.mjs already uses — bypasses Firestore rules
 * entirely, see firestore.rules).
 *
 * playlist/hamburgerNews.videos[] and playlist/hamburgerGames.games[]
 * don't carry a stable per-item id today — this script is what assigns
 * one. On every run, any item missing an `id` gets a random one
 * generated and written back to Firestore, so the same run both
 * backfills every existing episode/game once and keeps handling new ones
 * the admin adds later. Nothing else about those documents is touched.
 *
 * For every item that has an id, writes
 * videos/hamburgernews/v/<id>/index.html: a small static page with real
 * <title>/OG tags (so link previews work) whose body just redirects into
 * videos/hamburgernews.html?v=<id>, which resolves the id back to the
 * matching episode/game and starts it playing.
 *
 * WHY THERE IS A MANIFEST
 * ----------------------
 * Firestore items have no equivalent of WordPress's `modified` timestamp
 * to diff against, so the manifest itself is the "did this change" check
 * here — it stores the exact title/url/thumb an id's page was last built
 * with. It's also what makes deletes work: a video removed from Firestore
 * disappears from what we fetch, but its page would otherwise stay on
 * disk forever with no signal that it should go.
 *
 * Run by .github/workflows/sync-permalink-pages.yml on a schedule.
 *
 * Usage:
 *   node scripts/build-permalink-pages.mjs              # sync, report
 *   node scripts/build-permalink-pages.mjs --dry-run    # report only
 *
 * Requires GOOGLE_APPLICATION_CREDENTIALS_JSON in the environment — see
 * purge-expired-ip-logs.mjs's own header comment for how to get one.
 */

import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const DRY_RUN = process.argv.includes("--dry-run");

const SITE_ORIGIN = "https://knobsock.net";
const OUT_DIR = "videos/hamburgernews/v";
const MANIFEST_PATH = path.join(OUT_DIR, "_manifest.json");
const TEMPLATE_VERSION = 1;

// ---------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function newId() {
  return randomBytes(6).toString("hex");
}

function isSafeId(id) {
  return typeof id === "string" && /^[a-z0-9]{6,32}$/.test(id);
}

// Ported from videos/hamburgernews.html's own extractVideoId/thumbForUrl
// so the OG image matches what the page itself would show.
function extractVideoId(input) {
  if (!input) return null;
  const t = String(input).trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(t)) return t;
  const m = t.match(/(?:youtube\.com\/watch\?v=|youtube\.com\/embed\/|youtube\.com\/shorts\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}

function thumbForUrl(url) {
  const id = extractVideoId(url);
  if (id) return `https://img.youtube.com/vi/${id}/mqdefault.jpg`;
  const m = String(url || "").match(/^(https?:\/\/.+\/)playlist\.m3u8(\?.*)?$/i);
  return m ? `${m[1]}thumbnail.jpg` : "";
}

// ---------------------------------------------------------------
// FIRESTORE
// ---------------------------------------------------------------

function authedFirestore() {
  const keyJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (!keyJson) {
    throw new Error(
      "GOOGLE_APPLICATION_CREDENTIALS_JSON is not set — see this file's own header comment."
    );
  }
  initializeApp({ credential: cert(JSON.parse(keyJson)) });
  return getFirestore();
}

/**
 * Ensures every item in `list` has an `id`, generating+persisting new
 * ones where missing. Returns the (possibly updated) list; writes back
 * to `docRef`'s `field` only if anything actually changed.
 */
async function ensureIds(docRef, field, list) {
  const seen = new Set(list.map((v) => v.id).filter(Boolean));
  let changed = false;
  const next = list.map((v) => {
    if (v.id && isSafeId(v.id)) return v;
    let id = newId();
    while (seen.has(id)) id = newId();
    seen.add(id);
    changed = true;
    return { ...v, id };
  });
  if (changed && !DRY_RUN) {
    await docRef.set({ [field]: next }, { merge: true });
  }
  return next;
}

// ---------------------------------------------------------------
// PAGE TEMPLATE
// ---------------------------------------------------------------

function renderPage(item) {
  const canonical = `${SITE_ORIGIN}/${OUT_DIR}/${item.id}/`;
  const redirectTo = `/videos/hamburgernews.html?v=${item.id}`;
  const title = item.title || "Hamburger News";
  const image = item.thumb || "";
  const description = `Watch "${title}" — Hamburger News with Joe Medina, on KNOBSOCK.`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)} &mdash; Hamburger News &mdash; KNOBSOCK</title>
<meta name="theme-color" content="#000000">
<meta name="color-scheme" content="dark">
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:site_name" content="KNOBSOCK">
<meta property="og:description" content="${esc(description)}">
${image ? `<meta property="og:image" content="${esc(image)}">` : ""}
<meta name="twitter:card" content="${image ? "summary_large_image" : "summary"}">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
${image ? `<meta name="twitter:image" content="${esc(image)}">` : ""}
<meta http-equiv="refresh" content="0; url=${esc(redirectTo)}">
<!-- Generated by scripts/build-permalink-pages.mjs — do not edit by
     hand, the next sync will overwrite it. -->
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { background: #000; color-scheme: dark; height: 100%; }
  body {
    font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
    color: #fff;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    text-align: center;
    padding: 24px;
  }
  a { color: #ffd479; }
</style>
<script>location.replace(${JSON.stringify(redirectTo)});</script>
</head>
<body>
  <noscript>
    <p>${esc(title)} &mdash; <a href="${esc(redirectTo)}">Watch on Hamburger News</a></p>
  </noscript>
</body>
</html>
`;
}

// ---------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------

async function main() {
  const db = authedFirestore();

  const newsRef = db.collection("playlist").doc("hamburgerNews");
  const gamesRef = db.collection("playlist").doc("hamburgerGames");

  const [newsDoc, gamesDoc] = await Promise.all([newsRef.get(), gamesRef.get()]);
  const rawVideos = newsDoc.exists && Array.isArray(newsDoc.data().videos) ? newsDoc.data().videos : [];
  const rawGames = gamesDoc.exists && Array.isArray(gamesDoc.data().games) ? gamesDoc.data().games : [];

  const videos = await ensureIds(newsRef, "videos", rawVideos);
  const games = await ensureIds(gamesRef, "games", rawGames);

  const items = [
    ...videos.map((v) => ({
      id: v.id,
      title: (v.title || "").trim() || "Episode",
      url: v.url || "",
      thumb: (v.thumb || "").trim() || thumbForUrl(v.url),
    })),
    ...games.filter((g) => g && g.url).map((g) => ({
      id: g.id,
      title: (g.title || "").trim() || "Game",
      url: g.url,
      thumb: (g.thumb || "").trim(),
    })),
  ].filter((it) => isSafeId(it.id));

  let manifest = {};
  let builtWithVersion = null;
  if (existsSync(MANIFEST_PATH)) {
    try {
      const parsed = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
      manifest = parsed.items || {};
      builtWithVersion = parsed.templateVersion ?? null;
    } catch {
      console.warn("Manifest unreadable — treating every item as new.");
    }
  }
  const templateChanged = builtWithVersion !== TEMPLATE_VERSION;

  const created = [], updated = [], deleted = [], skipped = [];
  const nextManifest = {};

  for (const item of items) {
    const prev = manifest[item.id];
    const isNew = !prev;
    const changed = prev && (prev.title !== item.title || prev.url !== item.url || prev.thumb !== item.thumb);

    nextManifest[item.id] = { title: item.title, url: item.url, thumb: item.thumb };

    const dir = path.join(OUT_DIR, item.id);
    const file = path.join(dir, "index.html");

    if (!isNew && !changed && !templateChanged && existsSync(file)) {
      skipped.push(item.id);
      continue;
    }

    if (!DRY_RUN) {
      await mkdir(dir, { recursive: true });
      await writeFile(file, renderPage(item), "utf8");
    }
    (isNew ? created : updated).push(item.id);
  }

  for (const id of Object.keys(manifest)) {
    if (nextManifest[id]) continue;
    const dir = path.join(OUT_DIR, id);
    if (existsSync(dir) && !DRY_RUN) {
      await rm(dir, { recursive: true, force: true });
    }
    deleted.push(id);
  }

  if (!DRY_RUN) {
    await mkdir(OUT_DIR, { recursive: true });
    await writeFile(
      MANIFEST_PATH,
      JSON.stringify(
        {
          _comment:
            "Generated by scripts/build-permalink-pages.mjs. Records what was " +
            "built last run so deletes and updates can be detected. Do not edit.",
          templateVersion: TEMPLATE_VERSION,
          generated: new Date().toISOString(),
          count: Object.keys(nextManifest).length,
          items: nextManifest,
        },
        null,
        2
      ) + "\n",
      "utf8"
    );
  }

  const line = (label, arr) =>
    arr.length ? `  ${label}: ${arr.length} (${arr.slice(0, 8).join(", ")}${arr.length > 8 ? ", …" : ""})` : `  ${label}: 0`;

  console.log(`${DRY_RUN ? "[dry run] " : ""}Synced ${items.length} Hamburger News item(s)`);
  console.log(line("created", created));
  console.log(line("updated", updated));
  console.log(line("deleted", deleted));
  console.log(line("unchanged", skipped));

  const changedCount = created.length + updated.length + deleted.length;
  console.log(`${DRY_RUN ? "[dry run] " : ""}${changedCount} change(s).`);
}

main().catch((err) => {
  console.error("Permalink page sync failed:", err.message);
  process.exit(1);
});
