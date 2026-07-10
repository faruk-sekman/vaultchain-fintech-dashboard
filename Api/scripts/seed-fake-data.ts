/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * DEV-ONLY realistic data seeder (manual, not part of CI). Fills the LOCAL dev database with N
 * fully-detailed, enterprise-grade customers, each with one account/wallet/balance, a short KYC
 * history, and a realistic, VARIABLE-length transaction history (so the detail panel's pagination
 * is genuinely exercised — many customers span several pages). The national ID is generated as a
 * checksum-valid TC Kimlik No and stored COLUMN-ENCRYPTED, exactly as the create endpoint
 * does (same AAD + key), so the seeded data is consistent with the write path. Only `last4` is
 * derived for display.
 *
 * It TRUNCATEs ONLY the customer/ledger domain (customers, accounts, wallets, wallet_balances,
 * kyc_verifications, risk_assessments, risk_signals, transactions, ledger_entries, idempotency_keys)
 * and leaves auth/rbac/audit intact, so the seeded operator login keeps working.
 *
 * Run (local only): FTD_SEED_DESTRUCTIVE=1 DATABASE_URL=postgres://…@localhost:5544x/fintech_dev npx ts-node scripts/seed-fake-data.ts [count]
 */
import 'reflect-metadata';
import { randomInt, randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { createPiiEncryptor } from '../src/common/crypto/crypto.module';
import { packEnvelope } from '../src/common/crypto/envelope-codec';
import { assertLocalDb } from '../src/common/util/assert-local-db';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }) });

const COUNT = Math.max(1250, Number(process.argv[2] ?? 1250));

const FIRST = [
  'Ahmet', 'Mehmet', 'Mustafa', 'Ali', 'Hüseyin', 'Hasan', 'İbrahim', 'Murat', 'Ömer', 'Yusuf',
  'Emre', 'Burak', 'Can', 'Cem', 'Deniz', 'Kerem', 'Onur', 'Serkan', 'Tolga', 'Volkan',
  'Ayşe', 'Fatma', 'Emine', 'Hatice', 'Zeynep', 'Elif', 'Meryem', 'Hülya', 'Merve', 'Büşra',
  'Esra', 'Selin', 'Derya', 'Ebru', 'Pınar', 'Aslı', 'Gizem', 'Sıla', 'Ece', 'Nazlı',
];
const LAST = [
  'Yılmaz', 'Kaya', 'Demir', 'Şahin', 'Çelik', 'Yıldız', 'Yıldırım', 'Öztürk', 'Aydın', 'Özdemir',
  'Arslan', 'Doğan', 'Kılıç', 'Aslan', 'Çetin', 'Kara', 'Koç', 'Kurt', 'Özkan', 'Şimşek',
  'Polat', 'Korkmaz', 'Çakır', 'Erdoğan', 'Acar', 'Avcı', 'Bulut', 'Güneş', 'Aksoy', 'Bozkurt',
  'Taş', 'Yavuz', 'Aktaş', 'Turan', 'Sezer', 'Ünal', 'Güler', 'Aydoğan', 'Tekin', 'Erdem',
];
const CITIES = [
  'İstanbul', 'Ankara', 'İzmir', 'Bursa', 'Antalya', 'Adana', 'Konya', 'Gaziantep', 'Kocaeli', 'Mersin',
  'Diyarbakır', 'Hatay', 'Manisa', 'Kayseri', 'Samsun', 'Balıkesir', 'Van', 'Aydın', 'Tekirdağ', 'Sakarya',
  'Denizli', 'Muğla', 'Eskişehir', 'Trabzon', 'Ordu', 'Malatya', 'Erzurum', 'Mardin', 'Tokat', 'Sivas',
];
const STREETS = ['Atatürk', 'Cumhuriyet', 'İnönü', 'Bağdat', 'Gazi', 'Fevzi Çakmak', 'Mevlana', 'Barbaros', 'Yeni', 'Çamlık'];
const DOMAINS = ['gmail.com', 'hotmail.com', 'outlook.com', 'yahoo.com', 'icloud.com', 'yandex.com'];

const pick = <T>(arr: readonly T[]): T => arr[randomInt(arr.length)];

/** Weighted pick: entries are [value, weight]. */
function weighted<T>(entries: ReadonlyArray<readonly [T, number]>): T {
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = randomInt(total);
  for (const [v, w] of entries) {
    if (r < w) return v;
    r -= w;
  }
  return entries[0][0];
}

/** Uniform integer in [min, max] inclusive. */
const between = (min: number, max: number): number => min + randomInt(max - min + 1);

const KYC = [
  ['VERIFIED', 45], ['PENDING', 18], ['NOT_STARTED', 12], ['IN_REVIEW', 10], ['REJECTED', 8], ['EXPIRED', 7],
] as const;
const RISK = [['LOW', 62], ['MEDIUM', 25], ['HIGH', 10], ['BLOCKED', 3]] as const;
const STATUS = [['ACTIVE', 82], ['INACTIVE', 13], ['CLOSED', 5]] as const;
const CURRENCY = [['TRY', 80], ['USD', 12], ['EUR', 8]] as const;
const ACCTYPE = [['CHECKING', 50], ['SAVINGS', 30], ['WALLET', 20]] as const;

type TxKind = 'DEPOSIT' | 'WITHDRAWAL' | 'TRANSFER' | 'FEE';
const TX_KINDS = [['DEPOSIT', 28], ['WITHDRAWAL', 30], ['TRANSFER', 27], ['FEE', 15]] as const;
const TX_STATUS = [['POSTED', 88], ['PENDING', 7], ['FAILED', 5]] as const;
const TX_DESC: Record<TxKind, string[]> = {
  DEPOSIT: ['Maaş ödemesi', 'Para yatırma', 'İade', 'Faiz geliri', 'Gelen havale', 'Prim ödemesi'],
  WITHDRAWAL: ['ATM çekimi', 'Nakit çekim', 'Para çekme', 'POS harcaması'],
  TRANSFER: ['EFT', 'Havale', 'Kira ödemesi', 'Fatura ödemesi', 'Kredi taksiti', 'Online alışveriş'],
  FEE: ['İşlem ücreti', 'Hesap işletim ücreti', 'Kart ücreti', 'EFT/Havale masrafı'],
};

/** Realistic per-kind amount ranges in MAJOR units, converted to minor (×100). */
function amountMinorFor(kind: TxKind): bigint {
  const ranges: Record<TxKind, [number, number]> = {
    DEPOSIT: [3_000, 85_000],
    WITHDRAWAL: [100, 12_000],
    TRANSFER: [50, 60_000],
    FEE: [5, 600],
  };
  const [lo, hi] = ranges[kind];
  // major units with two decimals of jitter, then to minor units
  return BigInt(between(lo, hi)) * 100n + BigInt(randomInt(100));
}

/**
 * Variable transaction-history length, weighted so most customers have a couple of pages and a
 * meaningful tail has many (the detail panel paginates at 10/page). Produces counts like 7, 14,
 * 22, 34, 51…
 */
function transactionCount(): number {
  const band = weighted([
    ['light', 34], // 5–12  → 1–2 pages
    ['medium', 34], // 13–25 → 2–3 pages
    ['heavy', 22], // 26–40 → 3–4 pages
    ['vip', 10], // 41–60 → 5–6 pages
  ] as const);
  switch (band) {
    case 'light':
      return between(5, 12);
    case 'medium':
      return between(13, 25);
    case 'heavy':
      return between(26, 40);
    case 'vip':
      return between(41, 60);
  }
}

const slug = (s: string): string =>
  s.toLowerCase().replace(/ı/g, 'i').replace(/ş/g, 's').replace(/ç/g, 'c').replace(/ğ/g, 'g').replace(/ü/g, 'u').replace(/ö/g, 'o').replace(/[^a-z]/g, '');

const TWO_YEARS = 2 * 365 * 24 * 60 * 60 * 1000;
const randDateWithinPast = (ms: number): Date => new Date(Date.now() - randomInt(ms));
const pad = (n: number, len: number): string => String(n).padStart(len, '0');

/** AAD binds the encrypted national-id blob to its customer row — identical to the create endpoint. */
const nationalIdAad = (customerId: string): Buffer => Buffer.from(`customer:${customerId}`, 'utf8');

/** Generates a checksum-valid Turkish national ID (TC Kimlik No): 11 digits, first ≠ 0. */
function generateTurkishNationalId(): string {
  const d: number[] = [1 + randomInt(9), ...Array.from({ length: 8 }, () => randomInt(10))];
  const oddSum = d[0] + d[2] + d[4] + d[6] + d[8];
  const evenSum = d[1] + d[3] + d[5] + d[7];
  const digit10 = (((oddSum * 7 - evenSum) % 10) + 10) % 10;
  d.push(digit10);
  const digit11 = d.reduce((sum, n) => sum + n, 0) % 10;
  d.push(digit11);
  return d.join('');
}

async function main(): Promise<void> {
  // F2: strict, URL-parsed host-allowlist guard + destructive opt-in (was an unanchored substring regex).
  assertLocalDb({ script: 'seed-fake-data', requireDestructiveOptIn: true });
  // Same envelope encryptor the API uses (dev-fallback key unless FTD_PII_MASTER_KEY is set).
  const { encryptor } = createPiiEncryptor();
  console.log(`Seeding ${COUNT} customers into the local dev DB…`);

  // Clean the customer/ledger domain only (auth/rbac/audit untouched).
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE ledger_entries, transactions, idempotency_keys, risk_signals, risk_assessments, ' +
      'kyc_verifications, wallet_balances, wallets, accounts, customers RESTART IDENTITY CASCADE',
  );

  const customers: unknown[] = [];
  const accounts: unknown[] = [];
  const wallets: unknown[] = [];
  const balances: unknown[] = [];
  const kyc: unknown[] = [];
  const transactions: unknown[] = [];
  const ledgerEntries: unknown[] = [];
  let txSeq = 0;

  for (let i = 0; i < COUNT; i++) {
    const first = pick(FIRST);
    const last = pick(LAST);
    const kycStatus = weighted(KYC);
    const currency = weighted(CURRENCY);
    const createdAt = randDateWithinPast(TWO_YEARS);
    const updatedAt = new Date(createdAt.getTime() + randomInt(Math.max(1, Date.now() - createdAt.getTime())));

    const customerId = randomUUID();
    const accountId = randomUUID();
    const walletId = randomUUID();

    // Generate + column-encrypt the national ID exactly like the create endpoint (write-only PII).
    const nationalId = generateTurkishNationalId();
    const sealed = await encryptor.encrypt(Buffer.from(nationalId, 'utf8'), nationalIdAad(customerId));
    const nationalIdEnc = Uint8Array.from(packEnvelope(sealed));

    customers.push({
      id: customerId,
      fullName: `${first} ${last}`,
      // index keeps emails unique even when names collide
      email: `${slug(first)}.${slug(last)}${i}@${pick(DOMAINS)}`,
      phone: `+90 5${pad(randomInt(100), 2)} ${pad(randomInt(1000), 3)} ${pad(randomInt(100), 2)} ${pad(randomInt(100), 2)}`,
      nationalIdEnc,
      nationalIdLast4: nationalId.slice(-4),
      dateOfBirth: new Date(1955 + randomInt(51), randomInt(12), 1 + randomInt(28)),
      addressCountry: 'TR',
      addressCity: pick(CITIES),
      addressPostal: pad(randomInt(100000), 5),
      addressLine1: `${pick(STREETS)} Cad. No:${1 + randomInt(220)} D:${1 + randomInt(40)}`,
      walletNumber: `${pad(randomInt(1e9), 9)}${pad(randomInt(1e7), 7)}`,
      kycStatus,
      riskLevel: weighted(RISK),
      status: weighted(STATUS),
      contractSigned: kycStatus === 'VERIFIED' ? randomInt(100) < 80 : randomInt(100) < 10,
      createdAt,
      updatedAt,
    });

    accounts.push({
      id: accountId,
      customerId,
      type: weighted(ACCTYPE),
      status: 'ACTIVE',
      currency,
      createdAt,
      updatedAt,
    });

    const balanceMinor = BigInt(randomInt(5_000_000)) * 100n + BigInt(randomInt(100));
    wallets.push({
      id: walletId,
      accountId,
      currency,
      dailyLimitMinor: BigInt(10_000 + randomInt(490_000)) * 100n,
      monthlyLimitMinor: BigInt(100_000 + randomInt(4_900_000)) * 100n,
      status: weighted([['ACTIVE', 90], ['FROZEN', 7], ['CLOSED', 3]] as const),
      isSystem: false,
      createdAt,
      updatedAt,
    });
    balances.push({
      walletId,
      balanceMinor,
      availableBalanceMinor: balanceMinor - BigInt(randomInt(Number(balanceMinor > 100000n ? 100000n : balanceMinor) + 1)),
      updatedAt,
    });

    // 1–3 KYC verification rows (a small history)
    const methods = ['document', 'biometric', 'manual'];
    const historyLen = 1 + randomInt(3);
    for (let k = 0; k < historyLen; k++) {
      kyc.push({
        id: randomUUID(),
        customerId,
        status: k === historyLen - 1 ? kycStatus : weighted([['PENDING', 50], ['IN_REVIEW', 30], ['NOT_STARTED', 20]] as const),
        method: pick(methods),
        reasonCode: kycStatus === 'REJECTED' && k === historyLen - 1 ? 'DOC_MISMATCH' : null,
        decidedAt: k === historyLen - 1 && kycStatus !== 'NOT_STARTED' ? updatedAt : null,
        createdAt: new Date(createdAt.getTime() + k * 86_400_000),
      });
    }

    // Variable transaction history (weighted, see transactionCount). Each transaction has ONE ledger
    // entry on this customer's wallet (single-leg seed — the amount is positive; `leg` carries the
    // sign, which the endpoint turns into a net). Amounts are realistic per kind.
    const txCount = transactionCount();
    for (let t = 0; t < txCount; t++) {
      const kind: TxKind = weighted(TX_KINDS);
      const leg = kind === 'DEPOSIT' ? 'CREDIT' : kind === 'TRANSFER' ? (randomInt(2) ? 'CREDIT' : 'DEBIT') : 'DEBIT';
      const status = weighted(TX_STATUS);
      const occurredAt = randDateWithinPast(TWO_YEARS);
      const txId = randomUUID();
      txSeq += 1;
      transactions.push({
        id: txId,
        publicRef: `TX-2026-${pad(txSeq, 7)}`,
        idempotencyKey: randomUUID(),
        kind,
        status,
        accountId,
        description: pick(TX_DESC[kind]),
        occurredAt,
        postedAt: status === 'POSTED' ? new Date(occurredAt.getTime() + randomInt(86_400_000)) : null,
        createdAt: occurredAt,
      });
      ledgerEntries.push({
        id: randomUUID(),
        transactionId: txId,
        walletId,
        accountId,
        leg,
        amountMinor: amountMinorFor(kind),
        currency,
        entrySeq: BigInt(txSeq),
      });
    }
  }

  await prisma.customer.createMany({ data: customers as never });
  await prisma.account.createMany({ data: accounts as never });
  await prisma.wallet.createMany({ data: wallets as never });
  await prisma.walletBalance.createMany({ data: balances as never });
  await prisma.kycVerification.createMany({ data: kyc as never });
  await prisma.transaction.createMany({ data: transactions as never });
  await prisma.ledgerEntry.createMany({ data: ledgerEntries as never });

  const [c, a, w, b, k, tx, le] = await Promise.all([
    prisma.customer.count(),
    prisma.account.count(),
    prisma.wallet.count(),
    prisma.walletBalance.count(),
    prisma.kycVerification.count(),
    prisma.transaction.count(),
    prisma.ledgerEntry.count(),
  ]);
  console.log(`Done. customers=${c} accounts=${a} wallets=${w} balances=${b} kyc=${k} transactions=${tx} ledgerEntries=${le}`);
  console.log(`Average transactions/customer ≈ ${(tx / c).toFixed(1)} (variable; many customers span several pages).`);

  // A quick KYC distribution sanity check (so the dashboard/list look realistic).
  const dist = await prisma.customer.groupBy({ by: ['kycStatus'], _count: true });
  console.log('KYC distribution:', dist.map((d) => `${d.kycStatus}:${d._count}`).join('  '));
}

main()
  .catch((e) => {
    console.error('Seed failed:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
