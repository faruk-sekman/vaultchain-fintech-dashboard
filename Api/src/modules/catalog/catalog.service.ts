/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { CurrencyCatalogDto } from './dto/currency.dto';

@Injectable()
export class CatalogService {
  constructor(private readonly prisma: PrismaService) {}

  async listActiveCurrencies(): Promise<CurrencyCatalogDto> {
    const rows = await this.prisma.currency.findMany({
      where: { isActive: true },
      orderBy: { code: 'asc' },
    });
    return {
      items: rows.map((row) => ({
        code: row.code.trim(),
        name: row.name,
        scale: row.scale,
      })),
    };
  }
}
