# Repository instructions

## Shipping changes

This repo is a static site served directly from `main` via GitHub Pages — committing to `main` deploys to the live site immediately.

When completing a code change requested in this repo: commit directly to `main` and push — don't stop to ask for confirmation first, and don't bother with a feature branch or PR for the ordinary case.

Skip the automatic commit/push and check with the user instead if the change is unusually risky/destructive (e.g. touches Firestore rules, secrets, or payment/checkout code) — everything else just ships.

## Visual preview

For every visual website change, start or refresh a local browser preview of the page that changed and leave it visible for the user before pushing to `main`. Use the local preview to visually check the result rather than waiting for GitHub Pages to deploy. If a local browser cannot be controlled in the session, say so and provide the local preview URL instead.

## Firebase: two separate projects

The site uses two Firebase projects, both on the free Spark plan. Each has its own quota of 50k reads/day, so keep traffic in the right project.

- **Chat and everything else**: `chat-for-website-efee2`. This covers chat messages, presence, usernames, bans, admin config, forums, the store and the page counter. The admin login lives here too.
  - Its Firestore rules exist only in the Firebase console. `firestore.rules` in this repo is partial, so never run `firebase deploy --only firestore:rules`; it would wipe the live chat and forum rules.
- **Live minigames between players**: `games-6a3a7`. All high-frequency, real-time game traffic goes here, never in the chat project.
  - The fight game's once-a-second score packets live in the `fight_live` collection.
  - The fight's one-off events (`fight_challenge`, `fight_accept`, `fight_decline`, `fight_score`, `fight_result`, `fight_draw`) intentionally stay in the chat project's `chat_messages`, because some of them show up as chat lines.
  - The full ruleset is kept in `games-firestore.rules`. That file is authoritative for this project and is pasted into the console as a whole.
  - A new minigame gets its own collection here and its own `match` block in that file.

In `livestream-chat-widget.html`, the main app is the default `firebase.initializeApp(firebaseConfig)` and the games project is a second named app: `firebase.initializeApp(gamesFirebaseConfig, 'games')`, exposed as `gamesDb`.

Don't spread the same workload across extra Google accounts or projects to stack free quota. That's against Google's terms. The split is one project per kind of feature.
