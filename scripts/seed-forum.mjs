// Creates starter boards only when their exact IDs do not already exist.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const c = JSON.parse(
  await fs.readFile(
    path.join(os.homedir(), ".config/configstore/firebase-tools.json"),
    "utf8",
  ),
);
const base =
  "https://firestore.googleapis.com/v1/projects/chat-for-website-efee2/databases/(default)/documents";
const headers = {
  Authorization: "Bearer " + c.tokens.access_token,
  "Content-Type": "application/json",
};
const docs = {
  "forum_categories/knobsock": { title: "KNOBSOCK", order: 0 },
  "forum_categories/community": { title: "COMMUNITY", order: 1 },
  "forum_boards/general": {
    title: "General Discussion",
    description: "Pull up a chair. Talk about anything Knobsock.",
    categoryId: "knobsock",
    order: 0,
    locked: false,
  },
  "forum_boards/music": {
    title: "Music",
    description: "Songs, albums, recommendations, and things you are making.",
    categoryId: "knobsock",
    order: 1,
    locked: false,
  },
  "forum_boards/videos": {
    title: "Videos & Live",
    description: "Talk about the videos and what happened on stream.",
    categoryId: "knobsock",
    order: 2,
    locked: false,
  },
  "forum_boards/introductions": {
    title: "Introduce Yourself",
    description: "New around here? Say hello.",
    categoryId: "community",
    order: 3,
    locked: false,
  },
  "forum_boards/creations": {
    title: "Your Creations",
    description: "Share your art, projects, and ideas.",
    categoryId: "community",
    order: 4,
    locked: false,
  },
  "forum_boards/feedback": {
    title: "Forum Feedback",
    description: "Suggestions and bug reports for the site.",
    categoryId: "community",
    order: 5,
    locked: false,
  },
  "forum_config/main": {
    readOnly: false,
    rules:
      "Be kind. No harassment, hate, threats, spam, impersonation, or sharing private information. Keep posts in the right board. Do not post illegal content. Report problems instead of escalating them. Moderators may remove content, lock discussions, and suspend access to both forums and live chat.",
  },
};
for (const [id, obj] of Object.entries(docs)) {
  const fields = Object.fromEntries(
    Object.entries(obj).map(([k, v]) => [
      k,
      typeof v === "boolean"
        ? { booleanValue: v }
        : typeof v === "number"
          ? { integerValue: String(v) }
          : { stringValue: v },
    ]),
  );
  const r = await fetch(base + "/" + id + "?currentDocument.exists=false", {
    method: "PATCH",
    headers,
    body: JSON.stringify({ fields }),
  });
  if (!r.ok && r.status !== 409) throw Error(id + ": " + (await r.text()));
  console.log(id, r.ok ? "created" : "already exists");
}
