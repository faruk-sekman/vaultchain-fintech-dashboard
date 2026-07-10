/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Minimal ambient types for the untyped `qrcode` dependency. We use only `toDataURL`, so we declare
 * just that surface here instead of pulling in `@types/qrcode` (keeps the dependency footprint minimal).
 */
declare module 'qrcode' {
  export function toDataURL(text: string, options?: Record<string, unknown>): Promise<string>;
}
