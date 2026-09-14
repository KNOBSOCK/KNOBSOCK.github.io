// Integration checks use uniquely named temporary records and delete only those
// exact records in finally. No existing posts, accounts, or boards are changed.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
const c = JSON.parse(
  await fs.readFile(
    path.join(os.homedir(), ".config/configstore/firebase-tools.json"),
    "utf8",
  ),
);
const project = "chat-for-website-efee2",
  base =
    "https://firestore.googleapis.com/v1/projects/" +
    project +
    "/databases/(default)/documents",
  name = "projects/" + project + "/databases/(default)/documents/";
const id = "forumcheck-" + crypto.randomUUID(),
  user = "ForumCheck" + id.slice(-8),
  device = id,
  thread = id,
  board = id,
  secret = () => crypto.randomUUID() + crypto.randomUUID();
let key = secret();
const tracked = new Set();
const value = (v) =>
  v === null
    ? { nullValue: null }
    : typeof v === "string"
      ? { stringValue: v }
      : typeof v === "boolean"
        ? { booleanValue: v }
        : typeof v === "number"
          ? { integerValue: String(v) }
          : Array.isArray(v)
            ? { arrayValue: { values: v.map(value) } }
            : { mapValue: { fields: fields(v) } };
const fields = (o) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, value(v)]));
function set(p, data, ts = []) {
  tracked.add(p);
  return {
    update: { name: name + p, fields: fields(data) },
    ...(ts.length
      ? {
          updateTransforms: ts.map((fieldPath) => ({
            fieldPath,
            setToServerValue: "REQUEST_TIME",
          })),
        }
      : {}),
  };
}
async function call(url, method, body, admin = false) {
  const r = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(admin ? { Authorization: "Bearer " + c.tokens.access_token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json();
  return { status: r.status, body: j };
}
const commit = (writes, admin = false) =>
  call(base + ":commit", "POST", { writes }, admin);
async function yes(label, writes, admin = false) {
  const r = await commit(writes, admin);
  assert.equal(r.status, 200, label + ": " + JSON.stringify(r.body));
  console.log("PASS", label);
}
async function no(label, writes) {
  const r = await commit(writes);
  assert.equal(r.status, 403, label + ": " + JSON.stringify(r.body));
  console.log("PASS", label);
}
function session(next = secret()) {
  const prev = key;
  key = next;
  return set(
    "forum_sessions/" + device,
    { deviceId: device, username: user, secret: next, proof: prev },
    ["touched"],
  );
}
async function age() {
  const w = {
    update: {
      name: name + "forum_sessions/" + device,
      fields: { touched: { timestampValue: "2000-01-01T00:00:00Z" } },
    },
    updateMask: { fieldPaths: ["touched"] },
  };
  await yes("prepare cooldown fixture", [w], true);
}
const post = (pid, body = "A verification post") =>
  set(
    "forum_threads/" + thread + "/posts/" + pid,
    { body, authorId: device, username: user, editedAt: null, hidden: false },
    ["createdAt"],
  );
const threadData = {
  boardId: board,
  title: "Temporary permission verification",
  authorId: device,
  username: user,
  lastUsername: user,
  lastPostId: "first",
  postCount: 1,
  pinned: false,
  locked: false,
  hidden: false,
};
function reply(pid, count) {
  return [
    session(),
    post(pid),
    {
      update: {
        name: name + "forum_threads/" + thread,
        fields: fields({
          lastPostId: pid,
          lastUsername: user,
          postCount: count,
        }),
      },
      updateMask: { fieldPaths: ["lastPostId", "lastUsername", "postCount"] },
      updateTransforms: [
        { fieldPath: "updatedAt", setToServerValue: "REQUEST_TIME" },
      ],
    },
  ];
}
try {
  await yes(
    "prepare isolated fixtures",
    [
      set("chat_devices/" + device, { username: user }),
      set("chat_usernames/" + user.toLowerCase(), {
        username: user,
        lastDeviceId: device,
      }),
      set("forum_boards/" + board, {
        title: "Verification",
        categoryId: "verification",
        description: "",
        order: 99999,
        locked: false,
      }),
    ],
    true,
  );
  await no("guests cannot edit board settings", [
    set("forum_boards/" + board, { title: "Forged", locked: false }),
  ]);
  await yes("shared live identity can create a forum thread", [
    session(),
    set("forum_threads/" + thread, threadData, ["createdAt", "updatedAt"]),
    post("first"),
  ]);
  const privateRead = await call(base + "/forum_sessions/" + device, "GET");
  assert.equal(privateRead.status, 403);
  console.log("PASS forum credential is private");
  await no(
    "forged credential cannot post",
    reply("forged", 2).map((w, i) =>
      i
        ? w
        : {
            ...w,
            update: {
              ...w.update,
              fields: { ...w.update.fields, proof: value("wrong") },
            },
          },
    ),
  );
  // Restore key from the successful initial write (failed writes cannot rotate it).
  const owned = await call(
    base + "/forum_sessions/" + device,
    "GET",
    undefined,
    true,
  );
  key = owned.body.fields.secret.stringValue;
  await no("cooldown blocks immediate reply", reply("too-fast", 2));
  key = owned.body.fields.secret.stringValue;
  await age();
  await yes("valid credential can reply and update counts", reply("second", 2));
  await age();
  await yes("author can edit own post", [
    session(),
    {
      update: {
        name: name + "forum_threads/" + thread + "/posts/second",
        fields: fields({ body: "Edited verification" }),
      },
      updateMask: { fieldPaths: ["body"] },
      updateTransforms: [
        { fieldPath: "editedAt", setToServerValue: "REQUEST_TIME" },
      ],
    },
  ]);
  await no("guest cannot edit a post without its credential", [
    {
      update: {
        name: name + "forum_threads/" + thread + "/posts/second",
        fields: fields({ body: "Forged edit" }),
      },
      updateMask: { fieldPaths: ["body"] },
      updateTransforms: [
        { fieldPath: "editedAt", setToServerValue: "REQUEST_TIME" },
      ],
    },
  ]);
  await no("guest cannot pin threads", [
    {
      update: {
        name: name + "forum_threads/" + thread,
        fields: fields({ pinned: true }),
      },
      updateMask: { fieldPaths: ["pinned"] },
    },
  ]);
  await yes(
    "prepare shared ban",
    [
      set("chat_bans/" + device, {
        bannedBy: "verification",
        bannedAt: Date.now(),
        expiresAt: null,
        enforced: true,
        reason: "verification",
        usernames: [user],
      }),
    ],
    true,
  );
  await age();
  const beforeBan = key;
  await no("shared ban blocks forum reply", reply("banned", 3));
  key = beforeBan;
  await no("forum ban also blocks live chat", [
    set(
      "chat_messages/" + id,
      { username: user, deviceId: device, text: "verification" },
      ["ts"],
    ),
  ]);
  await yes(
    "expire shared ban fixture",
    [
      set("chat_bans/" + device, {
        bannedBy: "verification",
        expiresAt: Date.now() - 60000,
      }),
    ],
    true,
  );
  await yes("expired ban permits forum reply", reply("expired", 3));
  await yes("expired ban permits live chat", [
    set(
      "chat_messages/" + id,
      { username: user, deviceId: device, text: "verification" },
      ["ts"],
    ),
  ]);
  await age();
  await yes("member can submit private report", [
    session(),
    set(
      "forum_reports/" + id,
      {
        threadId: thread,
        postId: "first",
        authorId: device,
        username: user,
        reason: "verification",
        status: "open",
      },
      ["createdAt"],
    ),
  ]);
  assert.equal((await call(base + "/forum_reports/" + id, "GET")).status, 403);
  console.log("PASS reports are private");
  await yes(
    "hide thread fixture",
    [
      {
        update: {
          name: name + "forum_threads/" + thread,
          fields: fields({ hidden: true }),
        },
        updateMask: { fieldPaths: ["hidden"] },
      },
    ],
    true,
  );
  assert.equal(
    (await call(base + "/forum_threads/" + thread, "GET")).status,
    403,
  );
  assert.equal(
    (await call(base + "/forum_threads/" + thread + "/posts/first", "GET"))
      .status,
    403,
  );
  console.log("PASS hidden thread and posts are not publicly readable");
  console.log("All forum permission checks passed.");
} finally {
  const writes = [...tracked].map((p) => ({ delete: name + p }));
  const r = await commit(writes, true);
  assert.equal(r.status, 200, "Could not clean verification records");
  console.log("Removed only the temporary verification records:", tracked.size);
}
