// Fetch and preserve deployed site rules; append only the forum namespace.
// Default stages/compiles a ruleset. --deploy publishes it and creates indexes.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const project = "chat-for-website-efee2",
  root = fileURLToPath(new URL("../", import.meta.url));
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
  if (!r.ok) throw Error(r.status + " " + JSON.stringify(j));
  return j;
}
const base = "https://firebaserules.googleapis.com/v1/projects/" + project;
const release = await api(base + "/releases/cloud.firestore");
const live = await api(
  "https://firebaserules.googleapis.com/v1/" + release.rulesetName,
);
let source = live.source.files[0].content;
const backup = await fs.mkdtemp(
  path.join(os.tmpdir(), "knobsock-forum-rules-"),
);
await fs.writeFile(
  path.join(backup, "previous-rules.json"),
  JSON.stringify(live, null, 2),
);
console.log("Previous ruleset:", release.rulesetName, "; backup:", backup);
const start = "// BEGIN KNOBSOCK FORUM RULES",
  end = "// END KNOBSOCK FORUM RULES";
if (source.includes(start))
  source =
    source.slice(0, source.indexOf(start)) +
    source.slice(source.indexOf(end) + end.length);
const insert = source.lastIndexOf("}", source.lastIndexOf("}") - 1);
const fragment = await fs.readFile(
  path.join(root, "forum-firestore.rules"),
  "utf8",
);
source =
  source.slice(0, insert) +
  start +
  "\n" +
  fragment +
  "\n" +
  end +
  "\n" +
  source.slice(insert);
// Existing timed live bans must expire without requiring the visitor to delete
// the admin-owned ban record. Permanent bans remain effective on both pages.
source = source.replace(
  "allow create: if !exists(/databases/$(database)/documents/chat_bans/$(request.resource.data.deviceId));",
  "allow create: if forumNotBanned(request.resource.data.deviceId);",
);
await fs.writeFile(path.join(backup, "proposed.rules"), source);
const staged = await api(base + "/rulesets", "POST", {
  source: { files: [{ name: "firestore.rules", content: source }] },
});
console.log("Compiled ruleset:", staged.name);
if (!process.argv.includes("--deploy")) {
  console.log("Staged only; live rules unchanged.");
  process.exit(0);
}
const current = await api(base + "/releases/cloud.firestore");
if (current.rulesetName !== release.rulesetName)
  throw Error(
    "Live rules changed during staging. Re-run to merge with the new version.",
  );
await api(base + "/releases/cloud.firestore", "PATCH", {
  release: { name: release.name, rulesetName: staged.name },
  updateMask: "rulesetName",
});
console.log(
  "Published forum rules; all pre-existing collection blocks retained.",
);
for (const [group, first, field, direction, scope] of [
  ["forum_threads", "hidden", "updatedAt", "DESCENDING", "COLLECTION"],
  ["posts", "hidden", "createdAt", "ASCENDING", "COLLECTION"],
  ["posts", "authorId", "createdAt", "DESCENDING", "COLLECTION_GROUP"],
]) {
  const url =
    "https://firestore.googleapis.com/v1/projects/" +
    project +
    "/databases/(default)/collectionGroups/" +
    group +
    "/indexes";
  const existing = await api(url);
  if (
    (existing.indexes || []).some(
      (x) =>
        x.name.includes('/collectionGroups/'+group+'/') && x.queryScope === scope &&
        x.fields[0]?.fieldPath === first && x.fields[1]?.fieldPath === field &&
        x.fields[1]?.order === direction,
    )
  ) {
    console.log("Index already exists:", group);
    continue;
  }
  console.log(
    "Creating index:",
    group,
    await api(url, "POST", {
      queryScope: scope,
      fields: [
        { fieldPath: first, order: "ASCENDING" },
        { fieldPath: field, order: direction },
      ],
    }),
  );
}
