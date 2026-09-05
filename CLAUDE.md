# Repository instructions

## Shipping changes

This repo is a static site served directly from `main` via GitHub Pages — merging to `main` deploys to the live site immediately.

When completing a code change requested in this repo:
1. Commit and push the work to its feature branch as usual.
2. Open a PR into `main`.
3. Merge the PR yourself (squash merge, matching this repo's existing history of single-commit, `(#N)`-suffixed merges) — don't stop to ask for confirmation to create or merge the PR.

Skip the automatic merge and check with the user instead if CI is failing, there's a merge conflict, or the change is unusually risky/destructive.
