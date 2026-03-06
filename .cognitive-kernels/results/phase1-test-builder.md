result:phase1-test-builder

Updated `test/api/runs-api.test.ts` to target the existing Phase 1 scaffold in `src/api/app.ts` instead of the non-existent server wrapper.

Observed test coverage:
- `GET /runs` returns an empty list without runtime wiring
- `POST /runs` applies default `cwd` and `configPath`
- `POST /runs` returns the scaffold 400 envelope for invalid payloads
- `GET /runs/:runId` returns 404 when `getRun` yields no run
- `GET /runs/:runId/events` returns injected event data
- `GET /runs/:runId/topology` returns the Phase 1 `501` unavailable payload
- `POST /runs/:runId/cancel` returns the Phase 1 `501` not-implemented envelope

Observed verification:

```text
$ npx vitest run test/api/runs-api.test.ts

 RUN  v3.0.8 /Users/shawndavies/dev/cognitive-kernels

 ✓ test/api/runs-api.test.ts (7 tests) 16ms

 Test Files  1 passed (1)
      Tests  7 passed (7)
   Duration  234ms
```
