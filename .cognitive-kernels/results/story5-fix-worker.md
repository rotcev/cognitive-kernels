result:story5:fix

Changed files:
- test/db/run-manager-pg.test.ts
- src/runs/run-manager.ts

What changed:
- Expanded Story 5 contract tests to cover:
  - startRun calls saveRun on connected backend
  - listRuns reads from backend when connected
  - getRun reads from backend when connected
  - filesystem fallback when backend save fails
  - filesystem fallback when no backend is configured
- Updated run manager backend contract and behavior:
  - Added optional backend read methods (`listRuns`, `getRun`) to `KernelRunStorageBackend`
  - `listRuns()` now prefers connected backend results when available, with fallback to in-memory/filesystem records
  - `getRun()` now checks connected backend for exact/prefix matches after local exact lookup, with fallback behavior preserved
  - Preserved filesystem source-of-truth fallback in `persistRun()` when backend save fails

Command outputs summary:
1) Tests-only run after adding contract tests (expected fail):
   - Command: npm test -- test/db/run-manager-pg.test.ts
   - Result: FAILED (3 failed, 2 passed)
   - Failures:
     - listRuns reads from backend when connected
     - getRun reads from backend when connected
     - filesystem fallback status expectation adjusted after reconcile behavior

2) Story 5 tests after implementation (expected pass):
   - Command: npm test -- test/db/run-manager-pg.test.ts
   - Result: PASSED (5 passed)

3) Final full test suite:
   - Command: npm test
   - Result: PASSED (13 files, 51 tests)
