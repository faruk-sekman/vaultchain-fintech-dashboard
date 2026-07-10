/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Response DTOs for the customer transaction list (api-endpoint-specifications
 * §GET /customers/{id}/transactions). `amountMinor` is the customer's SIGNED net
 * for the transaction (CREDIT positive, DEBIT negative) so the client can derive direction/sign.
 *
 * Money wire-format (audit O-10): `amountMinor` crosses the wire as a JSON STRING of
 * the exact (signed) integer minor-units (e.g. "100000", "-40000"), NOT a JSON number. Lossless for
 * any magnitude; the FE mirrors this contract exactly.
 */
import { ApiProperty } from '@nestjs/swagger';
import { TransactionKind, TransactionStatus } from '@prisma/client';

export class TransactionListItemDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ nullable: true, example: 'TX-2026-000123' }) publicRef!: string | null;
  @ApiProperty({ enum: TransactionKind }) kind!: TransactionKind;
  @ApiProperty({ enum: TransactionStatus }) status!: TransactionStatus;
  @ApiProperty({ type: String, description: 'Signed net for the customer (minor units), as a decimal string: CREDIT > 0, DEBIT < 0.' }) amountMinor!: string;
  @ApiProperty({ description: 'ISO-4217 currency code.' }) currency!: string;
  @ApiProperty({ nullable: true }) description!: string | null;
  @ApiProperty({ format: 'date-time' }) occurredAt!: string;
  @ApiProperty({ format: 'date-time', nullable: true }) postedAt!: string | null;
}

export class TransactionPageDto {
  @ApiProperty() number!: number;
  @ApiProperty() size!: number;
  @ApiProperty() totalItems!: number;
  @ApiProperty() totalPages!: number;
}

export class PaginatedTransactionListDto {
  @ApiProperty({ type: [TransactionListItemDto] }) data!: TransactionListItemDto[];
  @ApiProperty({ type: TransactionPageDto }) page!: TransactionPageDto;
}
