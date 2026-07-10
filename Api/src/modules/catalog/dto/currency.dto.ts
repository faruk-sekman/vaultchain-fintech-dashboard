/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */
import { ApiProperty } from '@nestjs/swagger';

export class CurrencyDto {
  @ApiProperty({ minLength: 3, maxLength: 3, example: 'TRY' })
  code!: string;

  @ApiProperty({ example: 'Turkish Lira' })
  name!: string;

  @ApiProperty({ example: 2 })
  scale!: number;
}

export class CurrencyCatalogDto {
  @ApiProperty({ type: [CurrencyDto] })
  items!: CurrencyDto[];
}
