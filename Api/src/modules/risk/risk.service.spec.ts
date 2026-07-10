/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { RiskService } from './risk.service';

describe('RiskService', () => {
  function setup() {
    const prisma = {
      customer: { findFirst: jest.fn() },
      riskAssessment: { findMany: jest.fn(), count: jest.fn() },
      $transaction: jest.fn((ops: Array<Promise<unknown>>) => Promise.all(ops)),
    };
    const service = new RiskService(
      prisma as never,
      {} as never,
      { isSimulated: true, name: 'rule-based-risk-engine', screen: jest.fn() } as never,
    );
    return { service, prisma };
  }

  it('rejects risk history for missing or soft-deleted customers', async () => {
    const { service, prisma } = setup();
    prisma.customer.findFirst.mockResolvedValueOnce(null);

    await expect(service.listAssessments('customer-1', {})).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.riskAssessment.findMany).not.toHaveBeenCalled();
  });

  it('returns risk history only after confirming the customer is active', async () => {
    const { service, prisma } = setup();
    prisma.customer.findFirst.mockResolvedValueOnce({ id: 'customer-1' });
    prisma.riskAssessment.findMany.mockResolvedValueOnce([
      {
        id: 'risk-1',
        customerId: 'customer-1',
        address: '0x0000000000000000000000000000000000000000',
        decision: 'ALLOW',
        isSimulated: true,
        providerName: 'rule-based-risk-engine',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        signals: [{ key: 'sanctionsHit', hit: false, severity: 'high' }],
      },
    ]);
    prisma.riskAssessment.count.mockResolvedValueOnce(1);

    await expect(service.listAssessments('customer-1', {})).resolves.toEqual({
      data: [
        expect.objectContaining({
          id: 'risk-1',
          customerId: 'customer-1',
          signals: [{ key: 'sanctionsHit', hit: false, severity: 'high' }],
        }),
      ],
      page: { number: 1, size: 25, totalItems: 1, totalPages: 1 },
    });
    expect(prisma.customer.findFirst).toHaveBeenCalledWith({
      where: { id: 'customer-1', deletedAt: null },
      select: { id: true },
    });
  });

  // --- recordDecision + screenAddress (audit 9C: previously-uncovered write/screen branches) ---
  function setupWrite() {
    const tx = {
      riskAssessment: { create: jest.fn() },
      riskSignal: { createMany: jest.fn() },
    };
    const prisma = {
      customer: { findFirst: jest.fn().mockResolvedValue({ id: 'c1' }) },
      $transaction: jest.fn((cb: (t: unknown) => unknown) => cb(tx)),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const provider = { isSimulated: true, name: 'rule-based-risk-engine', screen: jest.fn() };
    const service = new RiskService(prisma as never, audit as never, provider as never);
    return { service, prisma, audit, provider, tx };
  }

  const actor = { sub: 'op-1' } as never;
  const decision = { address: '0xABC', decision: 'ALLOW', isSimulated: true } as never;

  it('recordDecision rejects a mislabeled simulation (isSimulated=false)', async () => {
    const { service } = setupWrite();
    await expect(
      service.recordDecision('c1', { address: '0xABC', decision: 'ALLOW', isSimulated: false } as never, actor),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('recordDecision throws NotFound for an inactive customer', async () => {
    const { service, prisma } = setupWrite();
    prisma.customer.findFirst.mockResolvedValue(null);
    await expect(service.recordDecision('c1', decision, actor)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('recordDecision persists a decision with signals + audits SUCCESS', async () => {
    const { service, tx, audit } = setupWrite();
    tx.riskAssessment.create.mockResolvedValue({
      id: 'a1', customerId: 'c1', address: '0xabc', decision: 'ALLOW', isSimulated: true,
      providerName: 'rule-based-risk-engine', createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const dto = { address: '0xABC', decision: 'ALLOW', isSimulated: true, signals: [{ key: 's', hit: false, severity: 'low' }] } as never;

    const result = await service.recordDecision('c1', dto, actor);

    expect(tx.riskSignal.createMany).toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'SUCCESS' }), tx);
    expect(result).toMatchObject({ id: 'a1', address: '0xabc', signals: [{ key: 's', hit: false, severity: 'low' }] });
    expect(result.createdAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('recordDecision persists without signals (no createMany)', async () => {
    const { service, tx } = setupWrite();
    tx.riskAssessment.create.mockResolvedValue({
      id: 'a2', customerId: 'c1', address: '0xabc', decision: 'ALLOW', isSimulated: true,
      providerName: 'rule-based-risk-engine', createdAt: new Date('2026-01-02T00:00:00.000Z'),
    });
    const result = await service.recordDecision('c1', decision, actor);
    expect(tx.riskSignal.createMany).not.toHaveBeenCalled();
    expect(result.signals).toEqual([]);
  });

  it('screenAddress normalizes the address and maps the provider result', async () => {
    const { service, provider } = setupWrite();
    provider.screen.mockResolvedValue({ decision: 'REVIEW', isSimulated: true, signals: [{ key: 'mixer', hit: true, severity: 'high' }] });
    const result = await service.screenAddress('c1', '0xDEAD');
    expect(provider.screen).toHaveBeenCalledWith({ address: '0xdead' });
    expect(result).toEqual({
      address: '0xdead', decision: 'REVIEW', isSimulated: true, providerName: 'rule-based-risk-engine',
      signals: [{ key: 'mixer', hit: true, severity: 'high' }],
    });
  });

  it('screenAddress throws NotFound for an inactive customer', async () => {
    const { service, prisma } = setupWrite();
    prisma.customer.findFirst.mockResolvedValue(null);
    await expect(service.screenAddress('c1', '0xabc')).rejects.toBeInstanceOf(NotFoundException);
  });
});
