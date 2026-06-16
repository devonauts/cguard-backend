/**
 * Bridge so the communications suite is also discovered by `npm run test:unit`
 * (which globs tests/unit/**), in addition to `npm test` (which globs
 * src/** /*.test.ts). The actual tests live next to the code under test at
 * src/services/communication/__tests__/routing.test.ts — see that file.
 *
 * Run any of:
 *   npm test            # all suites (tests/** + src/** /*.test.ts)
 *   npm run test:unit   # tests/unit/** (includes this bridge)
 */
import '../../../src/services/communication/__tests__/routing.test';
