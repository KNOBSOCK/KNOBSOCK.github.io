#!/usr/bin/env node
/**
 * WordPress -> static article pages.
 *
 * Pulls every published post from the WordPress.com public REST API and
 * writes one real, self-contained HTML file per post at
 * truth/article/<slug>/index.html — the same markup truth/article.html
 * renders client-side, except baked in at build time so the URL is a
 * genuine page (real <title>, real OG tags, works with JS off, previews
 * properly when shared).
 *
 * Run by .github/workflows/sync-articles.yml on a schedule. Reads only
 * public data, so there are no credentials involved.
 *
 * WHY THERE IS A MANIFEST
 * ----------------------
 * _manifest.json records what this script generated last time (slug ->
 * post id + WordPress's own `modified` timestamp). Without it the script
 * could only ever add: an API response tells you what exists NOW, never
 * what used to exist, so a deleted or unpublished post would leave its
 * page orphaned on the site forever. Diffing against the manifest is
 * what makes deletes and slug renames work, and it's also what keeps
 * unchanged posts from being rewritten every run — otherwise every
 * hourly run would rewrite all N files and bury the repo history.
 *
 * Usage:
 *   node scripts/build-articles.mjs              # fetch, write, report
 *   node scripts/build-articles.mjs --dry-run    # report only, touch nothing
 *   WP_FIXTURE=file.json node scripts/build-articles.mjs   # use saved data
 */

import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------
const SITE = "knobsock4.wordpress.com";
const API_BASE = `https://public-api.wordpress.com/rest/v1.1/sites/${SITE}`;

/* Where the generated pages go, relative to the repo root. Updated to
   truth/article now that the Truth Zone has moved to knobsock.net/truth
   — every page regenerates at the new path on the next run. */
const OUT_DIR = "truth/article";

/* Used for canonical + OG URLs, which have to be absolute. Changed at
   the same time as OUT_DIR for the same domain move. */
const SITE_ORIGIN = "https://knobsock.net";

const HOME_URL = "https://knobsock.net/truth/";
const LOGO_URL =
  "https://raw.githubusercontent.com/KNOBSOCK/KNOBSOCK.github.io/refs/heads/main/SIX_23C00EE8-DE7A-43B0-AE17-4BDA7C3DA392.png";
const BG_VIDEO_URL =
  "https://onuniverse-assets.imgix.net/487354D6-DD76-4A92-9846-20C085F6252C.mp4";

/* Same placeholder truth/article.html uses, but with its single quotes
   percent-encoded as %27. The raw version is written with '...' around
   every SVG attribute, and this string gets inlined into an onerror="..."
   handler below — the first bare quote closed the JS string early and
   the whole handler died with a syntax error. %27 is equivalent inside
   a data URI and has no quote to trip over. */
const NO_IMAGE_PLACEHOLDER =
  "data:image/svg+xml,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20width=%27900%27%20height=%27500%27%3E%3Crect%20width=%27100%25%27%20height=%27100%25%27%20fill=%27%23222%27/%3E%3Ctext%20x=%2750%25%27%20y=%2750%25%27%20fill=%27%2339ff14%27%20font-family=%27sans-serif%27%20font-size=%2728%27%20text-anchor=%27middle%27%20dominant-baseline=%27middle%27%3ENo%20Image%3C/text%3E%3C/svg%3E";

/* Bump this whenever renderPage() below changes in a way that should
   reach pages already on disk — a style fix, new meta tags, changed
   markup.

   Without it a template change silently never ships: the skip check
   below only asks whether WordPress's `modified` moved, so an untouched
   post keeps whatever HTML it was first built with, forever. The
   manifest records the version each run built with, and a mismatch
   forces a full rebuild of every article exactly once. */
const TEMPLATE_VERSION = 4;

const MANIFEST_PATH = path.join(OUT_DIR, "_manifest.json");
const PER_PAGE = 100;
const DRY_RUN = process.argv.includes("--dry-run");

// ---------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------

/** Escape for use in text nodes and double-quoted attributes. */
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

/** Strip tags to plain text — for meta descriptions and photo credits. */
function toText(html) {
  return String(html ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(s, n) {
  if (s.length <= n) return s;
  return s.slice(0, n - 1).trimEnd() + "…";
}

/* Formatted here rather than with toLocaleDateString() in the browser
   like truth/article.html does, because a static page has no browser at build
   time. Pinned to en-US so the output is identical no matter which
   runner builds it — otherwise the runner's locale would show up as a
   spurious diff on every file. */
function formatDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "";
  return d.toLocaleDateString("en-US", {
    year: "numeric", month: "numeric", day: "numeric", timeZone: "UTC",
  });
}

function getCategoryName(post) {
  const cats = post.categories;
  if (!cats) return "";
  const first = Object.keys(cats)[0];
  return first ? cats[first].name : "";
}

/* A slug becomes a directory name, so anything that could escape the
   output directory (".." , "/", a leading dot) has to be refused rather
   than sanitized — a silently rewritten slug would generate a page at a
   URL that nothing links to. */
function isSafeSlug(slug) {
  return typeof slug === "string" && /^[a-zA-Z0-9._-]+$/.test(slug) &&
    slug !== "." && slug !== ".." && !slug.startsWith(".");
}

// ---------------------------------------------------------------
// FETCH
// ---------------------------------------------------------------
async function fetchAllPosts() {
  if (process.env.WP_FIXTURE) {
    const raw = await readFile(process.env.WP_FIXTURE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : parsed.posts || [];
  }

  const all = [];
  for (let page = 1; page <= 50; page++) {
    const url = `${API_BASE}/posts/?number=${PER_PAGE}&page=${page}&status=publish`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`WordPress API returned ${res.status} for page ${page}`);
    }
    const data = await res.json();
    const posts = data.posts || [];
    all.push(...posts);
    if (posts.length < PER_PAGE) break;
  }
  return all;
}

// ---------------------------------------------------------------
// PAGE TEMPLATE
// ---------------------------------------------------------------
function renderPage(post) {
  const slug = post.slug;
  const canonical = `${SITE_ORIGIN}/${OUT_DIR}/${slug}/`;
  const title = toText(post.title) || "Untitled";
  const image = post.featured_image || "";
  const category = getCategoryName(post);
  const author = (post.author && post.author.name) || "";
  const credit = toText(post.excerpt || "");
  const description = truncate(credit || title, 200);
  const dateText = formatDate(post.date);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)} &mdash; Knobsock</title>
<meta name="theme-color" content="#0a0e2a">
<meta name="color-scheme" content="dark">
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:type" content="article">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:site_name" content="KNOBSOCK">
<meta property="og:description" content="${esc(description)}">
${image ? `<meta property="og:image" content="${esc(image)}">` : ""}
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
${image ? `<meta name="twitter:image" content="${esc(image)}">` : ""}
<!-- Generated by scripts/build-articles.mjs from ${esc(SITE)} — do not
     edit by hand, the next sync will overwrite it. Edit the post in
     WordPress instead. -->
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  /* The fallback color goes on html ONLY, never on body. An opaque body
     background paints OVER the fixed video behind it: a z-index:-1
     element paints beneath block-level backgrounds, so body's own
     background hid the video everywhere except the strip below body's
     box, where its collapsed bottom margin left a gap. html's background
     is propagated to the canvas instead, which paints under everything. */
  html {
    background: #0a0e2a;
  }
  html, body {
    color-scheme: dark;
    scrollbar-width: none;
    -ms-overflow-style: none;
  }
  html::-webkit-scrollbar, body::-webkit-scrollbar { display: none; }
  body {
    font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
    color: #fff;
    min-height: 100vh;
  }
  .bg-video { position: fixed; inset: 0; width: 100%; height: 100%; object-fit: cover; z-index: -1; }
  h1, h2, h3 { color: yellow; }
  a { text-decoration: none; color: inherit; }

  .site-header { display: flex; justify-content: center; align-items: center; padding: 20px 0; }
  .site-header img { display: block; max-height: 90px; max-width: 100%; width: auto; height: auto; }

  .page-wrapper {
    width: calc(100% - 24px);
    max-width: 820px;
    margin: 0 auto 40px;
    padding: 28px clamp(18px, 5vw, 44px) 40px;
    background: rgba(0, 19, 156, 0.5);
    backdrop-filter: blur(16px) saturate(150%);
    -webkit-backdrop-filter: blur(16px) saturate(150%);
    border-radius: 28px;
  }

  .back-link { display: inline-block; margin-bottom: 24px; color: #fff; font-size: 14px; opacity: 0.85; }
  .back-link:hover { opacity: 1; }

  .cat-tag {
    display: inline-block;
    background: #333;
    color: #fff;
    font-size: 12px;
    padding: 4px 10px;
    border-radius: 4px;
    margin-bottom: 14px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .article-header {
    padding-bottom: 24px;
    margin-bottom: 28px;
    border-bottom: 2px solid rgba(255, 80, 80, 0.45);
  }
  .article-header h1 { font-size: clamp(28px, 5vw, 42px); margin-bottom: 12px; line-height: 1.15; }
  .meta { color: #fff; font-size: 14px; opacity: 0.75; }

  .article-hero {
    padding-bottom: 28px;
    margin-bottom: 28px;
    border-bottom: 1px solid rgba(255, 80, 80, 0.3);
  }
  .article-hero img { width: 100%; height: auto; border-radius: 12px; display: block; }
  .photo-credit { color: #fff; font-size: 11px; opacity: 0.6; letter-spacing: 0.2px; margin-top: 6px; }

  .body-content { font-size: 17px; line-height: 1.8; color: #fff; }
  .body-content p { margin-bottom: 20px; }
  .body-content img { max-width: 100%; height: auto; border-radius: 12px; margin: 20px 0; display: block; }
  .body-content h2, .body-content h3 { margin: 28px 0 12px; line-height: 1.3; }
  .body-content iframe { max-width: 100%; }

  .share-bar {
    margin-top: 40px;
    padding-top: 24px;
    border-top: 1px solid rgba(255,255,255,0.15);
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }
  .share-bar span.label { font-size: 14px; color: #fff; }
  .share-bar button {
    background: #fff;
    color: #111;
    border: none;
    padding: 10px 18px;
    border-radius: 12px;
    font-size: 14px;
    cursor: pointer;
    font-weight: 600;
  }
  .share-bar button:hover { background: #ddd; }
  .share-bar .copied-msg { font-size: 13px; color: #4ade80; display: none; }

  .bottom-actions {
    margin-top: 24px;
    padding-top: 24px;
    border-top: 1px solid rgba(255,255,255,0.15);
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: 16px;
  }
  .wp-link { color: #fff; font-size: 14px; }
  .back-btn {
    display: inline-block;
    background: transparent;
    color: #fff;
    border: 1px solid rgba(255,255,255,0.3);
    padding: 10px 18px;
    border-radius: 12px;
    font-size: 14px;
  }
  .back-btn:hover { background: rgba(255,255,255,0.1); }
</style>
</head>
<body>
  <video class="bg-video" autoplay muted loop playsinline aria-hidden="true">
    <source src="${esc(BG_VIDEO_URL)}" type="video/mp4">
  </video>
  <header class="site-header">
    <a href="${esc(HOME_URL)}">
      <img src="${esc(LOGO_URL)}" alt="Knobsock">
    </a>
  </header>

  <div class="page-wrapper">
    <a class="back-link" href="${esc(HOME_URL)}">&larr; Back to Truth Zone</a>
    <main>
      <div class="article-header">
        ${category ? `<span class="cat-tag">${esc(category)}</span>` : ""}
        <h1>${esc(title)}</h1>
        <div class="meta">${author ? `By ${esc(author)} &middot; ` : ""}<time datetime="${esc(post.date)}">${esc(dateText)}</time></div>
      </div>
      <div class="article-hero">
        <img src="${esc(image || NO_IMAGE_PLACEHOLDER)}" alt=""
             onerror="this.onerror=null;this.src='${NO_IMAGE_PLACEHOLDER}';">
        ${credit ? `<div class="photo-credit">${esc(credit)}</div>` : ""}
      </div>
      <div class="body-content">${post.content || ""}</div>
      <div class="share-bar">
        <span class="label">Share this article:</span>
        <button id="copy-link-btn">Copy Link</button>
        <span class="copied-msg" id="copied-msg">Link copied!</span>
      </div>
      <div class="bottom-actions">
        <a href="${esc(post.URL || "#")}" target="_blank" rel="noopener" class="wp-link">View original post &rarr;</a>
        <a class="back-btn" href="${esc(HOME_URL)}">&larr; Back to Truth Zone</a>
      </div>
    </main>
  </div>

<script>
  // The page's own URL is the share URL now — no ?slug= to reconstruct.
  document.getElementById("copy-link-btn").addEventListener("click", function () {
    var url = window.location.href;
    navigator.clipboard.writeText(url).then(function () {
      var msg = document.getElementById("copied-msg");
      msg.style.display = "inline";
      setTimeout(function () { msg.style.display = "none"; }, 2000);
    }).catch(function () {
      alert("Couldn't copy automatically \\u2014 link: " + url);
    });
  });
</script>
</body>
</html>
`;
}

// ---------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------
async function main() {
  const posts = await fetchAllPosts();

  let manifest = {};
  let builtWithVersion = null;
  if (existsSync(MANIFEST_PATH)) {
    try {
      const parsed = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
      manifest = parsed.articles || {};
      builtWithVersion = parsed.templateVersion ?? null;
    } catch {
      console.warn("Manifest unreadable — treating every post as new.");
    }
  }
  const templateChanged = builtWithVersion !== TEMPLATE_VERSION;
  if (templateChanged && Object.keys(manifest).length) {
    console.log(
      `Template version ${builtWithVersion} -> ${TEMPLATE_VERSION}: rebuilding every article.`
    );
  }

  /* Safety rail. An API hiccup that returns an empty list is
     indistinguishable from "the author deleted every post", and the
     delete pass below would happily wipe the whole archive and commit
     it. Refuse instead: a sync that does nothing is recoverable, one
     that deletes everything is a restore-from-history job. */
  if (posts.length === 0 && Object.keys(manifest).length > 0) {
    throw new Error(
      `API returned 0 posts but the manifest has ${Object.keys(manifest).length}. ` +
      `Refusing to delete every article — assuming a transient API failure.`
    );
  }

  const created = [], updated = [], deleted = [], skipped = [], rejected = [];
  const nextManifest = {};

  for (const post of posts) {
    const slug = post.slug;
    if (!isSafeSlug(slug)) {
      rejected.push(String(slug));
      continue;
    }

    const prev = manifest[slug];
    const isNew = !prev;
    // WordPress bumps `modified` on any edit, so it's the whole change
    // check — no need to diff rendered output.
    const changed = prev && prev.modified !== post.modified;

    nextManifest[slug] = { id: post.ID, modified: post.modified, title: toText(post.title) };

    const dir = path.join(OUT_DIR, slug);
    const file = path.join(dir, "index.html");

    if (!isNew && !changed && !templateChanged && existsSync(file)) {
      skipped.push(slug);
      continue;
    }

    if (!DRY_RUN) {
      await mkdir(dir, { recursive: true });
      await writeFile(file, renderPage(post), "utf8");
    }
    (isNew ? created : updated).push(slug);
  }

  // Anything the manifest knows about that the API no longer returns has
  // been deleted, unpublished, or had its slug changed — its page has to
  // go, or it stays live forever with no way back to it.
  for (const slug of Object.keys(manifest)) {
    if (nextManifest[slug]) continue;
    const dir = path.join(OUT_DIR, slug);
    if (existsSync(dir) && !DRY_RUN) {
      await rm(dir, { recursive: true, force: true });
    }
    deleted.push(slug);
  }

  if (!DRY_RUN) {
    await mkdir(OUT_DIR, { recursive: true });
    await writeFile(
      MANIFEST_PATH,
      JSON.stringify(
        {
          _comment:
            "Generated by scripts/build-articles.mjs. Records what was " +
            "built last run so deletes and updates can be detected. Do not edit.",
          site: SITE,
          templateVersion: TEMPLATE_VERSION,
          generated: new Date().toISOString(),
          count: Object.keys(nextManifest).length,
          articles: nextManifest,
        },
        null,
        2
      ) + "\n",
      "utf8"
    );
  }

  const line = (label, arr) =>
    arr.length ? `  ${label}: ${arr.length} (${arr.slice(0, 8).join(", ")}${arr.length > 8 ? ", …" : ""})` : `  ${label}: 0`;

  console.log(`${DRY_RUN ? "[dry run] " : ""}Synced ${posts.length} post(s) from ${SITE}`);
  console.log(line("created", created));
  console.log(line("updated", updated));
  console.log(line("deleted", deleted));
  console.log(line("unchanged", skipped));
  if (rejected.length) console.log(line("REJECTED (unsafe slug)", rejected));

  const changedCount = created.length + updated.length + deleted.length;
  console.log(`${DRY_RUN ? "[dry run] " : ""}${changedCount} change(s).`);
}

main().catch((err) => {
  console.error("Article sync failed:", err.message);
  process.exit(1);
});
