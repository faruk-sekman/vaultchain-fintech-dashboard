/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

export function describeQuarantined(reason: string, spec: () => void): void {
  const enabled = String(Cypress.expose('RUN_QUARANTINED') ?? '') === '1';
  const runner = enabled ? describe : describe.skip;
  runner(`[quarantined] ${reason}`, spec);
}

export function isVisualArtifactCaptureEnabled(): boolean {
  return String(Cypress.expose('CAPTURE_VISUAL_ARTIFACTS') ?? '') === '1';
}
