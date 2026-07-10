# Public repository settings checklist

The codebase carries the policy and the CI gate name; the following settings are GitHub repository
metadata and must be applied in the repository UI/API by an administrator.

## Main protection (active ruleset)

Create an **active** ruleset named `Protect main` targeting the `main` branch with the payload in
[`main-protection.json`](../.github/rulesets/main-protection.json), or enter the same fields in the
Rulesets UI:

- Require a pull request before merging. Keep the approval count at `0` for this solo-maintainer
  portfolio repo; raise it to `1+` when a second reviewer is available.
- Require the single status check `CI gate` from the `ci` workflow.
- Dismiss stale approvals when new commits are pushed.
- Block force pushes and branch deletion.
- Do not grant bypass permission to individual users; keep any emergency bypass limited to a small
  administrator team and review it periodically.

The workflow already exposes the aggregate job as `CI gate`; this is the only check that should be
required, so optional `web-live-contract` remains optional without weakening the gate.

## Discovery metadata

Suggested topics:

`fintech`, `angular`, `nestjs`, `postgresql`, `rbac`, `mfa`, `kyc`, `prisma`, `web3`, `portfolio`

Upload [`social-preview.png`](assets/branding/social-preview.png) as the repository social preview.
Add a demo URL only after it points to a real, non-secret deployment; until then, the GIF and Docker
path are the honest evaluator entry points.

## Release

The repository and all three package manifests already declare `1.0.0`, and [`CHANGELOG.md`](../CHANGELOG.md)
contains the release note. Publish GitHub release `v1.0.0` from the matching tag after the CI gate is
green; do not rewrite the one-commit public history just to manufacture intermediate releases.
