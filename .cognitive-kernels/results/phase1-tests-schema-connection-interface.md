result:phase1-tests-schema-connection-interface

Created/adjusted Story 1–3 contract tests under `test/db` only:
- `test/db/schema.test.ts` (Story 1: schema contract)
- `test/db/connection.test.ts` (Story 2: connection contract)
- `test/db/storage-backend.test.ts` (Story 3: storage-backend interface contract)

Targeted Vitest execution:

```text
$ npx vitest run test/db/schema.test.ts test/db/connection.test.ts test/db/storage-backend.test.ts --reporter=verbose

Test Files  3 failed (3)
     Tests  3 failed (3)
```

Observed per-test outcomes:
- `test/db/schema.test.ts`: failed — missing module `../../src/db/schema.js`
- `test/db/connection.test.ts`: failed — missing module `../../src/db/connection.js`
- `test/db/storage-backend.test.ts`: failed — missing module `../../src/db/storage-backend.js`

Gaps identified from Story 1–3 contracts:
- Story 1 gap (schema): `src/db/schema.ts` not present, so required exports (`CURRENT_SCHEMA_VERSION`, `buildSchemaPlan`) are unavailable.
- Story 2 gap (connection): `src/db/connection.ts` not present, so connection lifecycle exports (`connectStorage`, `disconnectStorage`) are unavailable.
- Story 3 gap (storage backend interface): `src/db/storage-backend.ts` not present, so backend factory export (`createStorageBackend`) is unavailable.

Scope control evidence:
- Only `test/db/*` files were created/adjusted for this task; no implementation files were edited.
