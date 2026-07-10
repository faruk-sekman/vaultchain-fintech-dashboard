/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Customer transaction read service. Lists a customer's transactions over all
 * non-system wallets within the required date range, with the customer's SIGNED net per transaction
 * (CREDIT > 0, DEBIT < 0). Read-only; no migration. 404 only when the customer is absent — a
 * customer with no wallet returns an empty page.
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { minorToWireString } from '../../common/util/money';
import { TransactionListItemDto } from './dto/transaction-list.dto';
import { parseTxListQuery } from './customer-transactions.query';

@Injectable()
export class CustomerTransactionsService {
  constructor(private readonly prisma: PrismaService) {}

  async listForCustomer(
    customerId: string,
    rawQuery: Record<string, unknown>,
  ): Promise<{ data: TransactionListItemDto[]; page: { number: number; size: number; totalItems: number; totalPages: number } }> {
    const q = parseTxListQuery(rawQuery);

    const customer = await this.prisma.customer.findFirst({
      where: { id: customerId, deletedAt: null },
      select: { id: true },
    });
    if (!customer) {
      throw new NotFoundException({ code: 'Customers.NotFound', message: 'Customer not found.' });
    }

    const wallets = await this.prisma.wallet.findMany({
      where: { isSystem: false, account: { customerId } },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    const walletIds = wallets.map((wallet) => wallet.id);
    if (walletIds.length === 0) {
      return { data: [], page: { number: q.page, size: q.size, totalItems: 0, totalPages: 1 } };
    }

    const customerEntryWhere: Prisma.LedgerEntryWhereInput = {
      walletId: { in: walletIds },
      ...(q.currency ? { currency: q.currency } : {}),
    };

    const where: Prisma.TransactionWhereInput = {
      entries: { some: customerEntryWhere },
      occurredAt: { gte: q.occurredFrom, lte: q.occurredTo },
      ...(q.kind ? { kind: q.kind } : {}),
      ...(q.status ? { status: q.status } : {}),
    };

    const [rows, totalItems] = await this.prisma.$transaction([
      this.prisma.transaction.findMany({
        where,
        include: { entries: { where: customerEntryWhere, orderBy: { entrySeq: 'asc' } } },
        orderBy: q.orderBy,
        skip: (q.page - 1) * q.size,
        take: q.size,
      }),
      this.prisma.transaction.count({ where }),
    ]);

    const data = rows.map((tx): TransactionListItemDto => {
      // Signed net in BigInt minor-units across ALL the customer's own legs (CREDIT positive, DEBIT
      // negative), serialized as a wire STRING. Summing every customer-owned leg — not
      // just the first — nets an intra-customer transfer between two of their wallets correctly rather
      // than silently dropping the later legs (re-audit BE-004).
      const signed = tx.entries.reduce(
        (acc, e) => acc + (e.leg === 'CREDIT' ? e.amountMinor : -e.amountMinor),
        0n,
      );
      const amountMinor = minorToWireString(signed, 'amountMinor');
      return {
        id: tx.id,
        publicRef: tx.publicRef,
        kind: tx.kind,
        status: tx.status,
        amountMinor,
        currency: tx.entries[0]?.currency ?? '',
        description: tx.description,
        occurredAt: tx.occurredAt.toISOString(),
        postedAt: tx.postedAt ? tx.postedAt.toISOString() : null,
      };
    });

    return {
      data,
      page: {
        number: q.page,
        size: q.size,
        totalItems,
        totalPages: Math.max(1, Math.ceil(totalItems / q.size)),
      },
    };
  }
}
