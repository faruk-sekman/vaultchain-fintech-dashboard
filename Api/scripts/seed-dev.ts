/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Dev-only seed: local operator + realistic fintech scenario data for end-to-end UI testing.
 * It resets the LOCAL customer/ledger scenario dataset, then creates:
 * - 1 operator user with read/write local permissions
 * - 1500 visible customers with varied KYC/status/risk/address/wallet data
 * - TRY/USD/EUR wallets per customer
 * - 28-45 customer-authored transactions per currency, plus incoming transfers from peers
 *   and coverage rows for every transaction kind/status/currency filter
 * - analytics materialized views refreshed and daily metric rollups backfilled for charts
 *
 * NEVER run against production or shared databases. The script fail-fast checks DATABASE_URL.
 * Usage: `DATABASE_URL=postgresql://postgres:postgres@localhost:55440/fintech_dev npx ts-node scripts/seed-dev.ts`.
 */
import 'reflect-metadata';
import { hash } from '@node-rs/argon2';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'node:crypto';
import { ANALYTICS_DDL } from '../src/modules/analytics/analytics.ddl';
import { AnalyticsService } from '../src/modules/analytics/analytics.service';
import type { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { assertLocalDb } from '../src/common/util/assert-local-db';

const DEFAULT_CURRENCY = 'TRY';
const CURRENCIES = [
  { code: 'TRY', name: 'Turkish Lira', majorDivisor: 1, dailyBase: 5_000, monthlyBase: 75_000 },
  { code: 'USD', name: 'US Dollar', majorDivisor: 35, dailyBase: 500, monthlyBase: 7_500 },
  { code: 'EUR', name: 'Euro', majorDivisor: 38, dailyBase: 450, monthlyBase: 7_000 },
] as const;
const CUSTOMER_COUNT = 1500;
const TX_COUNT_PATTERN = [28, 32, 36, 40, 45, 30, 34, 38, 42, 29, 33, 37] as const;
const BATCH_SIZE = 750;
const TX_BATCH_SIZE = 1500;
const COMPLIANCE_COVERAGE_PERCENT = 70;
const LIMIT_USAGE_BASES = [14, 38, 68, 91] as const;

// Exported so a seed/RBAC test can assert the resolved permission set without importing this module's
// side effects (see the require.main guard below). Every code is served by a controller
// `@RequirePermissions(...)` EXCEPT `customers.pii.reveal`: it is a RESPONSE-SCOPE permission
// reached only via the `customers.read`-gated GET routes and consumed by the
// CustomersService mapper to unmask PII — intentionally NOT a standalone route gate. `customers.delete`
// IS served by the re-gated `@Delete(':id')` route. Historical removals: `audit-logs.read`
// (no route serves the audit chain), bare `wallets.manage` (the limit route is
// gated by the canonical `wallets.manage-limits`).
//
// INVARIANT (asserted in seed-permissions.spec.ts): `PERMISSIONS` must equal the union of every role's
// codes as a set, so the exported dictionary can never silently drift from what `ROLES` actually grants.
export const PERMISSIONS = [
  'customers.read',
  'customers.manage',
  'customers.update',
  'customers.delete',
  'customers.pii.reveal',
  'wallets.read',
  'wallets.manage-limits',
  'transactions.read',
  'transactions.create',
  'kyc.read',
  'kyc.manage',
  'roles.read',
  'roles.manage',
  'permissions.manage',
  'users.manage',
  'auth.mfa.admin_reset',
  'auth.password.admin_reset',
];

/**
 * Enterprise role → permission matrix. The single source of truth for the seed
 * loop and the PER-ROLE prune. `subtitle` is a documented human label only (no `Role` column yet):
 *  - `administrator` — everything (incl. reveal + delete + role/permission/user management).
 *  - `operator` ("Compliance Officer") — day-to-day ops; NO delete, NO PII reveal, NO role/permission/user mgmt.
 *  - `auditor` ("Viewer") — read-only oversight.
 * Each role's codes are written EXPLICITLY (not derived from PERMISSIONS) so the spec's
 * `set(PERMISSIONS) === set(union of role codes)` cross-check can actually catch a drift.
 */
export const ROLES: ReadonlyArray<{ name: string; subtitle: string | null; codes: string[] }> = [
  {
    name: 'administrator',
    subtitle: null,
    codes: [
      'customers.read',
      'customers.manage',
      'customers.update',
      'customers.delete',
      'customers.pii.reveal',
      'wallets.read',
      'wallets.manage-limits',
      'transactions.read',
      'transactions.create',
      'kyc.read',
      'kyc.manage',
      'roles.read',
      'roles.manage',
      'permissions.manage',
      'users.manage',
      'auth.mfa.admin_reset',
      'auth.password.admin_reset',
    ],
  },
  {
    name: 'operator',
    subtitle: 'Compliance Officer',
    codes: [
      'customers.read',
      'customers.manage',
      'wallets.read',
      'wallets.manage-limits',
      'transactions.read',
      'transactions.create',
      'kyc.read',
      'kyc.manage',
      'roles.read',
    ],
  },
  {
    name: 'auditor',
    subtitle: 'Viewer',
    codes: ['customers.read', 'wallets.read', 'transactions.read', 'kyc.read', 'roles.read'],
  },
];

/** Union of every role's codes — the retained dictionary for the union-scoped orphan-permission cleanup. */
export const ALL_ROLE_CODES = [...new Set(ROLES.flatMap((r) => r.codes))];

/** Dev-only fallback password (obviously non-secret); override per role via the env vars below. */
const DEFAULT_DEV_PASSWORD = 'Test-Passw0rd!';

/** One fake dev seed user per role. `operator@example.com` is preserved as the Operator identity (D4). */
const SEED_USERS: ReadonlyArray<{ email: string; passwordEnv: string; displayName: string; role: string }> = [
  { email: 'admin@example.com', passwordEnv: 'SEED_ADMIN_PASSWORD', displayName: 'Local Administrator', role: 'administrator' },
  { email: 'operator@example.com', passwordEnv: 'SEED_OPERATOR_PASSWORD', displayName: 'Local Operator', role: 'operator' },
  { email: 'auditor@example.com', passwordEnv: 'SEED_AUDITOR_PASSWORD', displayName: 'Local Auditor', role: 'auditor' },
];

const FIRST_NAMES = [
  'Ada', 'Deniz', 'Elif', 'Mert', 'Zeynep', 'Kerem', 'Aylin', 'Baran', 'Selin', 'Emir',
  'Derya', 'Can', 'Mina', 'Ege', 'Lara', 'Arda', 'Nehir', 'Bora', 'İpek', 'Kaan',
  'Defne', 'Ozan', 'Sena', 'Alp', 'Maya', 'Tuna', 'Eylül', 'Rüzgar', 'Asya', 'Atlas',
  'Cemre', 'Doruk', 'Yasemin', 'Sinan', 'Nil', 'Onur', 'Begüm', 'Levent', 'Ceren', 'Tolga',
  'Melis', 'Umut', 'İdil', 'Sarp', 'Gizem', 'Burak', 'Bade', 'Eren', 'Pelin', 'Çağrı',
  'Lina', 'Yiğit', 'Naz', 'Kuzey', 'Dila', 'Murat', 'İrem', 'Ali', 'Esra', 'Cem',
  'Mira', 'Fırat', 'Hazal', 'Efe', 'Buse', 'Kaya', 'Ela', 'Tibet', 'Sude', 'Koral',
];

const SURNAMES = [
  'Yılmaz', 'Kaya', 'Demir', 'Şahin', 'Çelik', 'Yıldız', 'Yıldırım', 'Öztürk', 'Aydın', 'Özdemir',
  'Arslan', 'Doğan', 'Kılıç', 'Aslan', 'Çetin', 'Kara', 'Koç', 'Kurt', 'Özkan', 'Şimşek',
  'Polat', 'Özkanlı', 'Aksoy', 'Taş', 'Avcı', 'Erdoğan', 'Tekin', 'Güneş', 'Bozkurt', 'Bulut',
  'Keskin', 'Ünal', 'Turan', 'Koçak', 'Acar', 'Korkmaz', 'Işık', 'Kaplan', 'Sezer', 'Erdem',
  'Güler', 'Bulutay', 'Karaca', 'Sönmez', 'Özer', 'Ayhan', 'Duman', 'Köse', 'Başar', 'Uysal',
  'Tan', 'Alkan', 'Peker', 'Bilgin', 'Ergin', 'Sarı', 'Bayram', 'Solmaz', 'Ekinci', 'Mavioğlu',
];

const CITIES = [
  ['İstanbul', ['Kadıköy', 'Beşiktaş', 'Üsküdar', 'Ataşehir', 'Şişli', 'Bakırköy']],
  ['Ankara', ['Çankaya', 'Yenimahalle', 'Keçiören', 'Etimesgut', 'Gölbaşı']],
  ['İzmir', ['Karşıyaka', 'Bornova', 'Konak', 'Buca', 'Balçova']],
  ['Bursa', ['Nilüfer', 'Osmangazi', 'Yıldırım', 'Mudanya']],
  ['Antalya', ['Muratpaşa', 'Konyaaltı', 'Kepez', 'Alanya']],
  ['Eskişehir', ['Odunpazarı', 'Tepebaşı']],
  ['Konya', ['Selçuklu', 'Meram', 'Karatay']],
  ['Kocaeli', ['İzmit', 'Gebze', 'Derince', 'Başiskele']],
  ['Adana', ['Seyhan', 'Çukurova', 'Yüreğir']],
  ['Kayseri', ['Melikgazi', 'Kocasinan', 'Talas']],
] as const;

const STREETS = [
  'Atatürk Caddesi', 'Cumhuriyet Sokak', 'Bağdat Caddesi', 'İnönü Bulvarı', 'İstasyon Caddesi',
  'Lale Sokak', 'Menekşe Sokak', 'Zeytinlik Caddesi', 'Mimar Sinan Sokak', 'Sahil Yolu',
  'Finans Merkezi Caddesi', 'Kervan Sokak', 'Akdeniz Bulvarı', 'Anadolu Caddesi', 'Teknoloji Sokak',
];

const MERCHANTS = [
  'Migros Market', 'Macrocenter', 'Shell Akaryakıt', 'Trendyol', 'Hepsiburada', 'Yemeksepeti',
  'Kahve Dünyası', 'Türk Telekom', 'Turkcell', 'İstanbulkart', 'Metro Market', 'Watsons',
  'Decathlon', 'Teknosa', 'IKEA', 'Mavi', 'Gratis', 'LC Waikiki', 'Boyner', 'Pegasus',
  'Netflix', 'Spotify', 'Amazon Prime', 'Fatura Merkezi', 'Eczane', 'Veteriner Kliniği',
  'Kitapçı', 'Otopark', 'Ofis Malzemeleri', 'Spor Salonu',
];

const DEPOSIT_DESCRIPTIONS = [
  'Maaş ödemesi', 'Serbest çalışma geliri', 'Kira tahsilatı', 'Havale girişi', 'Prim ödemesi',
  'İade tahsilatı', 'Birikim transferi', 'Aile desteği', 'Satış geliri', 'Temettü ödemesi',
];

const FEE_DESCRIPTIONS = [
  'FAST işlem ücreti', 'Aylık hesap bakım ücreti', 'Kart yenileme ücreti', 'Para çekme ücreti',
  'Yurt dışı işlem komisyonu', 'Limit güncelleme hizmet ücreti',
];

const ADJUSTMENT_DESCRIPTIONS = [
  'Mutabakat düzeltmesi', 'Promosyon bakiyesi düzeltmesi', 'Operasyonel bakiye düzeltmesi',
  'Harcama itirazı düzeltmesi', 'Kur farkı muhasebe düzeltmesi', 'Kampanya iadeli düzeltme',
];

const REVERSAL_DESCRIPTIONS = [
  'İade ters kaydı', 'Hatalı işlem ters kaydı', 'Kart harcaması iadesi', 'Transfer iptal kaydı',
  'Ücret iadesi ters kaydı', 'Mutabakat sonrası geri alma',
];

interface SeedCustomerRef {
  id: string;
  fullName: string;
  email: string;
  wallets: Record<SeedCurrency, SeedWalletRef>;
}

interface WalletRef {
  id: string;
  accountId: string;
  currency: SeedCurrency;
  balance: bigint;
}

type SeedCurrency = (typeof CURRENCIES)[number]['code'];
type SeedWalletRef = WalletRef;
type SeedTransactionKind = 'DEPOSIT' | 'WITHDRAWAL' | 'TRANSFER' | 'FEE' | 'ADJUSTMENT' | 'REVERSAL';
type SeedTransactionStatus = 'PENDING' | 'POSTED' | 'FAILED' | 'REVERSED';
type SeedLedgerLeg = 'DEBIT' | 'CREDIT';

function assertLocalDatabase(): string {
  // F2: strict, URL-parsed host-allowlist guard (shared) — replaces the earlier @host substring regex.
  return assertLocalDb({ script: 'seed-dev' });
}

function pick<T>(items: readonly T[], i: number, salt = 1): T {
  return items[Math.abs(i * salt + salt * 17) % items.length];
}

function weighted<T extends string>(weights: readonly [T, number][], i: number, salt: number): T {
  const total = weights.reduce((sum, [, weight]) => sum + weight, 0);
  let point = Math.abs((i * 37 + salt * 97) % total);
  for (const [value, weight] of weights) {
    if (point < weight) return value;
    point -= weight;
  }
  return weights[0][0];
}

function cents(lira: number): bigint {
  return BigInt(Math.round(lira * 100));
}

function currencyMajor(currency: SeedCurrency, tryMajorEquivalent: number): number {
  const profile = CURRENCIES.find((item) => item.code === currency);
  return Math.max(1, Math.round(tryMajorEquivalent / (profile?.majorDivisor ?? 1)));
}

function limitMinor(currency: SeedCurrency, baseMajor: number, n: number, spreadMajor: number): bigint {
  const base = baseMajor;
  const spread = currency === DEFAULT_CURRENCY ? spreadMajor : Math.max(250, spreadMajor);
  return cents(base + ((n * 37) % spread));
}

function dateDaysAgo(days: number, hourSeed: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours((hourSeed * 7) % 24, (hourSeed * 13) % 60, 0, 0);
  return d;
}

function birthDate(i: number): Date {
  const year = 1958 + ((i * 19) % 45);
  const month = (i * 7) % 12;
  const day = 1 + ((i * 11) % 27);
  return new Date(Date.UTC(year, month, day));
}

function normalized(value: string): string {
  return value
    .toLocaleLowerCase('tr-TR')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ı/g, 'i')
    .replace(/ğ/g, 'g')
    .replace(/ü/g, 'u')
    .replace(/ş/g, 's')
    .replace(/ö/g, 'o')
    .replace(/ç/g, 'c')
    .replace(/[^a-z0-9]+/g, '.');
}

function walletNumber(i: number): string {
  return `TR${String(1000000000000000 + i * 7919).slice(0, 16)}`;
}

function phone(i: number): string {
  const prefix = ['530', '532', '533', '541', '542', '551', '552', '555'][i % 8];
  return `+90${prefix}${String(1000000 + ((i * 48271) % 9000000)).padStart(7, '0')}`;
}

function nationalIdLast4(i: number): string {
  return String(1000 + ((i * 811) % 9000));
}

function transactionCount(i: number): number {
  // The first cycle exactly follows the requested variety; later cycles keep that shape with
  // deterministic jitter so paging totals are not synthetic-looking duplicates.
  const base = TX_COUNT_PATTERN[i % TX_COUNT_PATTERN.length];
  if (i < TX_COUNT_PATTERN.length) return base;
  const jitter = ((i * 7) % 5) - 2;
  return Math.max(3, Math.min(45, base + jitter));
}

function hasComplianceCoverage(index: number): boolean {
  return index % 100 < COMPLIANCE_COVERAGE_PERCENT;
}

function limitUsagePercent(customerIndex: number, currencyIndex: number): number {
  const base = LIMIT_USAGE_BASES[(customerIndex + currencyIndex * 2) % LIMIT_USAGE_BASES.length];
  const jitter = ((customerIndex * 11 + currencyIndex * 17) % 9) - 4;
  return Math.max(5, Math.min(97, base + jitter));
}

function dailyLimitFromMonthly(monthlyLimitMinor: bigint, usagePercent: number): bigint {
  return (monthlyLimitMinor * BigInt(usagePercent)) / 100n;
}

async function ensureRolesAndUsers(prisma: PrismaClient): Promise<void> {
  // Upsert the whole permission dictionary once, keyed by code → id.
  const permissionIdByCode = new Map<string, string>();
  for (const code of ALL_ROLE_CODES) {
    const permission = await prisma.permission.upsert({
      where: { code },
      create: { id: randomUUID(), code },
      update: {},
    });
    permissionIdByCode.set(code, permission.id);
  }

  // Upsert each role + grant EXACTLY its matrix codes, then PER-ROLE prune so the role converges to its
  // matrix on every run. The prune is the least-privilege downscope (D4): a legacy broad
  // `operator` role still carrying `roles.manage`/`permissions.manage`/`users.manage` loses them here,
  // because those codes are `notIn` the (now restricted) Operator matrix. Scoped to THIS role's id so it
  // never touches another role's grants.
  for (const roleDef of ROLES) {
    const role =
      (await prisma.role.findFirst({ where: { name: roleDef.name } })) ??
      (await prisma.role.create({ data: { id: randomUUID(), name: roleDef.name } }));

    for (const code of roleDef.codes) {
      const permissionId = permissionIdByCode.get(code)!;
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: role.id, permissionId } },
        create: { roleId: role.id, permissionId },
        update: {},
      });
    }

    await prisma.rolePermission.deleteMany({
      where: { roleId: role.id, permission: { code: { notIn: roleDef.codes } } },
    });
  }

  // Union-scoped orphan-permission cleanup: drop permission rows no longer in ANY role's matrix and
  // referenced by no grant. The `rolePermissions: { none: {} }` guard guarantees no grant references the
  // row, so no FK/cascade violation can occur; codes still granted by ANY role are left untouched.
  await prisma.permission.deleteMany({
    where: { code: { notIn: ALL_ROLE_CODES }, rolePermissions: { none: {} } },
  });

  // One fake dev user per role (idempotent). Passwords from env with a documented non-secret dev default;
  // never a committed real credential. Each user converges to EXACTLY its one role.
  for (const seed of SEED_USERS) {
    const password = process.env[seed.passwordEnv] ?? DEFAULT_DEV_PASSWORD;
    const user =
      (await prisma.user.findUnique({ where: { email: seed.email } })) ??
      (await prisma.user.create({
        data: { id: randomUUID(), email: seed.email, passwordHash: await hash(password), displayName: seed.displayName },
      }));
    const role = await prisma.role.findUniqueOrThrow({ where: { name: seed.role } });
    await prisma.userRole.upsert({
      where: { userId_roleId: { userId: user.id, roleId: role.id } },
      create: { userId: user.id, roleId: role.id },
      update: {},
    });
    // Drop any other role mapping from a prior seed shape so the user holds exactly its one role.
    await prisma.userRole.deleteMany({ where: { userId: user.id, roleId: { not: role.id } } });
  }
}

async function resetLocalDomainData(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe('DROP SCHEMA IF EXISTS analytics CASCADE');
  await prisma.riskSignal.deleteMany();
  await prisma.riskAssessment.deleteMany();
  await prisma.kycVerification.deleteMany();
  await prisma.ledgerEntry.deleteMany();
  await prisma.transaction.deleteMany();
  await prisma.idempotencyKey.deleteMany();
  await prisma.walletBalance.deleteMany();
  await prisma.wallet.deleteMany();
  await prisma.account.deleteMany();
  await prisma.customer.deleteMany();
}

async function ensureDbObjects(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe('CREATE SEQUENCE IF NOT EXISTS transaction_public_ref_seq');
  await prisma.$executeRawUnsafe('ALTER SEQUENCE transaction_public_ref_seq RESTART WITH 1');
  await prisma.$executeRawUnsafe('ALTER TABLE ledger_entries DROP CONSTRAINT IF EXISTS ledger_entries_leg_check');
  await prisma.$executeRawUnsafe("ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_leg_check CHECK (leg IN ('DEBIT','CREDIT'))");
  await prisma.$executeRawUnsafe('ALTER TABLE ledger_entries DROP CONSTRAINT IF EXISTS ledger_entries_amount_check');
  await prisma.$executeRawUnsafe('ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_amount_check CHECK (amount_minor > 0)');
  await prisma.$executeRawUnsafe('ALTER TABLE wallets DROP CONSTRAINT IF EXISTS wallets_system_purpose_check');
  await prisma.$executeRawUnsafe("ALTER TABLE wallets ADD CONSTRAINT wallets_system_purpose_check CHECK (system_purpose IS NULL OR system_purpose IN ('CLEARING','REVENUE'))");
  await prisma.$executeRawUnsafe('ALTER TABLE wallets DROP CONSTRAINT IF EXISTS wallets_system_coupling_check');
  await prisma.$executeRawUnsafe("ALTER TABLE wallets ADD CONSTRAINT wallets_system_coupling_check CHECK ((is_system AND system_purpose IS NOT NULL) OR (NOT is_system AND system_purpose IS NULL))");
  await prisma.$executeRawUnsafe('CREATE UNIQUE INDEX IF NOT EXISTS wallets_system_lookup ON wallets (currency, system_purpose) WHERE is_system');
}

async function createMany<T>(items: T[], write: (chunk: T[]) => Promise<unknown>, size = BATCH_SIZE): Promise<void> {
  for (let start = 0; start < items.length; start += size) {
    await write(items.slice(start, start + size));
  }
}

async function seedReferenceData(prisma: PrismaClient): Promise<void> {
  for (const currency of CURRENCIES) {
    await prisma.currency.upsert({
      where: { code: currency.code },
      create: { code: currency.code, name: currency.name, scale: 2, isActive: true },
      update: { name: currency.name, scale: 2, isActive: true },
    });
  }
}

function buildCustomers(): {
  customers: Prisma.CustomerCreateManyInput[];
  accounts: Prisma.AccountCreateManyInput[];
  wallets: Prisma.WalletCreateManyInput[];
  kycVerifications: Prisma.KycVerificationCreateManyInput[];
  refs: SeedCustomerRef[];
} {
  const customers: Prisma.CustomerCreateManyInput[] = [];
  const accounts: Prisma.AccountCreateManyInput[] = [];
  const wallets: Prisma.WalletCreateManyInput[] = [];
  const kycVerifications: Prisma.KycVerificationCreateManyInput[] = [];
  const refs: SeedCustomerRef[] = [];

  for (let n = 1; n <= CUSTOMER_COUNT; n += 1) {
    const firstIndex = (n - 1) % FIRST_NAMES.length;
    const surnameBlock = Math.floor((n - 1) / FIRST_NAMES.length);
    const first = FIRST_NAMES[firstIndex];
    const last = SURNAMES[(firstIndex * 17 + surnameBlock) % SURNAMES.length];
    const middle = n % 13 === 0 ? ` ${FIRST_NAMES[(firstIndex + surnameBlock * 5 + 11) % FIRST_NAMES.length]}` : '';
    const secondSurname = n % 17 === 0 ? ` ${SURNAMES[(firstIndex * 7 + surnameBlock * 3 + 19) % SURNAMES.length]}` : '';
    const fullName = `${first}${middle} ${last}${secondSurname}`;
    const [city, districts] = pick(CITIES, n, 3);
    const district = pick(districts, n, 5);
    const street = pick(STREETS, n, 9);
    const createdDaysAgo = (n * 11) % 356;
    const updatedDaysAgo = Math.min(createdDaysAgo, (n * 3) % 90);
    const createdAt = dateDaysAgo(createdDaysAgo, n);
    const updatedAt = dateDaysAgo(updatedDaysAgo, n + 11);
    const hasComplianceData = hasComplianceCoverage(n - 1);
    const kycStatus = hasComplianceData
      ? weighted(
          [
            ['VERIFIED', 54],
            ['PENDING', 14],
            ['IN_REVIEW', 12],
            ['REJECTED', 11],
            ['EXPIRED', 9],
          ] as const,
          n,
          2,
        )
      : weighted(
          [
            ['NOT_STARTED', 58],
            ['PENDING', 28],
            ['IN_REVIEW', 14],
          ] as const,
          n,
          2,
        );
    const status = weighted(
      [
        ['ACTIVE', 84],
        ['INACTIVE', 12],
        ['CLOSED', 4],
      ] as const,
      n,
      4,
    );
    const riskLevel = weighted(
      [
        ['LOW', 70],
        ['MEDIUM', 20],
        ['HIGH', 8],
        ['BLOCKED', 2],
      ] as const,
      n,
      8,
    );
    const id = randomUUID();
    const email = `${normalized(first)}.${normalized(last)}.${String(n).padStart(4, '0')}@seed.fintech.local`;
    const customerWallets = {} as Record<SeedCurrency, SeedWalletRef>;

    customers.push({
      id,
      fullName,
      email,
      phone: phone(n),
      nationalIdLast4: nationalIdLast4(n),
      dateOfBirth: birthDate(n),
      addressCountry: 'TR',
      addressCity: city,
      addressPostal: String(34000 + ((n * 17) % 4700)),
      addressLine1: `${street} No:${1 + (n % 180)} D:${1 + (n % 42)} ${district}`,
      walletNumber: walletNumber(n),
      kycStatus,
      riskLevel,
      status,
      contractSigned: kycStatus === 'VERIFIED' && n % 3 !== 0,
      createdAt,
      updatedAt,
      rowVersion: BigInt(n % 5),
    });

    CURRENCIES.forEach((currency, currencyIndex) => {
      const accountId = randomUUID();
      const walletId = randomUUID();
      const walletCreatedAt = new Date(createdAt.getTime() + currencyIndex * 1_000);
      const walletUpdatedAt = new Date(updatedAt.getTime() + currencyIndex * 1_000);
      const monthlyLimitMinor = limitMinor(currency.code, currency.monthlyBase, n, currency.monthlyBase * 5);
      const dailyLimitMinor = dailyLimitFromMonthly(monthlyLimitMinor, limitUsagePercent(n - 1, currencyIndex));
      customerWallets[currency.code] = { id: walletId, accountId, currency: currency.code, balance: 0n };
      accounts.push({
        id: accountId,
        customerId: id,
        type: 'WALLET',
        status: status === 'CLOSED' ? 'CLOSED' : 'ACTIVE',
        currency: currency.code,
        createdAt: walletCreatedAt,
        updatedAt: walletUpdatedAt,
      });
      wallets.push({
        id: walletId,
        accountId,
        currency: currency.code,
        dailyLimitMinor,
        monthlyLimitMinor,
        status: status === 'CLOSED' ? 'CLOSED' : (n + currencyIndex) % 29 === 0 ? 'FROZEN' : 'ACTIVE',
        isSystem: false,
        systemPurpose: null,
        createdAt: walletCreatedAt,
        updatedAt: walletUpdatedAt,
        rowVersion: BigInt((n + currencyIndex) % 4),
      });
    });
    refs.push({ id, fullName, email, wallets: customerWallets });

    if (hasComplianceData) {
      const methods = ['e_kyc', 'document_review', 'manual_review', 'risk_review'] as const;
      const historyLength = 2 + (n % 3);
      for (let step = 0; step < historyLength; step += 1) {
        const isFinal = step === historyLength - 1;
        const statusForStep = isFinal
          ? kycStatus
          : (['PENDING', 'IN_REVIEW', 'PENDING'] as const)[(n + step) % 3];
        kycVerifications.push({
          id: randomUUID(),
          customerId: id,
          status: statusForStep,
          method: methods[(n + step * 2) % methods.length],
          reasonCode: isFinal && kycStatus === 'REJECTED'
            ? ['DOCUMENT_MISMATCH', 'ADDRESS_UNVERIFIED', 'LIVENESS_FAILED'][n % 3]
            : isFinal && kycStatus === 'EXPIRED'
              ? 'DOCUMENT_EXPIRED'
              : null,
          decidedAt: isFinal && kycStatus !== 'PENDING' && kycStatus !== 'IN_REVIEW' ? updatedAt : null,
          decidedBy: null,
          createdAt: new Date(createdAt.getTime() + step * 86_400_000),
        });
      }
    }
  }

  return { customers, accounts, wallets, kycVerifications, refs };
}

function buildSystemRows(): {
  customer: Prisma.CustomerCreateManyInput;
  accounts: Prisma.AccountCreateManyInput[];
  wallets: Prisma.WalletCreateManyInput[];
  clearing: Record<SeedCurrency, WalletRef>;
  revenue: Record<SeedCurrency, WalletRef>;
} {
  const now = new Date();
  const customerId = randomUUID();
  const accounts: Prisma.AccountCreateManyInput[] = [];
  const wallets: Prisma.WalletCreateManyInput[] = [];
  const clearing = {} as Record<SeedCurrency, WalletRef>;
  const revenue = {} as Record<SeedCurrency, WalletRef>;

  CURRENCIES.forEach((currency, currencyIndex) => {
    const accountId = randomUUID();
    const clearingWalletId = randomUUID();
    const revenueWalletId = randomUUID();
    const createdAt = new Date(now.getTime() + currencyIndex * 1_000);
    accounts.push({
      id: accountId,
      customerId,
      type: 'WALLET',
      status: 'ACTIVE',
      currency: currency.code,
      createdAt,
      updatedAt: createdAt,
    });
    wallets.push(
      {
        id: clearingWalletId,
        accountId,
        currency: currency.code,
        dailyLimitMinor: 0n,
        monthlyLimitMinor: 0n,
        status: 'ACTIVE',
        isSystem: true,
        systemPurpose: 'CLEARING',
        createdAt,
        updatedAt: createdAt,
      },
      {
        id: revenueWalletId,
        accountId,
        currency: currency.code,
        dailyLimitMinor: 0n,
        monthlyLimitMinor: 0n,
        status: 'ACTIVE',
        isSystem: true,
        systemPurpose: 'REVENUE',
        createdAt,
        updatedAt: createdAt,
      },
    );
    clearing[currency.code] = { id: clearingWalletId, accountId, currency: currency.code, balance: 0n };
    revenue[currency.code] = { id: revenueWalletId, accountId, currency: currency.code, balance: 0n };
  });

  return {
    customer: {
      id: customerId,
      fullName: 'Fintech Treasury System',
      email: 'treasury.system@seed.fintech.local',
      phone: null,
      walletNumber: null,
      kycStatus: 'VERIFIED',
      riskLevel: 'LOW',
      status: 'CLOSED',
      contractSigned: false,
      createdAt: now,
      updatedAt: now,
      deletedAt: now,
    },
    accounts,
    wallets,
    clearing,
    revenue,
  };
}

function buildTransactions(
  refs: SeedCustomerRef[],
  clearing: Record<SeedCurrency, WalletRef>,
  revenue: Record<SeedCurrency, WalletRef>,
): {
  transactions: Prisma.TransactionCreateManyInput[];
  entries: Prisma.LedgerEntryCreateManyInput[];
  balances: Prisma.WalletBalanceCreateManyInput[];
  totalAuthored: number;
} {
  const transactions: Prisma.TransactionCreateManyInput[] = [];
  const entries: Prisma.LedgerEntryCreateManyInput[] = [];
  const walletRefs = new Map<string, WalletRef>();
  const entrySeq = new Map<string, bigint>();
  let publicRefNo = 1;
  let totalAuthored = 0;

  for (const ref of refs) {
    for (const wallet of Object.values(ref.wallets)) {
      walletRefs.set(wallet.id, { ...wallet, balance: 0n });
    }
  }
  for (const wallet of Object.values(clearing)) walletRefs.set(wallet.id, wallet);
  for (const wallet of Object.values(revenue)) walletRefs.set(wallet.id, wallet);

  const nextSeq = (walletId: string): bigint => {
    const next = (entrySeq.get(walletId) ?? 0n) + 1n;
    entrySeq.set(walletId, next);
    return next;
  };

  const addEntry = (transactionId: string, walletId: string, leg: 'DEBIT' | 'CREDIT', amount: bigint, occurredAt: Date): void => {
    const wallet = walletRefs.get(walletId);
    if (!wallet) throw new Error(`Unknown wallet ${walletId}`);
    entries.push({
      id: randomUUID(),
      transactionId,
      walletId,
      accountId: wallet.accountId,
      leg,
      amountMinor: amount,
      currency: wallet.currency,
      entrySeq: nextSeq(walletId),
      createdAt: occurredAt,
    });
    wallet.balance += leg === 'CREDIT' ? amount : -amount;
  };

  const addTx = (args: {
    kind: SeedTransactionKind;
    status?: SeedTransactionStatus;
    owner: SeedCustomerRef;
    ownerWallet: SeedWalletRef;
    target?: SeedCustomerRef;
    targetWallet?: SeedWalletRef;
    amount: bigint;
    description: string;
    occurredAt: Date;
    ownerLeg?: SeedLedgerLeg;
  }): void => {
    const transactionId = randomUUID();
    const status = args.status ?? 'POSTED';
    const currency = args.ownerWallet.currency;
    const clearingWallet = clearing[currency];
    const revenueWallet = revenue[currency];
    transactions.push({
      id: transactionId,
      publicRef: `TX-2026-${String(publicRefNo++).padStart(6, '0')}`,
      idempotencyKey: `seed-${args.owner.id}-${currency}-${transactions.length + 1}`,
      kind: args.kind,
      status,
      accountId: args.ownerWallet.accountId,
      categoryId: null,
      description: args.description,
      correlationId: null,
      reversalOf: null,
      occurredAt: args.occurredAt,
      postedAt: status === 'POSTED' || status === 'REVERSED' ? args.occurredAt : null,
      createdAt: args.occurredAt,
    });

    if (args.kind === 'DEPOSIT') {
      addEntry(transactionId, clearingWallet.id, 'DEBIT', args.amount, args.occurredAt);
      addEntry(transactionId, args.ownerWallet.id, 'CREDIT', args.amount, args.occurredAt);
    } else if (args.kind === 'WITHDRAWAL') {
      addEntry(transactionId, args.ownerWallet.id, 'DEBIT', args.amount, args.occurredAt);
      addEntry(transactionId, clearingWallet.id, 'CREDIT', args.amount, args.occurredAt);
    } else if (args.kind === 'FEE') {
      addEntry(transactionId, args.ownerWallet.id, 'DEBIT', args.amount, args.occurredAt);
      addEntry(transactionId, revenueWallet.id, 'CREDIT', args.amount, args.occurredAt);
    } else if (args.kind === 'TRANSFER') {
      if (!args.targetWallet) throw new Error('TRANSFER requires target wallet');
      addEntry(transactionId, args.ownerWallet.id, 'DEBIT', args.amount, args.occurredAt);
      addEntry(transactionId, args.targetWallet.id, 'CREDIT', args.amount, args.occurredAt);
    } else {
      const ownerLeg = args.ownerLeg ?? 'CREDIT';
      if (ownerLeg === 'CREDIT') {
        addEntry(transactionId, clearingWallet.id, 'DEBIT', args.amount, args.occurredAt);
        addEntry(transactionId, args.ownerWallet.id, 'CREDIT', args.amount, args.occurredAt);
      } else {
        addEntry(transactionId, args.ownerWallet.id, 'DEBIT', args.amount, args.occurredAt);
        addEntry(transactionId, clearingWallet.id, 'CREDIT', args.amount, args.occurredAt);
      }
    }
  };

  const coverageKinds: readonly SeedTransactionKind[] = ['DEPOSIT', 'WITHDRAWAL', 'TRANSFER', 'FEE', 'ADJUSTMENT', 'REVERSAL'];
  const coverageStatuses: readonly SeedTransactionStatus[] = ['POSTED', 'PENDING', 'FAILED', 'REVERSED'];
  const statusLabel: Record<SeedTransactionStatus, string> = {
    POSTED: 'tamamlandı',
    PENDING: 'beklemede',
    FAILED: 'başarısız',
    REVERSED: 'ters kayıt',
  };

  const coverageLeg = (kind: SeedTransactionKind, kindIndex: number, statusIndex: number): SeedLedgerLeg => {
    if (kind === 'DEPOSIT') return 'CREDIT';
    if (kind === 'WITHDRAWAL' || kind === 'FEE' || kind === 'TRANSFER') return 'DEBIT';
    return (kindIndex + statusIndex) % 2 === 0 ? 'CREDIT' : 'DEBIT';
  };

  const coverageAmount = (kind: SeedTransactionKind, currency: SeedCurrency, index: number, statusIndex: number): bigint => {
    const seed = index * 97 + statusIndex * 31;
    if (kind === 'FEE') return cents(currencyMajor(currency, 25 + (seed % 450)));
    if (kind === 'WITHDRAWAL') return cents(currencyMajor(currency, 650 + (seed % 8_500)));
    if (kind === 'TRANSFER') return cents(currencyMajor(currency, 900 + (seed % 12_500)));
    if (kind === 'ADJUSTMENT') return cents(currencyMajor(currency, 75 + (seed % 2_250)));
    if (kind === 'REVERSAL') return cents(currencyMajor(currency, 120 + (seed % 5_500)));
    return cents(currencyMajor(currency, 12_000 + (seed % 55_000)));
  };

  const coverageDescription = (
    kind: SeedTransactionKind,
    status: SeedTransactionStatus,
    index: number,
    statusIndex: number,
    target?: SeedCustomerRef,
  ): string => {
    const note = statusLabel[status];
    if (kind === 'DEPOSIT') return `${pick(DEPOSIT_DESCRIPTIONS, index + statusIndex, 3)} (${note})`;
    if (kind === 'WITHDRAWAL') return `${pick(MERCHANTS, index + statusIndex, 5)} (${note})`;
    if (kind === 'FEE') return `${pick(FEE_DESCRIPTIONS, index + statusIndex, 7)} (${note})`;
    if (kind === 'TRANSFER') return `Para transferi - ${target?.fullName ?? 'karşı hesap'} (${note})`;
    if (kind === 'ADJUSTMENT') return `${pick(ADJUSTMENT_DESCRIPTIONS, index + statusIndex, 9)} (${note})`;
    return `${pick(REVERSAL_DESCRIPTIONS, index + statusIndex, 11)} (${note})`;
  };

  const addCoverageTransactions = (ref: SeedCustomerRef, index: number, currency: SeedCurrency): number => {
    let added = 0;
    const ownerWallet = ref.wallets[currency];
    coverageKinds.forEach((kind, kindIndex) => {
      coverageStatuses.forEach((status, statusIndex) => {
        const targetCandidate = refs[(index + kindIndex * 17 + statusIndex * 31 + 37) % refs.length];
        const target = targetCandidate.id === ref.id ? refs[(index + 1) % refs.length] : targetCandidate;
        const targetWallet = target.wallets[currency];
        const occurredAt = dateDaysAgo(5 + ((index + kindIndex * 47 + statusIndex * 83) % 350), index + kindIndex + statusIndex);
        addTx({
          kind,
          status,
          owner: ref,
          ownerWallet,
          target: kind === 'TRANSFER' ? target : undefined,
          targetWallet: kind === 'TRANSFER' ? targetWallet : undefined,
          amount: coverageAmount(kind, currency, index, statusIndex),
          description: coverageDescription(kind, status, index, statusIndex, target),
          occurredAt,
          ownerLeg: coverageLeg(kind, kindIndex, statusIndex),
        });
        added += 1;
      });
    });
    return added;
  };

  refs.forEach((ref, index) => {
    CURRENCIES.forEach((currency, currencyIndex) => {
      const ownerWallet = ref.wallets[currency.code];
      const count = transactionCount(index + currencyIndex * 11);
      totalAuthored += count;
      const coverageCount = addCoverageTransactions(ref, index + currencyIndex * 101, currency.code);
      for (let j = coverageCount; j < count; j += 1) {
        const current = walletRefs.get(ownerWallet.id)!;
        const occurredAt = dateDaysAgo(((index * 37 + currencyIndex * 29 + j * 11) % 330) + 1, index + currencyIndex + j);
        const selector = (index * 29 + currencyIndex * 23 + j * 17) % 100;

        if (current.balance < cents(currencyMajor(currency.code, 10_000)) || selector < 25) {
          const amount = cents(currencyMajor(currency.code, 18_000 + ((index * 997 + j * 421) % 125_000)));
          addTx({
            kind: 'DEPOSIT',
            owner: ref,
            ownerWallet,
            amount,
            description: pick(DEPOSIT_DESCRIPTIONS, index + j + currencyIndex, 3),
            occurredAt,
          });
          continue;
        }

        if (selector < 58) {
          const maxSpend = Number(current.balance / 100n);
          const plannedSpend = currencyMajor(currency.code, 18_000 + ((index * 211 + j * 503) % 42_000));
          const amount = cents(Math.max(25, Math.min(plannedSpend, Math.floor(maxSpend * 0.22))));
          addTx({
            kind: 'WITHDRAWAL',
            owner: ref,
            ownerWallet,
            amount,
            description: pick(MERCHANTS, index + j + currencyIndex, 5),
            occurredAt,
          });
          continue;
        }

        if (selector < 76) {
          const amount = cents(currencyMajor(currency.code, 12 + ((index * 13 + j * 19) % 950)));
          addTx({
            kind: 'FEE',
            owner: ref,
            ownerWallet,
            amount,
            description: pick(FEE_DESCRIPTIONS, index + j + currencyIndex, 7),
            occurredAt,
          });
          continue;
        }

        const target = refs[(index + currencyIndex * 19 + j * 13 + 37) % refs.length];
        const targetWallet = target.wallets[currency.code];
        if (target.id === ref.id || current.balance < cents(currencyMajor(currency.code, 15_000))) {
          const amount = cents(currencyMajor(currency.code, 7_500 + ((index * 389 + j * 97) % 65_000)));
          addTx({
            kind: 'DEPOSIT',
            owner: ref,
            ownerWallet,
            amount,
            description: pick(DEPOSIT_DESCRIPTIONS, index + j + currencyIndex, 11),
            occurredAt,
          });
          continue;
        }

        const maxTransfer = Number(current.balance / 100n);
        const plannedTransfer = currencyMajor(currency.code, 6_000 + ((index * 157 + j * 313) % 37_000));
        const amount = cents(Math.max(25, Math.min(plannedTransfer, Math.floor(maxTransfer * 0.18))));
        addTx({
          kind: 'TRANSFER',
          owner: ref,
          ownerWallet,
          target,
          targetWallet,
          amount,
          description: `Para transferi - ${target.fullName}`,
          occurredAt,
        });
      }
    });
  });

  const balances: Prisma.WalletBalanceCreateManyInput[] = [...walletRefs.values()].map((wallet) => ({
    walletId: wallet.id,
    balanceMinor: wallet.balance,
    availableBalanceMinor: wallet.balance,
  }));

  return { transactions, entries, balances, totalAuthored };
}

function buildRiskData(refs: SeedCustomerRef[]): {
  assessments: Prisma.RiskAssessmentCreateManyInput[];
  signals: Prisma.RiskSignalCreateManyInput[];
} {
  const assessments: Prisma.RiskAssessmentCreateManyInput[] = [];
  const signals: Prisma.RiskSignalCreateManyInput[] = [];
  const signalKeys = ['mixerExposure', 'highVelocity', 'suspiciousCounterparty', 'sanctionsHit'] as const;
  const severityByKey: Record<(typeof signalKeys)[number], 'low' | 'medium' | 'high'> = {
    mixerExposure: 'medium',
    highVelocity: 'medium',
    suspiciousCounterparty: 'low',
    sanctionsHit: 'high',
  };

  const addressFor = (index: number, caseIndex: number): string => {
    const raw = (BigInt(index + 1) * 0x9e3779b97f4a7c15n + BigInt(caseIndex + 17)).toString(16);
    return `0x${raw.padStart(40, '0').slice(-40)}`;
  };

  const scenarioFor = (index: number, caseIndex: number): {
    decision: 'ALLOW' | 'REVIEW' | 'BLOCK';
    hits: ReadonlySet<(typeof signalKeys)[number]>;
  } => {
    const signalSet = (...keys: Array<(typeof signalKeys)[number]>): ReadonlySet<(typeof signalKeys)[number]> =>
      new Set<(typeof signalKeys)[number]>(keys);
    const score = (index * 31 + caseIndex * 43) % 100;
    if (score >= 90) return { decision: 'BLOCK', hits: signalSet('sanctionsHit', 'mixerExposure') };
    if (score >= 74) return { decision: 'REVIEW', hits: signalSet('mixerExposure', 'suspiciousCounterparty') };
    if (score >= 54) return { decision: 'REVIEW', hits: signalSet('highVelocity') };
    return { decision: 'ALLOW', hits: signalSet() };
  };

  refs.forEach((ref, index) => {
    if (!hasComplianceCoverage(index)) return;
    const assessmentCount = 1 + ((index * 7) % 3);

    for (let caseIndex = 0; caseIndex < assessmentCount; caseIndex += 1) {
      const id = randomUUID();
      const scenario = scenarioFor(index, caseIndex);
      assessments.push({
        id,
        customerId: ref.id,
        address: addressFor(index, caseIndex),
        decision: scenario.decision,
        isSimulated: true,
        providerName: 'rule-based-risk-engine',
        createdAt: dateDaysAgo((index * 5 + caseIndex * 17) % 120, index + caseIndex),
        createdBy: null,
      });

      signalKeys.forEach((key) => {
        signals.push({
          id: randomUUID(),
          riskAssessmentId: id,
          key,
          hit: scenario.hits.has(key),
          severity: severityByKey[key],
        });
      });
    }
  });

  return { assessments, signals };
}

async function applyAnalytics(prisma: PrismaClient): Promise<number> {
  for (const statement of ANALYTICS_DDL) {
    await prisma.$executeRawUnsafe(statement);
  }
  await prisma.$executeRawUnsafe('REFRESH MATERIALIZED VIEW analytics.mv_customer_summary');
  await prisma.$executeRawUnsafe('REFRESH MATERIALIZED VIEW analytics.mv_kyc_distribution');
  return new AnalyticsService(prisma as unknown as PrismaService).backfillDailyMetrics();
}

async function main(): Promise<void> {
  const databaseUrl = assertLocalDatabase();
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });

  try {
    await ensureRolesAndUsers(prisma);
    await resetLocalDomainData(prisma);
    await ensureDbObjects(prisma);
    await seedReferenceData(prisma);

    const system = buildSystemRows();
    const { customers, accounts, wallets, kycVerifications, refs } = buildCustomers();
    await prisma.customer.createMany({ data: [system.customer, ...customers] });
    await createMany([...system.accounts, ...accounts], (chunk) => prisma.account.createMany({ data: chunk }), BATCH_SIZE);
    await createMany([...system.wallets, ...wallets], (chunk) => prisma.wallet.createMany({ data: chunk }), BATCH_SIZE);

    const { transactions, entries, balances, totalAuthored } = buildTransactions(refs, system.clearing, system.revenue);
    const { assessments, signals } = buildRiskData(refs);

    await createMany(transactions, (chunk) => prisma.transaction.createMany({ data: chunk }), TX_BATCH_SIZE);
    await createMany(entries, (chunk) => prisma.ledgerEntry.createMany({ data: chunk }), TX_BATCH_SIZE);
    await createMany(balances, (chunk) => prisma.walletBalance.createMany({ data: chunk }), BATCH_SIZE);
    await createMany(kycVerifications, (chunk) => prisma.kycVerification.createMany({ data: chunk }), BATCH_SIZE);
    await createMany(assessments, (chunk) => prisma.riskAssessment.createMany({ data: chunk }), BATCH_SIZE);
    await createMany(signals, (chunk) => prisma.riskSignal.createMany({ data: chunk }), BATCH_SIZE);

    await prisma.$executeRawUnsafe(`SELECT setval('transaction_public_ref_seq', ${transactions.length}, true)`);
    const metricDays = await applyAnalytics(prisma);

    const visibleCustomers = await prisma.customer.count({ where: { deletedAt: null } });
    const txCount = await prisma.transaction.count();
    const ledgerCount = await prisma.ledgerEntry.count();
    console.log(`seed-dev: ensured ${ROLES.length} roles + ${SEED_USERS.length} users; dictionary=${PERMISSIONS.length} permissions.`);
    for (const r of ROLES) {
      console.log(`seed-dev:   role ${r.name}${r.subtitle ? ` (${r.subtitle})` : ''}: ${r.codes.length} permissions.`);
    }
    console.log(`seed-dev: visible customers=${visibleCustomers}; wallets=${balances.length - system.wallets.length}; authored transactions=${totalAuthored}; listed transaction rows=${txCount}; ledger entries=${ledgerCount}.`);
    console.log(`seed-dev: compliance coverage=${COMPLIANCE_COVERAGE_PERCENT}%; risk assessments=${assessments.length}; kyc history rows=${kycVerifications.length}.`);
    console.log(`seed-dev: analytics daily metrics backfilled for ${metricDays} days.`);
    console.log('seed-dev: local scenario dataset refreshed. Log in again to pick up a fresh JWT.');
  } finally {
    await prisma.$disconnect();
  }
}

// Only run the seed when executed directly (e.g. `ts-node scripts/seed-dev.ts`). Importing this
// module — e.g. a seed/RBAC test reading PERMISSIONS — must NOT connect to or mutate any database.
if (require.main === module) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
