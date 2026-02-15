# Agents

## Mission and boundaries

- Make minimal, correct, repo-consistent changes.
- Prefer the smallest viable diff over broad rewrites.
- Do not refactor unless explicitly requested.
- Do not introduce style churn beyond local tidy passes.
- Do not invent new public APIs or contracts without explicit direction.

## Non-negotiables checklist

- Do not violate architecture invariants: `docs/architecture.md`.
- Follow contributor workflow and formatting conventions: `CONTRIBUTING.md`.
- Keep diffs small, scoped, and reviewable.
- Do not rename or move files unless required.
- Avoid widening public entrypoints/contracts without explicit direction.
- Update the authoritative docs when behavior or contracts change.

## Before you change anything

- Find an existing local pattern in the nearest module and follow it.
- Identify the owning layer/module for the change.
- Identify the authoritative docs for the area:
  - Core API and semantics: `docs/core-api.md`
  - DOM runtime and lifecycle: `docs/dom-runtime.md`
  - View behavior: `docs/views-spec.md`
  - Style system: `docs/style-system.md`
  - Architecture invariants: `docs/architecture.md`
- Choose the smallest possible change that solves the task.
- If unsure, link to existing architecture rules instead of inventing new ones.

## Where to make changes

- Core semantics/state/transactions/selection/routing: `src/core/`
- DOM runtime/controls/target binding: `src/dom/`
- View behavior/layout: `src/views/`
- App wiring/bootstrap: `src/main.ts`
- Tests: `test/`
- Shared test helpers: `test/test-utils.ts`

## After you change something

- Run the canonical validation commands listed in `CONTRIBUTING.md`.
- Confirm no architecture invariant regressions: `docs/architecture.md`.
- Summarize the change, rationale, and risk areas.

## Tests policy:

- Do not add new tests unless explicitly requested.
- If a fix is regression-prone, propose a focused test.

## Documentation update triggers

- Core API or semantics changed: `docs/core-api.md`.
- DOM runtime or lifecycle changed: `docs/dom-runtime.md`.
- Styling or tokens changed: `docs/style-system.md`.
- View behavior changed: `docs/views-spec.md`.
- Architecture invariants changed: `docs/architecture.md`.

## Pointers

- `README.md`
- `CONTRIBUTING.md`
- `docs/architecture.md`
- `docs/core-api.md`
- `docs/dom-runtime.md`
- `docs/style-system.md`
- `docs/views-spec.md`
