// TrustCircleAI — root ESLint flat configuration (task T003 / GAR-010).
//
// This is the single, authoritative lint surface for the whole monorepo. It composes
// four concerns that the phase requires:
//
//   1. ESLint       — @eslint/js recommended + typescript-eslint recommended, applied to
//                     every TypeScript source across packages/apps/adapters/tests.
//   2. Prettier     — eslint-config-prettier is layered LAST so ESLint never fights the
//                     formatter (all stylistic rules that would conflict are turned off).
//                     Formatting itself is owned by `prettier --check .` (npm run format).
//   3. Dependency-boundary rules — import/no-restricted-paths encodes the architectural
//                     layering (leaf domain, libraries, composition roots) so a boundary
//                     violation fails `npm run lint` deterministically. See LAYERING below.
//   4. Generated-file / build-output exclusions — generated contract types, compiled
//                     declaration output (.tsbuild), node_modules, and other disposable or
//                     machine-authored artifacts are globally ignored so the linter never
//                     reports on code it does not own.
//
// The config is intentionally dependency-light and runs under Node 22 with `eslint .`.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

// ---------------------------------------------------------------------------------------
// Generated-file & build-output exclusions.
//
// Everything here is either machine-generated, installed, or disposable build output. The
// linter must never own or report on it (GAR-010: generated code is validated by the
// contract pipeline / tsc, not by ESLint style rules).
// ---------------------------------------------------------------------------------------
const IGNORES = [
  '**/node_modules/**',
  '.tsbuild/**', // tsc --build declaration + .tsbuildinfo output (git-ignored)
  '**/*.tsbuildinfo',
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
  '.lisa/**', // Lisa runtime state (git-ignored)
  '.git/**',
  '.agents/**',
  '.specify/**',
  // Generated contract types: OpenAPI / AsyncAPI / JSON Schema output produced by
  // `npm run contracts:generate`. Authored-by-tooling; excluded from lint.
  'packages/contracts/src/generated/**',
  '**/*.gen.ts',
  '**/*.generated.ts',
  'playwright-report/**',
  'test-results/**',
  // Gate evidence-capture scratch: disposable proof artifacts (run logs, emitted manifest
  // samples, evidence drivers) written by the test harness. Mirrors .prettierignore so both
  // tools agree these are not authored source. Kept tracked so gate snapshots can read them.
  'tests/e2e/scenarios/_evidence/**',
];

// ---------------------------------------------------------------------------------------
// LAYERING — the dependency-boundary contract, enforced by import/no-restricted-paths.
//
// The monorepo has three tiers. Imports may only flow DOWN the tiers, never up, and the
// leaf domain package may not import any other workspace member.
//
//   tier 0 (leaf)          packages/domain, packages/contracts, packages/observability
//   tier 1 (libraries)     the remaining packages/* (application, persistence, policy,
//                          projections, adapter-sdk, authz, evidence, audit-ledger)
//   tier 2 (composition)   apps/*, adapters/*  — the ONLY deployable composition roots
//
// Rules (each a `import/no-restricted-paths` zone):
//   R1  Nothing under packages/** may import from apps/** or adapters/**.
//       (Libraries must never depend on a deployable — that would invert the tiers.)
//   R2  packages/domain/** may not import from any OTHER workspace member. It is the leaf;
//       everything is allowed to depend on it, it depends on nothing internal.
//   R3  apps/** may not import from adapters/** and adapters/** may not import from apps/**.
//       (Sibling composition roots are independently deployable process boundaries.)
// ---------------------------------------------------------------------------------------
const boundaryZones = {
  // R1 — libraries (packages/**) must not reach into deployables.
  'no-package-to-app': {
    target: './packages',
    from: ['./apps', './adapters'],
    message:
      'Dependency-boundary violation (R1): packages/** must not import from apps/** or ' +
      'adapters/**. Libraries may not depend on deployable composition roots.',
  },
  // R2 — the leaf domain package must not import any sibling workspace member.
  'no-domain-fan-out': {
    target: './packages/domain/src',
    from: [
      './packages/application',
      './packages/persistence',
      './packages/policy',
      './packages/projections',
      './packages/adapter-sdk',
      './packages/authz',
      './packages/evidence',
      './packages/audit-ledger',
      './packages/contracts',
      './packages/observability',
      './apps',
      './adapters',
    ],
    message:
      'Dependency-boundary violation (R2): packages/domain is the leaf layer and must not ' +
      'import from any other workspace member.',
  },
  // R3 — apps and adapters are independent process boundaries; neither imports the other.
  'no-app-to-adapter': {
    target: './apps',
    from: ['./adapters'],
    message:
      'Dependency-boundary violation (R3): apps/** and adapters/** are independent ' +
      'composition roots and must not import each other.',
  },
  'no-adapter-to-app': {
    target: './adapters',
    from: ['./apps'],
    message:
      'Dependency-boundary violation (R3): apps/** and adapters/** are independent ' +
      'composition roots and must not import each other.',
  },
};

// The zones array consumed by import/no-restricted-paths (order is not significant).
export const DEPENDENCY_BOUNDARY_ZONES = Object.values(boundaryZones);

export default tseslint.config(
  // 1. Global ignores (must be its own object to apply repo-wide).
  { ignores: IGNORES },

  // 2. Base JavaScript recommended rules.
  js.configs.recommended,

  // 3. typescript-eslint recommended rules (non type-checked: fast, no full program build
  //    required, so `eslint .` runs without a warm tsc build).
  ...tseslint.configs.recommended,

  // 4. Project-wide language options + dependency-boundary rules for TypeScript sources.
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'],
    plugins: { import: importPlugin },
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    settings: {
      'import/resolver': {
        typescript: { alwaysTryTypes: true },
        node: true,
      },
    },
    rules: {
      // ---- Dependency-boundary enforcement (the architectural contract) ----
      'import/no-restricted-paths': ['error', { zones: DEPENDENCY_BOUNDARY_ZONES }],
      // A package must not import a workspace member it does not declare as a dependency.
      'import/no-extraneous-dependencies': [
        'error',
        {
          devDependencies: [
            '**/*.test.ts',
            '**/*.spec.ts',
            'tests/**',
            '**/scripts/**',
            // Root-level tooling configs legitimately consume dev-only tooling.
            'vitest.config.ts',
            'vitest.workspace.ts',
            '*.config.ts',
            '*.config.mts',
          ],
        },
      ],
      // No cycles across the layered boundary.
      'import/no-cycle': ['error', { maxDepth: Infinity }],
      'import/no-self-import': 'error',

      // ---- Correctness hygiene consumed by verify:release ----
      'no-console': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },

  // 5. Node built-in test suites (tests/**/*.mjs) — allow Node test globals, relax TS-only
  //    rules that do not apply to plain ESM test files.
  {
    files: [
      'tests/**/*.mjs',
      'scripts/**/*.mjs',
      'deploy/**/*.mjs',
      '**/*.config.mjs',
      'eslint.config.mjs',
    ],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },

  // 6. Prettier LAST — disables every stylistic rule that could conflict with the
  //    formatter so ESLint and `prettier --check .` never disagree.
  prettier,
);
