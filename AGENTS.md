# Repository instructions

## Shipping changes

This repo is a static site served directly from `main` via GitHub Pages — committing to `main` deploys to the live site immediately.

When completing a code change requested in this repo: commit directly to `main` and push — don't stop to ask for confirmation first, and don't bother with a feature branch or PR for the ordinary case.

Skip the automatic commit/push and check with the user instead if the change is unusually risky/destructive (e.g. touches Firestore rules, secrets, or payment/checkout code) — everything else just ships.

## Visual preview

For every visual website change, start or refresh a local browser preview of the page that changed and leave it visible for the user before pushing to `main`. Use the local preview to visually check the result rather than waiting for GitHub Pages to deploy. If a local browser cannot be controlled in the session, say so and provide the local preview URL instead.
