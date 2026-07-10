# Screen Gallery

Every Vaultchain screen, captured from the running application and grouped by user journey. The 30 frames below are the visual evidence for the features documented across this set — from MFA (TOTP two-step verification) at sign-in to the realtime dashboard, masked-PII customer operations, on-chain risk review, and the Administrator recovery tools.

## 🗺️ Journey map

| Journey | Routes on screen | Frames |
| --- | --- | ---: |
| Sign-in & recovery | `/login`, `/mfa/verify`, `/forgot-password` | 7 |
| Dashboard & realtime | `/dashboard` | 2 |
| Theming & i18n | `/login` and `/dashboard` in dark theme, `/dashboard` in Turkish | 4 |
| Customers & KYC | `/customers`, `/customers/new`, `/customers/:id`, `/customers/:id/edit` | 5 |
| On-chain risk | `/customers/:id/web3-risk` | 2 |
| Insights & inbox | `/analytics`, `/notifications` | 2 |
| Settings & administration | `/settings` panels, `/settings/mfa`, `/settings/admin-mfa-reset`, `/admin-password-reset` | 10 |

## 🔐 Sign-in & recovery

Password sign-in, the two-step verification challenge, and the on-screen password-reset wizard.

**Email and password sign-in**

![Email and password sign-in](assets/screenshots/login.png)

*`/login` — the operator sign-in form. Access tokens stay in memory; the session survives reloads through a rotating httpOnly refresh cookie.*

**One-click demo role sign-in**

![One-click demo role sign-in](assets/screenshots/login-demo-roles.png)

*`/login` — quick-fill entries for the three seeded roles — Administrator, Compliance Officer, Viewer — above a clearly labeled demo banner.*

**Dark sign-in**

![Dark sign-in](assets/screenshots/login-dark.png)

*`/login` — the sign-in surface rendered with the same runtime dark-theme tokens used throughout the console.*

**Two-step verification challenge**

![Two-step verification challenge](assets/screenshots/mfa-verify.png)

*`/mfa/verify` — the mid-login authenticator-code challenge, with a remember-this-device option and a single-use backup-code fallback.*

**Password reset, account step**

![Password reset, account step](assets/screenshots/forgot-password-email.png)

*`/forgot-password` — the reset wizard opens by identifying the account by operator email.*

**Password reset, verification step**

![Password reset, verification step](assets/screenshots/forgot-password-otp.png)

*`/forgot-password` — the one-time-code entry step; the code is checked before the wizard advances to setting a new password.*

**Password reset, new password**

![Password reset, new password](assets/screenshots/forgot-password-reset.png)

*`/forgot-password` — the final step, with a live strength meter and a passwords-match check before submission.*

## 📊 Dashboard & realtime

The operations landing page, live without a refresh.

**Live operations dashboard**

![Live operations dashboard](assets/screenshots/dashboard-light.png)

*`/dashboard` — KPI tiles, a recent-customers list fed over Server-Sent Events (SSE), and KYC-distribution and customer-trend charts drawn by hand-written chart components.*

**Dashboard loading skeleton**

![Dashboard loading skeleton](assets/screenshots/dashboard-skeleton.png)

*`/dashboard` while data loads — skeleton blocks mirror the final layout so the page settles without jumps.*

## 🎨 Theming & i18n

The same screen, re-skinned and re-translated — both are runtime switches, not separate builds.

**Dashboard in dark theme**

![Dashboard in dark theme](assets/screenshots/dashboard-dark.png)

*The dashboard with the dark theme active — surfaces, charts, and badges all follow SCSS design tokens, so the theme is a token swap rather than a re-style.*

**Dashboard in Turkish**

![Dashboard in Turkish](assets/screenshots/dashboard-tr.png)

*The dashboard in Turkish — 963 translation keys per language, with English/Turkish parity enforced by `npm run i18n:check`.*

## 👥 Customers & KYC

Day-to-day customer operations, with PII masked by default and sensitive actions permission-gated.

**Masked customer directory**

![Masked customer directory](assets/screenshots/customers-list.png)

*`/customers` — masked PII by default, status tabs, a KYC filter, pagination, and a permission-gated reveal action that is audited server-side.*

**Guided customer creation**

![Guided customer creation](assets/screenshots/customer-create.png)

*`/customers/new` — an identity and address form with inline validation before submission.*

**Customer 360 view**

![Customer 360 view](assets/screenshots/customer-detail.png)

*`/customers/:id` — identity, balances, transactions, wallet limits, and the KYC and risk-decision history on a single screen.*

**Inline edit validation**

![Inline edit validation](assets/screenshots/customer-edit-validation.png)

*`/customers/:id/edit` — field-level validation errors surface inline as the form is corrected.*

**Guarded delete confirmation**

![Guarded delete confirmation](assets/screenshots/customer-delete-modal.png)

*The delete-customer dialog — deletion is an Administrator-only permission, and even then it demands explicit confirmation.*

## ⛓️ On-chain risk

Non-custodial wallet review: the reads are real, the AML signals are simulated and labeled as such.

**Read-only on-chain snapshot**

![Read-only on-chain snapshot](assets/screenshots/web3-risk.png)

*`/customers/:id/web3-risk` — key-free reads from a public Ethereum JSON-RPC endpoint, kept visually separate from the simulated AML signals.*

**Flagged risk signal review**

![Flagged risk signal review](assets/screenshots/web3-risk-flagged.png)

*The same flow with a simulated signal flagged, feeding the operator's allow / review / block decision.*

## 📈 Insights & inbox

Portfolio-level trends and the operator's own notification feed.

**Portfolio analytics overview**

![Portfolio analytics overview](assets/screenshots/analytics.png)

*`/analytics` — volume over time, a customer-status split, and a KYC breakdown across the 1,500-customer seed portfolio.*

**Severity-badged notification inbox**

![Severity-badged notification inbox](assets/screenshots/notifications.png)

*`/notifications` — the operator notification feed, filterable by read state, type, and severity.*

## ⚙️ Settings & administration

Self-service account settings plus the Administrator-only recovery surfaces.

**Settings shell and profile**

![Settings shell and profile](assets/screenshots/settings.png)

*`/settings` — the profile panel inside the settings shell: an identity banner plus a tab rail for Profile, Security, Appearance, Language, Notifications, and Access.*

**Security settings panel**

![Security settings panel](assets/screenshots/settings-security.png)

*The Security tab — enable two-step verification, manage trusted devices, and reach the Administrator recovery tools.*

**Appearance settings**

![Appearance settings](assets/screenshots/settings-appearance.png)

*The Appearance tab — the runtime theme selector and motion preference controls.*

**Appearance settings in dark theme**

![Appearance settings in dark theme](assets/screenshots/settings-appearance-dark.png)

*The same Appearance panel in dark mode, verifying the theme switch inside the settings workflow.*

**Language settings**

![Language settings](assets/screenshots/settings-language.png)

*The Language tab — English and Turkish locale controls.*

**Notification settings**

![Notification settings](assets/screenshots/settings-notifications.png)

*The Notifications tab — operator delivery preferences.*

**Access and system health settings**

![Access and system health settings](assets/screenshots/settings-access.png)

*The Access tab — session and service-health visibility for the current operator.*

**Two-step verification enrolment**

![Two-step verification enrolment](assets/screenshots/mfa-setup.png)

*`/settings/mfa` — the enrolment wizard, captured at the password-confirmation step: deliberately before any QR code or TOTP secret exists on screen.*

**Administrator password-reset queue**

![Administrator password-reset queue](assets/screenshots/admin-password-reset.png)

*`/admin-password-reset` — reset a locked-out operator's password and review the pending-request queue.*

**Administrator MFA reset**

![Administrator MFA reset](assets/screenshots/admin-mfa-reset.png)

*`/settings/admin-mfa-reset` — clear a locked-out operator's two-step verification so they can re-enrol with a fresh authenticator.*

## 📸 Capture standard

One capture standard keeps the gallery comparable as the product evolves.

| Aspect | Standard |
| --- | --- |
| Account | An Administrator holding the full permission set, so every permission-gated control is visible |
| Locale and theme | English, light theme; dark and Turkish variants exist only where they demonstrate theming and i18n |
| Frame | 1600×1511 viewport capture — the app shell scrolls internally, so frames are viewport shots, not stitched full-page captures. Rendered at 2× device scale, then downsampled to 1600 px wide: crisp text without retina-weight files |
| Secrets | Never a usable secret on screen — the two-step verification wizard is shot at the password step, before any QR code or TOTP secret is generated |
| Rendering | The real Angular application, driven through its real UI in Chrome — never a mockup or a design file |
| Data | Deterministic stubbed API responses, not database rows. Cypress intercepts every `/api/v1` call (with a catch-all `404` for anything unstubbed), the SSE stream, and the public Ethereum RPC — so no backend state, seed drift, or live on-chain value can reach a frame |

Stubbing the data layer is what makes the gallery stable: a frame changes only when the interface
changes, never because the seed produced different customers today. Every committed frame is
1600×1511 — verify with `sips -g pixelWidth -g pixelHeight docs/assets/screenshots/*.png`.

Regeneration is scripted for every frame. The lane drives the web dev server on `:4200`
(`npm run dev` from the repo root starts it):

```bash
# 1. Capture each frame from the running web app, at 2x device scale.
npm --prefix Web run e2e:docs-shots

# 2. Downsample to the committed 1600 px standard and copy into place.
#    sips ships with macOS; any resampler that preserves the aspect ratio works.
for frame in Web/cypress/artifacts/screenshots/capture.cy.ts/*.png; do
  sips --resampleWidth 1600 "$frame" --out "docs/assets/screenshots/$(basename "$frame")"
done
```

The lane's spec is `Web/cypress/docs-screenshots/capture.cy.ts`. It sits outside the default Cypress
spec pattern, so plain `cypress run` and CI never execute it. Captured frames land in
`Web/cypress/artifacts/screenshots/capture.cy.ts/` and are copied into `docs/assets/screenshots/` after
review. No production account, secret, QR code or external RPC response is captured.

## 🔗 See also

- [Documentation hub](README.md)
- [Getting started](getting-started.md) — run the stack these frames were captured from
- [Architecture](architecture.md) — how the screens fit the system underneath
