#!/usr/bin/env node
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const DRY_RUN = process.argv.includes("--dry-run");
const BUNNY_LIBRARY_ID = "762310";
const BUNNY = `https://video.bunnycdn.com/library/${BUNNY_LIBRARY_ID}/live`;
const SITE_ORIGIN = "https://knobsock.net/";
const TITLE = "KNOBSOCK Live!";
const LOCAL_SCRIPT_WINDOW_MS = 65 * 60 * 1000;
const LOOKBACK_MS = 3 * 24 * 60 * 60 * 1000;
const ARCHIVE_LOG_DOC = "chat_config/pastStreamsArchived";
const ARCHIVE_LOG_KEEP = 200;

const bunnyApiKey = process.env.BUNNY_STREAM_API_KEY;
if (!bunnyApiKey) throw new Error("BUNNY_STREAM_API_KEY is not set.");

async function bunny(path) {
  const res = await fetch(BUNNY + path, {
    headers: { AccessKey: bunnyApiKey, Accept: "application/json" },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Bunny GET ${path || "/"} returned ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

function bunnyDate(value) {
  if (!value) return null;
  const date = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : value + "Z");
  return Number.isNaN(date.getTime()) ? null : date;
}

async function playable(url) {
  try {
    const res = await fetch(url, { headers: { Referer: SITE_ORIGIN } });
    return res.ok;
  } catch {
    return false;
  }
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { Referer: SITE_ORIGIN } });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.text();
}

async function recordingTimeline(playlistUrl) {
  try {
    let text = await fetchText(playlistUrl);
    if (!/#EXTINF/.test(text)) {
      const variant = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith("#"));
      if (!variant) return null;
      text = await fetchText(new URL(variant, playlistUrl).href);
    }
    const anchors = [];
    const maxEpoch = Date.now() / 1000 + 86400;
    let position = 0, duration = 0, previous = null, discontinuity = false;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      if (line === "#EXT-X-DISCONTINUITY") { discontinuity = true; continue; }
      if (line.startsWith("#EXTINF:")) { duration = parseFloat(line.slice(8)) || 0; continue; }
      if (line.startsWith("#")) continue;
      const match = line.match(/-(\d{10})\.(?:m4s|ts)(?:[?#]|$)/);
      const number = match ? Number(match[1]) : NaN;
      if (!(number > 1500000000 && number < maxEpoch)) return null;
      if (previous === null || discontinuity || number !== previous + 1) {
        anchors.push({ v: Math.round(position * 1000) / 1000, t: number * 1000 });
      }
      previous = number;
      discontinuity = false;
      position += duration;
    }
    return anchors.length && anchors.length <= 500 ? anchors : null;
  } catch (err) {
    console.log(`Could not read recording timestamps from ${playlistUrl}: ${err.message}`);
    return null;
  }
}

async function recentEndedStreams() {
  const data = await bunny("?page=1&itemsPerPage=100");
  const items = data && Array.isArray(data.items) ? data.items : [];
  const now = Date.now();
  return items.filter((item) => {
    const ended = bunnyDate(item.endedAt);
    if (!item.guid || !ended) return false;
    const age = now - ended.getTime();
    return age >= LOCAL_SCRIPT_WINDOW_MS && age <= LOOKBACK_MS;
  });
}

async function finishedRecording(guid) {
  const play = await bunny(`/${guid}/play`);
  if (!play) return null;
  const live = play.liveStream || {};
  if (!live.endedAt || !play.videoPlaylistUrl) return null;
  if (!(await playable(play.videoPlaylistUrl))) return null;
  return {
    guid,
    url: play.videoPlaylistUrl,
    thumb: play.thumbnailUrl || live.thumbnailUrl || "",
    startedAt: bunnyDate(live.startedAt || live.dateCreated),
    vertical: Number(live.height) > Number(live.width),
    timeline: await recordingTimeline(play.videoPlaylistUrl),
  };
}

async function main() {
  const candidates = await recentEndedStreams();
  if (!candidates.length) {
    console.log("No streams ended between 65 minutes and 3 days ago. Nothing to check.");
    return;
  }

  const ready = [];
  for (const stream of candidates) {
    const rec = await finishedRecording(stream.guid);
    if (rec) ready.push(rec);
    else console.log(`Stream ${stream.guid} is still processing.`);
  }
  if (!ready.length) return;

  const keyJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (!keyJson) throw new Error("GOOGLE_APPLICATION_CREDENTIALS_JSON is not set.");
  initializeApp({ credential: cert(JSON.parse(keyJson)) });
  const db = getFirestore();
  const logRef = db.doc(ARCHIVE_LOG_DOC);
  const vodsRef = db.doc("chat_config/vods");

  await db.runTransaction(async (tx) => {
    const logSnap = await tx.get(logRef);
    const guids = logSnap.exists && Array.isArray(logSnap.data().guids)
      ? logSnap.data().guids.map(String)
      : [];
    const todo = ready.filter((rec) => !guids.includes(rec.guid));
    if (!todo.length) {
      console.log("Every finished stream is already in Past Streams.");
      return;
    }

    const vodsSnap = await tx.get(vodsRef);
    const items = vodsSnap.exists && Array.isArray(vodsSnap.data().items)
      ? vodsSnap.data().items.slice()
      : [];
    let added = 0;
    for (const rec of todo) {
      const present = items.some((v) => String(v.url || "").toLowerCase().includes(rec.guid.toLowerCase()));
      if (present) {
        console.log(`Stream ${rec.guid} is already in Past Streams; recording it in the log.`);
        continue;
      }
      items.unshift({
        url: rec.url,
        title: TITLE,
        thumb: rec.thumb,
        aspect: rec.vertical ? "9:16" : "16:9",
        addedAt: (rec.startedAt || new Date()).getTime(),
        guid: rec.guid,
        ...(rec.timeline ? { timeline: rec.timeline, startedAt: rec.timeline[0].t } : rec.startedAt ? { startedAt: rec.startedAt.getTime() } : {}),
      });
      added += 1;
      console.log(`${DRY_RUN ? "[dry run] Would save" : "Saving"} ${rec.guid} to Past Streams: ${rec.url}`);
    }

    if (DRY_RUN) return;
    if (added) {
      tx.set(vodsRef, { items, updatedAt: new Date(), updatedBy: "archive-past-streams.mjs" }, { merge: true });
    }
    const nextGuids = guids
      .filter((g) => !todo.some((rec) => rec.guid === g))
      .concat(todo.map((rec) => rec.guid))
      .slice(-ARCHIVE_LOG_KEEP);
    tx.set(logRef, { guids: nextGuids, updatedAt: new Date() }, { merge: true });
  });
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
