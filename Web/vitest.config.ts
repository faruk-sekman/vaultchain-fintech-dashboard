import { defineConfig } from 'vitest/config';
import angular from '@analogjs/vite-plugin-angular';
import path from 'node:path';

export default defineConfig({
  // @analogjs/vite-plugin-angular (MIT) compiles Angular component templates/styles
  // (templateUrl/styleUrl) during tests, enabling TestBed.createComponent() + ComponentRef
  // .setInput() so signal input()/output() primitives are unit-testable in this vitest setup.
  plugins: [angular()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['src/test/setup.ts'],
    include: ['src/**/*.spec.ts'],
    pool: 'threads',
    // Inline Angular's fesm2022 ESM bundles so the plugin's transform applies to them.
    server: { deps: { inline: [/fesm2022/] } },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      thresholds: {
        // Vitest 4 reads coverage gates under `coverage.thresholds`. These are AGGREGATE ratchets
        // (defense-in-depth) that lock in the achieved numbers. TRUE per-file >=90 is enforced
        // separately and uniformly across both stacks by `scripts/check-file-coverage.mjs`
        // (run via `npm run coverage:files:check`).
        // Ratchet up as coverage improves; never loosen.
        statements: 97,
        lines: 98,
        functions: 97,
        branches: 94,
      },
      exclude: [
        '**/*.d.ts',
        'src/main.ts',
        'src/polyfills.ts',
        '**/index.ts',
        '**/shared/models/**/*.ts',
        '**/*.types.ts',
        // Build-time configuration objects (no executable branch); selected by the Angular builder.
        'src/environments/**'
      ]
    }
  },
  poolOptions: {
    threads: {
      minThreads: 1,
      maxThreads: 1
    }
  },
  resolve: {
    alias: {
      '@core': path.resolve(__dirname, 'src/app/core'),
      '@shared': path.resolve(__dirname, 'src/app/shared'),
      '@features': path.resolve(__dirname, 'src/app/features')
    }
  }
});
