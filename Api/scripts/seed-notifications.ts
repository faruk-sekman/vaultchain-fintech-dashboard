/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * DEV-ONLY notification seeder (manual, not part of CI). The customer/ledger seeders
 * (`seed-dev.ts` / `seed-fake-data.ts`) do NOT create notifications — those are normally produced by
 * real domain events — so the redesigned `/notifications` page + header popover render the empty
 * state on a fresh dev DB. This fills a realistic, recipient-scoped feed for the two seed operators
 * so the surfaces can be demoed/QA'd with real data (honest: real `notifications` rows via the real
 * `titleKey`/`bodyKey` i18n contract, NOT fabricated client-side copy).
 *
 * It is IDEMPOTENT and SCOPED: it deletes ONLY the seed recipients' own notifications, then re-inserts
 * a fresh set — it never touches another user's feed, and never any other table. `paramsJson` is left
 * null (every key used is a static sentence with no interpolation), so it is inert to the read-path
 * params/value guard. Some rows deep-link to a real customer (`resourceType: 'customer'`), most carry
 * no PII. Severities/types/read-states/timestamps are varied so the type/severity filters, the
 * unread emphasis, and the Bugün/Daha eski date grouping are all exercised.
 *
 * Run (local only):
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:55440/fintech_dev npx ts-node scripts/seed-notifications.ts
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { assertLocalDb } from '../src/common/util/assert-local-db';

type NType = 'SECURITY_ALERT' | 'KYC_EVENT' | 'CUSTOMER_EVENT' | 'SYSTEM' | 'ACCOUNT';
type NSeverity = 'info' | 'success' | 'warning' | 'critical';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Recipient seed operators (created by seed-dev.ts). Missing ones are skipped, not an error. */
const RECIPIENT_EMAILS = ['admin@example.com', 'operator@example.com'] as const;

/**
 * The feed template. `ago` is milliseconds before "now" (spread across today + earlier so the date
 * grouping has both buckets). `unread` → readAt null. `customerLink` pulls a real customerId so the
 * row deep-links to the customer detail; security/account rows point at the recipient's own user id.
 * Every titleKey/bodyKey ALREADY EXISTS in the FE bundle (tr.json/en.json) with TR+EN parity, so the
 * rows render real localized copy, never the fallback.
 */
interface Tpl {
  type: NType;
  severity: NSeverity;
  key: string; // shared title/body namespace: `${key}.title` / `${key}.body`
  ago: number;
  unread: boolean;
  resource: 'self' | 'session' | 'customer' | 'system';
  customerLink?: number; // index into the fetched customers list
}

const TEMPLATES: readonly Tpl[] = [
  // --- today (Bugün) ---
  { type: 'SECURITY_ALERT', severity: 'critical', key: 'notifications.security.accountLockout', ago: 12 * MIN, unread: true, resource: 'self' },
  { type: 'KYC_EVENT', severity: 'info', key: 'notifications.kyc.statusChanged', ago: 3 * HOUR, unread: true, resource: 'customer', customerLink: 1 },
  { type: 'CUSTOMER_EVENT', severity: 'success', key: 'notifications.customer.created', ago: 5 * HOUR, unread: true, resource: 'customer', customerLink: 0 },
  { type: 'SECURITY_ALERT', severity: 'warning', key: 'notifications.security.newTrustedDevice', ago: 8 * HOUR, unread: false, resource: 'session' },
  { type: 'ACCOUNT', severity: 'info', key: 'notifications.account.signedIn', ago: 10 * HOUR, unread: false, resource: 'self' },
  // --- earlier (Daha eski) ---
  { type: 'SECURITY_ALERT', severity: 'critical', key: 'notifications.security.adminPasswordReset', ago: 1 * DAY + 2 * HOUR, unread: false, resource: 'self' },
  { type: 'KYC_EVENT', severity: 'success', key: 'notifications.kyc.statusChanged', ago: 1 * DAY + 6 * HOUR, unread: false, resource: 'customer', customerLink: 2 },
  { type: 'SYSTEM', severity: 'info', key: 'notifications.system.maintenance', ago: 2 * DAY, unread: false, resource: 'system' },
  { type: 'SECURITY_ALERT', severity: 'warning', key: 'notifications.security.adminMfaReset', ago: 3 * DAY, unread: false, resource: 'self' },
  { type: 'KYC_EVENT', severity: 'warning', key: 'notifications.kyc.statusChanged', ago: 4 * DAY, unread: false, resource: 'customer', customerLink: 0 },
];

async function main(): Promise<void> {
  // F2: strict, URL-parsed host-allowlist guard (shared) — replaces the earlier @host substring regex.
  const url = assertLocalDb({ script: 'seed-notifications' });
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });

  try {
    const recipients = await prisma.user.findMany({
      where: { email: { in: [...RECIPIENT_EMAILS] } },
      select: { id: true, email: true },
    });
    if (recipients.length === 0) {
      throw new Error('No seed recipients found (run seed-dev.ts first to create admin@/operator@example.com).');
    }

    // A few real, non-deleted customers for the customer-scoped deep-links (newest first).
    const customers = await prisma.customer.findMany({
      where: { deletedAt: null },
      select: { id: true },
      orderBy: { updatedAt: 'desc' },
      take: 3,
    });

    const now = Date.now();
    let inserted = 0;

    for (const recipient of recipients) {
      // Idempotent + scoped: clear ONLY this recipient's notifications, then re-seed.
      await prisma.notification.deleteMany({ where: { recipientUserId: recipient.id } });

      const rows = TEMPLATES.map((t) => {
        const resourceId =
          t.resource === 'customer'
            ? (customers[t.customerLink ?? 0]?.id ?? null)
            : t.resource === 'self'
              ? recipient.id
              : null;
        return {
          id: randomUUID(),
          recipientUserId: recipient.id,
          type: t.type,
          severity: t.severity,
          titleKey: `${t.key}.title`,
          bodyKey: `${t.key}.body`,
          paramsJson: undefined, // inert to the read-path params/value guard (keys are static)
          resourceType: t.resource === 'customer' ? 'customer' : t.resource === 'session' ? 'session' : t.resource === 'system' ? 'system' : 'user',
          resourceId,
          readAt: t.unread ? null : new Date(now - Math.floor(t.ago / 2)),
          createdAt: new Date(now - t.ago),
        };
      });

      await prisma.notification.createMany({ data: rows });
      inserted += rows.length;
      const unread = rows.filter((r) => r.readAt === null).length;
      console.log(`seed-notifications: ${recipient.email} → ${rows.length} notifications (${unread} unread).`);
    }

    console.log(`seed-notifications: done. Inserted ${inserted} rows for ${recipients.length} recipient(s). Customer deep-links: ${customers.length}.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error('seed-notifications failed:', e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
