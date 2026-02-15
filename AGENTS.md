# Agent Instructions

This file is the quick field manual for contributors and coding agents. Use it to make safe, coherent, repo-consistent changes with small, reviewable diffs. It defines **how to work in this repository**: what to preserve, where to make changes, and how to finish a change cleanly.

## Engineering tenets

Rules:

- Prefer **local reasoning** over global coordination.
- Prefer **explicit state and explicit data flow** over implicit coupling.
- Prefer **clear boundaries and ownership** over convenience access.
- Prefer **small, stable public surfaces** over convenience exports.
- Prefer **one obvious way** to implement common patterns.
- Prefer **consistency and predictability** over cleverness.
- Prefer **reducing concept count** over accumulating special cases.
- Prefer **small diffs** that are easy to review and revert.

Notes:

- A contained rewrite is fine when it is the smallest way to reduce complexity while preserving contracts.

## Project shape

This repository is a layered TypeScript system:

- `src/core/`: model, transactions, selection/focus, runtime wiring.
- `src/dom/`: shared DOM/component runtime and reusable controls.
- `src/views/`: view-specific behavior (`outline`, `table`, `slider`).
- `src/main.ts`: app bootstrap.

Primary architecture and contracts live in:

- `conventions.md`
- `docs/core-api.md`
- `docs/ui-contracts.md`
- `docs/dom-runtime.md`
- `docs/views-spec.md`

## Hard invariants

These invariants MUST be preserved.

### Architecture

- `core/` MUST NOT import from `dom/` or `views/`.
- Cyclic dependencies MUST NOT be introduced.
- Cross-layer usage MUST go through stable layer entrypoints; do not depend on deep internals across layers.

### State, edits, and focus

- Core MUST be the single source of truth for state.
- All state changes MUST go through `core.commit(...)` (atomic transactions); do not mutate Core state ad-hoc.
- Selection MUST be the single source of truth for focus; UI focus MUST follow selection, not DOM tab order.
- The UI MUST be target-driven; `.ui-main` MUST be the only tabbable element.

### UI structure and ownership

- Each rendered item MUST map to exactly one stable `.ui-frame`.
- Selection-driven updates MUST be styling-only; selection MUST NOT remount, reorder, or recreate frames/bodies.
- Target ownership MUST remain consistent:
  - `.ui-frame` MUST own `DEFAULT_TARGET`.
  - `.ui-header` MUST own `label` and `conn:*`.
  - `.ui-body.<view>` MUST own `value`.

### Input and routing

- Keyboard behavior MUST be semantic (intent-driven); do not implement view behavior by ad-hoc raw `keydown` routing.
- Core MUST route intents to the active view; views MUST implement behavior by interpreting intents.

## Where to make changes

Use layer ownership to decide where code belongs.

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

## How to approach changes

Rules:

- Keep edits minimal and scoped to the task.
- Follow existing local patterns in touched files.
- Avoid touching unrelated files.
- Avoid broad formatting changes.
- Prefer shared runtime primitives over ad-hoc event/mount logic.

## Change strategy

Prefer the smallest change that preserves contracts and improves clarity.

Rules:

- For widely-used surfaces: prefer `add new -> migrate call sites -> remove old`.
- For isolated modules: a contained rewrite MAY be the cleanest option.
- Avoid mixing feature work and refactors in the same change unless the refactor is tiny and necessary.

## Decision rules (common tradeoffs)

### When to extract a module

Extract when it improves:

- Clarity of responsibilities.
- Reuse without deep imports.
- Testability of pure logic.

Avoid extracting when it:

- Only reduces line count.
- Creates a generic dumping ground.
- Increases navigation overhead without improving cohesion.

### When to promote something to a public entrypoint

Promote when:

- It is imported widely across a layer boundary.
- It represents a stable shared contract.
- It reduces deep internal imports.

Avoid promoting when:

- It is a local helper.
- It is likely to churn.
- It would expand the public surface without clear benefit.

### When to add tests

Rules:

- Do not add new tests unless explicitly requested.
- If a bug fix is non-trivial or regression-prone, adding a focused test SHOULD be proposed.

## Documentation update triggers

Update docs in the same change when contracts or behavior change.

- Core API/types/semantics changed: update `docs/core-api.md`.
- Shared UI contracts changed: update `docs/ui-contracts.md`.
- Shared UI runtime/targets/interaction contracts changed: update `docs/dom-runtime.md`.
- View behavior/key handling/DOM shape changed: update `docs/views-spec.md`.
- Naming/structure/docs-formatting conventions changed: update `conventions.md`.

## Diff hygiene

Rules:

- Keep diffs small, local, and reversible.
- Preserve existing naming and file organization patterns.
- Do not rename or move files unless required.
- Avoid widening public exports without clear need.

## Validation

Run these from repo root in this order:

```sh
bun run typecheck
bun test
bun run format
```

Useful focused runs:

```sh
bun test test/core.test.ts
bun test test/views.test.ts
bun run format:files -- src/core/index.ts src/core/model.ts
```

## Definition of done

Before finishing, verify:

- Validation commands pass.
- Layering and target ownership invariants are preserved.
- Public API discipline is preserved.
- Docs are updated for any contract or behavior change.
- The diff contains only task-relevant edits.

## PR / change checklist

- What is the change in one sentence?
- What invariants could this violate?
- What docs were updated (if any)?
- What validation commands were run?
