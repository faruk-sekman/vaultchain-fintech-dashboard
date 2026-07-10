/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Customer wallet read + limit-write service (read; limit write).
 * Returns the customer's single default wallet (1:1) — the first non-system wallet under
 * the customer's account — with its balance. `updateLimits` sets the daily/monthly limits with an
 * optimistic-concurrency guard (rowVersion → 409) and appends an audit entry. 404 when the
 * customer (soft-delete aware) or wallet is absent. No migration (tables exist).
 */
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { AuthPrincipal } from '../../common/auth/auth-principal';
import { AuditService } from '../../common/audit/audit.service';
import { majorToMinor, minorToWireString } from '../../common/util/money';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { WalletDetailDto } from './dto/wallet.dto';
import { UpdateWalletLimitsDto } from './dto/update-wallet-limits.dto';

@Injectable()
export class WalletsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async getForCustomer(customerId: string): Promise<WalletDetailDto> {
    const customer = await this.prisma.customer.findFirst({
      where: { id: customerId, deletedAt: null },
      select: { id: true },
    });
    if (!customer) {
      throw new NotFoundException({ code: 'Customers.NotFound', message: 'Customer not found.' });
    }

    const wallet = await this.prisma.wallet.findFirst({
      where: { isSystem: false, account: { customerId } },
      include: { balance: true },
      orderBy: { createdAt: 'asc' },
    });
    if (!wallet) {
      throw new NotFoundException({ code: 'Wallets.NotFound', message: 'No wallet for this customer.' });
    }

    // Money fields serialize as decimal STRINGS of the exact integer minor-units.
    return {
      id: wallet.id,
      currency: wallet.currency,
      balanceMinor: minorToWireString(wallet.balance?.balanceMinor ?? 0n, 'balanceMinor'),
      availableBalanceMinor: minorToWireString(
        wallet.balance?.availableBalanceMinor ?? 0n,
        'availableBalanceMinor',
      ),
      dailyLimitMinor: minorToWireString(wallet.dailyLimitMinor, 'dailyLimitMinor'),
      monthlyLimitMinor: minorToWireString(wallet.monthlyLimitMinor, 'monthlyLimitMinor'),
      status: wallet.status,
      rowVersion: Number(wallet.rowVersion),
    };
  }

  /**
   * Updates the customer's default-wallet limits. Input is MAJOR units (converted to minor);
   * requires `dailyLimit < monthlyLimit` (else 400). Optimistic-concurrency guarded on the
   * wallet's rowVersion (mismatch → 409). Returns the refreshed wallet detail.
   */
  async updateLimits(customerId: string, dto: UpdateWalletLimitsDto, actor: AuthPrincipal): Promise<WalletDetailDto> {
    if (dto.dailyLimit >= dto.monthlyLimit) {
      throw new BadRequestException({ code: 'Wallets.InvalidLimits', message: 'dailyLimit must be less than monthlyLimit.' });
    }

    await this.prisma.$transaction(async (tx) => {
      const customer = await tx.customer.findFirst({ where: { id: customerId, deletedAt: null }, select: { id: true } });
      if (!customer) {
        throw new NotFoundException({ code: 'Customers.NotFound', message: 'Customer not found.' });
      }
      const wallet = await tx.wallet.findFirst({
        where: { isSystem: false, account: { customerId } },
        orderBy: { createdAt: 'asc' },
        select: { id: true, currency: true },
      });
      if (!wallet) {
        throw new NotFoundException({ code: 'Wallets.NotFound', message: 'No wallet for this customer.' });
      }

      // Convert MAJOR→minor with the wallet currency's real scale (default 2) rather than a hardcoded
      // ×100, so a non-scale-2 currency is not stored 10^(2-scale)× wrong (re-audit BE-001).
      const currency = await tx.currency.findUnique({ where: { code: wallet.currency }, select: { scale: true } });
      const scale = currency?.scale ?? 2;
      const dailyLimitMinor = majorToMinor(dto.dailyLimit, scale, 'dailyLimit');
      const monthlyLimitMinor = majorToMinor(dto.monthlyLimit, scale, 'monthlyLimit');

      const result = await tx.wallet.updateMany({
        where: { id: wallet.id, rowVersion: BigInt(dto.rowVersion) },
        data: { dailyLimitMinor, monthlyLimitMinor, rowVersion: { increment: 1 } },
      });
      if (result.count === 0) {
        throw new ConflictException({ code: 'Wallets.Conflict', message: 'The wallet was modified by someone else. Reload and try again.' });
      }
      await this.audit.record(
        {
          actorUserId: actor.sub,
          action: 'wallet.update_limits',
          resourceType: 'wallet',
          resourceId: wallet.id,
          outcome: 'SUCCESS',
          context: { dailyLimitMinor: Number(dailyLimitMinor), monthlyLimitMinor: Number(monthlyLimitMinor) },
        },
        tx,
      );
    });

    return this.getForCustomer(customerId);
  }
}
