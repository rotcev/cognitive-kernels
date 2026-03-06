result:phase1-contract-fix-builder

Updated only `src/api/*` and `test/api/*` for the three Phase 1 contract gaps:

1. Validation failures now return HTTP `422` with the envelope code `VALIDATION_ERROR`.
2. SSE responses now include the required streaming headers: `content-type`, `cache-control: no-cache, no-transform`, `connection: keep-alive`, and `x-accel-buffering: no`.
3. `GET /runs/:runId/topology` now returns `{ run, stateSource, topology }`.

Observed file changes:
- `src/api/app.ts`
- `src/api/server.ts`
- `src/api/types.ts`
- `test/api/runs-api.test.ts`

Observed verification evidence:

```text
$ npm exec vitest run test/api --reporter=verbose

RUN  v3.0.8 /Users/shawndavies/dev/cognitive-kernels

✓ test/api/runs-api.test.ts (11 tests) 106ms

Test Files  1 passed (1)
     Tests  11 passed (11)
  Duration  321ms
```

```text
$ npm run build

> cognitive-kernels@0.1.0 build
> tsc -p tsconfig.json
```

Closed-loop confirmation:
- The targeted API suite passed after asserting the new `422 VALIDATION_ERROR` contract, the SSE headers, and the `{ run, stateSource, topology }` topology payload.
- `npm run build` exited successfully after updating the shared API types to the new topology response shape.
