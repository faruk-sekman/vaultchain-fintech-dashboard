/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Web3/AML risk persistence. Persists a screening decision + signals
 * behind the pluggable provider port, with a structural honesty guard (`isSimulated`) and an audit
 * row per decision. Read-only / non-custodial: no on-chain writes, no keys.
 */
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { RiskAssessment, RiskSignal } from '@prisma/client';
import type { AuthPrincipal } from '../../common/auth/auth-principal';
import { AuditService } from '../../common/audit/audit.service';
import { uuidv7 } from '../../common/util/uuid';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import {
  CreateRiskDecisionDto,
  RiskAssessmentResponseDto,
  RiskScreeningResponseDto,
} from './dto/risk.dto';
import { parseRiskAssessmentListQuery } from './risk-assessments.query';
import { SCREENING_PROVIDER, type ScreeningProvider } from './screening/screening-provider';

@Injectable()
export class RiskService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(SCREENING_PROVIDER) private readonly provider: ScreeningProvider,
  ) {}

  async recordDecision(customerId: string, dto: CreateRiskDecisionDto, actor: AuthPrincipal): Promise<RiskAssessmentResponseDto> {
    // Honesty guard: the rule-based engine must not persist a decision claiming to be real.
    if (this.provider.isSimulated && !dto.isSimulated) {
      throw new BadRequestException({
        code: 'Risk.MislabeledSimulation',
        message: 'isSimulated must be true while the rule-based screening engine is active.',
      });
    }
    await this.assertActiveCustomer(customerId);

    const assessmentId = uuidv7();
    const address = dto.address.toLowerCase();
    const signals = dto.signals ?? [];

    const assessment = await this.prisma.$transaction(async (tx) => {
      const created = await tx.riskAssessment.create({
        data: {
          id: assessmentId,
          customerId,
          address,
          decision: dto.decision,
          isSimulated: dto.isSimulated,
          providerName: this.provider.name,
          createdBy: actor.sub,
        },
      });
      if (signals.length > 0) {
        await tx.riskSignal.createMany({
          data: signals.map((s) => ({ id: uuidv7(), riskAssessmentId: assessmentId, key: s.key, hit: s.hit, severity: s.severity })),
        });
      }
      await this.audit.record(
        {
          actorUserId: actor.sub,
          action: 'risk.record_decision',
          resourceType: 'customer',
          resourceId: customerId,
          outcome: 'SUCCESS',
          context: { decision: dto.decision, providerName: this.provider.name, isSimulated: dto.isSimulated },
        },
        tx,
      );
      return created;
    });

    return this.toResponse(assessment, signals);
  }

  async screenAddress(customerId: string, address: string): Promise<RiskScreeningResponseDto> {
    await this.assertActiveCustomer(customerId);
    const normalized = address.toLowerCase();
    const result = await this.provider.screen({ address: normalized });
    return {
      address: normalized,
      decision: result.decision,
      isSimulated: result.isSimulated,
      providerName: this.provider.name,
      signals: result.signals.map((s) => ({ key: s.key, hit: s.hit, severity: s.severity })),
    };
  }

  async listAssessments(
    customerId: string,
    rawQuery: Record<string, unknown>,
  ): Promise<{ data: RiskAssessmentResponseDto[]; page: { number: number; size: number; totalItems: number; totalPages: number } }> {
    const q = parseRiskAssessmentListQuery(rawQuery);
    await this.assertActiveCustomer(customerId);

    const where = { customerId };
    const [rows, totalItems] = await this.prisma.$transaction([
      this.prisma.riskAssessment.findMany({
        where,
        include: { signals: true },
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.size,
        take: q.size,
      }),
      this.prisma.riskAssessment.count({ where }),
    ]);

    return {
      data: rows.map((row) => this.toResponse(row, row.signals)),
      page: {
        number: q.page,
        size: q.size,
        totalItems,
        totalPages: Math.max(1, Math.ceil(totalItems / q.size)),
      },
    };
  }

  private async assertActiveCustomer(customerId: string): Promise<void> {
    const customer = await this.prisma.customer.findFirst({
      where: { id: customerId, deletedAt: null },
      select: { id: true },
    });
    if (!customer) throw new NotFoundException({ code: 'Risk.CustomerNotFound', message: 'Customer not found.' });
  }

  private toResponse(
    a: RiskAssessment,
    signals: Array<Pick<RiskSignal, 'key' | 'hit' | 'severity'>>,
  ): RiskAssessmentResponseDto {
    return {
      id: a.id,
      customerId: a.customerId,
      address: a.address,
      decision: a.decision,
      isSimulated: a.isSimulated,
      providerName: a.providerName,
      createdAt: a.createdAt.toISOString(),
      signals: signals.map((s) => ({ key: s.key, hit: s.hit, severity: s.severity })),
    };
  }
}
