/*
 * Integration-test Jest config — CommonJS so Jest loads it without an ESM loader.
 *
 * WHY THIS EXISTS (the CI fix): `npm run test:int` boots the REAL AppModule, which wires MfaModule →
 * otplib v13. otplib v13's transitive deps @scure/base and @noble/hashes are ESM-only (`type: module`,
 * bare `export`), and one @noble/hashes copy is NESTED under @otplib/plugin-crypto-noble/node_modules.
 * The default Jest `transformIgnorePatterns` skips everything in node_modules, so those .js files reached
 * the runtime untransformed → "SyntaxError: Unexpected token 'export'" / "Jest failed to parse a file"
 * for every int-spec that loads AppModule.
 *
 * The fix mirrors the inline package.json `jest` block (kept for unit `npm test`) but:
 *   1. transforms via ts-jest with the int tsconfig (tsconfig.int.json → allowJs + isolatedModules), and
 *   2. narrows `transformIgnorePatterns` to an ALLOWLIST: ignore all of node_modules EXCEPT @scure/base,
 *      @noble/hashes, and otplib/@otplib — at ANY nesting depth (the `(?:...node_modules/)+` prefix lets
 *      the negative lookahead match both the top-level copy and the nested @otplib/.../node_modules copy).
 *
 * Keep this in sync with the inline `jest` block for the shared fields (moduleFileExtensions, rootDir,
 * collectCoverageFrom, coverageDirectory, testEnvironment). Only the int-specific bits differ.
 */
/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: 'src',
  testRegex: '.*\\.int-spec\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': ['ts-jest', { tsconfig: '<rootDir>/../tsconfig.int.json' }],
  },
  // Transform otplib's ESM-only deps (and otplib itself) wherever they resolve — top-level OR nested under
  // @otplib/*/node_modules. Everything else in node_modules stays untransformed (fast).
  transformIgnorePatterns: ['/node_modules/(?:.+/node_modules/)?(?!(?:@scure/base|@noble/hashes|@otplib|otplib)/)'],
  collectCoverageFrom: [
    '**/*.(t|j)s',
    '!**/*.spec.ts',
    '!**/*.int-spec.ts',
    '!main.ts',
    '!**/*.module.ts',
    '!generated/**',
    '!**/index.ts',
  ],
  coverageDirectory: '../coverage',
  testEnvironment: 'node',
  // Silence Nest's default Logger during int runs (TEST-001); pino is silenced separately in
  // app.module.ts (JEST_WORKER_ID-gated). Shared with the unit config's setup for consistency.
  setupFilesAfterEnv: ['<rootDir>/../jest.setup.cjs'],
};
