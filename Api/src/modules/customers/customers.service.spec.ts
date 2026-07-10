/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Unit tests for CustomersService write/guard branches (audit 9C). Prisma + Audit + Encryptor +
 * Realtime are mocked (the envelope codec is stubbed so encryption shape is irrelevant). Covers the
 * VC preview (found + 404 + kycVerified flag), create (success + minimal-dto defaults + duplicate-email
 * 409), update (404 + duplicate 409 + optimistic-concurrency 409 + KYC-change + field preservation),
 * soft-delete (success + 404), the list query branches (active/passive taxonomy + search), KYC-
 * verification listing (+ 404), the null-field mapper defaults, and the role-based PII reveal decisions.
 */
jest.mock('../../common/crypto/envelope-codec', () => ({ packEnvelope: () => Buffer.from([1, 2, 3]) }));

import { ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AuthPrincipal } from '../../common/auth/auth-principal';
import type { AuditService } from '../../common/audit/audit.service';
import type { EnvelopeEncryptor } from '../../common/crypto/envelope-encryptor';
import type { PrismaService } from '../../infrastructure/prisma/prisma.service';
import type { RealtimeService } from '../realtime/realtime.service';
import type { NotificationService } from '../notification/notification.service';
import { CustomersService } from './customers.service';

const actor = { sub: 'op-1' } as AuthPrincipal;

function customerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'c1', fullName: 'Ada Lovelace', email: 'ada@x.io', phone: '5551112233',
    walletNumber: '1234567890123456', nationalIdLast4: '1234', kycStatus: 'PENDING',
    riskLevel: 'LOW', status: 'ACTIVE', createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'), dateOfBirth: null,
    addressCountry: 'TR', addressCity: 'Istanbul', addressPostal: '34000', addressLine1: 'Main 1',
    contractSigned: true, rowVersion: 1n, ...overrides,
  };
}

function makeMocks() {
  const tx = {
    customer: { findFirst: jest.fn(), create: jest.fn(), updateMany: jest.fn() },
    account: { create: jest.fn() },
    wallet: { create: jest.fn() },
    walletBalance: { create: jest.fn() },
    kycVerification: { create: jest.fn() },
  };
  const prisma = {
    customer: { findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn() },
    kycVerification: { findMany: jest.fn(), count: jest.fn() },
    $transaction: jest.fn((arg: unknown) =>
      Array.isArray(arg) ? Promise.all(arg as Promise<unknown>[]) : (arg as (t: unknown) => unknown)(tx),
    ),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const encryptor = {
    encrypt: jest.fn().mockResolvedValue({ any: 'sealed' }),
    blindIndex: jest.fn().mockReturnValue('nid-blind-hash'),
  };
  const realtime = { emit: jest.fn() };
  const notifications = {
    emit: jest.fn().mockResolvedValue({ id: 'n1', deduped: false }),
    emitToOperatorsWithPreference: jest.fn().mockResolvedValue(0),
  };
  const service = new CustomersService(
    prisma as unknown as PrismaService,
    audit as unknown as AuditService,
    encryptor as unknown as EnvelopeEncryptor,
    realtime as unknown as RealtimeService,
    notifications as unknown as NotificationService,
  );
  return { prisma, audit, encryptor, realtime, notifications, tx, service };
}

const createDto = {
  fullName: 'Ada Lovelace', email: 'ada@x.io', nationalId: '12345678901', phone: '5551112233',
  dateOfBirth: '1990-01-01', address: { country: 'TR', city: 'Istanbul', postalCode: '34000', line1: 'Main 1' },
} as never;

describe('CustomersService', () => {
  describe('getCredentialPreview', () => {
    it('returns a VC with kycVerified=true for a VERIFIED customer', async () => {
      const { prisma, service } = makeMocks();
      prisma.customer.findFirst.mockResolvedValue({ id: 'c1', kycStatus: 'VERIFIED' });
      const vc = await service.getCredentialPreview('c1');
      expect(vc.credentialSubject).toEqual({ id: 'did:example:c1', kycVerified: true });
    });

    it('returns kycVerified=false for a non-verified customer', async () => {
      const { prisma, service } = makeMocks();
      prisma.customer.findFirst.mockResolvedValue({ id: 'c1', kycStatus: 'PENDING' });
      await expect(service.getCredentialPreview('c1')).resolves.toMatchObject({
        credentialSubject: { kycVerified: false },
      });
    });

    it('throws NotFound when the customer is absent', async () => {
      const { prisma, service } = makeMocks();
      prisma.customer.findFirst.mockResolvedValue(null);
      await expect(service.getCredentialPreview('c1')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('create', () => {
    it('creates the customer + wallet, emits realtime, and returns the masked detail', async () => {
      const { prisma, tx, realtime, service } = makeMocks();
      tx.customer.findFirst.mockResolvedValue(null); // no duplicate
      prisma.customer.findFirst.mockResolvedValue(customerRow()); // getById at the end
      const result = await service.create(createDto, actor);
      expect(tx.customer.create).toHaveBeenCalled();
      expect(tx.wallet.create).toHaveBeenCalled();
      expect(realtime.emit).toHaveBeenCalledWith('customer.created', expect.any(String));
      expect(result.id).toBe('c1');
    });

    it('defaults the optional fields to null when a minimal dto omits phone / dateOfBirth / address', async () => {
      // Exercises the create-data `?? null` / `dateOfBirth ? … : null` arms for omitted optionals.
      const { prisma, tx, service } = makeMocks();
      tx.customer.findFirst.mockResolvedValue(null); // no duplicate
      prisma.customer.findFirst.mockResolvedValue(customerRow());
      const minimalDto = { fullName: 'Grace Hopper', email: 'grace@x.io', nationalId: '98765432109' } as never;

      await service.create(minimalDto, actor);

      const data = tx.customer.create.mock.calls[0][0].data;
      expect(data.phone).toBeNull();
      expect(data.dateOfBirth).toBeNull();
      expect(data.addressCountry).toBeNull();
      expect(data.addressCity).toBeNull();
      expect(data.addressPostal).toBeNull();
      expect(data.addressLine1).toBeNull();
    });

    it('an address object with NO country still maps addressCountry to null (`country?.trim() ?? null`)', async () => {
      // address is provided (the `!== undefined` true arm) but every sub-field is absent, so even
      // country falls to `?? null` (the optional-chain short-circuits before `.trim()`).
      const { prisma, tx, service } = makeMocks();
      tx.customer.findFirst.mockResolvedValue(customerRow({ kycStatus: 'VERIFIED' }));
      tx.customer.updateMany.mockResolvedValue({ count: 1 });
      prisma.customer.findFirst.mockResolvedValue(customerRow({ kycStatus: 'VERIFIED' }));

      await service.update('c1', { rowVersion: 1, address: {} } as never, actor);

      expect(tx.customer.updateMany.mock.calls[0][0].data.addressCountry).toBeNull();
    });

    it('throws Conflict on a duplicate email', async () => {
      const { tx, service } = makeMocks();
      tx.customer.findFirst.mockResolvedValue({ id: 'dup' });
      await expect(service.create(createDto, actor)).rejects.toBeInstanceOf(ConflictException);
    });

    it('maps a DB unique-violation (P2002) on the email backstop to a clean 409 (F12 crash-window race)', async () => {
      // The racy fast-path check passes for BOTH racers (findFirst → null); the losing racer then trips
      // the partial-unique index at commit. Simulate that P2002 and assert it becomes the domain 409.
      const { tx, service } = makeMocks();
      tx.customer.findFirst.mockResolvedValue(null);
      tx.customer.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: 'test',
          meta: { target: ['customers_email_active_unique'] },
        }),
      );
      const err = await service.create(createDto, actor).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).getResponse()).toMatchObject({ code: 'Customers.DuplicateEmail' });
    });

    it('rethrows a non-email P2002 unchanged (does not mislabel another unique violation as duplicate email)', async () => {
      const { tx, service } = makeMocks();
      tx.customer.findFirst.mockResolvedValue(null);
      tx.customer.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: 'test',
          meta: { target: ['wallet_number'] },
        }),
      );
      const err = await service.create(createDto, actor).catch((e: unknown) => e);
      expect(err).not.toBeInstanceOf(ConflictException);
      expect((err as Prisma.PrismaClientKnownRequestError).code).toBe('P2002');
    });

    it('throws Conflict on a duplicate national ID via the fast-path blind-index check (QA)', async () => {
      const { tx, service } = makeMocks();
      // 1st findFirst (email) → null, 2nd findFirst (national-id blind index) → a hit.
      tx.customer.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'dup-nid' });
      const err = await service.create(createDto, actor).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).getResponse()).toMatchObject({ code: 'Customers.DuplicateNationalId' });
    });

    it('maps a DB unique-violation (P2002) on the national-id backstop to a clean 409 (QA crash-window race)', async () => {
      const { tx, service } = makeMocks();
      tx.customer.findFirst.mockResolvedValue(null); // both racers pass the fast-path
      tx.customer.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: 'test',
          meta: { target: ['customers_national_id_active_unique'] },
        }),
      );
      const err = await service.create(createDto, actor).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).getResponse()).toMatchObject({ code: 'Customers.DuplicateNationalId' });
    });
  });

  describe('update', () => {
    const updateDto = { rowVersion: 1, fullName: 'Ada N', kycStatus: 'VERIFIED' } as never;

    it('throws NotFound when the customer is absent', async () => {
      const { tx, service } = makeMocks();
      tx.customer.findFirst.mockResolvedValue(null);
      await expect(service.update('c1', updateDto, actor)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws Conflict when the new email collides with another customer', async () => {
      const { tx, service } = makeMocks();
      tx.customer.findFirst
        .mockResolvedValueOnce(customerRow({ email: 'old@x.io' })) // existing
        .mockResolvedValueOnce({ id: 'other' }); // duplicate
      await expect(service.update('c1', { rowVersion: 1, email: 'new@x.io' } as never, actor)).rejects.toBeInstanceOf(ConflictException);
    });

    it('maps a DB unique-violation (P2002) on an email change to a clean 409 (F12 race)', async () => {
      // existing found, the racy dup check passes (race), then updateMany trips the partial-unique index.
      const { tx, service } = makeMocks();
      tx.customer.findFirst
        .mockResolvedValueOnce(customerRow({ email: 'old@x.io' })) // existing
        .mockResolvedValueOnce(null); // fast-path dup check passes
      tx.customer.updateMany.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: 'test',
          meta: { target: ['customers_email_active_unique'] },
        }),
      );
      const err = await service.update('c1', { rowVersion: 1, email: 'new@x.io' } as never, actor).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).getResponse()).toMatchObject({ code: 'Customers.DuplicateEmail' });
    });

    it('throws Conflict (optimistic concurrency) when no row matches the rowVersion', async () => {
      const { tx, service } = makeMocks();
      tx.customer.findFirst.mockResolvedValue(customerRow());
      tx.customer.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.update('c1', updateDto, actor)).rejects.toBeInstanceOf(ConflictException);
    });

    it('applies a KYC change (writes a verification row) + emits realtime + returns detail', async () => {
      const { prisma, tx, audit, realtime, notifications, service } = makeMocks();
      tx.customer.findFirst.mockResolvedValue(customerRow({ kycStatus: 'PENDING' }));
      tx.customer.updateMany.mockResolvedValue({ count: 1 });
      prisma.customer.findFirst.mockResolvedValue(customerRow({ kycStatus: 'VERIFIED' }));

      await service.update('c1', updateDto, actor);

      expect(tx.kycVerification.create).toHaveBeenCalled();
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'customer.kyc_change' }), tx);
      expect(realtime.emit).toHaveBeenCalledWith('customer.updated', 'c1');
      // A preference-gated KYC notification fans out — PII-FREE params (id + enum only),
      // actor excluded.
      expect(notifications.emitToOperatorsWithPreference).toHaveBeenCalledWith(
        'productUpdates',
        expect.objectContaining({
          type: 'KYC_EVENT',
          resourceId: 'c1',
          params: { customerId: 'c1', from: 'PENDING', to: 'VERIFIED' },
        }),
        { excludeUserId: actor.sub },
      );
    });

    it('does NOT mint a kyc_verifications decision row for a non-decision target, but still audits it (DATA-001)', async () => {
      const { prisma, tx, audit, service } = makeMocks();
      tx.customer.findFirst.mockResolvedValue(customerRow({ kycStatus: 'NOT_STARTED' }));
      tx.customer.updateMany.mockResolvedValue({ count: 1 });
      prisma.customer.findFirst.mockResolvedValue(customerRow({ kycStatus: 'IN_REVIEW' }));

      await service.update('c1', { rowVersion: 1, kycStatus: 'IN_REVIEW' } as never, actor);

      // Moving to IN_REVIEW is a lifecycle change, not a verify/reject decision → no fabricated row…
      expect(tx.kycVerification.create).not.toHaveBeenCalled();
      // …but the transition is still recorded in the tamper-evident audit trail.
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'customer.kyc_change' }), tx);
    });

    it('rejects reopening a CLOSED customer (terminal status) with 422 (DATA-001)', async () => {
      const { tx, service } = makeMocks();
      tx.customer.findFirst.mockResolvedValue(customerRow({ status: 'CLOSED' }));

      await expect(
        service.update('c1', { rowVersion: 1, status: 'ACTIVE' } as never, actor),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      // Guarded BEFORE the write — no update is attempted.
      expect(tx.customer.updateMany).not.toHaveBeenCalled();
    });

    it('rejects an illegal KYC transition (REJECTED → VERIFIED needs re-review) with 422 (DATA-001)', async () => {
      const { tx, service } = makeMocks();
      tx.customer.findFirst.mockResolvedValue(customerRow({ kycStatus: 'REJECTED' }));

      await expect(
        service.update('c1', { rowVersion: 1, kycStatus: 'VERIFIED' } as never, actor),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      // Guarded before the write — no fabricated verification row, no update.
      expect(tx.customer.updateMany).not.toHaveBeenCalled();
    });

    it('does NOT fan out a KYC notification when the KYC status is unchanged', async () => {
      const { prisma, tx, notifications, service } = makeMocks();
      const existing = customerRow({ kycStatus: 'VERIFIED' });
      tx.customer.findFirst.mockResolvedValue(existing);
      tx.customer.updateMany.mockResolvedValue({ count: 1 });
      prisma.customer.findFirst.mockResolvedValue(existing);

      await service.update('c1', { rowVersion: 1, fullName: 'Ada N' } as never, actor);

      expect(notifications.emitToOperatorsWithPreference).not.toHaveBeenCalled();
    });

    it('preserves the stored values when the dto omits fullName / phone / address (no KYC change)', async () => {
      // The next KYC equals existing (no kycStatus in the dto) → kyc-change branch skipped; the omitted
      // fields take their `: existing.*` else arms (field-preservation), not a masked round-trip.
      const { prisma, tx, audit, service } = makeMocks();
      const existing = customerRow({ kycStatus: 'VERIFIED', fullName: 'Ada Stored', phone: '5550000000', addressCity: 'Ankara' });
      tx.customer.findFirst.mockResolvedValue(existing);
      tx.customer.updateMany.mockResolvedValue({ count: 1 });
      prisma.customer.findFirst.mockResolvedValue(existing);

      await service.update('c1', { rowVersion: 1 } as never, actor); // only the required rowVersion

      const data = tx.customer.updateMany.mock.calls[0][0].data;
      expect(data.fullName).toBe('Ada Stored'); // preserved
      expect(data.phone).toBe('5550000000'); // preserved
      expect(data.addressCity).toBe('Ankara'); // preserved (address dto absent)
      expect(data.kycStatus).toBe('VERIFIED'); // unchanged
      expect(tx.kycVerification.create).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'customer.kyc_change' }), tx);
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'customer.update' }), tx);
    });

    it('applies provided fullName / phone / dateOfBirth / address fields (the change ternaries, not preservation)', async () => {
      // Every optional field is present in the dto -> the `dto.X !== undefined ? ... : existing` true arms,
      // the address `?.trim() ?? null` defaults (country present, others absent), and a phone that
      // whitespace-trims to null (`dto.phone.trim() || null`).
      const { prisma, tx, service } = makeMocks();
      tx.customer.findFirst.mockResolvedValue(customerRow({ kycStatus: 'VERIFIED' }));
      tx.customer.updateMany.mockResolvedValue({ count: 1 });
      prisma.customer.findFirst.mockResolvedValue(customerRow({ kycStatus: 'VERIFIED' }));

      await service.update(
        'c1',
        {
          rowVersion: 1, fullName: '  Grace Hopper  ', phone: '   ', dateOfBirth: '1906-12-09',
          address: { country: '  US  ' }, // only country provided -> city/postal/line1 -> null
        } as never,
        actor,
      );

      const data = tx.customer.updateMany.mock.calls[0][0].data;
      expect(data.fullName).toBe('Grace Hopper'); // trimmed, change arm
      expect(data.phone).toBeNull(); // whitespace-only -> `trim() || null`
      expect(data.dateOfBirth).toBeInstanceOf(Date); // change arm (new Date(dto.dateOfBirth))
      expect(data.addressCountry).toBe('US'); // trimmed
      expect(data.addressCity).toBeNull(); // absent sub-field -> `?? null`
      expect(data.addressPostal).toBeNull();
      expect(data.addressLine1).toBeNull();
    });
  });

  describe('softDelete', () => {
    it('soft-deletes and emits realtime', async () => {
      const { tx, realtime, service } = makeMocks();
      tx.customer.updateMany.mockResolvedValue({ count: 1 });
      await service.softDelete('c1', actor);
      expect(realtime.emit).toHaveBeenCalledWith('customer.deleted', 'c1');
    });

    it('throws NotFound when nothing was deleted', async () => {
      const { tx, service } = makeMocks();
      tx.customer.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.softDelete('c1', actor)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // List query → Prisma `where` shaping (the active/passive taxonomy + the search OR + exact status).
  describe('list query branches', () => {
    it('filter[active]=false selects not-ACTIVE (INACTIVE+CLOSED) via `status <> ACTIVE`', async () => {
      const { prisma, service } = makeMocks();
      prisma.customer.findMany.mockResolvedValue([]);
      prisma.customer.count.mockResolvedValue(0);

      await service.list({ 'filter[active]': 'false' });

      const where = prisma.customer.findMany.mock.calls[0][0].where;
      expect(where.status).toEqual({ not: 'ACTIVE' }); // the passive arm
      expect(where.deletedAt).toBeNull();
    });

    it('filter[active]=true selects exactly ACTIVE', async () => {
      const { prisma, service } = makeMocks();
      prisma.customer.findMany.mockResolvedValue([]);
      prisma.customer.count.mockResolvedValue(0);

      await service.list({ 'filter[active]': 'true' });

      expect(prisma.customer.findMany.mock.calls[0][0].where.status).toBe('ACTIVE');
    });

    it('an exact filter[status] WINS over filter[active] (the active arm is skipped)', async () => {
      const { prisma, service } = makeMocks();
      prisma.customer.findMany.mockResolvedValue([]);
      prisma.customer.count.mockResolvedValue(0);

      await service.list({ 'filter[status]': 'CLOSED', 'filter[active]': 'true' });

      // Exact status is applied verbatim; the `{ not: 'ACTIVE' }`/`'ACTIVE'` active override never runs.
      expect(prisma.customer.findMany.mock.calls[0][0].where.status).toBe('CLOSED');
    });

    it('filter[q] builds a case-insensitive OR across fullName / email / walletNumber', async () => {
      const { prisma, service } = makeMocks();
      prisma.customer.findMany.mockResolvedValue([]);
      prisma.customer.count.mockResolvedValue(0);

      await service.list({ 'filter[q]': 'ada' });

      const where = prisma.customer.findMany.mock.calls[0][0].where;
      expect(where.OR).toEqual([
        { fullName: { contains: 'ada', mode: 'insensitive' } },
        { email: { contains: 'ada', mode: 'insensitive' } },
        { walletNumber: { contains: 'ada', mode: 'insensitive' } },
      ]);
    });

    it('filter[kycStatus] narrows the where clause and returns the paged envelope', async () => {
      const { prisma, service } = makeMocks();
      prisma.customer.findMany.mockResolvedValue([customerRow()]);
      prisma.customer.count.mockResolvedValue(1);

      const res = await service.list({ 'filter[kycStatus]': 'PENDING' });

      expect(prisma.customer.findMany.mock.calls[0][0].where.kycStatus).toBe('PENDING');
      expect(res.page).toEqual({ number: 1, size: 25, totalItems: 1, totalPages: 1 });
    });
  });

  describe('listKycVerifications', () => {
    it('returns the customer’s KYC verifications as a paged, ISO-mapped envelope', async () => {
      const { prisma, service } = makeMocks();
      prisma.customer.findFirst.mockResolvedValue({ id: 'c1' }); // assertCustomerExists → found
      prisma.kycVerification.findMany.mockResolvedValue([
        {
          id: 'k1', customerId: 'c1', status: 'VERIFIED', method: 'manual', reasonCode: null,
          decidedAt: new Date('2026-02-01T00:00:00.000Z'), decidedBy: 'op-1', createdAt: new Date('2026-01-15T00:00:00.000Z'),
        },
      ]);
      prisma.kycVerification.count.mockResolvedValue(1);

      const res = await service.listKycVerifications('c1', {});

      expect(res.data).toHaveLength(1);
      expect(res.data[0]).toMatchObject({
        id: 'k1', status: 'VERIFIED', method: 'manual',
        decidedAt: '2026-02-01T00:00:00.000Z', createdAt: '2026-01-15T00:00:00.000Z',
      });
      expect(res.page).toEqual({ number: 1, size: 25, totalItems: 1, totalPages: 1 });
    });

    it('maps a still-pending verification (decidedAt null) without throwing', async () => {
      const { prisma, service } = makeMocks();
      prisma.customer.findFirst.mockResolvedValue({ id: 'c1' });
      prisma.kycVerification.findMany.mockResolvedValue([
        { id: 'k2', customerId: 'c1', status: 'PENDING', method: 'auto', reasonCode: 'NEEDS_REVIEW', decidedAt: null, decidedBy: null, createdAt: new Date('2026-01-15T00:00:00.000Z') },
      ]);
      prisma.kycVerification.count.mockResolvedValue(1);

      const res = await service.listKycVerifications('c1', {});
      expect(res.data[0].decidedAt).toBeNull(); // the `?? null` arm
    });

    it('throws NotFound when the customer does not exist (assertCustomerExists guard)', async () => {
      const { prisma, service } = makeMocks();
      prisma.customer.findFirst.mockResolvedValue(null); // assertCustomerExists → 404
      await expect(service.listKycVerifications('missing', {})).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.kycVerification.findMany).not.toHaveBeenCalled();
    });
  });

  // Null-field mapper defaults: a sparse row (no DOB, no address parts, no last-4) must map to nulls in
  // BOTH masked and revealed modes — the `?? null` / `dateOfBirth ? … : null` arms, not a throw.
  describe('detail mapper null-field defaults', () => {
    const sparse = () =>
      customerRow({
        nationalIdLast4: null, dateOfBirth: null,
        addressCountry: null, addressCity: null, addressPostal: null, addressLine1: null,
      });
    const revealer = { sub: 'admin-1', permissions: ['customers.pii.reveal'] } as AuthPrincipal;

    it('masked: a row with no DOB / last-4 / address fields maps every nullable to null', async () => {
      const { prisma, service } = makeMocks();
      prisma.customer.findFirst.mockResolvedValue(sparse());
      const detail = await service.getById('c1');
      expect(detail.dateOfBirth).toBeNull();
      expect(detail.nationalIdLast4).toBeNull();
      expect(detail.address).toEqual({ country: null, city: null, postalCode: null, line1: null });
    });

    it('revealed: the same sparse row still maps the absent address parts to null (reveal else-arms)', async () => {
      const { prisma, service } = makeMocks();
      prisma.customer.findFirst.mockResolvedValue(sparse());
      const detail = await service.getById('c1', { reveal: true, principal: revealer });
      // Revealed, but the underlying columns are null → `addressCity ?? null` etc. still yield null.
      expect(detail.address).toEqual({ country: null, city: null, postalCode: null, line1: null });
      expect(detail.dateOfBirth).toBeNull();
    });

    it('a row WITH a date of birth maps it to a YYYY-MM-DD string (the truthy DOB arm)', async () => {
      const { prisma, service } = makeMocks();
      prisma.customer.findFirst.mockResolvedValue(customerRow({ dateOfBirth: new Date('1990-05-17T00:00:00.000Z') }));
      const detail = await service.getById('c1');
      expect(detail.dateOfBirth).toBe('1990-05-17'); // sliced ISO date, not null
    });
  });

  // canRevealPii fail-closed: a principal with no `permissions` array must resolve to masked (`?? false`).
  describe('reveal permission resolution (fail-closed)', () => {
    it('a principal with no permissions array is treated as not-permitted (masked, no audit)', async () => {
      const { prisma, audit, service } = makeMocks();
      prisma.customer.findFirst.mockResolvedValue(customerRow());
      const noPerms = { sub: 'op-x' } as AuthPrincipal; // permissions undefined → `?? false`
      const detail = await service.getById('c1', { reveal: true, principal: noPerms });
      expect(detail.fullName).toBe('Ada L***'); // masked
      expect(audit.record).not.toHaveBeenCalled();
    });
  });

  // Role-based PII reveal. The mapper boundary + effective-reveal resolution.
  describe('read masking + reveal', () => {
    const revealer = { sub: 'admin-1', permissions: ['customers.read', 'customers.pii.reveal'] } as AuthPrincipal;
    const reader = { sub: 'op-1', permissions: ['customers.read'] } as AuthPrincipal;
    const MASKED_DETAIL = { country: 'TR', city: null, postalCode: null, line1: 'M***' };
    const RAW_DETAIL = { country: 'TR', city: 'Istanbul', postalCode: '34000', line1: 'Main 1' };

    it('getById masks by default (no opts): city/postalCode null, country raw, line1 reduced; no audit', async () => {
      const { prisma, audit, service } = makeMocks();
      prisma.customer.findFirst.mockResolvedValue(customerRow());
      const detail = await service.getById('c1');
      expect(detail.fullName).toBe('Ada L***');
      expect(detail.email).toBe('a***@x***.io');
      expect(detail.address).toEqual(MASKED_DETAIL);
      expect(detail.nationalIdLast4).toBe('1234');
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('getById reveals raw PII for a permitted principal + writes exactly one customer.pii.reveal row', async () => {
      const { prisma, audit, service } = makeMocks();
      prisma.customer.findFirst.mockResolvedValue(customerRow());
      const detail = await service.getById('c1', { reveal: true, principal: revealer });
      expect(detail.fullName).toBe('Ada Lovelace');
      expect(detail.email).toBe('ada@x.io');
      expect(detail.address).toEqual(RAW_DETAIL);
      expect(detail.nationalIdLast4).toBe('1234'); // last-4 even when revealed (D2)
      expect(audit.record).toHaveBeenCalledTimes(1);
      expect(audit.record).toHaveBeenCalledWith(
        { actorUserId: 'admin-1', action: 'customer.pii.reveal', resourceType: 'customer', resourceId: 'c1', outcome: 'SUCCESS' },
      );
    });

    it('getById masks (no audit) when reveal requested but principal lacks customers.pii.reveal (fail-closed)', async () => {
      const { prisma, audit, service } = makeMocks();
      prisma.customer.findFirst.mockResolvedValue(customerRow());
      const detail = await service.getById('c1', { reveal: true, principal: reader });
      expect(detail.address).toEqual(MASKED_DETAIL);
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('getById on a 404 throws BEFORE any reveal audit row is written', async () => {
      const { prisma, audit, service } = makeMocks();
      prisma.customer.findFirst.mockResolvedValue(null);
      await expect(service.getById('missing', { reveal: true, principal: revealer })).rejects.toBeInstanceOf(NotFoundException);
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('list reveals raw items + writes exactly one customer.pii.reveal_list summary row {page,count}', async () => {
      const { prisma, audit, service } = makeMocks();
      prisma.customer.findMany.mockResolvedValue([customerRow(), customerRow({ id: 'c2' })]);
      prisma.customer.count.mockResolvedValue(2);
      const res = await service.list({ reveal: 'true' }, revealer);
      expect(res.data[0].fullName).toBe('Ada Lovelace');
      expect(audit.record).toHaveBeenCalledTimes(1);
      expect(audit.record).toHaveBeenCalledWith(
        { actorUserId: 'admin-1', action: 'customer.pii.reveal_list', resourceType: 'customer', resourceId: null, outcome: 'SUCCESS', context: { page: 1, count: 2 } },
      );
    });

    it('list masks (no audit) when reveal requested but principal lacks the permission', async () => {
      const { prisma, audit, service } = makeMocks();
      prisma.customer.findMany.mockResolvedValue([customerRow()]);
      prisma.customer.count.mockResolvedValue(1);
      const res = await service.list({ reveal: 'true' }, reader);
      expect(res.data[0].fullName).toBe('Ada L***');
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('create() returns MASKED detail and never writes a reveal row (write-path masked by construction)', async () => {
      const { prisma, tx, audit, service } = makeMocks();
      tx.customer.findFirst.mockResolvedValue(null); // no duplicate
      prisma.customer.findFirst.mockResolvedValue(customerRow()); // getById at the end
      const result = await service.create(createDto, actor);
      expect(result.address).toEqual(MASKED_DETAIL);
      expect(audit.record).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'customer.pii.reveal' }));
    });
  });
});
