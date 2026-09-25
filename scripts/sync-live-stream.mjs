#!/usr/bin/env node
/**
 * Keeps chat_config/liveVideo pointed at the current Bunny live stream
 * without anyone having to paste a new link into admin.html by hand.
 *
 * Bunny's "KNOBSOCK LIVE" Stream library forces a brand new live stream
 * (new GUID, new RTMP stream key) to be created manually before every
 * broadcast — there's no way to keep reusing one. This script polls that
 * library, finds whichever video object is newest, and if it isn't the
 * one already saved, archives the outgoing link into chat_config/vods
 * (it keeps working as a rewatchable recording once superseded — see
 * admin.html's archivePreviousLiveLinkAsVod, which does the same thing
 * for a manual paste) and writes the new one in.
 *
 * The manifest URL shape for a Bunny LIVE stream is NOT the same as a
 * VOD's — it's <host>/live/<guid>/live.m3u8, not <host>/<guid>/playlist.m3u8
 * (confirmed by watching Bunny's own embed player's real network requests
 * while genuinely live; see the "Fix: Bunny live streams use a different
 * manifest path than VOD" commit). BUNNY_LIBRARY_ID/BUNNY_CDN_HOST below
 * must stay in sync with BUNNY_LIBRARY_HOSTS in admin.html if either ever
 * changes.
 *
 * Run by .github/workflows/sync-live-stream.yml on a schedule.
 *
 * Requires two environment variables:
 *   GOOGLE_APPLICATION_CREDENTIALS_JSON — full JSON of a Firebase service
 *     account key (Project Settings -> Service Accounts). This repo
 *     already has one saved as the FIREBASE_SERVICE_ACCOUNT_KEY secret
 *     for purge-expired-ip-logs.mjs — reuse the same secret.
 *   BUNNY_STREAM_API_KEY — the KNOBSOCK LIVE library's own API key (its
 *     dashboard page in Bunny shows this, or `ApiKey`/`ReadOnlyApiKey`
 *     from `GET /videolibrary/762310` with an account-level key; this
 *     script only reads, so the read-only one is enough). Add it as a
 *     new repo secret named BUNNY_STREAM_API_KEY.
 *
 * Usage:
 *   node scripts/sync-live-stream.mjs              # sync, report
 *   node scripts/sync-live-stream.mjs --dry-run    # report only, write nothing
 */

import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const DRY_RUN = process.argv.includes("--dry-run");

const BUNNY_LIBRARY_ID = "762310";
const BUNNY_CDN_HOST = "vz-168e0ecf-c9d.b-cdn.net";

const keyJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
if (!keyJson) {
  throw new Error(
    "GOOGLE_APPLICATION_CREDENTIALS_JSON is not set — see this file's own header comment."
  );
}
const bunnyApiKey = process.env.BUNNY_STREAM_API_KEY;
if (!bunnyApiKey) {
  throw new Error(
    "BUNNY_STREAM_API_KEY is not set — see this file's own header comment."
  );
}

initializeApp({ credential: cert(JSON.parse(keyJson)) });
const db = getFirestore();

function liveUrlFor(guid) {
  return `https://${BUNNY_CDN_HOST}/live/${guid}/live.m3u8`;
}

async function fetchNewestVideo() {
  const res = await fetch(
    `https://video.bunnycdn.com/library/${BUNNY_LIBRARY_ID}/videos?page=1&itemsPerPage=5&orderBy=date`,
    { headers: { AccessKey: bunnyApiKey, Accept: "application/json" } }
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Bunny video list request failed: HTTP ${res.status} ${body.slice(0, 300)}`
    );
  }
  const data = await res.json();
  const items = Array.isArray(data.items) ? data.items : Array.isArray(data) ? data : [];
  if (!items.length) return null;
  items.sort(
    (a, b) => new Date(b.dateUploaded).getTime() - new Date(a.dateUploaded).getTime()
  );
  return items[0];
}

async function main() {
  const newest = await fetchNewestVideo();
  if (!newest || !newest.guid) {
    console.log("No live stream found in the library — nothing to sync.");
    return;
  }

  const newUrl = liveUrlFor(newest.guid);
  const liveRef = db.collection("chat_config").doc("liveVideo");
  const liveSnap = await liveRef.get();
  const liveData = liveSnap.exists ? liveSnap.data() : null;
  const previousUrl = liveData && liveData.directUrl ? liveData.directUrl : null;

  if (previousUrl === newUrl) {
    console.log(`Already up to date (${newUrl}).`);
    return;
  }

  console.log(
    `${DRY_RUN ? "[dry run] " : ""}New live stream detected: ${previousUrl || "(none saved yet)"} -> ${newUrl}`
  );

  if (DRY_RUN) return;

  if (previousUrl) {
    const vodsRef = db.collection("chat_config").doc("vods");
    const vodsSnap = await vodsRef.get();
    const items = vodsSnap.exists && Array.isArray(vodsSnap.data().items)
      ? vodsSnap.data().items
      : [];
    const alreadyArchived = items.some((v) => v.url === previousUrl);
    if (!alreadyArchived) {
      const aspect = liveData && liveData.aspect === "9:16" ? "9:16" : "16:9";
      const archived = {
        url: previousUrl,
        title: `Past Live Stream — ${new Date().toLocaleDateString("en-US")}`,
        thumb: "",
        aspect,
        addedAt: Date.now(),
      };
      await vodsRef.set(
        {
          items: [archived, ...items],
          updatedAt: new Date(),
          updatedBy: "sync-live-stream.mjs",
        },
        { merge: true }
      );
      console.log(`Archived previous live link into Past Streams: ${previousUrl}`);
    }
  }

  await liveRef.set({ directUrl: newUrl, videoId: null }, { merge: true });
  console.log(`Saved new live link: ${newUrl}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
