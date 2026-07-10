/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Additional unit tests for the ledger posting service that
 * complement transactions.service.spec.ts. The base spec pins TRANSFER + the idempotency guards;
 * this file exercises the remaining money-critical paths with Prisma fully mocked (no database):
 * the DEPOSIT / WITHDRAWAL / FEE / REVERSAL planners, the system-wallet lookup (found / missing),
 * the reverse-once `reversal_of` UNIQUE backstop, the release-failure log branch, the P2002-without
 * -row fall-through, and the ledger-imbalance invariant guard. These pin the per-kind balanced
 * double-entry, the BigInt minor-unit math, and the `minorToWireString` serialization end-to-end.
 */
import { Prisma } from '@prisma/client';
import { fingerprintRequest } from '../../common/util/request-fingerprint';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import { TransactionsService } from './transactions.service';

type LedgerLeg = { leg: 'DEBIT' | 'CREDIT'; amountMinor: bigint; walletId: string; accountId: string };

/** A wallet row as `executePlan` reads it (id-keyed, with its balance). */
function makeWallet(over: Record<string, unknown> = {}) {
  return {
    id: 'w-src',
    currency: 'USD',
    isSystem: false,
    accountId: 'acc-src',
    systemPurpose: null,
    balance: { balanceMinor: 1_000_000n, availableBalanceMinor: 1_000_000n },
    ...over,
  };
}

/**
 * A transaction-scoped Prisma client (`tx`). The tagged-template `$queryRaw` router returns the
 * seq/ref helper rows; an optional `systemWallet`/`original` configures the per-kind finders.
 */
function makeTx(over: Record<string, unknown> = {}) {
  const { systemWallet, original, ...rest } = over as {
    systemWallet?: unknown;
    original?: unknown;
  } & Record<string, unknown>;
  return {
    $queryRaw: jest.fn((strings: TemplateStringsArray) => {
      const sql = Array.isArray(strings) ? strings.join(' ') : String(strings);
      if (sql.includes('nextval')) return Promise.resolve([{ v: 7 }]);
      if (sql.includes('entry_seq')) return Promise.resolve([{ seq: 1 }]);
      return Promise.resolve([]); // FOR UPDATE locks return nothing
    }),
    transaction: {
      create: jest.fn().mockResolvedValue(undefined),
      findUnique: jest.fn().mockResolvedValue(original ?? null),
      update: jest.fn().mockResolvedValue(undefined),
    },
    ledgerEntry: { createMany: jest.fn().mockResolvedValue({ count: 2 }) },
    wallet: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(systemWallet ?? null),
    },
    walletBalance: { update: jest.fn().mockResolvedValue(undefined) },
    // Completion (mark COMPLETED) now runs THROUGH the transaction client, atomically with the ledger.
    idempotencyKey: { update: jest.fn().mockResolvedValue(undefined) },
    ...rest,
  };
}

/** The request-scoped Prisma service. `$transaction` simply runs the callback against `tx`. */
function makePrisma(tx: ReturnType<typeof makeTx>, over: Record<string, unknown> = {}) {
  return {
    idempotencyKey: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
    },
    $transaction: jest.fn((cb: (client: unknown) => unknown) => cb(tx)),
    ...over,
  };
}

const dtoOf = (over: Partial<CreateTransactionDto>): CreateTransactionDto =>
  ({ amountMinor: 10_000, currency: 'USD', ...over }) as unknown as CreateTransactionDto;

const fingerprintOf = (dto: CreateTransactionDto): string =>
  fingerprintRequest({
    kind: dto.kind,
    sourceWalletId: dto.sourceWalletId,
    targetWalletId: dto.targetWalletId,
    originalTransactionId: (dto as { originalTransactionId?: string }).originalTransactionId,
    amountMinor: dto.amountMinor,
    currency: dto.currency,
    categoryId: (dto as { categoryId?: string }).categoryId,
    description: (dto as { description?: string }).description,
  });

function ledgerLegs(tx: ReturnType<typeof makeTx>): LedgerLeg[] {
  return tx.ledgerEntry.createMany.mock.calls[0][0].data as LedgerLeg[];
}

describe('TransactionsService.post — DEPOSIT / WITHDRAWAL / FEE / REVERSAL', () => {
  describe('DEPOSIT', () => {
    it('posts a balanced deposit against the CLEARING system wallet and credits the customer', async () => {
      const tx = makeTx({
        systemWallet: { id: 'sys-clearing' },
        wallet: {
          findFirst: jest.fn().mockResolvedValue({ id: 'sys-clearing' }),
          findMany: jest.fn().mockResolvedValue([
            makeWallet({ id: 'sys-clearing', accountId: 'acc-sys', isSystem: true, balance: { balanceMinor: 0n, availableBalanceMinor: 0n } }),
            makeWallet({ id: 'w-tgt', accountId: 'acc-tgt', balance: { balanceMinor: 0n, availableBalanceMinor: 0n } }),
          ]),
        },
      });
      const prisma = makePrisma(tx);
      const service = new TransactionsService(prisma as never);

      const result = await service.post(dtoOf({ kind: 'DEPOSIT', targetWalletId: 'w-tgt', amountMinor: 25_000 }), 'idem-dep');

      expect(result).toMatchObject({ status: 'POSTED', amountMinor: '25000', currency: 'USD' });
      const legs = ledgerLegs(tx);
      expect(legs).toHaveLength(2);
      // System wallet is DEBITed (not balance-checked), customer is CREDITed.
      expect(legs.find((l) => l.walletId === 'sys-clearing')?.leg).toBe('DEBIT');
      expect(legs.find((l) => l.walletId === 'w-tgt')?.leg).toBe('CREDIT');
      const debit = legs.filter((l) => l.leg === 'DEBIT').reduce((s, l) => s + l.amountMinor, 0n);
      const credit = legs.filter((l) => l.leg === 'CREDIT').reduce((s, l) => s + l.amountMinor, 0n);
      expect(debit).toBe(credit);
      expect(debit).toBe(25_000n);
    });

    it('rejects a deposit without targetWalletId (400) and never opens the ledger', async () => {
      const tx = makeTx({ systemWallet: { id: 'sys-clearing' } });
      const prisma = makePrisma(tx);
      const service = new TransactionsService(prisma as never);

      await expect(service.post(dtoOf({ kind: 'DEPOSIT' }), 'idem-dep')).rejects.toMatchObject({
        response: { code: 'Validation.Failed' },
      });
      expect(tx.ledgerEntry.createMany).not.toHaveBeenCalled();
      expect(prisma.idempotencyKey.delete).toHaveBeenCalledWith({ where: { key: 'idem-dep' } });
    });

    it('rejects a deposit when no CLEARING system wallet is provisioned (422, fail-closed)', async () => {
      const tx = makeTx({
        wallet: { findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) },
      });
      const prisma = makePrisma(tx);
      const service = new TransactionsService(prisma as never);

      await expect(service.post(dtoOf({ kind: 'DEPOSIT', targetWalletId: 'w-tgt' }), 'idem-dep')).rejects.toMatchObject({
        response: { code: 'Transactions.SystemWalletMissing' },
      });
      expect(tx.ledgerEntry.createMany).not.toHaveBeenCalled();
    });
  });

  describe('WITHDRAWAL', () => {
    it('debits the (balance-checked) customer and credits the CLEARING system wallet', async () => {
      const tx = makeTx({
        wallet: {
          findFirst: jest.fn().mockResolvedValue({ id: 'sys-clearing' }),
          findMany: jest.fn().mockResolvedValue([
            makeWallet({ id: 'w-src', accountId: 'acc-src', balance: { balanceMinor: 80_000n, availableBalanceMinor: 80_000n } }),
            makeWallet({ id: 'sys-clearing', accountId: 'acc-sys', isSystem: true, balance: { balanceMinor: 0n, availableBalanceMinor: 0n } }),
          ]),
        },
      });
      const prisma = makePrisma(tx);
      const service = new TransactionsService(prisma as never);

      const result = await service.post(dtoOf({ kind: 'WITHDRAWAL', sourceWalletId: 'w-src', amountMinor: 30_000 }), 'idem-wd');

      expect(result).toMatchObject({ status: 'POSTED', amountMinor: '30000' });
      const legs = ledgerLegs(tx);
      expect(legs.find((l) => l.walletId === 'w-src')?.leg).toBe('DEBIT');
      expect(legs.find((l) => l.walletId === 'sys-clearing')?.leg).toBe('CREDIT');
    });

    it('rejects a withdrawal without sourceWalletId (400)', async () => {
      const tx = makeTx();
      const prisma = makePrisma(tx);
      const service = new TransactionsService(prisma as never);

      await expect(service.post(dtoOf({ kind: 'WITHDRAWAL' }), 'idem-wd')).rejects.toMatchObject({
        response: { code: 'Validation.Failed' },
      });
    });

    it('rejects a withdrawal exceeding the customer available balance (422)', async () => {
      const tx = makeTx({
        wallet: {
          findFirst: jest.fn().mockResolvedValue({ id: 'sys-clearing' }),
          findMany: jest.fn().mockResolvedValue([
            makeWallet({ id: 'w-src', accountId: 'acc-src', balance: { balanceMinor: 100n, availableBalanceMinor: 100n } }),
            makeWallet({ id: 'sys-clearing', accountId: 'acc-sys', isSystem: true, balance: { balanceMinor: 0n, availableBalanceMinor: 0n } }),
          ]),
        },
      });
      const prisma = makePrisma(tx);
      const service = new TransactionsService(prisma as never);

      await expect(service.post(dtoOf({ kind: 'WITHDRAWAL', sourceWalletId: 'w-src', amountMinor: 30_000 }), 'idem-wd')).rejects.toMatchObject({
        response: { code: 'Transactions.InsufficientBalance' },
      });
    });
  });

  describe('FEE', () => {
    it('debits the customer and credits the REVENUE system wallet', async () => {
      const findFirst = jest.fn().mockResolvedValue({ id: 'sys-revenue' });
      const tx = makeTx({
        wallet: {
          findFirst,
          findMany: jest.fn().mockResolvedValue([
            makeWallet({ id: 'w-src', accountId: 'acc-src', balance: { balanceMinor: 5_000n, availableBalanceMinor: 5_000n } }),
            makeWallet({ id: 'sys-revenue', accountId: 'acc-rev', isSystem: true, balance: { balanceMinor: 0n, availableBalanceMinor: 0n } }),
          ]),
        },
      });
      const prisma = makePrisma(tx);
      const service = new TransactionsService(prisma as never);

      const result = await service.post(dtoOf({ kind: 'FEE', sourceWalletId: 'w-src', amountMinor: 250 }), 'idem-fee');

      expect(result).toMatchObject({ status: 'POSTED', amountMinor: '250' });
      // The REVENUE purpose is requested (not CLEARING).
      expect(findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ systemPurpose: 'REVENUE' }) }),
      );
      const legs = ledgerLegs(tx);
      expect(legs.find((l) => l.walletId === 'w-src')?.leg).toBe('DEBIT');
      expect(legs.find((l) => l.walletId === 'sys-revenue')?.leg).toBe('CREDIT');
    });

    it('rejects a fee without sourceWalletId (400)', async () => {
      const tx = makeTx();
      const prisma = makePrisma(tx);
      const service = new TransactionsService(prisma as never);

      await expect(service.post(dtoOf({ kind: 'FEE' }), 'idem-fee')).rejects.toMatchObject({
        response: { code: 'Validation.Failed' },
      });
    });

    it('rejects a fee when no REVENUE system wallet is provisioned (422)', async () => {
      const tx = makeTx({
        wallet: { findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) },
      });
      const prisma = makePrisma(tx);
      const service = new TransactionsService(prisma as never);

      await expect(service.post(dtoOf({ kind: 'FEE', sourceWalletId: 'w-src' }), 'idem-fee')).rejects.toMatchObject({
        response: { code: 'Transactions.SystemWalletMissing' },
      });
    });
  });

  describe('REVERSAL', () => {
    const originalPosted = (over: Record<string, unknown> = {}) => ({
      id: 'orig-1',
      accountId: 'acc-orig',
      status: 'POSTED',
      entries: [
        { walletId: 'w-a', leg: 'DEBIT', amountMinor: 10_000n, currency: 'USD' },
        { walletId: 'w-b', leg: 'CREDIT', amountMinor: 10_000n, currency: 'USD' },
      ],
      ...over,
    });

    it('mirrors every original leg (DEBIT↔CREDIT), marks the original REVERSED, and posts', async () => {
      const tx = makeTx({
        transaction: {
          create: jest.fn().mockResolvedValue(undefined),
          findUnique: jest.fn().mockResolvedValue(originalPosted()),
          update: jest.fn().mockResolvedValue(undefined),
        },
        wallet: {
          findFirst: jest.fn().mockResolvedValue(null),
          findMany: jest.fn().mockResolvedValue([
            makeWallet({ id: 'w-a', accountId: 'acc-a', balance: { balanceMinor: 0n, availableBalanceMinor: 0n } }),
            makeWallet({ id: 'w-b', accountId: 'acc-b', balance: { balanceMinor: 1_000_000n, availableBalanceMinor: 1_000_000n } }),
          ]),
        },
      });
      const prisma = makePrisma(tx);
      const service = new TransactionsService(prisma as never);

      const result = await service.post(
        dtoOf({ kind: 'REVERSAL', originalTransactionId: 'orig-1', amountMinor: 10_000, currency: 'USD' }),
        'idem-rev',
      );

      expect(result).toMatchObject({ status: 'POSTED', amountMinor: '10000', currency: 'USD' });
      // Original DEBIT on w-a is mirrored to a CREDIT; original CREDIT on w-b is mirrored to a DEBIT.
      const legs = ledgerLegs(tx);
      expect(legs.find((l) => l.walletId === 'w-a')?.leg).toBe('CREDIT');
      expect(legs.find((l) => l.walletId === 'w-b')?.leg).toBe('DEBIT');
      // The original transaction is flipped POSTED → REVERSED.
      expect(tx.transaction.update).toHaveBeenCalledWith({ where: { id: 'orig-1' }, data: { status: 'REVERSED' } });
      // The transaction row records reversalOf = the original id.
      expect(tx.transaction.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ reversalOf: 'orig-1', kind: 'REVERSAL' }) }),
      );
    });

    it('rejects a reversal without originalTransactionId (400)', async () => {
      const tx = makeTx();
      const prisma = makePrisma(tx);
      const service = new TransactionsService(prisma as never);

      await expect(service.post(dtoOf({ kind: 'REVERSAL' }), 'idem-rev')).rejects.toMatchObject({
        response: { code: 'Validation.Failed' },
      });
    });

    it('rejects when the original transaction is not found (404)', async () => {
      const tx = makeTx({
        transaction: {
          create: jest.fn(),
          findUnique: jest.fn().mockResolvedValue(null),
          update: jest.fn(),
        },
      });
      const prisma = makePrisma(tx);
      const service = new TransactionsService(prisma as never);

      await expect(
        service.post(dtoOf({ kind: 'REVERSAL', originalTransactionId: 'missing', amountMinor: 10_000 }), 'idem-rev'),
      ).rejects.toMatchObject({ response: { code: 'Transactions.OriginalNotFound' } });
    });

    it('rejects reversing an already-REVERSED transaction (409)', async () => {
      const tx = makeTx({
        transaction: {
          create: jest.fn(),
          findUnique: jest.fn().mockResolvedValue(originalPosted({ status: 'REVERSED' })),
          update: jest.fn(),
        },
      });
      const prisma = makePrisma(tx);
      const service = new TransactionsService(prisma as never);

      await expect(
        service.post(dtoOf({ kind: 'REVERSAL', originalTransactionId: 'orig-1', amountMinor: 10_000 }), 'idem-rev'),
      ).rejects.toMatchObject({ response: { code: 'Transactions.AlreadyReversed' } });
    });

    it('rejects reversing a non-POSTED transaction (422 NotReversible)', async () => {
      const tx = makeTx({
        transaction: {
          create: jest.fn(),
          findUnique: jest.fn().mockResolvedValue(originalPosted({ status: 'PENDING' })),
          update: jest.fn(),
        },
      });
      const prisma = makePrisma(tx);
      const service = new TransactionsService(prisma as never);

      await expect(
        service.post(dtoOf({ kind: 'REVERSAL', originalTransactionId: 'orig-1', amountMinor: 10_000 }), 'idem-rev'),
      ).rejects.toMatchObject({ response: { code: 'Transactions.NotReversible' } });
    });

    it('rejects reversing a POSTED transaction with no ledger entries (422 NotReversible)', async () => {
      const tx = makeTx({
        transaction: {
          create: jest.fn(),
          findUnique: jest.fn().mockResolvedValue(originalPosted({ entries: [] })),
          update: jest.fn(),
        },
      });
      const prisma = makePrisma(tx);
      const service = new TransactionsService(prisma as never);

      await expect(
        service.post(dtoOf({ kind: 'REVERSAL', originalTransactionId: 'orig-1', amountMinor: 10_000 }), 'idem-rev'),
      ).rejects.toMatchObject({ response: { code: 'Transactions.NotReversible' } });
    });

    it('rejects a confirm-by-value mismatch on amount (422 ReversalMismatch)', async () => {
      const tx = makeTx({
        transaction: {
          create: jest.fn(),
          findUnique: jest.fn().mockResolvedValue(originalPosted()),
          update: jest.fn(),
        },
      });
      const prisma = makePrisma(tx);
      const service = new TransactionsService(prisma as never);

      // The original total DEBIT is 10_000; the caller states 9_999.
      await expect(
        service.post(dtoOf({ kind: 'REVERSAL', originalTransactionId: 'orig-1', amountMinor: 9_999, currency: 'USD' }), 'idem-rev'),
      ).rejects.toMatchObject({ response: { code: 'Transactions.ReversalMismatch' } });
    });

    it('rejects a confirm-by-value mismatch on currency (422 ReversalMismatch)', async () => {
      const tx = makeTx({
        transaction: {
          create: jest.fn(),
          findUnique: jest.fn().mockResolvedValue(originalPosted()),
          update: jest.fn(),
        },
      });
      const prisma = makePrisma(tx);
      const service = new TransactionsService(prisma as never);

      await expect(
        service.post(dtoOf({ kind: 'REVERSAL', originalTransactionId: 'orig-1', amountMinor: 10_000, currency: 'EUR' }), 'idem-rev'),
      ).rejects.toMatchObject({ response: { code: 'Transactions.ReversalMismatch' } });
    });

    it('maps the reversal_of UNIQUE race to a clean 409 AlreadyReversed (reverse-once backstop)', async () => {
      const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint', {
        code: 'P2002',
        clientVersion: 'test',
        // Prisma names the offending UNIQUE — here the `reversal_of` field — so the service can
        // classify it precisely instead of assuming every P2002 is a reversal race.
        meta: { target: ['reversalOf'] },
      });
      const tx = makeTx({
        transaction: {
          // The transaction-row insert loses the reversal_of UNIQUE race.
          create: jest.fn().mockRejectedValue(p2002),
          findUnique: jest.fn().mockResolvedValue(originalPosted()),
          update: jest.fn(),
        },
        wallet: {
          findFirst: jest.fn().mockResolvedValue(null),
          findMany: jest.fn().mockResolvedValue([
            makeWallet({ id: 'w-a', accountId: 'acc-a', balance: { balanceMinor: 0n, availableBalanceMinor: 0n } }),
            makeWallet({ id: 'w-b', accountId: 'acc-b', balance: { balanceMinor: 1_000_000n, availableBalanceMinor: 1_000_000n } }),
          ]),
        },
      });
      const prisma = makePrisma(tx);
      const service = new TransactionsService(prisma as never);

      await expect(
        service.post(dtoOf({ kind: 'REVERSAL', originalTransactionId: 'orig-1', amountMinor: 10_000, currency: 'USD' }), 'idem-rev'),
      ).rejects.toMatchObject({ response: { code: 'Transactions.AlreadyReversed' } });
    });

    it('falls back to AlreadyReversed when a REVERSAL insert trips a UNIQUE with no meta.target (older driver)', async () => {
      // No meta.target on the error. The only UNIQUE a REVERSAL insert can trip is `reversal_of`,
      // so the historical reverse-once mapping is preserved for backward compatibility.
      const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint', { code: 'P2002', clientVersion: 'test' });
      const tx = makeTx({
        transaction: {
          create: jest.fn().mockRejectedValue(p2002),
          findUnique: jest.fn().mockResolvedValue(originalPosted()),
          update: jest.fn(),
        },
        wallet: {
          findFirst: jest.fn().mockResolvedValue(null),
          findMany: jest.fn().mockResolvedValue([
            makeWallet({ id: 'w-a', accountId: 'acc-a', balance: { balanceMinor: 0n, availableBalanceMinor: 0n } }),
            makeWallet({ id: 'w-b', accountId: 'acc-b', balance: { balanceMinor: 1_000_000n, availableBalanceMinor: 1_000_000n } }),
          ]),
        },
      });
      const prisma = makePrisma(tx);
      const service = new TransactionsService(prisma as never);

      await expect(
        service.post(dtoOf({ kind: 'REVERSAL', originalTransactionId: 'orig-1', amountMinor: 10_000, currency: 'USD' }), 'idem-rev'),
      ).rejects.toMatchObject({ response: { code: 'Transactions.AlreadyReversed' } });
    });
  });

  describe('createTransactionRow — non-P2002 errors propagate unchanged', () => {
    it('rethrows a non-P2002 Prisma error from the transaction insert', async () => {
      const other = new Prisma.PrismaClientKnownRequestError('FK violation', { code: 'P2003', clientVersion: 'test' });
      const tx = makeTx({
        transaction: {
          create: jest.fn().mockRejectedValue(other),
          findUnique: jest.fn(),
          update: jest.fn(),
        },
        wallet: {
          findFirst: jest.fn().mockResolvedValue(null),
          findMany: jest.fn().mockResolvedValue([
            makeWallet({ id: 'w-src', accountId: 'acc-src', balance: { balanceMinor: 1_000_000n, availableBalanceMinor: 1_000_000n } }),
            makeWallet({ id: 'w-tgt', accountId: 'acc-tgt', balance: { balanceMinor: 0n, availableBalanceMinor: 0n } }),
          ]),
        },
      });
      const prisma = makePrisma(tx);
      const service = new TransactionsService(prisma as never);

      await expect(
        service.post(dtoOf({ kind: 'TRANSFER', sourceWalletId: 'w-src', targetWalletId: 'w-tgt' }), 'idem-1'),
      ).rejects.toBe(other);
      // The key is released on the failure so a retry is possible.
      expect(prisma.idempotencyKey.delete).toHaveBeenCalledWith({ where: { key: 'idem-1' } });
    });
  });

  describe('createTransactionRow — P2002 UNIQUE races are classified by target', () => {
    // Two funded wallets so a TRANSFER reaches the transaction-row insert (plan.reversalOf is unset,
    // proving the target — not the kind — drives the classification).
    const twoWallets = () => ({
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([
        makeWallet({ id: 'w-src', accountId: 'acc-src', balance: { balanceMinor: 1_000_000n, availableBalanceMinor: 1_000_000n } }),
        makeWallet({ id: 'w-tgt', accountId: 'acc-tgt', balance: { balanceMinor: 0n, availableBalanceMinor: 0n } }),
      ]),
    });

    it('maps a transactions.idempotency_key UNIQUE race to 409 Idempotency.KeyConflict, not AlreadyReversed', async () => {
      // The F1 replay backstop: a concurrent request with this key already posted a transaction, so the
      // idempotency_key UNIQUE rejects the duplicate insert. This is an idempotency conflict, NOT a reversal.
      const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint', {
        code: 'P2002',
        clientVersion: 'test',
        meta: { target: ['idempotency_key'] },
      });
      const tx = makeTx({
        transaction: { create: jest.fn().mockRejectedValue(p2002), findUnique: jest.fn(), update: jest.fn() },
        wallet: twoWallets(),
      });
      const prisma = makePrisma(tx);
      const service = new TransactionsService(prisma as never);

      // The code is Idempotency.KeyConflict (which, being an exact string, is by construction NOT
      // Transactions.AlreadyReversed — the pre-fix mislabel).
      await expect(
        service.post(dtoOf({ kind: 'TRANSFER', sourceWalletId: 'w-src', targetWalletId: 'w-tgt' }), 'idem-dup'),
      ).rejects.toMatchObject({ response: { code: 'Idempotency.KeyConflict' } });
      // Key release is preserved by the existing post() catch flow so the caller can replay/resolve.
      expect(prisma.idempotencyKey.delete).toHaveBeenCalledWith({ where: { key: 'idem-dup' } });
    });

    it('rethrows a P2002 whose target is neither reversal nor idempotency (e.g. a public_ref collision)', async () => {
      // A realistic Postgres constraint-name STRING that matches neither classifier. It must NOT be
      // swallowed as AlreadyReversed (the pre-fix behavior) — the raw P2002 propagates unchanged.
      const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint', {
        code: 'P2002',
        clientVersion: 'test',
        meta: { target: 'transactions_public_ref_key' },
      });
      const tx = makeTx({
        transaction: { create: jest.fn().mockRejectedValue(p2002), findUnique: jest.fn(), update: jest.fn() },
        wallet: twoWallets(),
      });
      const prisma = makePrisma(tx);
      const service = new TransactionsService(prisma as never);

      await expect(
        service.post(dtoOf({ kind: 'TRANSFER', sourceWalletId: 'w-src', targetWalletId: 'w-tgt' }), 'idem-pr'),
      ).rejects.toBe(p2002);
      // The key is still released on the failure so a retry is possible.
      expect(prisma.idempotencyKey.delete).toHaveBeenCalledWith({ where: { key: 'idem-pr' } });
    });
  });

  describe('idempotency release-failure branch', () => {
    it('logs (does not throw) when releasing the key after a posting failure itself fails', async () => {
      // Arrange — a same-wallet transfer fails inside the transaction, then the key DELETE rejects.
      const tx = makeTx();
      const prisma = makePrisma(tx, {
        idempotencyKey: {
          findUnique: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockResolvedValue(undefined),
          update: jest.fn().mockResolvedValue(undefined),
          delete: jest.fn().mockRejectedValue(new Error('db blip on release')),
        },
      });
      const service = new TransactionsService(prisma as never);
      const errorSpy = jest.spyOn((service as unknown as { logger: { error: (...a: unknown[]) => void } }).logger, 'error').mockImplementation(() => undefined);

      // Act + Assert — the ORIGINAL posting error surfaces (SameWallet), not the release error.
      await expect(
        service.post(dtoOf({ kind: 'TRANSFER', sourceWalletId: 'w-x', targetWalletId: 'w-x' }), 'idem-1'),
      ).rejects.toMatchObject({ response: { code: 'Transactions.SameWallet' } });
      // The release failure was logged, never swallowed silently (audit O-8).
      expect(errorSpy).toHaveBeenCalled();
      errorSpy.mockRestore();
    });
  });

  describe('P2002 on create without a re-readable row', () => {
    it('rethrows the P2002 when the racing winner row cannot be re-read', async () => {
      const dto = dtoOf({ kind: 'TRANSFER', sourceWalletId: 'w-src', targetWalletId: 'w-tgt' });
      const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint', { code: 'P2002', clientVersion: 'test' });
      const tx = makeTx();
      const prisma = makePrisma(tx, {
        idempotencyKey: {
          // First lookup empty; create loses the race; the re-read still returns null (row not visible).
          findUnique: jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(null),
          create: jest.fn().mockRejectedValue(p2002),
          update: jest.fn(),
          delete: jest.fn(),
        },
      });
      const service = new TransactionsService(prisma as never);

      await expect(service.post(dto, 'idem-1')).rejects.toBe(p2002);
      expect(fingerprintOf(dto)).toEqual(expect.any(String)); // fingerprint helper stays consistent
    });

    it('rethrows a non-P2002 create error unchanged', async () => {
      const dto = dtoOf({ kind: 'TRANSFER', sourceWalletId: 'w-src', targetWalletId: 'w-tgt' });
      const other = new Error('connection reset');
      const tx = makeTx();
      const prisma = makePrisma(tx, {
        idempotencyKey: {
          findUnique: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockRejectedValue(other),
          update: jest.fn(),
          delete: jest.fn(),
        },
      });
      const service = new TransactionsService(prisma as never);

      await expect(service.post(dto, 'idem-1')).rejects.toBe(other);
    });
  });

  describe('stale-reclaim delete races a concurrent reclaim', () => {
    it('still proceeds to post when the stale-IN_PROGRESS delete itself rejects (concurrent reclaim removed it)', async () => {
      // A stranded IN_PROGRESS key from 5 minutes ago; the reclaim DELETE rejects (a concurrent
      // reclaim already removed it). The service swallows that and the fresh create below wins.
      const dto = dtoOf({ kind: 'TRANSFER', sourceWalletId: 'w-src', targetWalletId: 'w-tgt' });
      const tx = makeTx({
        wallet: {
          findFirst: jest.fn().mockResolvedValue(null),
          findMany: jest.fn().mockResolvedValue([
            makeWallet({ id: 'w-src', accountId: 'acc-src', balance: { balanceMinor: 1_000_000n, availableBalanceMinor: 1_000_000n } }),
            makeWallet({ id: 'w-tgt', accountId: 'acc-tgt', balance: { balanceMinor: 0n, availableBalanceMinor: 0n } }),
          ]),
        },
      });
      const deleteMock = jest
        .fn()
        .mockRejectedValueOnce(new Error('already gone — concurrent reclaim')) // the stale-reclaim delete
        .mockResolvedValue(undefined); // any later release
      const prisma = makePrisma(tx, {
        idempotencyKey: {
          findUnique: jest.fn().mockResolvedValue({
            requestFingerprint: fingerprintOf(dto),
            state: 'IN_PROGRESS',
            responseBodyJson: null,
            createdAt: new Date(Date.now() - 5 * 60 * 1000),
          }),
          create: jest.fn().mockResolvedValue(undefined),
          update: jest.fn().mockResolvedValue(undefined),
          delete: deleteMock,
        },
      });
      const service = new TransactionsService(prisma as never);

      const result = await service.post(dto, 'idem-stale');

      expect(deleteMock).toHaveBeenCalled();
      expect(result).toMatchObject({ status: 'POSTED' });
    });
  });

  describe('ledger-imbalance invariant guard (must-never-happen bug guard)', () => {
    it('rolls the posting back when a REVERSAL plan does not balance (SUM(DEBIT) != SUM(CREDIT))', async () => {
      // Craft an original whose entries pass confirm-by-value (totalDebit == dto.amountMinor) but
      // whose CREDIT magnitude differs, so the mirrored plan is unbalanced and trips the guard.
      const unbalancedOriginal = {
        id: 'orig-1',
        accountId: 'acc-orig',
        status: 'POSTED',
        entries: [
          { walletId: 'w-a', leg: 'DEBIT', amountMinor: 10_000n, currency: 'USD' },
          { walletId: 'w-b', leg: 'CREDIT', amountMinor: 9_000n, currency: 'USD' },
        ],
      };
      const tx = makeTx({
        transaction: {
          create: jest.fn().mockResolvedValue(undefined),
          findUnique: jest.fn().mockResolvedValue(unbalancedOriginal),
          update: jest.fn().mockResolvedValue(undefined),
        },
        wallet: {
          findFirst: jest.fn().mockResolvedValue(null),
          findMany: jest.fn().mockResolvedValue([
            makeWallet({ id: 'w-a', accountId: 'acc-a', balance: { balanceMinor: 0n, availableBalanceMinor: 0n } }),
            makeWallet({ id: 'w-b', accountId: 'acc-b', balance: { balanceMinor: 1_000_000n, availableBalanceMinor: 1_000_000n } }),
          ]),
        },
      });
      const prisma = makePrisma(tx);
      const service = new TransactionsService(prisma as never);

      await expect(
        service.post(dtoOf({ kind: 'REVERSAL', originalTransactionId: 'orig-1', amountMinor: 10_000, currency: 'USD' }), 'idem-rev'),
      ).rejects.toThrow(/Ledger invariant violated/);
      // The key is released so the (impossible) state can be retried after the fix.
      expect(prisma.idempotencyKey.delete).toHaveBeenCalledWith({ where: { key: 'idem-rev' } });
    });
  });

});
