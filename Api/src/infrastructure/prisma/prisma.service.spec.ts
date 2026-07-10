/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Unit tests for the PrismaService SEC-003 boot guard (assertRuntimeRoleIsSafe): PRODUCTION refuses a
 * superuser runtime connection (a superuser bypasses Row-Level Security), while NON-production skips the
 * probe entirely so dev/CI (which connect as the superuser by design) are unchanged.
 * Design: docs/security/rls-app-connection-design.md.
 */
import { PrismaService } from './prisma.service';

/** Build a PrismaService with $connect/$queryRaw/$disconnect replaced by capturable fakes (no real DB). */
function makeService(superuser?: 'on' | 'off'): {
  service: PrismaService;
  connect: jest.Mock;
  query: jest.Mock;
  disconnect: jest.Mock;
} {
  const service = new PrismaService();
  const connect = jest.fn().mockResolvedValue(undefined);
  const disconnect = jest.fn().mockResolvedValue(undefined);
  const query = jest.fn().mockResolvedValue(superuser ? [{ is_superuser: superuser }] : []);
  // Instance-level shadowing of the constructor-assigned client methods — no real connection is made.
  (service as unknown as Record<string, unknown>).$connect = connect;
  (service as unknown as Record<string, unknown>).$disconnect = disconnect;
  (service as unknown as Record<string, unknown>).$queryRaw = query;
  return { service, connect, query, disconnect };
}

describe('PrismaService — SEC-003 runtime-role boot guard', () => {
  const ORIGINAL_ENV = process.env.NODE_ENV;

  beforeAll(() => {
    process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://localhost:5432/db';
  });

  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_ENV;
  });

  it('connects and skips the superuser probe entirely outside production (dev/CI unchanged)', async () => {
    process.env.NODE_ENV = 'development';
    const { service, connect, query } = makeService('off');
    await expect(service.onModuleInit()).resolves.toBeUndefined();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(query).not.toHaveBeenCalled(); // no probe in non-prod — preserves lazy-connect / boots-DB-down
  });

  it('refuses to boot in production when the runtime role is a superuser (RLS would be bypassed)', async () => {
    process.env.NODE_ENV = 'production';
    const { service, query } = makeService('on');
    await expect(service.onModuleInit()).rejects.toThrow(/non-superuser/);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('surfaces the RLS rationale + remediation in the production superuser error', async () => {
    process.env.NODE_ENV = 'production';
    const { service } = makeService('on');
    await expect(service.onModuleInit()).rejects.toThrow(/Row-Level Security/);
    await expect(makeService('on').service.onModuleInit()).rejects.toThrow(/app_login/);
  });

  it('boots in production when the runtime role is a non-superuser (app_login)', async () => {
    process.env.NODE_ENV = 'production';
    const { service, connect, query } = makeService('off');
    await expect(service.onModuleInit()).resolves.toBeUndefined();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('onModuleDestroy disconnects the client', async () => {
    const { service, disconnect } = makeService();
    await expect(service.onModuleDestroy()).resolves.toBeUndefined();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
