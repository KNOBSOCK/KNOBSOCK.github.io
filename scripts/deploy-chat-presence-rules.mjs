#!/usr/bin/env node
/**
 * Replaces the deployed chat_presence rules with chat-presence-firestore.rules.
 *
 * Same shape as deploy-forum-rules.mjs — fetch the live ruleset, splice, back
 * it up, compile, and only publish behind an explicit flag — with one extra
 * step that script doesn't need. The forum namespace was new, so appending a
 * fragment was enough. chat_presence already has a block live, and Firestore
 * ORs matching rules together, so a stricter block added alongside the
 * existing `allow read, write: if true` would be a silent no-op. The old block
 * has to come out, which means finding it in text this repo has never held a
 * copy of. Hence three modes rather than two:
 *
 *   node scripts/deploy-chat-presence-rules.mjs            # show the diff, touch nothing
 *   node scripts/deploy-chat-presence-rules.mjs --stage    # compile it, still don't publish
 *   node scripts/deploy-chat-presence-rules.mjs --deploy   # publish
 *
 * Read the printed before/after on the first mode before running the third.
 * Everything else in the deployed ruleset is carried across untouched.
 *
 * Needs a current `firebase login` — it reads the CLI's own stored token, the
 * same as deploy-forum-rules.mjs. A 401 means run `firebase login --reauth`.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const project = "chat-for-website-efee2";
const root = fileURLToPath(new URL("../", import.meta.url));
const MODE = process.argv.includes("--deploy")
  ? "deploy"
  : process.argv.includes("--stage")
    ? "stage"
    : "preview";

const config = JSON.parse(
  await fs.readFile(
    path.join(os.homedir(), ".config/configstore/firebase-tools.json"),
    "utf8",
  ),
);
const headers = {
  Authorization: "Bearer " + config.tokens.access_token,
  "Content-Type": "application/json",
};
async function api(url, method = "GET", body) {
  const r = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json();
  if (!r.ok) {
    if (r.status === 401)
      throw Error("401 — the stored firebase-tools token has expired. Run `firebase login --reauth`.");
    throw Error(r.status + " " + JSON.stringify(j));
  }
  return j;
}

const base = "https://firebaserules.googleapis.com/v1/projects/" + project;
const release = await api(base + "/releases/cloud.firestore");
const live = await api("https://firebaserules.googleapis.com/v1/" + release.rulesetName);
let source = live.source.files[0].content;

const backup = await fs.mkdtemp(path.join(os.tmpdir(), "knobsock-presence-rules-"));
await fs.writeFile(path.join(backup, "previous-rules.json"), JSON.stringify(live, null, 2));
console.log("Previous ruleset:", release.rulesetName);
console.log("Backup:", backup);

// Find the live `match /chat_presence/...` block by walking braces, not by
// regex — a rule body contains braces of its own, and a lazy .*? would stop
// at the first one. Two separate brace shapes are in play and conflating
// them is the trap here: the wildcard in the path (`/{id}`, `/{doc=**}`)
// opens and closes before the block does, so the path is consumed whole
// first, and only the brace after it starts the depth count.
function findMatchBlock(text, collection) {
  const at = text.search(new RegExp("match\\s+/" + collection + "/"));
  if (at === -1) return null;
  let i = at + "match".length;
  while (i < text.length && /\s/.test(text[i])) i++;
  while (i < text.length && !/\s/.test(text[i])) {
    if (text[i] === "{") while (i < text.length && text[i] !== "}") i++;
    i++;
  }
  while (i < text.length && /\s/.test(text[i])) i++;
  if (text[i] !== "{") return null;
  let depth = 0;
  for (; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) {
      let start = at;
      while (start > 0 && (text[start - 1] === " " || text[start - 1] === "\t")) start--;
      return { start, end: i + 1, text: text.slice(start, i + 1) };
    }
  }
  return null;
}

const existing = findMatchBlock(source, "chat_presence");
if (!existing) {
  throw Error(
    "No chat_presence block found in the deployed rules. Nothing was changed. " +
      "Inspect " + path.join(backup, "previous-rules.json") + " and adjust this script before retrying.",
  );
}

const fragment = (await fs.readFile(path.join(root, "chat-presence-firestore.rules"), "utf8")).trim();
const indent = (existing.text.match(/^[ \t]*/) || [""])[0];
const indented = fragment
  .split("\n")
  .map((line) => (line ? indent + line : line))
  .join("\n");

source = source.slice(0, existing.start) + indented + source.slice(existing.end);
await fs.writeFile(path.join(backup, "proposed.rules"), source);

console.log("\n--- currently deployed -------------------------------------");
console.log(existing.text);
console.log("--- replacement --------------------------------------------");
console.log(indented);
console.log("------------------------------------------------------------\n");

if (MODE === "preview") {
  console.log("Preview only. Nothing was compiled or published.");
  console.log("Full proposed ruleset:", path.join(backup, "proposed.rules"));
  console.log("Re-run with --stage to compile it, or --deploy to publish it.");
  process.exit(0);
}

const staged = await api(base + "/rulesets", "POST", {
  source: { files: [{ name: "firestore.rules", content: source }] },
});
console.log("Compiled ruleset:", staged.name);

if (MODE === "stage") {
  console.log("Staged only; live rules unchanged.");
  process.exit(0);
}

const current = await api(base + "/releases/cloud.firestore");
if (current.rulesetName !== release.rulesetName)
  throw Error("Live rules changed during staging. Re-run to merge with the new version.");

await api(base + "/releases/cloud.firestore", "PATCH", {
  release: { name: release.name, rulesetName: staged.name },
  updateMask: "rulesetName",
});
console.log("Published. Every other collection block was carried across untouched.");
console.log("Roll back with the ruleset name above:", release.rulesetName);
