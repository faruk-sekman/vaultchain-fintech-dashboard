<!--
Title must be a Conventional Commit header, e.g.:
  feat(web): add customer wallet limit editing
  fix(api): reject stale wallet-limit updates
See CONTRIBUTING.md for branch naming, commit conventions, and the quality gates.
-->

## Summary

<!-- One short paragraph: what this PR does and why. -->

## Type of change

- [ ] `feat` — new capability
- [ ] `fix` — bug fix
- [ ] `docs` — documentation only
- [ ] `refactor` / `perf` / `style`
- [ ] `test`
- [ ] `chore` / `build` / `ci`
- [ ] **BREAKING CHANGE** (describe the impact below)

## Changes

<!-- Bullet the notable changes; group by area. -->

-

## Checklist

- [ ] Tests added or updated; coverage gates still pass (per-file floor 90%)
- [ ] Web gates green *(if `Web/` touched)*: `format:check`, `lint:styles`, `npm test`, production build within budgets
- [ ] Api gates green *(if `Api/` touched)*: `lint`, `test`, `build`, `openapi:generate` with a clean diff, `test:int`
- [ ] TR/EN translations in parity; light and dark themes verified *(if UI touched)*
- [ ] Docs updated (README / `docs/` / CHANGELOG) if behavior changed
- [ ] No secrets, tokens, `.env` values, credentials, or PII in the diff
- [ ] CI green — the aggregate `ci-gate` check passes

## Screenshots

<!-- For UI changes: before/after, ideally light + dark. Remove if not applicable. -->

## Rollback

<!-- How to revert safely (usually: revert the squash commit). -->
