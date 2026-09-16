#!/usr/bin/env node
/**
 * Deletes chat_presence documents nobody has heartbeat in a week.
 *
 * chat_presence holds one tiny { lastSeen } document per device that has
 * opened /live — written once a minute by the presence block at the
 * bottom of livestream-chat-widget.html, and counted (never listed) by
 * that block and by chat-monitor-widget.html through a Firestore
 * count() aggregation. Because the document id is derived from the
 * device's own stable chat_client_id, a returning viewer overwrites
 * their own row rather than adding a new one, so this collection grows
 * by distinct devices rather than by page loads — slowly enough that
 * this script is hygiene, not a load-bearing part of the viewer count.
 *
 * It exists because no browser should be deleting other people's rows.
 * The previous implementation had every connected viewer scan the whole
 * collection and delete anything stale, which turned one abandoned row
 * into one billed delete per viewer watching at that moment. Cleanup
 * belongs somewhere trusted and singular, which is here.
 *
 * Nothing breaks if this never runs: a stale row is already excluded
 * from the count by the lastSeen window both widgets query with. The
 * first run does have a real backlog to clear, though — every random-id
 * row the old one-document-per-page-load scheme left behind.
 *
 * Run by .github/workflows/purge-ip-logs.yml on a daily schedule.
 *
 * Usage:
 *   node scripts/purge-stale-presence.mjs              # delete, report
 *   node scripts/purge-stale-presence.mjs --dry-run    # report only
 *
 * Requires GOOGLE_APPLICATION_CREDENTIALS_JSON in the environment, the
 * same service account key purge-expired-ip-logs.mjs uses.
 */

import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const DRY_RUN = process.argv.includes("--dry-run");
const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

const keyJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
if (!keyJson) {
  throw new Error(
    "GOOGLE_APPLICATION_CREDENTIALS_JSON is not set — see this file's own header comment."
  );
}

initializeApp({ credential: cert(JSON.parse(keyJson)) });
const db = getFirestore();

async function main() {
  // lastSeen is plain epoch millis written by the browser, not a
  // Firestore timestamp, so the cutoff is a number too. select() with
  // no fields fetches keys only — every row here is going to be deleted
  // anyway, so there is nothing worth reading out of it.
  const snapshot = await db
    .collection("chat_presence")
    .where("lastSeen", "<", Date.now() - STALE_AFTER_MS)
    .select()
    .get();

  if (snapshot.empty) {
    console.log(`${DRY_RUN ? "[dry run] " : ""}No stale chat_presence documents.`);
    return;
  }

  console.log(
    `${DRY_RUN ? "[dry run] " : ""}Found ${snapshot.size} stale document(s).`
  );

  if (DRY_RUN) {
    snapshot.docs.forEach((doc) => console.log(`  would delete: ${doc.id}`));
    return;
  }

  // Firestore batches cap at 500 writes (same chunking as
  // purge-expired-ip-logs.mjs — unlike that one, the limit really is
  // reachable on this script's first run).
  const refs = snapshot.docs.map((doc) => doc.ref);
  for (let i = 0; i < refs.length; i += 450) {
    const batch = db.batch();
    refs.slice(i, i + 450).forEach((ref) => batch.delete(ref));
    await batch.commit();
  }

  console.log(`Deleted ${refs.length} stale document(s).`);
}

main().catch((err) => {
  console.error("Presence purge failed:", err.message);
  process.exit(1);
});
