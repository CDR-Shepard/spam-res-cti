// Augments *this workspace's* `vitest` module (not whichever copy npm happens
// to hoist `@testing-library/jest-dom`'s own type declarations against — see
// the comment in `setup.ts`) with the jest-dom matcher types, so
// `expect(...).toBeInTheDocument()` etc. type-check against the same
// `Assertion` interface our test files import from 'vitest'.
import 'vitest';
import type * as JestDomMatchers from '@testing-library/jest-dom/matchers';

declare module 'vitest' {
  interface Assertion<T = any> extends JestDomMatchers.TestingLibraryMatchers<unknown, T> {}
  interface AsymmetricMatchersContaining extends JestDomMatchers.TestingLibraryMatchers<unknown, unknown> {}
}
