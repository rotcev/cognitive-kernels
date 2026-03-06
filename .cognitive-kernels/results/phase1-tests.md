result:phase1-tests

Updated API tests in `test/api/runs-api.test.ts` to close Phase 1 gaps across validation, lifecycle, SSE, error mapping, and concurrency assertions.

Changed files:
- test/api/runs-api.test.ts

Added/adjusted assertions:
- Validation:
  - `POST /runs` rejects non-JSON content types with `415 unsupported_media_type`.
  - `GET /runs/:id/events?limit=0` returns `422 VALIDATION_ERROR`.
- SSE:
  - Existing live-stream test still verifies snapshot + runtime event framing.
  - Added concurrent SSE subscriber test to ensure both streams receive snapshot and runtime events.
- Lifecycle:
  - `GET /runs/:id/topology` returns valid topology when run is `completed` and state source is `snapshot`.
- Error mapping:
  - `GET /runs/:id/events` maps unexpected dependency exceptions to `500 internal_error`.

Focused command and evidence:

```text
$ npm test -- --run test/api/runs-api.test.ts

> cognitive-kernels@0.1.0 test
> vitest run --passWithNoTests --run test/api/runs-api.test.ts

RUN  v3.0.8 /Users/shawndavies/dev/cognitive-kernels

✓ test/api/runs-api.test.ts (18 tests) 1168ms

Test Files  1 passed (1)
     Tests  18 passed (18)
```

Notes:
- No feature implementation changes were made in this phase.
