/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Vite `?raw` asset imports (used by login.component.spec.ts to assert the shipped
 * template's v2 structure — this vitest setup has no Angular external-resource loader).
 */
declare module '*.html?raw' {
  const content: string;
  export default content;
}
