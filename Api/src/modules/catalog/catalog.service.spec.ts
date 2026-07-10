/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Unit tests for CatalogService (audit 9C). Mocked Prisma — covers the active-currency query shape
 * and the row mapping (code trim), plus the empty-result path.
 */
import type { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { CatalogService } from './catalog.service';

function makeService(rows: Array<{ code: string; name: string; scale: number }>) {
  const findMany = jest.fn().mockResolvedValue(rows);
  const prisma = { currency: { findMany } };
  return { findMany, service: new CatalogService(prisma as unknown as PrismaService) };
}

describe('CatalogService', () => {
  it('lists active currencies ordered by code and trims the code', async () => {
    const { findMany, service } = makeService([
      { code: 'TRY ', name: 'Turkish Lira', scale: 2 },
      { code: 'USD', name: 'US Dollar', scale: 2 },
    ]);

    const result = await service.listActiveCurrencies();

    expect(findMany).toHaveBeenCalledWith({ where: { isActive: true }, orderBy: { code: 'asc' } });
    expect(result.items).toEqual([
      { code: 'TRY', name: 'Turkish Lira', scale: 2 },
      { code: 'USD', name: 'US Dollar', scale: 2 },
    ]);
  });

  it('returns an empty list when there are no active currencies', async () => {
    const { service } = makeService([]);
    await expect(service.listActiveCurrencies()).resolves.toEqual({ items: [] });
  });
});
