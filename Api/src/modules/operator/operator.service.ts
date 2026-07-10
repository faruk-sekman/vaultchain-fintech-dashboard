/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * O-7 (audit fix): operator profile + notification preferences are FIRST-CLASS mutable application
 * state and live in their own `operator_settings` table (1:1 with User) — NOT in the append-only
 * tamper-evident audit log. Writes upsert the settings row AND still emit an audit entry (so the
 * governance trail records THAT a change happened), but reads come from the settings row (falling back
 * to sensible defaults when absent), never from `audit_logs`.
 *
 * The operator notification FEED moved out of this service. It used to read the last 12
 * audit rows (`listNotifications`) as an audit-log shadow with a derived DENIED/FAIL "unread" count;
 * that leaky abstraction is RETIRED. The real, per-recipient notification domain (true read-state,
 * categories, retention, recipient-scoped SSE) now lives in `notification/` and owns
 * GET /operator/notifications. This service keeps only profile + notification PREFERENCES.
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import type { AuthPrincipal } from '../../common/auth/auth-principal';
import { AuditService } from '../../common/audit/audit.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import {
  NotificationPreferencesDto,
  OperatorProfileDto,
  UpdateNotificationPreferencesDto,
  UpdateOperatorProfileDto,
} from './dto/operator.dto';

const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferencesDto = {
  productUpdates: true,
  securityAlerts: true,
  weeklyDigest: false,
};

@Injectable()
export class OperatorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async getProfile(actor: AuthPrincipal): Promise<OperatorProfileDto> {
    const user = await this.prisma.user.findUnique({
      where: { id: actor.sub },
      select: { displayName: true, email: true, phone: true },
    });
    if (!user) throw new NotFoundException({ code: 'Operator.NotFound', message: 'Operator not found.' });
    const settings = await this.prisma.operatorSettings.findUnique({
      where: { userId: actor.sub },
      select: { jobTitle: true },
    });
    return {
      displayName: user.displayName,
      email: user.email,
      phone: user.phone,
      jobTitle: normalizeJobTitle(settings?.jobTitle),
    };
  }

  async updateProfile(actor: AuthPrincipal, dto: UpdateOperatorProfileDto): Promise<OperatorProfileDto> {
    const displayName = trimOptional(dto.displayName);
    const phone = trimOptional(dto.phone);
    const jobTitle = trimOptional(dto.jobTitle);
    // jobTitle is only persisted when the caller sent the field; a cleared ('' / whitespace) value nulls it.
    const nextJobTitle = jobTitle === undefined ? undefined : jobTitle || null;

    const updated = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.update({
        where: { id: actor.sub },
        data: {
          ...(displayName !== undefined ? { displayName: displayName || null } : {}),
          ...(phone !== undefined ? { phone: phone || null } : {}),
        },
        select: { displayName: true, email: true, phone: true },
      });
      if (nextJobTitle !== undefined) {
        await tx.operatorSettings.upsert({
          where: { userId: actor.sub },
          create: { userId: actor.sub, jobTitle: nextJobTitle },
          update: { jobTitle: nextJobTitle },
        });
      }
      const settings =
        nextJobTitle === undefined
          ? await tx.operatorSettings.findUnique({ where: { userId: actor.sub }, select: { jobTitle: true } })
          : { jobTitle: nextJobTitle };
      await this.audit.record(
        {
          actorUserId: actor.sub,
          action: 'operator.profile.update',
          resourceType: 'user',
          resourceId: actor.sub,
          outcome: 'SUCCESS',
          context: { jobTitle: settings?.jobTitle ?? null },
        },
        tx,
      );
      return { user, jobTitle: settings?.jobTitle ?? null };
    });

    return {
      displayName: updated.user.displayName,
      email: updated.user.email,
      phone: updated.user.phone,
      jobTitle: normalizeJobTitle(updated.jobTitle),
    };
  }

  async getNotificationPreferences(actor: AuthPrincipal): Promise<NotificationPreferencesDto> {
    const settings = await this.prisma.operatorSettings.findUnique({
      where: { userId: actor.sub },
      select: { productUpdates: true, securityAlerts: true, weeklyDigest: true },
    });
    if (!settings) return { ...DEFAULT_NOTIFICATION_PREFERENCES };
    return {
      productUpdates: settings.productUpdates,
      securityAlerts: settings.securityAlerts,
      weeklyDigest: settings.weeklyDigest,
    };
  }

  async updateNotificationPreferences(
    actor: AuthPrincipal,
    dto: UpdateNotificationPreferencesDto,
  ): Promise<NotificationPreferencesDto> {
    const patch = definedBooleanFields(dto);

    const next = await this.prisma.$transaction(async (tx) => {
      const current = await tx.operatorSettings.findUnique({
        where: { userId: actor.sub },
        select: { productUpdates: true, securityAlerts: true, weeklyDigest: true },
      });
      const merged: NotificationPreferencesDto = {
        productUpdates: current?.productUpdates ?? DEFAULT_NOTIFICATION_PREFERENCES.productUpdates,
        securityAlerts: current?.securityAlerts ?? DEFAULT_NOTIFICATION_PREFERENCES.securityAlerts,
        weeklyDigest: current?.weeklyDigest ?? DEFAULT_NOTIFICATION_PREFERENCES.weeklyDigest,
        ...patch,
      };
      await tx.operatorSettings.upsert({
        where: { userId: actor.sub },
        create: { userId: actor.sub, ...merged },
        update: merged,
      });
      await this.audit.record(
        {
          actorUserId: actor.sub,
          action: 'operator.notification_preferences.update',
          resourceType: 'user',
          resourceId: actor.sub,
          outcome: 'SUCCESS',
          context: { ...merged },
        },
        tx,
      );
      return merged;
    });

    return next;
  }
}

function trimOptional(value: string | undefined): string | undefined {
  return value === undefined ? undefined : value.trim();
}

/** Treat an empty/whitespace stored title as absent so the contract returns null, not ''. */
function normalizeJobTitle(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function definedBooleanFields(dto: UpdateNotificationPreferencesDto): Partial<NotificationPreferencesDto> {
  const prefs: Partial<NotificationPreferencesDto> = {};
  if (typeof dto.productUpdates === 'boolean') prefs.productUpdates = dto.productUpdates;
  if (typeof dto.securityAlerts === 'boolean') prefs.securityAlerts = dto.securityAlerts;
  if (typeof dto.weeklyDigest === 'boolean') prefs.weeklyDigest = dto.weeklyDigest;
  return prefs;
}
