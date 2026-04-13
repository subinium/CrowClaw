# CrowClaw Project Instructions

## Git Workflow (OVERRIDES global auto-push)

**Never push directly to main.** All changes go through branches + PRs.

```
git checkout -b fix/description   # or feat/, release/
# ... work ...
git commit
git push -u origin HEAD           # push to BRANCH, not main
gh pr create
# wait for pre-CI (typecheck + test) to pass
# merge after approval
```

- `git push` after commit goes to the **current branch**, not main
- Do NOT use `git push origin main` unless explicitly asked
- Releases: `release/vX.Y.Z` branch with version bump, PR, merge, then tag + gh release

## Release Process

1. `git checkout -b release/vX.Y.Z`
2. Bump `version` in `package.json`
3. Update README badges (version, test count)
4. `npm run typecheck && npm test` (must pass)
5. Commit + push branch + PR
6. After merge: `git tag vX.Y.Z && git push --tags`
7. `gh release create vX.Y.Z` with detailed notes grouped by subsystem

## Language

- Code, commits, PR descriptions: English
- User communication: follow user's language (usually Korean)

## Build & Test

```bash
npm run build        # tsc -b
npm run typecheck    # tsc -b --pretty false
npm test             # vitest run
npm run preflight    # typecheck + test
```

## Key Conventions

- Package names: `@crowclaw/*`
- Tool names: `namespace.action` (e.g., `web.search`)
- Config presets = MCP+Skill+Tool bundles (NOT personas)
- No emojis in code, dashboard, or commit messages
- Dashboard is single HTML template literal in `packages/web/src/index.ts`
