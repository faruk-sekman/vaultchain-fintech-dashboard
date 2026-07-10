/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Unit tests for the SEC-003 applyRlsContext helper: default-OFF no-op (existing suite unchanged), and
 * when DB_RLS_ENFORCED is set it issues SET LOCAL ROLE app_rw + a parameterised app.user_id set_config,
 * defaulting the operator id to the AsyncLocalStorage request context.
 */
import { applyRlsContext, isRlsEnforced } from './rls-context';
import { runWithRequestContext } from '../../common/context/request-context';

type TxMock = { $executeRawUnsafe: jest.Mock; $queryRawUnsafe: jest.Mock };
const makeTx = (): TxMock => ({
  $executeRawUnsafe: jest.fn().mockResolvedValue(0),
  $queryRawUnsafe: jest.fn().mockResolvedValue([]),
});

describe('rls-context (SEC-003 applyRlsContext)', () => {
  const ORIGINAL = process.env.DB_RLS_ENFORCED;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.DB_RLS_ENFORCED;
    else process.env.DB_RLS_ENFORCED = ORIGINAL;
  });

  it('isRlsEnforced reflects the DB_RLS_ENFORCED flag', () => {
    delete process.env.DB_RLS_ENFORCED;
    expect(isRlsEnforced()).toBe(false);
    process.env.DB_RLS_ENFORCED = '1';
    expect(isRlsEnforced()).toBe(true);
    process.env.DB_RLS_ENFORCED = 'true';
    expect(isRlsEnforced()).toBe(true);
    process.env.DB_RLS_ENFORCED = '0';
    expect(isRlsEnforced()).toBe(false);
  });

  it('is a no-op when enforcement is OFF (default) — never touches the tx', async () => {
    delete process.env.DB_RLS_ENFORCED;
    const tx = makeTx();
    await applyRlsContext(tx as never, 'op-1');
    expect(tx.$executeRawUnsafe).not.toHaveBeenCalled();
    expect(tx.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('sets SET LOCAL ROLE app_rw + the parameterised app.user_id GUC when ON', async () => {
    process.env.DB_RLS_ENFORCED = '1';
    const tx = makeTx();
    await applyRlsContext(tx as never, 'op-42');
    expect(tx.$executeRawUnsafe).toHaveBeenCalledWith('SET LOCAL ROLE app_rw');
    expect(tx.$queryRawUnsafe).toHaveBeenCalledWith(expect.stringContaining("set_config('app.user_id'"), 'op-42');
  });

  it('defaults the operator id to the AsyncLocalStorage request context', async () => {
    process.env.DB_RLS_ENFORCED = '1';
    const tx = makeTx();
    await runWithRequestContext({ operatorId: 'op-als' }, () => applyRlsContext(tx as never));
    expect(tx.$queryRawUnsafe).toHaveBeenCalledWith(expect.any(String), 'op-als');
  });

  it('passes an empty string when there is no operator (null)', async () => {
    process.env.DB_RLS_ENFORCED = '1';
    const tx = makeTx();
    await applyRlsContext(tx as never, null);
    expect(tx.$queryRawUnsafe).toHaveBeenCalledWith(expect.any(String), '');
  });
});
