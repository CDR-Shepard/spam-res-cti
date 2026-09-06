// `@testing-library/jest-dom/vitest` imports its own `vitest` module to call
// `expect.extend`. In this monorepo that subpath resolves (via hoisting) to
// the root's vitest@2.1.9 (pulled in by packages/contracts), not the
// vitest@4 instance this workspace's tests actually run under — so the
// extend would land on the wrong `expect` and matchers would appear
// missing. Import the environment-agnostic matcher table instead and
// extend the `expect` from *this* workspace's own vitest import.
import { afterEach, expect } from 'vitest';
import { cleanup } from '@testing-library/react';
import * as matchers from '@testing-library/jest-dom/matchers';

expect.extend(matchers);

// `@testing-library/react`'s built-in auto-cleanup only registers itself
// when `afterEach` is a global (i.e. `test.globals: true`); this project's
// vitest.config.ts intentionally doesn't set that, so register it here.
afterEach(() => { cleanup(); });
