# Security proof map

Claims are only useful when a reviewer can follow them to a control, a test, and the file that
implements the behavior. This is the compact evidence map for the public portfolio build; the
honest gaps remain documented in [`security-model.md`](security-model.md).

| Claim | Control | Test / gate | Source of truth |
| --- | --- | --- | --- |
| Authentication is session-bound and MFA-aware | In-memory access token, rotating `httpOnly` refresh cookie, MFA challenge guard | `Api/src/modules/auth/auth.int-spec.ts`, `Api/src/modules/auth/mfa-login.service.spec.ts`, `Web/cypress/e2e/auth-session.cy.ts` | [`Api/src/modules/auth/`](../Api/src/modules/auth/) |
| Sensitive customer data is masked by default | Permission-gated `?reveal=true`; reveal is audited | `Api/src/modules/customers/customers.int-spec.ts`, `Api/src/modules/analytics/analytics.int-spec.ts` | [`Api/src/modules/customers/`](../Api/src/modules/customers/), [`security-model.md`](security-model.md) |
| Money movement is balanced and retry-safe | Integer minor units, double-entry posting, atomic idempotency record | `Api/src/modules/transactions/transactions.posting.int-spec.ts`, `Api/src/modules/transactions/transactions.service.spec.ts` | [`Api/src/modules/transactions/`](../Api/src/modules/transactions/), [`Api/prisma/schema.prisma`](../Api/prisma/schema.prisma) |
| Audit history is tamper-evident | Hash chain, advisory-lock serialization, database-level append-only grants | `Api/src/common/audit/audit.service.spec.ts`, `Api/src/infrastructure/prisma/db-rls-enforcement.int-spec.ts` | [`Api/src/common/audit/`](../Api/src/common/audit/), [`db-security.sql`](../Api/prisma/sql/db-security.sql) |
| Database authorization has a least-privilege seam | `app_login`/`app_rw` roles, RLS policies, request-scoped GUC | `Api/src/infrastructure/prisma/db-rls-enforcement.int-spec.ts` | [`Api/prisma/sql/db-security.sql`](../Api/prisma/sql/db-security.sql), [`rls-context.ts`](../Api/src/infrastructure/prisma/rls-context.ts) |
| Supply-chain changes are reviewable and blocking | Full-SHA-pinned Actions, dependency/license gate, secret scan, Trivy HIGH/CRITICAL gate | `.github/workflows/ci.yml` (`governance`, `security`, `ci-gate`) | [CI workflow](../.github/workflows/ci.yml), [`scripts/`](../scripts/) |

## Reading the map

The “test / gate” column is deliberately concrete: a claim is not a production guarantee unless the
corresponding test lane is green and the documented deployment prerequisites are enabled. In
particular, RLS is wired and proven against a real PostgreSQL test instance but is still opt-in at
deployment time; see the [honest gaps](security-model.md#honest-gaps).
