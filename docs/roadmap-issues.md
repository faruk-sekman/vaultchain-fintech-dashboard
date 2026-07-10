# Roadmap issue drafts

The GitHub connector currently has read access to this public repository but returns `403 Resource
not accessible by integration` for issue creation. These are the three ready-to-paste issue bodies
for the release handoff; they deliberately contain no secrets or production details.

## Enforce RLS on a deployed least-privilege target

Promote the existing `app_login`/`app_rw` and `DB_RLS_ENFORCED=1` seam to a deployed environment.

**Definition of done**

- Runtime connects as `app_login`; migrations use the separate owner URL.
- The RLS integration lane runs against the deployment target.
- Rollback and operator runbook are documented.

Context: `docs/security-model.md` and `Api/src/infrastructure/prisma/db-rls-enforcement.int-spec.ts`.

## Add an external WORM anchor for the audit-chain head

Anchor the daily `audit_logs.entry_hash` head in an external write-once store so a privileged
database actor cannot rewrite the entire in-database chain without detection.

**Definition of done**

- Anchor format and retention policy are documented.
- Failure/restore drill and verification command are tested.
- No raw PII or secrets are included in the anchor payload.

Context: `docs/security-model.md` and `Api/src/common/audit/`.

## Publish a hosted demo and browsable API reference

Give evaluators a zero-provision path while keeping the local Docker demo as the source of truth.

**Definition of done**

- A public demo URL uses synthetic data only.
- Hosted OpenAPI is derived from `Api/openapi.json`.
- Health, rate limits, and data-reset behavior are documented.

Context: `docs/evaluator-path.md`, `docs/deployment-and-operations.md`, and `Api/openapi.json`.
