#!/usr/bin/env node
/**
 * Keeps chat_config/liveVideo pointed at the current Bunny live stream
 * without anyone having to paste a new link into admin.html by hand.
 *
 * Bunny's "KNOBSOCK LIVE" Stream library forces a brand new live stream
 * (new GUID, new RTMP stream key) to be created manually before every
 * broadcast — there's no way to keep reusing one. Live streams are NOT
 * part of the regular GET /library/{id}/videos listing (that's VOD
 * uploads only, hence VideoModel's Created/Uploaded/.../Finished status
 * enum never showing a "Live" state) — they live under their own
 * GET /library/{id}/live endpoint, confirmed directly against this
 * account. Each item there already carries a ready-made playbackUrlHls
 * (no need to hand-build <host>/live/<guid>/live.m3u8), and endedAt is
 * null for exactly as long as that stream is actually live.
 *
 * This script finds whichever entry has endedAt === null (if any), and
 * if its playbackUrlHls isn't the one already saved, archives the
 * outgoing link into chat_config/vods first — it keeps working as a
 * rewatchable recording once superseded, same as admin.html's
 * archivePreviousLiveLinkAsVod does for a manual paste — then writes
 * the new one in.
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
 *     repo secret named BUNNY_STREAM_API_KEY.
 *
 * Usage:
 *   node scripts/sync-live-stream.mjs              # sync, report
 *   node scripts/sync-live-stream.mjs --dry-run    # report only, write nothing
 */

import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const DRY_RUN = process.argv.includes("--dry-run");

const BUNNY_LIBRARY_ID = "762310";

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

// Never let a stream key reach a log line — it's a live-broadcast
// credential (whoever has it can push video as this channel).
function redact(item) {
  const { streamKey, rtmpOutputs, ingestEndpoints, ...safe } = item;
  return safe;
}

async function fetchActiveLiveStream() {
  const res = await fetch(
    `https://video.bunnycdn.com/library/${BUNNY_LIBRARY_ID}/live?page=1&itemsPerPage=100`,
    { headers: { AccessKey: bunnyApiKey, Accept: "application/json" } }
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Bunny live stream list request failed: HTTP ${res.status} ${body.slice(0, 300)}`
    );
  }
  const data = await res.json();
  const items = Array.isArray(data.items) ? data.items : [];
  const active = items.filter((v) => v.endedAt == null && v.playbackUrlHls);
  if (!active.length) return null;
  // Normally there's only ever one, but prefer the most recently started
  // if somehow more than one shows no endedAt yet.
  active.sort(
    (a, b) => new Date(b.startedAt || b.dateCreated).getTime() - new Date(a.startedAt || a.dateCreated).getTime()
  );
  return active[0];
}

async function main() {
  const active = await fetchActiveLiveStream();
  if (!active) {
    console.log("No currently-live Bunny stream — nothing to sync.");
    return;
  }
  console.log("Active live stream:", JSON.stringify(redact(active)));

  const newUrl = active.playbackUrlHls;
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
