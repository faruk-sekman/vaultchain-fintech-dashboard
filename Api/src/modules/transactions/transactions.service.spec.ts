/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Unit tests for the ledger posting service. Prisma is mocked,
 * so these run with no database: they pin the money-critical invariants — balanced double-entry,
 * sufficient-balance checks, same/cross-currency guards, and idempotency replay/conflict — in
 * milliseconds. The real DB path is additionally covered by transactions.posting.int-spec.ts.
 */
import { Prisma } from '@prisma/client';
import { fingerprintRequest } from '../../common/util/request-fingerprint';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import { TransactionsService } from './transactions.service';

type LedgerLeg = { leg: 'DEBIT' | 'CREDIT'; amountMinor: bigint; walletId: string };

/** A wallet row as `executePlan` reads it (id-keyed, with its balance). */
function makeWallet(over: Record<string, unknown> = {}) {
  return {
    id: 'w-src',
    currency: 'USD',
    isSystem: false,
    accountId: 'acc-src',
    balance: { balanceMinor: 1_000_000n, availableBalanceMinor: 1_000_000n },
    ...over,
  };
}

/** A transaction-scoped Prisma client (`tx`) with the calls `executePlan` makes. */
function makeTx(over: Record<string, unknown> = {}) {
  return {
    // Tagged-template router: FOR UPDATE locks return nothing; the seq/ref helpers return a row.
    $queryRaw: jest.fn((strings: TemplateStringsArray) => {
      const sql = Array.isArray(strings) ? strings.join(' ') : String(strings);
      if (sql.includes('nextval')) return Promise.resolve([{ v: 1 }]);
      if (sql.includes('entry_seq')) return Promise.resolve([{ seq: 1 }]);
      return Promise.resolve([]);
    }),
    transaction: {
      create: jest.fn().mockResolvedValue(undefined),
      findUnique: jest.fn(),
      update: jest.fn().mockResolvedValue(undefined),
    },
    ledgerEntry: { createMany: jest.fn().mockResolvedValue({ count: 2 }) },
    wallet: { findMany: jest.fn().mockResolvedValue([]) },
    walletBalance: { update: jest.fn().mockResolvedValue(undefined) },
    // Completion (mark COMPLETED) now runs THROUGH the transaction client, atomically with the ledger.
    idempotencyKey: { update: jest.fn().mockResolvedValue(undefined) },
    ...over,
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

const transferDto = (over: Partial<CreateTransactionDto> = {}): CreateTransactionDto =>
  ({
    kind: 'TRANSFER',
    sourceWalletId: 'w-src',
    targetWalletId: 'w-tgt',
    amountMinor: 10_000,
    currency: 'USD',
    ...over,
  }) as unknown as CreateTransactionDto;

/** Reproduce the fingerprint the service derives, so replay/conflict paths can be exercised. */
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

describe('TransactionsService.post', () => {
  describe('guards before posting', () => {
    it('rejects an unimplemented kind with 422 and never opens a transaction', async () => {
      // Arrange
      const tx = makeTx();
      const prisma = makePrisma(tx);
      const service = new TransactionsService(prisma as never);

      // Act + Assert
      await expect(service.post(transferDto({ kind: 'ADJUSTMENT' as never }), 'idem-1')).rejects.toMatchObject({
        response: { code: 'Transactions.KindNotImplemented' },
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.idempotencyKey.create).not.toHaveBeenCalled();
    });

    it('replays a COMPLETED idempotent request without re-posting', async () => {
      // Arrange — a stored row whose fingerprint matches the incoming request.
      const dto = transferDto();
      const stored = { id: 'tx-1', publicRef: 'TX-2026-000001', status: 'POSTED', amountMinor: '10000', currency: 'USD', postedAt: 'x' };
      const tx = makeTx();
      const prisma = makePrisma(tx, {
        idempotencyKey: {
          findUnique: jest.fn().mockResolvedValue({ requestFingerprint: fingerprintOf(dto), state: 'COMPLETED', responseBodyJson: stored }),
          create: jest.fn(),
          update: jest.fn(),
          delete: jest.fn(),
        },
      });
      const service = new TransactionsService(prisma as never);

      // Act
      const result = await service.post(dto, 'idem-1');

      // Assert — returns the stored snapshot, opens no new transaction.
      expect(result).toEqual(stored);
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.idempotencyKey.create).not.toHaveBeenCalled();
    });

    it('rejects a key reused with a different body (fingerprint mismatch) as 409', async () => {
      const dto = transferDto();
      const tx = makeTx();
      const prisma = makePrisma(tx, {
        idempotencyKey: {
          findUnique: jest.fn().mockResolvedValue({ requestFingerprint: 'a-different-fingerprint', state: 'COMPLETED', responseBodyJson: {} }),
          create: jest.fn(),
          update: jest.fn(),
          delete: jest.fn(),
        },
      });
      const service = new TransactionsService(prisma as never);

      await expect(service.post(dto, 'idem-1')).rejects.toMatchObject({ response: { code: 'Idempotency.KeyConflict' } });
    });

    it('reports an in-flight key (IN_PROGRESS) as 409', async () => {
      const dto = transferDto();
      const tx = makeTx();
      const prisma = makePrisma(tx, {
        idempotencyKey: {
          findUnique: jest.fn().mockResolvedValue({ requestFingerprint: fingerprintOf(dto), state: 'IN_PROGRESS', responseBodyJson: null }),
          create: jest.fn(),
          update: jest.fn(),
          delete: jest.fn(),
        },
      });
      const service = new TransactionsService(prisma as never);

      await expect(service.post(dto, 'idem-1')).rejects.toMatchObject({ response: { code: 'Idempotency.InFlight' } });
    });

    it('reclaims a STALE IN_PROGRESS key (stranded remnant) and posts instead of 409 (audit O-8)', async () => {
      // Arrange — a prior attempt died mid-flight, stranding an IN_PROGRESS row 5 minutes ago.
      const dto = transferDto();
      const tx = makeTx({
        wallet: {
          findMany: jest.fn().mockResolvedValue([
            makeWallet({ id: 'w-src', accountId: 'acc-src', balance: { balanceMinor: 50_000n, availableBalanceMinor: 50_000n } }),
            makeWallet({ id: 'w-tgt', accountId: 'acc-tgt', balance: { balanceMinor: 0n, availableBalanceMinor: 0n } }),
          ]),
        },
      });
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
          delete: jest.fn().mockResolvedValue(undefined),
        },
      });
      const service = new TransactionsService(prisma as never);

      // Act
      const result = await service.post(dto, 'idem-1');

      // Assert — the stranded key was reclaimed (deleted), then a fresh posting completed; NOT InFlight.
      expect(prisma.idempotencyKey.delete).toHaveBeenCalledWith({ where: { key: 'idem-1' } });
      expect(tx.idempotencyKey.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ state: 'COMPLETED' }) }),
      );
      expect(result).toMatchObject({ status: 'POSTED' });
    });
  });

  describe('TRANSFER posting', () => {
    it('writes a balanced double-entry and moves the balances, returning a POSTED snapshot', async () => {
      // Arrange — two same-currency customer wallets, source funded.
      const tx = makeTx({
        wallet: {
          findMany: jest.fn().mockResolvedValue([
            makeWallet({ id: 'w-src', accountId: 'acc-src', balance: { balanceMinor: 50_000n, availableBalanceMinor: 50_000n } }),
            makeWallet({ id: 'w-tgt', accountId: 'acc-tgt', balance: { balanceMinor: 0n, availableBalanceMinor: 0n } }),
          ]),
        },
      });
      const prisma = makePrisma(tx);
      const service = new TransactionsService(prisma as never);

      // Act
      const result = await service.post(transferDto({ amountMinor: 10_000 }), 'idem-1');

      // Assert — snapshot shape.
      expect(result).toMatchObject({ status: 'POSTED', amountMinor: '10000', currency: 'USD' });
      expect(result.publicRef).toBe('TX-2026-000001');

      // Assert — the ledger entries balance: SUM(DEBIT) === SUM(CREDIT) and the two legs are opposite + equal.
      const entries = tx.ledgerEntry.createMany.mock.calls[0][0].data as LedgerLeg[];
      expect(entries).toHaveLength(2);
      const debit = entries.filter((e) => e.leg === 'DEBIT').reduce((s, e) => s + e.amountMinor, 0n);
      const credit = entries.filter((e) => e.leg === 'CREDIT').reduce((s, e) => s + e.amountMinor, 0n);
      expect(debit).toBe(credit);
      expect(debit).toBe(10_000n);
      expect(entries.find((e) => e.leg === 'DEBIT')?.walletId).toBe('w-src');
      expect(entries.find((e) => e.leg === 'CREDIT')?.walletId).toBe('w-tgt');

      // Assert — balances moved both ways and the key was completed (atomically, via the tx client).
      expect(tx.walletBalance.update).toHaveBeenCalledTimes(2);
      expect(tx.idempotencyKey.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ state: 'COMPLETED' }) }));
    });

    it('rejects a transfer to the same wallet with 422 and releases the idempotency key', async () => {
      const tx = makeTx();
      const prisma = makePrisma(tx);
      const service = new TransactionsService(prisma as never);

      await expect(service.post(transferDto({ targetWalletId: 'w-src' }), 'idem-1')).rejects.toMatchObject({
        response: { code: 'Transactions.SameWallet' },
      });
      // Posting failed inside the transaction → the key is deleted so the client may retry.
      expect(prisma.idempotencyKey.delete).toHaveBeenCalledWith({ where: { key: 'idem-1' } });
    });

    it('rejects a transfer missing the target wallet with 400', async () => {
      const tx = makeTx();
      const prisma = makePrisma(tx);
      const service = new TransactionsService(prisma as never);

      await expect(service.post(transferDto({ targetWalletId: undefined }), 'idem-1')).rejects.toMatchObject({
        response: { code: 'Validation.Failed' },
      });
    });

    it('rejects when the source has insufficient available balance (422)', async () => {
      const tx = makeTx({
        wallet: {
          findMany: jest.fn().mockResolvedValue([
            makeWallet({ id: 'w-src', accountId: 'acc-src', balance: { balanceMinor: 500n, availableBalanceMinor: 500n } }),
            makeWallet({ id: 'w-tgt', accountId: 'acc-tgt' }),
          ]),
        },
      });
      const prisma = makePrisma(tx);
      const service = new TransactionsService(prisma as never);

      await expect(service.post(transferDto({ amountMinor: 10_000 }), 'idem-1')).rejects.toMatchObject({
        response: { code: 'Transactions.InsufficientBalance' },
      });
      expect(tx.ledgerEntry.createMany).not.toHaveBeenCalled();
    });

    it('rejects legs that do not share the transaction currency (422 cross-currency)', async () => {
      const tx = makeTx({
        wallet: {
          findMany: jest.fn().mockResolvedValue([
            makeWallet({ id: 'w-src', accountId: 'acc-src', currency: 'USD' }),
            makeWallet({ id: 'w-tgt', accountId: 'acc-tgt', currency: 'EUR' }),
          ]),
        },
      });
      const prisma = makePrisma(tx);
      const service = new TransactionsService(prisma as never);

      await expect(service.post(transferDto(), 'idem-1')).rejects.toMatchObject({
        response: { code: 'Transactions.CrossCurrency' },
      });
    });

    it('rejects when a wallet in the plan does not exist (404)', async () => {
      const tx = makeTx({
        wallet: {
          // Only the source resolves; the target is missing.
          findMany: jest.fn().mockResolvedValue([makeWallet({ id: 'w-src', accountId: 'acc-src' })]),
        },
      });
      const prisma = makePrisma(tx);
      const service = new TransactionsService(prisma as never);

      await expect(service.post(transferDto(), 'idem-1')).rejects.toMatchObject({
        response: { code: 'Wallet.NotFound' },
      });
    });
  });

  describe('concurrency', () => {
    it('replays the winning row when a racing request claims the key first (P2002)', async () => {
      // Arrange — initial lookup is empty, the create loses the race (unique violation),
      // and the re-read returns the COMPLETED row the winner wrote.
      const dto = transferDto();
      const stored = { id: 'tx-1', publicRef: 'TX-2026-000001', status: 'POSTED', amountMinor: '10000', currency: 'USD', postedAt: 'x' };
      const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint', { code: 'P2002', clientVersion: 'test' });
      const tx = makeTx();
      const prisma = makePrisma(tx, {
        idempotencyKey: {
          findUnique: jest
            .fn()
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ requestFingerprint: fingerprintOf(dto), state: 'COMPLETED', responseBodyJson: stored }),
          create: jest.fn().mockRejectedValue(p2002),
          update: jest.fn(),
          delete: jest.fn(),
        },
      });
      const service = new TransactionsService(prisma as never);

      // Act
      const result = await service.post(dto, 'idem-1');

      // Assert — the racing request returns the winner's snapshot, posts nothing itself.
      expect(result).toEqual(stored);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('crash-window atomicity (audit F1)', () => {
    it('marks the key COMPLETED THROUGH the posting transaction, not in a separate post-commit write', async () => {
      // Arrange — a funded transfer that posts cleanly.
      const tx = makeTx({
        wallet: {
          findMany: jest.fn().mockResolvedValue([
            makeWallet({ id: 'w-src', accountId: 'acc-src', balance: { balanceMinor: 50_000n, availableBalanceMinor: 50_000n } }),
            makeWallet({ id: 'w-tgt', accountId: 'acc-tgt', balance: { balanceMinor: 0n, availableBalanceMinor: 0n } }),
          ]),
        },
      });
      const prisma = makePrisma(tx);
      const service = new TransactionsService(prisma as never);

      // Act
      await service.post(transferDto({ amountMinor: 10_000 }), 'idem-1');

      // Assert — completion is written via the TRANSACTION client, so it commits atomically with the
      // ledger; there is NO separate post-commit update (the old crash-window path is gone).
      expect(tx.idempotencyKey.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ state: 'COMPLETED' }) }),
      );
      expect(prisma.idempotencyKey.update).not.toHaveBeenCalled();
    });

    it('never marks the key COMPLETED when posting fails inside the transaction, and releases it for retry', async () => {
      // Arrange — the source cannot cover the transfer, so executePlan throws INSIDE the transaction.
      const tx = makeTx({
        wallet: {
          findMany: jest.fn().mockResolvedValue([
            makeWallet({ id: 'w-src', accountId: 'acc-src', balance: { balanceMinor: 500n, availableBalanceMinor: 500n } }),
            makeWallet({ id: 'w-tgt', accountId: 'acc-tgt', balance: { balanceMinor: 0n, availableBalanceMinor: 0n } }),
          ]),
        },
      });
      const prisma = makePrisma(tx);
      const service = new TransactionsService(prisma as never);

      // Act + Assert — the whole transaction rolls back...
      await expect(service.post(transferDto({ amountMinor: 10_000 }), 'idem-1')).rejects.toMatchObject({
        response: { code: 'Transactions.InsufficientBalance' },
      });
      // ...so the key is NEVER completed (no committed ledger to record) and is released for a clean retry.
      expect(tx.idempotencyKey.update).not.toHaveBeenCalled();
      expect(prisma.idempotencyKey.delete).toHaveBeenCalledWith({ where: { key: 'idem-1' } });
    });
  });
});
