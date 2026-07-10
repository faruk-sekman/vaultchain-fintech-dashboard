/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */
import { SimulatedScreeningProvider } from './simulated.provider';

describe('SimulatedScreeningProvider', () => {
  const provider = new SimulatedScreeningProvider();
  const ADDRESS = '0xd8da6bf26964af9d7eed9e03e53415d37aa96045';

  it('always declares itself simulated', async () => {
    expect(provider.isSimulated).toBe(true);
    expect(provider.name).toBe('rule-based-risk-engine');
    const result = await provider.screen({ address: ADDRESS });
    expect(result.isSimulated).toBe(true);
  });

  it('is deterministic — same address yields the same signals and decision', async () => {
    const a = await provider.screen({ address: ADDRESS });
    const b = await provider.screen({ address: ADDRESS.toUpperCase() }); // address normalized to lowercase
    expect(b).toEqual(a);
    expect(['ALLOW', 'REVIEW', 'BLOCK']).toContain(a.decision);
    expect(a.signals.map((s) => s.key)).toEqual([
      'sanctionsHit',
      'mixerExposure',
      'highVelocity',
      'suspiciousCounterparty',
    ]);
  });

  it('derives the decision from signal severity (high hit ⇒ BLOCK; any hit ⇒ REVIEW; none ⇒ ALLOW)', async () => {
    const { decision, signals } = await provider.screen({ address: ADDRESS });
    const hasHighHit = signals.some((s) => s.hit && s.severity === 'high');
    const hasAnyHit = signals.some((s) => s.hit);
    const expected = hasHighHit ? 'BLOCK' : hasAnyHit ? 'REVIEW' : 'ALLOW';
    expect(decision).toBe(expected);
  });

  // Each of the three decision branches against a concrete address whose sha-256 digest is known to trip
  // exactly the signals named. The thresholds are deterministic (digest[i] % N), so these fixtures are
  // stable across runs/platforms — they pin the whole score→decision ladder, not just one observed path.
  describe('decision ladder (every branch exercised)', () => {
    it('BLOCK: a high-severity hit (sanctionsHit) forces BLOCK', async () => {
      const res = await provider.screen({ address: 'addr-candidate-15' });
      expect(res.decision).toBe('BLOCK');
      expect(res.signals.find((s) => s.key === 'sanctionsHit')).toMatchObject({ hit: true, severity: 'high' });
    });

    it('REVIEW: only non-high signals hit ⇒ REVIEW (no high, but ≥1 medium/low)', async () => {
      const res = await provider.screen({ address: 'addr-candidate-0' });
      expect(res.decision).toBe('REVIEW');
      expect(res.signals.some((s) => s.hit && s.severity === 'high')).toBe(false);
      expect(res.signals.some((s) => s.hit)).toBe(true);
    });

    it('ALLOW: no signal hits ⇒ ALLOW (the clean path)', async () => {
      const res = await provider.screen({ address: 'addr-candidate-2' });
      expect(res.decision).toBe('ALLOW');
      expect(res.signals.every((s) => !s.hit)).toBe(true);
    });
  });
});
