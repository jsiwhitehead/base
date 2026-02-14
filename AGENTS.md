# Agent Instructions

This file is the quick field manual for contributors and coding agents.
Use it to make safe, coherent, repo-consistent changes with small, reviewable diffs.

## Project shape

This repository is a layered TypeScript system:

- `src/core/`: model, transactions, selection/focus, runtime wiring.
- `src/dom/`: shared DOM/component runtime and reusable controls.
- `src/views/`: view-specific behavior (`outline`, `table`, `slider`).
- `src/main.ts`: app bootstrap.

Primary architecture and contracts live in:

- `conventions.md`
- `docs/core-api.md`
- `docs/ui-system.md`
- `docs/ui-views.md`

## Hard invariants

- `core` MUST NOT import from `dom` or `views`.
- Cross-layer changes MUST preserve public API discipline and existing entrypoints.
- `DEFAULT_TARGET`/target ownership MUST stay consistent with `docs/ui-system.md`.
- Use stable discriminants and naming conventions (`kind` vs `type`) from `conventions.md`.
- Do not change behavior, architecture, or docs style silently; update docs in the same change.

## Do and don't

Do:

- Keep edits minimal and scoped to the task.
- Follow existing local patterns in touched files.
- Reuse existing primitives (`createComponent`, `ctx.on`, `ctx.effect`, `ctx.slot`, `ctx.list`).
- Prefer simple, clean, minimal, standard implementations that directly solve the requested task.

Don't:

- Do unrelated refactors or broad formatting changes.
- Add dependencies or change tooling config without explicit need.
- Rename/move files unless required.
- Bypass shared runtime patterns with ad-hoc event/mount logic.
- Do not add code comments unless explicitly requested.
- Do not add new tests unless explicitly requested. If existing tests do not cover the changed behavior, prefer a quick inline runtime check where suitable.

## Where to make changes

- Core behavior, transactions, selection/focus, view routing:
  - `src/core/*`
- Shared DOM runtime, component lifecycle, target binding, text controls:
  - `src/dom/base.ts`
  - `src/dom/controls.ts`
  - `src/dom/index.ts`
- View-specific UI/interaction logic:
  - `src/views/*`
- App bootstrap/wiring:
  - `src/main.ts`
- Shared test helpers:
  - `test/test-utils.ts`
- Tests:
  - `test/*.test.ts`

## Validate changes

Run these from repo root in this order:

```sh
bun run typecheck
bun test
bun run format
```

Useful focused run:

```sh
bun test test/core.test.ts
bun test test/views.test.ts
bun run format:files -- src/core/index.ts src/core/model.ts
```

## Documentation update triggers

Update docs in the same change when contracts or behavior change:

- Core API/types/semantics changed:
  - update `docs/core-api.md`
- Shared UI runtime/targets/interaction contracts changed:
  - update `docs/ui-system.md`
- View behavior/key handling/DOM shape changed:
  - update `docs/ui-views.md`
- Naming/structure/docs-formatting conventions changed:
  - update `conventions.md`

## Diff hygiene

- Keep diffs small, local, and reversible.
- Avoid touching unrelated files.
- Preserve existing naming and file organization patterns.
- Prefer additive/targeted edits over rewrites.

## Definition of done

Before finishing, verify:

- Validation commands above pass.
- Layering and target ownership invariants are preserved.
- Docs are updated for any contract or behavior change.
- The diff contains only task-relevant edits.
