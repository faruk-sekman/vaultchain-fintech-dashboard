/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Customer transaction list (api-endpoint-specifications §GET /customers/{id}/transactions).
 * Gated by `transactions.read`; a bounded date range is required.
 * Response wrapped by the global envelope (the `{ data, page }` keeps its shape, gains `meta`).
 */
import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/auth/jwt-auth.guard';
import { PermissionsGuard } from '../../common/auth/permissions.guard';
import { RequirePermissions } from '../../common/auth/require-permissions.decorator';
import { PaginatedTransactionListDto } from './dto/transaction-list.dto';
import { CustomerTransactionsService } from './customer-transactions.service';

@ApiTags('transactions')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('customers')
export class CustomerTransactionsController {
  constructor(private readonly transactions: CustomerTransactionsService) {}

  @Get(':id/transactions')
  @RequirePermissions('transactions.read')
  @ApiQuery({ name: 'page[number]', required: false, schema: { type: 'integer', minimum: 1, default: 1 } })
  @ApiQuery({ name: 'page[size]', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 } })
  @ApiQuery({ name: 'filter[occurredFrom]', required: true, description: 'ISO-8601 start (required).' })
  @ApiQuery({ name: 'filter[occurredTo]', required: true, description: 'ISO-8601 end (required, ≤ 366d span).' })
  @ApiQuery({ name: 'filter[kind]', required: false })
  @ApiQuery({ name: 'filter[status]', required: false })
  @ApiQuery({ name: 'filter[currency]', required: false })
  @ApiQuery({ name: 'sort', required: false, description: 'Whitelist: occurredAt, createdAt (default -occurredAt).' })
  @ApiOkResponse({ type: PaginatedTransactionListDto, description: "The customer's transactions over the date range." })
  list(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: Record<string, unknown>,
  ): Promise<PaginatedTransactionListDto> {
    return this.transactions.listForCustomer(id, query);
  }
}
