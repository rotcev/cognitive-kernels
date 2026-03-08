# ARCHITECTURE.md required sections (best-effort)

**Status:** `ARCHITECTURE.md` not found at `/Users/shawndavies/dev/cognitive-kernels/ARCHITECTURE.md` (checked 2026-03-08).

This checklist is reconstructed from local run artifacts:
- `result:architecture-writer`
- `.cognitive-kernels/results/phase2-remediation-writer.md`

## Required sections / structure

- **Module records**: `ARCHITECTURE.md` should contain **8 module records** (heading level unknown; artifacts grep for `^### `).
  - Each module record must include these explicit fields:
    - `Taxonomy:`
    - `Responsibility:`
    - `Owns:`
    - `Out of scope:`
    - `Depends on:`
    - `Interfaces:`

- **Interaction model**: include a `## Interaction model` section with concrete flow bullets covering (at least):
  - runtime control
  - execution
  - IPC
  - observability
  - packaging

## Top-level sections (from architecture writer)

Artifacts indicate these were the intended top-level topics for the architecture doc:
- Project overview
- Directory structure
- Core abstractions (kernel/processes/blackboard/metacog/lens)
- Execution model
- IPC mechanisms
- Database schema
- Extension points
- Evidence map (claims -> repo anchors)
