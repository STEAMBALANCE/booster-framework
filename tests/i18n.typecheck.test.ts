// This file verifies that LL.framework.* enforces per-key argument types.
// It is a TYPECHECK-ONLY test — bun test does not need to execute it; the
// guard is `bunx tsc --noEmit framework/tests/i18n.typecheck.test.ts`.
//
// If typesafe-i18n is downgraded from `typesafeI18nObject` to `i18nObject`
// (the loose form), every `@ts-expect-error` comment below becomes an
// "Unused '@ts-expect-error' directive" diagnostic and tsc exits non-zero,
// surfacing the regression.
import { LL } from '../src/i18n';

// @ts-expect-error — close_aria_label takes no arguments
LL.framework.window.close_aria_label({ extra: 1 });

// Positive control (this SHOULD compile):
const valid1: string = LL.framework.window.close_aria_label();

export { valid1 };
