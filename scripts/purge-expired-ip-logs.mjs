#!/usr/bin/env node
/**
 * Deletes chat_ip_log documents past their own expiresAt.
 *
 * chat_ip_log holds a salted hash of a chat visitor's IP plus an
 * expiresAt timestamp — set 90 days out at write time by
 * logIpBestEffort() in livestream-chat-widget.html, matching what
 * privacy.html's Live Chat section promises. admin.html already treats
 * anything past expiresAt as gone on read (see getLiveIpHash), so this
 * script isn't what makes the data stop being USED after 90 days — it's
 * what makes it stop EXISTING, which is what "deleted automatically"
 * in privacy.html actually needs to be true.
 *
 * Firestore has a built-in TTL feature that would normally do exactly
 * this — but turning it on requires the Blaze (pay-as-you-go) plan
 * purely to unlock the *management* of TTL policies, regardless of
 * whether the actual usage would cost anything. This script gets the
 * same real outcome (documents genuinely deleted, not just ignored) on
 * a free GitHub Actions schedule instead, via the Admin SDK — which
 * authenticates as a service account and bypasses Firestore security
 * rules entirely, the same way functions/index.js's stripeWebhook
 * already does (see firestore.rules).
 *
 * Run by .github/workflows/purge-ip-logs.yml on a daily schedule.
 *
 * Usage:
 *   node scripts/purge-expired-ip-logs.mjs              # delete, report
 *   node scripts/purge-expired-ip-logs.mjs --dry-run    # report only, delete nothing
 *
 * Requires GOOGLE_APPLICATION_CREDENTIALS_JSON in the environment — the
 * full JSON content (not a file path) of a Firebase service account
 * key, generated from Project Settings -> Service Accounts. Never
 * commit that key; it's read here from an env var that the workflow
 * pulls from a GitHub Actions secret.
 */

import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const DRY_RUN = process.argv.includes("--dry-run");

const keyJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
if (!keyJson) {
  throw new Error(
    "GOOGLE_APPLICATION_CREDENTIALS_JSON is not set — see this file's own header comment."
  );
}

initializeApp({ credential: cert(JSON.parse(keyJson)) });
const db = getFirestore();

async function main() {
  const now = new Date();
  const snapshot = await db
    .collection("chat_ip_log")
    .where("expiresAt", "<=", now)
    .get();

  if (snapshot.empty) {
    console.log(
      `${DRY_RUN ? "[dry run] " : ""}No expired chat_ip_log documents.`
    );
    return;
  }

  console.log(
    `${DRY_RUN ? "[dry run] " : ""}Found ${snapshot.size} expired document(s).`
  );

  if (DRY_RUN) {
    snapshot.docs.forEach((doc) => console.log(`  would delete: ${doc.id}`));
    return;
  }

  // Firestore batches cap at 500 writes — a daily run against a 90-day
  // window should only ever see a handful, but chunking means a missed
  // run or an unexpected burst still can't fail outright by exceeding
  // the limit (same pattern as commitDeletesInBatches in admin.html).
  const refs = snapshot.docs.map((doc) => doc.ref);
  const chunks = [];
  for (let i = 0; i < refs.length; i += 450) chunks.push(refs.slice(i, i + 450));

  for (const chunk of chunks) {
    const batch = db.batch();
    chunk.forEach((ref) => batch.delete(ref));
    await batch.commit();
  }

  console.log(`Deleted ${refs.length} expired document(s).`);
}

main().catch((err) => {
  console.error("Purge failed:", err.message);
  process.exit(1);
});
