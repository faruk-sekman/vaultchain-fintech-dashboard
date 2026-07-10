/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Customer read + write service (read; writes). Reads the `customers`
 * table (soft-delete aware) and returns PII-masked list/detail shapes. Writes create/update/
 * soft-delete customers: the national ID is column-encrypted on create and never read
 * back; updates are optimistic-concurrency guarded (rowVersion → 409); a KYC-status change and
 * every mutation append to the tamper-evident audit chain (fail-closed, in the same transaction).
 */
import { ConflictException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { isKycTransitionAllowed } from './kyc-transitions';
import { Prisma, type Customer } from '@prisma/client';
import { randomInt } from 'node:crypto';
import type { AuthPrincipal } from '../../common/auth/auth-principal';
import { AuditService } from '../../common/audit/audit.service';
import { PII_ENCRYPTOR } from '../../common/crypto/crypto.module';
import type { EnvelopeEncryptor } from '../../common/crypto/envelope-encryptor';
import { packEnvelope } from '../../common/crypto/envelope-codec';
import { maskAddress, maskEmail, maskName, maskPhone, maskWalletNumber } from '../../common/util/mask';
import { uuidv7 } from '../../common/util/uuid';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { applyRlsContext } from '../../infrastructure/prisma/rls-context';

/**
 * Map a P2002 unique-violation on a customer backstop index to its domain 409, so the LOSING racer
 * returns the same clean error as the service-level fast-path check rather than a raw 500: the active-
 * email index (F12) → `Customers.DuplicateEmail`; the active-national-id blind-index (QA) →
 * `Customers.DuplicateNationalId`. Anything else — the fast-path ConflictException, NotFound, or the
 * optimistic-concurrency conflict — is rethrown unchanged.
 */
function toDuplicateCustomerError(err: unknown): never {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    const target = String(err.meta?.target ?? '');
    // Postgres/Prisma reports the INDEX NAME here (e.g. `customers_national_id_active_unique`), so match
    // on `national_id` — the only unique index carrying it — rather than the `national_id_hash` column name.
    if (target.includes('national_id')) {
      throw new ConflictException({ code: 'Customers.DuplicateNationalId', message: 'A customer with this national ID already exists.' });
    }
    if (target.includes('email')) {
      throw new ConflictException({ code: 'Customers.DuplicateEmail', message: 'A customer with this email already exists.' });
    }
  }
  throw err;
}
import { RealtimeService } from '../realtime/realtime.service';
import { NotificationService } from '../notification/notification.service';
import {
  CredentialPreviewDto,
  CustomerDetailDto,
  CustomerListItemDto,
  KycVerificationDto,
} from './dto/customer.dto';
import { CreateCustomerDto, UpdateCustomerDto } from './dto/customer-write.dto';
import { parseCustomerListQuery } from './customers.query';
import { parseKycListQuery } from './customer-kyc.query';

/** Default wallet limits for a newly created customer (minor units): ₺10,000 / ₺100,000. */
const DEFAULT_DAILY_LIMIT_MINOR = 1_000_000n;
const DEFAULT_MONTHLY_LIMIT_MINOR = 10_000_000n;
const DEFAULT_CURRENCY = 'TRY';

/** AAD binds the encrypted national-id blob to its customer row (a stolen blob can't be replanted). */
function nationalIdAad(customerId: string): Buffer {
  return Buffer.from(`customer:${customerId}`, 'utf8');
}

/** A 16-digit dev wallet number (display only; masked on read). Mirrors the seed's format. */
function generateWalletNumber(): string {
  const pad = (n: number, len: number): string => String(n).padStart(len, '0');
  return `${pad(randomInt(1e9), 9)}${pad(randomInt(1e7), 7)}`;
}

/** Response-scope permission that lifts PII masking on the customer read surface. */
const PII_REVEAL_PERMISSION = 'customers.pii.reveal';

/** Whether a principal may receive unmasked PII. Fail-closed: no principal / missing code → false. */
function canRevealPii(principal: AuthPrincipal | undefined): boolean {
  return principal?.permissions?.includes(PII_REVEAL_PERMISSION) ?? false;
}

/**
 * Maps a customer row to its list-item DTO. `reveal` is the EFFECTIVE decision the service has already
 * resolved against the principal's permission — this mapper is a pure function of (row, reveal) so it
 * is unit-testable without a DB. When `reveal` is false (the default) every contact field is masked;
 * when true they are returned raw. `nationalIdLast4` is last-4 in BOTH modes — the full national ID is
 * never served and `nationalIdEnc` is never fetched/decrypted (D2).
 */
function mapCustomerListItem(c: Omit<Customer, 'nationalIdEnc'>, reveal: boolean): CustomerListItemDto {
  return {
    id: c.id,
    fullName: reveal ? c.fullName : maskName(c.fullName),
    email: reveal ? c.email : maskEmail(c.email),
    phone: reveal ? c.phone : maskPhone(c.phone),
    walletNumber: reveal ? c.walletNumber : maskWalletNumber(c.walletNumber),
    nationalIdLast4: c.nationalIdLast4 ?? null,
    kycStatus: c.kycStatus,
    riskLevel: c.riskLevel,
    status: c.status,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

/**
 * Maps a customer row to its detail DTO. Address masking: `country` is kept RAW even when
 * masked (low-identifying, retained for ops UX); `city`/`postalCode` are dropped to `null` when masked
 * (a presence toggle, not a transformation — hence inline, no `mask.ts` helper); `line1` is reduced via
 * `maskAddress`. All four are returned raw only on an EFFECTIVE reveal.
 */
function mapCustomerDetail(c: Omit<Customer, 'nationalIdEnc'>, reveal: boolean): CustomerDetailDto {
  return {
    ...mapCustomerListItem(c, reveal),
    dateOfBirth: c.dateOfBirth ? c.dateOfBirth.toISOString().slice(0, 10) : null,
    address: {
      country: c.addressCountry ?? null,
      city: reveal ? c.addressCity ?? null : null,
      postalCode: reveal ? c.addressPostal ?? null : null,
      line1: reveal ? c.addressLine1 ?? null : maskAddress(c.addressLine1),
    },
    contractSigned: c.contractSigned,
    rowVersion: Number(c.rowVersion),
  };
}

@Injectable()
export class CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(PII_ENCRYPTOR) private readonly encryptor: EnvelopeEncryptor,
    private readonly realtime: RealtimeService,
    private readonly notifications: NotificationService,
  ) {}

  async list(
    rawQuery: Record<string, unknown>,
    principal?: AuthPrincipal,
  ): Promise<{ data: CustomerListItemDto[]; page: { number: number; size: number; totalItems: number; totalPages: number } }> {
    const q = parseCustomerListQuery(rawQuery);
    // EFFECTIVE reveal (server-authoritative): the caller must BOTH ask (`?reveal=true`) AND hold
    // `customers.pii.reveal`. Otherwise fail-closed to masked — no error, no leak (D1).
    const reveal = q.reveal && canRevealPii(principal);

    const where: Prisma.CustomerWhereInput = { deletedAt: null };
    if (q.kycStatus) where.kycStatus = q.kycStatus;
    if (q.status) where.status = q.status;
    // Unified active/passive taxonomy (TASK-FE-INT-013): when an exact status is NOT supplied,
    // `filter[active]` selects ACTIVE vs not-ACTIVE (INACTIVE+CLOSED) so the list "Pasif" count
    // matches the dashboard summary's `status <> 'ACTIVE'`. Exact `filter[status]` still wins.
    if (q.status === undefined && q.active !== undefined) {
      where.status = q.active ? 'ACTIVE' : { not: 'ACTIVE' };
    }
    if (q.q) {
      where.OR = [
        { fullName: { contains: q.q, mode: 'insensitive' } },
        { email: { contains: q.q, mode: 'insensitive' } },
        { walletNumber: { contains: q.q, mode: 'insensitive' } },
      ];
    }

    const [rows, totalItems] = await this.prisma.$transaction([
      this.prisma.customer.findMany({
        where,
        orderBy: q.orderBy,
        skip: (q.page - 1) * q.size,
        take: q.size,
        // Never fetch the encrypted national-id blob on reads — it is never read back (audit D1).
        omit: { nationalIdEnc: true },
      }),
      this.prisma.customer.count({ where }),
    ]);

    const data = rows.map((c) => mapCustomerListItem(c, reveal));

    if (reveal) {
      // Exactly ONE summary audit row per reveal request — never one-per-row: audit appends serialize
      // on a pg advisory lock, so a 25-row page would mean 25 serialized appends (D3).
      // An authorized empty/last page (count 0) is still a recorded access (bounded audit-noise).
      await this.audit.record({
        actorUserId: principal!.sub,
        action: 'customer.pii.reveal_list',
        resourceType: 'customer',
        resourceId: null,
        outcome: 'SUCCESS',
        context: { page: q.page, count: data.length },
      });
    }

    return {
      data,
      page: {
        number: q.page,
        size: q.size,
        totalItems,
        totalPages: Math.max(1, Math.ceil(totalItems / q.size)),
      },
    };
  }

  /**
   * Reads one customer. `opts.reveal` is the REQUESTED intent and `opts.principal` the caller; the
   * EFFECTIVE reveal is resolved here (server-authoritative). The default `{}` means masked + no
   * principal, so the write paths `create()`/`update()` — which call `getById(id)` with no opts —
   * inherit masked-by-default by construction and can never leak PII (F2).
   */
  async getById(
    id: string,
    opts: { reveal?: boolean; principal?: AuthPrincipal } = {},
  ): Promise<CustomerDetailDto> {
    const customer = await this.prisma.customer.findFirst({
      where: { id, deletedAt: null },
      omit: { nationalIdEnc: true }, // never fetch the encrypted national-id blob on reads (audit D1)
    });
    if (!customer) {
      throw new NotFoundException({ code: 'Customers.NotFound', message: 'Customer not found.' });
    }

    const reveal = opts.reveal === true && canRevealPii(opts.principal);
    if (reveal) {
      // Audit the unmasked access — SUCCESS path only (never on the 404 above, which would write a
      // misleading row for a non-existent id). Standalone append (no tx): this is a read (D3, F4).
      await this.audit.record({
        actorUserId: opts.principal!.sub,
        action: 'customer.pii.reveal',
        resourceType: 'customer',
        resourceId: id,
        outcome: 'SUCCESS',
      });
    }

    return mapCustomerDetail(customer, reveal);
  }

  async listKycVerifications(
    id: string,
    rawQuery: Record<string, unknown>,
  ): Promise<{ data: KycVerificationDto[]; page: { number: number; size: number; totalItems: number; totalPages: number } }> {
    const q = parseKycListQuery(rawQuery);
    await this.assertCustomerExists(id);

    const where = { customerId: id };
    const [rows, totalItems] = await this.prisma.$transaction([
      this.prisma.kycVerification.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (q.page - 1) * q.size,
        take: q.size,
      }),
      this.prisma.kycVerification.count({ where }),
    ]);

    return {
      data: rows.map((row) => ({
        id: row.id,
        customerId: row.customerId,
        status: row.status,
        method: row.method,
        reasonCode: row.reasonCode,
        decidedAt: row.decidedAt?.toISOString() ?? null,
        decidedBy: row.decidedBy,
        createdAt: row.createdAt.toISOString(),
      })),
      page: {
        number: q.page,
        size: q.size,
        totalItems,
        totalPages: Math.max(1, Math.ceil(totalItems / q.size)),
      },
    };
  }

  async getCredentialPreview(id: string): Promise<CredentialPreviewDto> {
    const customer = await this.prisma.customer.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, kycStatus: true },
    });
    if (!customer) {
      throw new NotFoundException({ code: 'Customers.NotFound', message: 'Customer not found.' });
    }
    return {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      type: ['VerifiableCredential', 'KycCredential'],
      issuer: 'did:example:fintech-ops-compliance',
      issuanceDate: new Date().toISOString(),
      credentialSubject: {
        id: `did:example:${customer.id}`,
        kycVerified: customer.kycStatus === 'VERIFIED',
      },
    };
  }

  /**
   * Creates a customer plus their 1:1 default wallet: customer + account + wallet +
   * zero balance in one transaction. The national ID is column-encrypted (never returned); a
   * duplicate (non-deleted) email → 409.
   */
  async create(dto: CreateCustomerDto, actor: AuthPrincipal): Promise<CustomerDetailDto> {
    const email = dto.email.trim();
    const customerId = uuidv7();
    const nationalId = dto.nationalId.trim();
    const sealed = await this.encryptor.encrypt(Buffer.from(nationalId, 'utf8'), nationalIdAad(customerId));
    // Prisma's `Bytes` column wants a Uint8Array over a plain ArrayBuffer (not Node's Buffer/ArrayBufferLike).
    const nationalIdEnc = Uint8Array.from(packEnvelope(sealed));
    // Deterministic keyed blind index so a partial UNIQUE index can reject a second ACTIVE customer with
    // the same national ID (QA) — the randomized ciphertext above cannot be uniqued.
    const nationalIdHash = this.encryptor.blindIndex(Buffer.from(nationalId, 'utf8'));

    await this.prisma.$transaction(async (tx) => {
      await applyRlsContext(tx, actor.sub); // SEC-003: role + app.user_id GUC (no-op unless DB_RLS_ENFORCED)
      const duplicate = await tx.customer.findFirst({
        where: { email: { equals: email, mode: 'insensitive' }, deletedAt: null },
        select: { id: true },
      });
      if (duplicate) {
        throw new ConflictException({ code: 'Customers.DuplicateEmail', message: 'A customer with this email already exists.' });
      }
      const duplicateNationalId = await tx.customer.findFirst({
        where: { nationalIdHash, deletedAt: null },
        select: { id: true },
      });
      if (duplicateNationalId) {
        throw new ConflictException({ code: 'Customers.DuplicateNationalId', message: 'A customer with this national ID already exists.' });
      }

      const accountId = uuidv7();
      const walletId = uuidv7();
      await tx.customer.create({
        data: {
          id: customerId,
          fullName: dto.fullName.trim(),
          email,
          phone: dto.phone?.trim() ?? null,
          nationalIdEnc,
          nationalIdLast4: nationalId.slice(-4),
          nationalIdHash,
          dateOfBirth: dto.dateOfBirth ? new Date(dto.dateOfBirth) : null,
          addressCountry: dto.address?.country?.trim() ?? null,
          addressCity: dto.address?.city?.trim() ?? null,
          addressPostal: dto.address?.postalCode?.trim() ?? null,
          addressLine1: dto.address?.line1?.trim() ?? null,
          walletNumber: generateWalletNumber(),
        },
      });
      await tx.account.create({
        data: { id: accountId, customerId, type: 'WALLET', status: 'ACTIVE', currency: DEFAULT_CURRENCY },
      });
      await tx.wallet.create({
        data: {
          id: walletId,
          accountId,
          currency: DEFAULT_CURRENCY,
          dailyLimitMinor: DEFAULT_DAILY_LIMIT_MINOR,
          monthlyLimitMinor: DEFAULT_MONTHLY_LIMIT_MINOR,
          status: 'ACTIVE',
          isSystem: false,
        },
      });
      await tx.walletBalance.create({ data: { walletId, balanceMinor: 0n, availableBalanceMinor: 0n } });
      await this.audit.record(
        { actorUserId: actor.sub, action: 'customer.create', resourceType: 'customer', resourceId: customerId, outcome: 'SUCCESS', context: { email: maskEmail(email) } },
        tx,
      );
    }).catch((err: unknown) => toDuplicateCustomerError(err)); // F12/QA: DB backstop → clean 409 on the crash-window race

    // Stream the committed creation to connected dashboards (PII-free signal: id + type + time).
    this.realtime.emit('customer.created', customerId);

    return this.getById(customerId);
  }

  /**
   * Updates a customer. Optimistic-concurrency guarded: the update only applies when the stored
   * rowVersion matches `dto.rowVersion`, else 409. A KYC-status change also appends a
   * `kyc_verifications` row + a `customer.kyc_change` audit entry. The national ID is immutable here.
   */
  async update(id: string, dto: UpdateCustomerDto, actor: AuthPrincipal): Promise<CustomerDetailDto> {
    // Optional fields are omitted by the form unless the operator changed them (the read masks PII,
    // so a masked value must never round-trip back) — an absent field preserves the stored value.
    const email = dto.email?.trim();
    // Captured inside the tx, used AFTER commit to fan out a PII-free KYC notification.
    let kycTransition: { from: string; to: string } | null = null;

    await this.prisma.$transaction(async (tx) => {
      await applyRlsContext(tx, actor.sub); // SEC-003: role + app.user_id GUC (no-op unless DB_RLS_ENFORCED)
      const existing = await tx.customer.findFirst({ where: { id, deletedAt: null } });
      if (!existing) {
        throw new NotFoundException({ code: 'Customers.NotFound', message: 'Customer not found.' });
      }

      if (email && email.toLowerCase() !== existing.email.toLowerCase()) {
        const duplicate = await tx.customer.findFirst({
          where: { email: { equals: email, mode: 'insensitive' }, deletedAt: null, NOT: { id } },
          select: { id: true },
        });
        if (duplicate) {
          throw new ConflictException({ code: 'Customers.DuplicateEmail', message: 'A customer with this email already exists.' });
        }
      }

      const nextKyc = dto.kycStatus ?? existing.kycStatus;
      const kycChanged = nextKyc !== existing.kycStatus;
      // Reject an illegal KYC lifecycle jump (re-audit DATA-001): a negative decision can't be silently
      // re-verified without re-review, and a VERIFIED customer can't be downgraded. See kyc-transitions.ts.
      if (kycChanged && !isKycTransitionAllowed(existing.kycStatus, nextKyc)) {
        throw new UnprocessableEntityException({
          code: 'Customers.IllegalKycTransition',
          message: `KYC transition ${existing.kycStatus} → ${nextKyc} is not allowed.`,
        });
      }

      // CLOSED is a terminal customer status — it must not be reopened via a status edit (re-audit
      // DATA-001). This enforces the clearest illegal transition the audit named; a fuller KYC
      // transition matrix (e.g. REJECTED→VERIFIED) is a separate product-policy decision, since the
      // shipped contract intentionally lets an RBAC-gated compliance operator set KYC directly.
      const nextStatus = dto.status ?? existing.status;
      if (existing.status === 'CLOSED' && nextStatus !== 'CLOSED') {
        throw new UnprocessableEntityException({
          code: 'Customers.IllegalStatusTransition',
          message: 'A closed customer cannot be reopened.',
        });
      }

      const result = await tx.customer.updateMany({
        where: { id, deletedAt: null, rowVersion: BigInt(dto.rowVersion) },
        data: {
          fullName: dto.fullName !== undefined ? dto.fullName.trim() : existing.fullName,
          email: email ?? existing.email,
          phone: dto.phone !== undefined ? dto.phone.trim() || null : existing.phone,
          dateOfBirth: dto.dateOfBirth !== undefined ? new Date(dto.dateOfBirth) : existing.dateOfBirth,
          addressCountry: dto.address !== undefined ? dto.address.country?.trim() ?? null : existing.addressCountry,
          addressCity: dto.address !== undefined ? dto.address.city?.trim() ?? null : existing.addressCity,
          addressPostal: dto.address !== undefined ? dto.address.postalCode?.trim() ?? null : existing.addressPostal,
          addressLine1: dto.address !== undefined ? dto.address.line1?.trim() ?? null : existing.addressLine1,
          kycStatus: nextKyc,
          status: nextStatus,
          contractSigned: dto.contractSigned ?? existing.contractSigned,
          rowVersion: { increment: 1 },
        },
      });
      if (result.count === 0) {
        throw new ConflictException({ code: 'Customers.Conflict', message: 'The customer was modified by someone else. Reload and try again.' });
      }

      if (kycChanged) {
        kycTransition = { from: existing.kycStatus, to: nextKyc };
        // A kyc_verifications row records a DECISION (an operator verifying or rejecting KYC). Only
        // mint it for a decision target — not for a lifecycle move like →IN_REVIEW/→NOT_STARTED,
        // which would fabricate a spurious "decision" row (re-audit DATA-001). The transition itself
        // is still fully recorded in the tamper-evident audit trail below.
        if (nextKyc === 'VERIFIED' || nextKyc === 'REJECTED') {
          await tx.kycVerification.create({
            data: { id: uuidv7(), customerId: id, status: nextKyc, method: 'manual', decidedBy: actor.sub, decidedAt: new Date() },
          });
        }
        await this.audit.record(
          { actorUserId: actor.sub, action: 'customer.kyc_change', resourceType: 'customer', resourceId: id, outcome: 'SUCCESS', context: { from: existing.kycStatus, to: nextKyc } },
          tx,
        );
      }
      await this.audit.record(
        // Audit the EFFECTIVE (masked) email — `email` is undefined when the operator didn't change it,
        // so fall back to the stored value rather than recording maskEmail(undefined) (re-audit BE-005).
        { actorUserId: actor.sub, action: 'customer.update', resourceType: 'customer', resourceId: id, outcome: 'SUCCESS', context: { email: maskEmail(email ?? existing.email) } },
        tx,
      );
    }).catch((err: unknown) => toDuplicateCustomerError(err)); // F12/QA: DB backstop → clean 409 on the crash-window race

    this.realtime.emit('customer.updated', id);

    // PII-free, preference-gated KYC notification: only operators with productUpdates on
    // are notified; the actor is excluded; params carry ONLY the customer id + KYC enum transition (no
    // name/email/PII). Best-effort — a notification failure never fails the customer update.
    if (kycTransition) {
      const transition = kycTransition as { from: string; to: string };
      const severity = transition.to === 'REJECTED' ? 'warning' : 'info';
      try {
        await this.notifications.emitToOperatorsWithPreference(
          'productUpdates',
          {
            type: 'KYC_EVENT',
            severity,
            titleKey: 'notifications.kyc.statusChanged.title',
            bodyKey: 'notifications.kyc.statusChanged.body',
            params: { customerId: id, from: transition.from, to: transition.to },
            resourceType: 'customer',
            resourceId: id,
          },
          { excludeUserId: actor.sub },
        );
      } catch {
        // swallow — notification is a side effect, not part of the update contract.
      }
    }

    return this.getById(id);
  }

  /** Soft-deletes a customer (sets `deletedAt`, bumps rowVersion) + audit. Idempotent; 404 if absent. */
  async softDelete(id: string, actor: AuthPrincipal): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await applyRlsContext(tx, actor.sub); // SEC-003: role + app.user_id GUC (no-op unless DB_RLS_ENFORCED)
      const result = await tx.customer.updateMany({
        where: { id, deletedAt: null },
        data: { deletedAt: new Date(), rowVersion: { increment: 1 } },
      });
      if (result.count === 0) {
        throw new NotFoundException({ code: 'Customers.NotFound', message: 'Customer not found.' });
      }
      await this.audit.record(
        { actorUserId: actor.sub, action: 'customer.delete', resourceType: 'customer', resourceId: id, outcome: 'SUCCESS' },
        tx,
      );
    });

    this.realtime.emit('customer.deleted', id);
  }

  private async assertCustomerExists(id: string): Promise<void> {
    const customer = await this.prisma.customer.findFirst({
      where: { id, deletedAt: null },
      select: { id: true },
    });
    if (!customer) {
      throw new NotFoundException({ code: 'Customers.NotFound', message: 'Customer not found.' });
    }
  }
}
