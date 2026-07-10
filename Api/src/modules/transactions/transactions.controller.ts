/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * POST /api/v1/transactions — create a money-moving transaction (idempotent, ledger-posted).
 * Requires the `Idempotency-Key` header on this financial write. Gated by
 * `transactions.create`: JwtAuthGuard + PermissionsGuard.
 */
import { BadRequestException, Body, Controller, Headers, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiHeader, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../common/auth/jwt-auth.guard';
import { PermissionsGuard } from '../../common/auth/permissions.guard';
import { RequirePermissions } from '../../common/auth/require-permissions.decorator';
import { isUuid } from '../../common/util/uuid';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import { TransactionSnapshot, TransactionsService } from './transactions.service';

/** Financial-write throttle: 30/min/IP — stricter than the default read class (audit M10). */
const WRITE_THROTTLE = { default: { limit: 30, ttl: 60_000 } } as const;

@ApiTags('transactions')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions('transactions.create')
@Controller('transactions')
export class TransactionsController {
  constructor(private readonly transactions: TransactionsService) {}

  @Post()
  @Throttle(WRITE_THROTTLE)
  @HttpCode(201)
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: 'UUID; replay-safe key.' })
  @ApiCreatedResponse({ description: 'Transaction posted (balanced double-entry ledger set).' })
  async create(
    @Body() dto: CreateTransactionDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<TransactionSnapshot> {
    const key = idempotencyKey?.trim();
    if (!key) {
      throw new BadRequestException({
        code: 'Idempotency.KeyRequired',
        message: 'The Idempotency-Key header is required for this endpoint.',
      });
    }
    if (!isUuid(key)) {
      throw new BadRequestException({
        code: 'Idempotency.KeyInvalid',
        message: 'The Idempotency-Key header must be a UUID.',
      });
    }
    return this.transactions.post(dto, key);
  }
}
