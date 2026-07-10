# Security Policy

Vaultchain is a local case-study / portfolio application — a back-office fintech operations
console that runs on a developer's machine. It is **not a deployed production system**: there is no
public server, no live database, and no real customer data. This policy describes how the codebase
treats secrets, personal data, on-chain access, and dependencies, and how to raise a concern.

## Scope

This policy covers the repository itself: the Angular frontend (`Web/`), the NestJS backend
(`Api/`), their build and configuration, environment files, the REST client/server boundary,
authentication and authorization, the audit trail, cryptography, and the read-only Web3 reader. It
does **not** imply that any production database, deployment, or live system exists or is available.

## Security controls at a glance

| Control | Implementation | Status |
| ------- | -------------- | ------ |
| Session tokens | 15-minute access JWT held in memory only; rotating Argon2id-hashed refresh token in an httpOnly `SameSite=Strict` cookie; replay detection revokes the whole session family | ✅ built |
| MFA (TOTP two-step verification) | Opt-in authenticator-app TOTP, 10 single-use Argon2id-hashed backup codes, trusted devices, admin-driven MFA reset | ✅ built |
| RBAC | Three roles — Administrator, Compliance Officer, Viewer — enforced server-side per permission | ✅ built |
| PII at rest | `national_id` under AES-256-GCM envelope encryption; read paths expose only the last four digits | ✅ built |
| PII reveal | Requires the `customers.pii.reveal` permission **and** an explicit `?reveal=true` opt-in; every reveal writes an audit record | ✅ built |
| Audit trail | Append-only `audit_logs`, hash-chained entry to entry with SHA-256 | ✅ built |
| HTTP hardening | Helmet CSP `default-src 'none'` and `frame-ancestors 'none'`; HSTS in production; explicit CORS allowlist | ✅ built |
| Input validation | Global validation pipe: whitelisting, unknown-property rejection, transformation | ✅ built |
| Rate limiting | 100 requests/min/IP globally, 10/min on auth endpoints, 30/min on customer writes; cannot be disabled in production | ✅ built |
| Ledger integrity | Double-entry ledger in integer minor units; `Idempotency-Key` committed in the same database transaction | ✅ built |
| Supply chain | Trivy scan in CI (HIGH/CRITICAL enforced), SHA-pinned GitHub Actions, dependency license allowlist | ✅ built |
| Account lockout | 5 failed logins lock the account for 15 minutes (`423 Auth.AccountLocked`); a successful login resets the counter | ✅ built |
| WORM audit anchor | Designed; not built | ⚠️ not built |
| Row-level security | Database policies and role wiring exist; disabled by default via `DB_RLS_ENFORCED` | ⚠️ off by default |

The full design and rationale behind these controls is in
[docs/security-model.md](docs/security-model.md).

## Secrets handling

No secrets are committed to this repository. Configuration values used to run the project locally
live only in local or runtime files, never in version control, logs, or documentation.

- API keys, tokens, passwords, and database connection strings are never committed, printed, or
  pasted anywhere. Environment files (`.env` and similar) are gitignored, and a CI gate
  (`sensitive:check`) fails the build if one is ever tracked.
- Anything placed in the browser's build-time environment config **ships inside the JavaScript
  bundle and is therefore public**. Client configuration is treated as non-secret by design; real
  secrets belong behind the backend, never in the single-page app.
- The backend refuses to boot on missing or weak security configuration. For a production-faithful
  run it requires strong JWT secrets (at least 32 characters), an explicit CORS allowlist, an
  always-on rate limiter, and TLS or authenticated Redis if `REDIS_URL` is set.
- The HTTP logger redacts authorization headers and cookies at the logger level, so bearer tokens
  and session cookies never reach log output; this redaction must not be defeated.

The only credential shown anywhere is the intentionally non-secret demo password `Test-Passw0rd!`,
used by the seeded demo login accounts.

## Personal data (PII) and customer data

All customer data is **seeded demo data** — roughly 1,500 fictional customers generated at setup.
There are no real people in this system. Even so, the code treats PII with production discipline so
the patterns are honest and reviewable.

- **Masking by default.** Names, emails, phones, wallet numbers, and addresses are masked in the UI
  and in logs. Operators see only what a task requires.
- **National ID encryption.** `national_id` is protected with AES-256-GCM envelope encryption and is
  **never decrypted on a read path** — only the last four digits are ever displayed. The envelope
  uses a local master key and is designed to be swappable for a managed KMS.
- **Permission-gated, audited reveal.** Viewing unmasked PII requires both the
  `customers.pii.reveal` permission **and** an explicit opt-in on the request. Without the
  permission the request is silently ignored, and every reveal is recorded in the audit trail.
- **Least data everywhere.** PII is kept out of URLs, analytics, and any third-party surface. The
  approach follows GDPR/KVKK principles: minimization, encryption, masking, and audit.

## Web3 — read-only and non-custodial

On-chain access is strictly **read-only**. The Web3 risk screen performs key-free JSON-RPC reads
against a public Ethereum node and is EIP-1193-aware for connecting an operator's own address.

- **No custody, no transaction sending, no private keys.** The code also includes an optional
  proof-of-control wallet signature helper; do not describe the Web3 layer as "no signing"
  without that caveat.
- **No PII is ever written on-chain** or embedded in RPC requests.
- Real on-chain facts are shown separately from **simulated** AML/risk signals, which are always
  clearly labeled as simulated. The backend rejects any attempt to mark simulated data as real.

## Dependencies

The dependency footprint is deliberately small, and every dependency is checked in CI against a
permissive-license allowlist (MIT, Apache-2.0, BSD, ISC, PostgreSQL, MPL-2.0). Copyleft and
otherwise-restricted licenses are not used. New packages are reviewed for provenance and footprint,
and existing libraries are preferred over adding new ones.

## Reporting a concern

This is a public portfolio / demo repository with no production deployment, so there is nothing live
to exploit. If you spot something worth flagging, thank you — a short private note to the maintainer
is the best way to share it.

- Please include the affected file or route, the impact, and a minimal reproduction.
- **Please don't open public issues containing exploit details or any real data.**
- Triage is best-effort and informal: acknowledge, assess, and patch as time allows. There is no
  formal SLA.

## Related docs

- Full security design and rationale: [docs/security-model.md](docs/security-model.md)
- Identity, sessions, and roles: [docs/auth-and-rbac.md](docs/auth-and-rbac.md)
- Project overview and how to run it: [README.md](README.md)
