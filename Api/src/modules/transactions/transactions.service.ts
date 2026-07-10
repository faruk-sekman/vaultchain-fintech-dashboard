/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Ledger posting. Implements the algorithm in
 * docs/backend-api/ledger-posting-design.md: idempotency guard → single DB transaction with
 * deterministic `FOR UPDATE` wallet locking → balance check → balanced double-entry insert →
 * snapshot update → idempotency completion.
 *
 * The initial ledger shipped kind = TRANSFER; later work adds DEPOSIT / WITHDRAWAL / FEE (the external leg
 * posts against a per-currency system wallet) and REVERSAL (a mirrored, reverse-once
 * counter-posting). ADJUSTMENT stays a documented follow-up → 422 Transactions.KindNotImplemented.
 *
 * Every kind reduces to a balanced `PostingPlan` (a list of legs that sum to zero), which a single
 * audited executor writes atomically — so the money-critical path stays singular, not per-kind.
 */
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma, TransactionKind } from '@prisma/client';
import { minorToWireString } from '../../common/util/money';
import { fingerprintRequest } from '../../common/util/request-fingerprint';
import { uuidv7 } from '../../common/util/uuid';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { CreateTransactionDto } from './dto/create-transaction.dto';

export interface TransactionSnapshot {
  id: string;
  publicRef: string;
  status: 'POSTED';
  // Money wire-format: a decimal STRING of the exact integer minor-units.
  amountMinor: string;
  currency: string;
  postedAt: string;
}

/** One side of a posting. A `balanceChecked` debit on a non-system wallet must not overdraw. */
interface PlannedLeg {
  walletId: string;
  leg: 'DEBIT' | 'CREDIT';
  amount: bigint;
  balanceChecked: boolean;
}

/** A resolved, kind-agnostic posting the executor writes atomically. */
interface PostingPlan {
  kind: TransactionKind;
  currency: string;
  amountMinor: bigint; // headline amount for the response snapshot
  legs: PlannedLeg[];
  ownerWalletId?: string; // transactions.account_id comes from this wallet's account…
  ownerAccountId?: string; // …unless set explicitly (REVERSAL reuses the original's account)
  reversalOf?: string; // REVERSAL → original transaction id (UNIQUE column: reverse-once)
  markReversedTxId?: string; // original transaction to flip POSTED → REVERSED
}

/** A wallet row with its balance, as the executor locks and reads it. */
type WalletWithBalance = Prisma.WalletGetPayload<{ include: { balance: true } }>;

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
// A posting completes in milliseconds, so an IN_PROGRESS key older than this can only be a
// stranded remnant of a process that died before COMPLETED or cleanup. Reclaim it instead of
// wedging every legitimate retry with 409 InFlight for the full 24h TTL (audit O-8).
const IDEMPOTENCY_STALE_MS = 60 * 1000;
const IMPLEMENTED_KINDS: ReadonlySet<TransactionKind> = new Set([
  'TRANSFER',
  'DEPOSIT',
  'WITHDRAWAL',
  'FEE',
  'REVERSAL',
]);

/**
 * Flatten a Prisma P2002 `meta.target` (string | string[] | undefined) into one lowercased string so
 * the offending UNIQUE can be classified regardless of whether Prisma reports the model field
 * (`reversalOf`), the DB column (`reversal_of`), or the constraint name (`transactions_reversal_of_key`).
 * Returns '' when the driver omits the target.
 */
function p2002TargetText(error: Prisma.PrismaClientKnownRequestError): string {
  const target: unknown = error.meta?.target;
  if (Array.isArray(target)) return target.join(' ').toLowerCase();
  if (typeof target === 'string') return target.toLowerCase();
  return '';
}

@Injectable()
export class TransactionsService {
  private readonly logger = new Logger(TransactionsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async post(
    dto: CreateTransactionDto,
    idempotencyKey: string,
    clientId = 'default',
  ): Promise<TransactionSnapshot> {
    if (!IMPLEMENTED_KINDS.has(dto.kind)) {
      throw new UnprocessableEntityException({
        code: 'Transactions.KindNotImplemented',
        message: `Transaction kind ${dto.kind} is not yet implemented.`,
      });
    }

    const fingerprint = fingerprintRequest({
      kind: dto.kind,
      sourceWalletId: dto.sourceWalletId,
      targetWalletId: dto.targetWalletId,
      originalTransactionId: dto.originalTransactionId,
      amountMinor: dto.amountMinor,
      currency: dto.currency,
      categoryId: dto.categoryId,
      description: dto.description,
    });

    const existing = await this.prisma.idempotencyKey.findUnique({ where: { key: idempotencyKey } });
    if (existing) {
      if (this.isStaleInProgress(existing)) {
        // A prior attempt for this key died before COMPLETED or cleanup, stranding it IN_PROGRESS.
        // Reclaim it so a legitimate retry is not blocked for the full 24h TTL (audit O-8).
        this.logger.warn(
          `Reclaiming stale IN_PROGRESS idempotency key (older than ${IDEMPOTENCY_STALE_MS}ms).`,
        );
        await this.prisma.idempotencyKey
          .delete({ where: { key: idempotencyKey } })
          .catch(() => undefined); // a concurrent reclaim already removed it — the create below races safely
      } else {
        return this.resolveExisting(existing, fingerprint);
      }
    }

    try {
      await this.prisma.idempotencyKey.create({
        data: {
          key: idempotencyKey,
          clientId,
          requestFingerprint: fingerprint,
          state: 'IN_PROGRESS',
          expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        // Concurrent request claimed the key first — replay or report in-flight.
        const row = await this.prisma.idempotencyKey.findUnique({ where: { key: idempotencyKey } });
        if (row) {
          return this.resolveExisting(row, fingerprint);
        }
      }
      throw error;
    }

    let snapshot: TransactionSnapshot;
    try {
      // Post the ledger AND mark the idempotency key COMPLETED (with the cached response) in ONE
      // interactive transaction, so the financial movement and its idempotency record commit together.
      // Previously completion ran in a SEPARATE transaction AFTER posting had already committed; a crash
      // in that window left the key IN_PROGRESS over an already-posted ledger, and the stale-reclaim path
      // could then replay it into a SECOND financial movement (audit F1 — CWE-362 / CWE-841). The
      // transactions.idempotency_key UNIQUE constraint is the DB-level backstop for that replay.
      snapshot = await this.prisma.$transaction(async (tx) => {
        const posted = await this.postByKind(tx, dto, idempotencyKey);
        await tx.idempotencyKey.update({
          where: { key: idempotencyKey },
          data: {
            state: 'COMPLETED',
            responseStatus: 201,
            responseBodyJson: posted as unknown as Prisma.InputJsonValue,
          },
        });
        return posted;
      });
    } catch (error) {
      // Posting (or the completion write) failed and the whole transaction rolled back — no ledger state
      // was committed. Release the key so the client may retry.
      await this.prisma.idempotencyKey
        .delete({ where: { key: idempotencyKey } })
        .catch((releaseError: unknown) => {
          // Best-effort: if the release itself fails (DB blip), the stale-reclaim path above
          // recovers the key after IDEMPOTENCY_STALE_MS rather than stranding it for the full TTL.
          // Log it — never swallow silently (audit O-8).
          this.logger.error(
            `Failed to release idempotency key after posting failure; reclaimable in ${IDEMPOTENCY_STALE_MS}ms.`,
            releaseError instanceof Error ? releaseError.stack : String(releaseError),
          );
        });
      throw error;
    }
    return snapshot;
  }

  private resolveExisting(
    row: { requestFingerprint: string; state: string; responseBodyJson: Prisma.JsonValue | null },
    fingerprint: string,
  ): TransactionSnapshot {
    if (row.requestFingerprint !== fingerprint) {
      throw new ConflictException({
        code: 'Idempotency.KeyConflict',
        message: 'Idempotency-Key was reused with a different request body.',
      });
    }
    if (row.state === 'COMPLETED' && row.responseBodyJson) {
      return row.responseBodyJson as unknown as TransactionSnapshot;
    }
    throw new ConflictException({
      code: 'Idempotency.InFlight',
      message: 'A request with this Idempotency-Key is already in progress.',
    });
  }

  /**
   * True when an IN_PROGRESS key is old enough to be a stranded remnant (a prior process died
   * before COMPLETED/cleanup) rather than a live in-flight request. A missing/invalid timestamp
   * is treated as fresh (not reclaimable), so genuine concurrency still reports 409 InFlight.
   */
  private isStaleInProgress(row: { state: string; createdAt: Date }): boolean {
    if (row.state !== 'IN_PROGRESS') return false;
    const ageMs = Date.now() - new Date(row.createdAt).getTime();
    return Number.isFinite(ageMs) && ageMs > IDEMPOTENCY_STALE_MS;
  }

  /** Resolve the kind-specific plan, then post it atomically. */
  private async postByKind(
    tx: Prisma.TransactionClient,
    dto: CreateTransactionDto,
    idempotencyKey: string,
  ): Promise<TransactionSnapshot> {
    const plan = await this.planFor(tx, dto);
    return this.executePlan(tx, plan, dto, idempotencyKey);
  }

  private async planFor(tx: Prisma.TransactionClient, dto: CreateTransactionDto): Promise<PostingPlan> {
    switch (dto.kind) {
      case 'TRANSFER':
        return this.planTransfer(dto);
      case 'DEPOSIT':
        return this.planDeposit(tx, dto);
      case 'WITHDRAWAL':
        return this.planWithdrawal(tx, dto);
      case 'FEE':
        return this.planFee(tx, dto);
      case 'REVERSAL':
        return this.planReversal(tx, dto);
      default:
        // Unreachable: post() rejects unimplemented kinds before this point.
        throw new UnprocessableEntityException({
          code: 'Transactions.KindNotImplemented',
          message: `Transaction kind ${dto.kind} is not yet implemented.`,
        });
    }
  }

  private planTransfer(dto: CreateTransactionDto): PostingPlan {
    if (!dto.sourceWalletId || !dto.targetWalletId) {
      throw new BadRequestException({
        code: 'Validation.Failed',
        message: 'TRANSFER requires both sourceWalletId and targetWalletId.',
      });
    }
    if (dto.sourceWalletId === dto.targetWalletId) {
      throw new UnprocessableEntityException({
        code: 'Transactions.SameWallet',
        message: 'Source and target wallets must differ.',
      });
    }
    const amount = BigInt(dto.amountMinor);
    return {
      kind: 'TRANSFER',
      currency: dto.currency,
      amountMinor: amount,
      ownerWalletId: dto.sourceWalletId,
      legs: [
        { walletId: dto.sourceWalletId, leg: 'DEBIT', amount, balanceChecked: true },
        { walletId: dto.targetWalletId, leg: 'CREDIT', amount, balanceChecked: false },
      ],
    };
  }

  private async planDeposit(tx: Prisma.TransactionClient, dto: CreateTransactionDto): Promise<PostingPlan> {
    if (!dto.targetWalletId) {
      throw new BadRequestException({
        code: 'Validation.Failed',
        message: 'DEPOSIT requires targetWalletId.',
      });
    }
    const amount = BigInt(dto.amountMinor);
    const systemWalletId = await this.lookupSystemWallet(tx, dto.currency, 'CLEARING');
    return {
      kind: 'DEPOSIT',
      currency: dto.currency,
      amountMinor: amount,
      ownerWalletId: dto.targetWalletId,
      legs: [
        { walletId: systemWalletId, leg: 'DEBIT', amount, balanceChecked: false },
        { walletId: dto.targetWalletId, leg: 'CREDIT', amount, balanceChecked: false },
      ],
    };
  }

  private async planWithdrawal(tx: Prisma.TransactionClient, dto: CreateTransactionDto): Promise<PostingPlan> {
    if (!dto.sourceWalletId) {
      throw new BadRequestException({
        code: 'Validation.Failed',
        message: 'WITHDRAWAL requires sourceWalletId.',
      });
    }
    const amount = BigInt(dto.amountMinor);
    const systemWalletId = await this.lookupSystemWallet(tx, dto.currency, 'CLEARING');
    return {
      kind: 'WITHDRAWAL',
      currency: dto.currency,
      amountMinor: amount,
      ownerWalletId: dto.sourceWalletId,
      legs: [
        { walletId: dto.sourceWalletId, leg: 'DEBIT', amount, balanceChecked: true },
        { walletId: systemWalletId, leg: 'CREDIT', amount, balanceChecked: false },
      ],
    };
  }

  private async planFee(tx: Prisma.TransactionClient, dto: CreateTransactionDto): Promise<PostingPlan> {
    if (!dto.sourceWalletId) {
      throw new BadRequestException({
        code: 'Validation.Failed',
        message: 'FEE requires sourceWalletId.',
      });
    }
    const amount = BigInt(dto.amountMinor);
    const systemWalletId = await this.lookupSystemWallet(tx, dto.currency, 'REVENUE');
    return {
      kind: 'FEE',
      currency: dto.currency,
      amountMinor: amount,
      ownerWalletId: dto.sourceWalletId,
      legs: [
        { walletId: dto.sourceWalletId, leg: 'DEBIT', amount, balanceChecked: true },
        { walletId: systemWalletId, leg: 'CREDIT', amount, balanceChecked: false },
      ],
    };
  }

  private async planReversal(tx: Prisma.TransactionClient, dto: CreateTransactionDto): Promise<PostingPlan> {
    if (!dto.originalTransactionId) {
      throw new BadRequestException({
        code: 'Validation.Failed',
        message: 'REVERSAL requires originalTransactionId.',
      });
    }
    // Lock the original row first so two concurrent reversals of the same transaction serialize
    // (the `reversal_of` UNIQUE constraint is the hard backstop if they somehow race past this).
    await tx.$queryRaw`SELECT id FROM transactions WHERE id = ${dto.originalTransactionId}::uuid FOR UPDATE`;
    const original = await tx.transaction.findUnique({
      where: { id: dto.originalTransactionId },
      include: { entries: true },
    });
    if (!original) {
      throw new NotFoundException({
        code: 'Transactions.OriginalNotFound',
        message: 'Original transaction not found.',
      });
    }
    if (original.status === 'REVERSED') {
      throw new ConflictException({
        code: 'Transactions.AlreadyReversed',
        message: 'This transaction has already been reversed.',
      });
    }
    if (original.status !== 'POSTED' || original.entries.length === 0) {
      throw new UnprocessableEntityException({
        code: 'Transactions.NotReversible',
        message: 'Only a POSTED transaction with ledger entries can be reversed.',
      });
    }

    const currency = original.entries[0].currency;
    const totalDebit = original.entries
      .filter((entry) => entry.leg === 'DEBIT')
      .reduce((sum, entry) => sum + entry.amountMinor, 0n);
    // Confirm-by-value: the caller states the amount + currency they intend to reverse.
    if (BigInt(dto.amountMinor) !== totalDebit || dto.currency !== currency) {
      throw new UnprocessableEntityException({
        code: 'Transactions.ReversalMismatch',
        message: 'amountMinor/currency do not match the original transaction.',
      });
    }

    // Mirror every original leg: a DEBIT becomes a CREDIT (refund) and vice-versa (claw-back).
    const legs: PlannedLeg[] = original.entries.map((entry) => ({
      walletId: entry.walletId,
      leg: entry.leg === 'DEBIT' ? 'CREDIT' : 'DEBIT',
      amount: entry.amountMinor,
      balanceChecked: entry.leg === 'CREDIT', // mirror of an original CREDIT is a customer DEBIT
    }));

    return {
      kind: 'REVERSAL',
      currency,
      amountMinor: totalDebit,
      legs,
      ownerAccountId: original.accountId,
      reversalOf: original.id,
      markReversedTxId: original.id,
    };
  }

  private async lookupSystemWallet(
    tx: Prisma.TransactionClient,
    currency: string,
    purpose: 'CLEARING' | 'REVENUE',
  ): Promise<string> {
    const wallet = await tx.wallet.findFirst({
      where: { isSystem: true, currency, systemPurpose: purpose },
      select: { id: true },
    });
    if (!wallet) {
      // Fail closed: no partial ledger when the external leg has nowhere to post.
      throw new UnprocessableEntityException({
        code: 'Transactions.SystemWalletMissing',
        message: `No ${purpose} system wallet is provisioned for ${currency}.`,
      });
    }
    return wallet.id;
  }

  private async executePlan(
    tx: Prisma.TransactionClient,
    plan: PostingPlan,
    dto: CreateTransactionDto,
    idempotencyKey: string,
  ): Promise<TransactionSnapshot> {
    // The money-critical path as six ordered steps; each step is one responsibility.
    const byId = await this.lockAndLoadWallets(tx, plan);
    this.assertSufficientBalance(plan, byId);

    const ownerAccountId = plan.ownerAccountId ?? byId.get(plan.ownerWalletId!)!.accountId;
    const transactionId = uuidv7();
    const now = new Date();
    const publicRef = await this.nextPublicRef(tx);

    await this.createTransactionRow(tx, plan, dto, idempotencyKey, { transactionId, ownerAccountId, publicRef, now });
    await this.writeBalancedLedger(tx, plan, transactionId, byId);
    await this.applyBalanceDeltas(tx, plan);

    if (plan.markReversedTxId) {
      await tx.transaction.update({
        where: { id: plan.markReversedTxId },
        data: { status: 'REVERSED' },
      });
    }

    return {
      id: transactionId,
      publicRef,
      status: 'POSTED',
      amountMinor: minorToWireString(plan.amountMinor, 'amountMinor'),
      currency: plan.currency,
      postedAt: now.toISOString(),
    };
  }

  /**
   * Lock every involved wallet row in a deterministic (id-sorted) order to avoid deadlocks, load
   * them with balances, and validate existence + single-currency. Returns the wallets keyed by id.
   */
  private async lockAndLoadWallets(
    tx: Prisma.TransactionClient,
    plan: PostingPlan,
  ): Promise<Map<string, WalletWithBalance>> {
    const walletIds = [...new Set(plan.legs.map((leg) => leg.walletId))].sort();
    for (const id of walletIds) {
      await tx.$queryRaw`SELECT id FROM wallets WHERE id = ${id}::uuid FOR UPDATE`;
    }

    const wallets = await tx.wallet.findMany({
      where: { id: { in: walletIds } },
      include: { balance: true },
    });
    const byId = new Map(wallets.map((wallet) => [wallet.id, wallet]));
    for (const id of walletIds) {
      if (!byId.has(id)) {
        throw new NotFoundException({ code: 'Wallet.NotFound', message: 'Wallet not found.' });
      }
    }
    for (const wallet of wallets) {
      if (wallet.currency !== plan.currency) {
        throw new UnprocessableEntityException({
          code: 'Transactions.CrossCurrency',
          message: 'All legs must share the transaction currency.',
        });
      }
    }
    return byId;
  }

  /** Sufficient-balance check — applies to customer (non-system) balance-checked debits only. */
  private assertSufficientBalance(plan: PostingPlan, byId: Map<string, WalletWithBalance>): void {
    for (const leg of plan.legs) {
      if (leg.leg !== 'DEBIT' || !leg.balanceChecked) continue;
      const wallet = byId.get(leg.walletId)!;
      if (wallet.isSystem) continue;
      const available = wallet.balance?.availableBalanceMinor ?? 0n;
      if (available < leg.amount) {
        throw new UnprocessableEntityException({
          code: 'Transactions.InsufficientBalance',
          message: 'Insufficient available balance.',
        });
      }
    }
  }

  /**
   * Insert the transaction row and classify a UNIQUE race by which constraint it tripped:
   * `reversal_of` → 409 Transactions.AlreadyReversed (reverse-once) and `idempotency_key` →
   * 409 Idempotency.KeyConflict (the F1 replay backstop). Any other P2002 propagates unchanged.
   */
  private async createTransactionRow(
    tx: Prisma.TransactionClient,
    plan: PostingPlan,
    dto: CreateTransactionDto,
    idempotencyKey: string,
    ids: { transactionId: string; ownerAccountId: string; publicRef: string; now: Date },
  ): Promise<void> {
    try {
      await tx.transaction.create({
        data: {
          id: ids.transactionId,
          publicRef: ids.publicRef,
          idempotencyKey,
          kind: plan.kind,
          status: 'POSTED',
          accountId: ids.ownerAccountId,
          categoryId: dto.categoryId ?? null,
          description: dto.description ?? null,
          occurredAt: ids.now,
          postedAt: ids.now,
          reversalOf: plan.reversalOf ?? null,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        // The transactions row is UNIQUE on BOTH `reversal_of` (reverse-once) and `idempotency_key`
        // (replay backstop). They carry opposite domain meaning, so classify by target rather than
        // collapsing every P2002 to AlreadyReversed.
        const target = p2002TargetText(error);
        if (target.includes('reversal')) {
          // `reversal_of` UNIQUE: the original was already reversed by a racing request.
          throw new ConflictException({
            code: 'Transactions.AlreadyReversed',
            message: 'This transaction has already been reversed.',
          });
        }
        if (target.includes('idempotency')) {
          // `idempotency_key` UNIQUE: a concurrent request with this key already posted a transaction
          // (the F1 replay backstop — CWE-362 / CWE-841). An idempotency conflict, NOT a reversal.
          throw new ConflictException({
            code: 'Idempotency.KeyConflict',
            message: 'A transaction for this Idempotency-Key already exists.',
          });
        }
        if (!target && plan.reversalOf) {
          // Target unknown (a driver that omits meta.target). On a REVERSAL the only UNIQUE this
          // insert can trip is `reversal_of`, so preserve the historical reverse-once mapping.
          throw new ConflictException({
            code: 'Transactions.AlreadyReversed',
            message: 'This transaction has already been reversed.',
          });
        }
      }
      // Any other P2002 (e.g. an unexpected public_ref collision) or non-P2002 error propagates
      // unchanged — previously every P2002 was mislabeled AlreadyReversed.
      throw error;
    }
  }

  /** Write the ledger entries and assert the plan balances: SUM(DEBIT) === SUM(CREDIT). */
  private async writeBalancedLedger(
    tx: Prisma.TransactionClient,
    plan: PostingPlan,
    transactionId: string,
    byId: Map<string, WalletWithBalance>,
  ): Promise<void> {
    const entries: Prisma.LedgerEntryCreateManyInput[] = [];
    for (const leg of plan.legs) {
      entries.push({
        id: uuidv7(),
        transactionId,
        walletId: leg.walletId,
        accountId: byId.get(leg.walletId)!.accountId,
        leg: leg.leg,
        amountMinor: leg.amount,
        currency: plan.currency,
        entrySeq: await this.nextEntrySeq(tx, leg.walletId),
      });
    }
    await tx.ledgerEntry.createMany({ data: entries });

    const debit = entries.filter((entry) => entry.leg === 'DEBIT').reduce((sum, entry) => sum + (entry.amountMinor as bigint), 0n);
    const credit = entries.filter((entry) => entry.leg === 'CREDIT').reduce((sum, entry) => sum + (entry.amountMinor as bigint), 0n);
    if (debit !== credit) {
      // Bug guard: a plan must always balance. Roll the whole posting back.
      throw new Error('Ledger invariant violated: SUM(DEBIT) != SUM(CREDIT).');
    }
  }

  /** Apply the per-leg balance deltas: a DEBIT decrements, a CREDIT increments. */
  private async applyBalanceDeltas(tx: Prisma.TransactionClient, plan: PostingPlan): Promise<void> {
    for (const leg of plan.legs) {
      const data =
        leg.leg === 'DEBIT'
          ? { balanceMinor: { decrement: leg.amount }, availableBalanceMinor: { decrement: leg.amount } }
          : { balanceMinor: { increment: leg.amount }, availableBalanceMinor: { increment: leg.amount } };
      await tx.walletBalance.update({ where: { walletId: leg.walletId }, data });
    }
  }

  private async nextEntrySeq(tx: Prisma.TransactionClient, walletId: string): Promise<bigint> {
    const rows = await tx.$queryRaw<Array<{ seq: bigint | string }>>`
      SELECT COALESCE(MAX(entry_seq), 0) + 1 AS seq FROM ledger_entries WHERE wallet_id = ${walletId}::uuid`;
    return BigInt(rows[0].seq);
  }

  private async nextPublicRef(tx: Prisma.TransactionClient): Promise<string> {
    const rows = await tx.$queryRaw<Array<{ v: bigint | string }>>`
      SELECT nextval('transaction_public_ref_seq') AS v`;
    return `TX-${new Date().getUTCFullYear()}-${String(rows[0].v).padStart(6, '0')}`;
  }
}
