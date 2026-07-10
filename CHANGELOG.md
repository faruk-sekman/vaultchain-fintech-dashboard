# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

_No changes yet._

## 1.0.0 - 2026-07-09

Initial release of Vaultchain — a back-office console for fintech operations, built as an
Angular web app on top of an OpenAPI-contracted NestJS + PostgreSQL API.

### Added

- Authentication with opt-in MFA (TOTP two-step verification): authenticator apps, single-use
  backup codes, and trusted-device remembering, plus a self-service password reset flow, an
  administrator-driven MFA reset, and an administrator-approved password reset queue.
- Role-based access control with three roles (Administrator, Compliance Officer, Viewer)
  and permission-gated, fully audited PII reveal for customer records.
- Customer management: searchable directory, customer detail with risk and KYC status
  history, and a KYC review lifecycle.
- Multi-currency wallets (TRY, USD, EUR) with operator-editable limits protected by
  optimistic concurrency (rowVersion).
- Double-entry transaction ledger in integer minor units, with idempotent writes
  (`Idempotency-Key` committed in the same database transaction), filtering, and
  per-customer transaction views.
- Append-only, hash-chained audit trail.
- Live operations dashboard: KPI summary cards and a recent-customers feed updated in
  real time over Server-Sent Events (SSE).
- Read-only, non-custodial Web3 risk screen: key-free JSON-RPC reads against public
  Ethereum, shown alongside clearly labeled simulated AML signals.
- In-app notifications.
- Turkish and English localization with enforced key parity, and light/dark themes.
- Dockerized demo (`npm run demo`): web, API, and PostgreSQL containers, seeded with
  demo data on first run.
- NestJS API versioned under `/api/v1` with a committed OpenAPI specification and a CI
  drift gate.
- Test pyramid across both stacks: unit and component tests, API integration tests
  against real PostgreSQL, and Cypress end-to-end suites.
