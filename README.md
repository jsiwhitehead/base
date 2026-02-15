# Base

Base is an experimental platform for grouped, labeled, and connected information with a diverse ecosystem of composable views (outline, table, rich text, etc). This README is a quick orientation for running the app and understanding repository layout. Behavioral and contract details are defined in the docs listed below.

## Status

Work in progress.

## Quickstart

```sh
bun install
bun run app
```

## Validation

Run from repository root:

```sh
bun run typecheck
bun test
bun run format
```

## Repository shape

The system is organized as layered modules with intentionally one-way dependencies:

- `src/core/`: state model, transactions, selection/focus state, and intent routing.
- `src/dom/`: shared UI runtime primitives and reusable controls.
- `src/views/`: view implementations (`outline`, `table`, `slider`).
- `src/main.ts`: bootstrap and top-level wiring.

Rules:

- `core/` MUST NOT import from `dom/` or `views/`.
- Cross-layer imports SHOULD go through layer entrypoints.
- Cyclic dependencies MUST NOT be introduced.

## Runtime model at a glance

Base is built around a small set of stable contracts:

- **Core owns state and interaction semantics**. All edits flow through `core.commit(...)`, and Core owns selection, focus, and keyboard intent routing.
- **Selection is the source of truth for focus**. Core selection drives DOM focus (not browser tab order).
- **Targets provide stable focus surfaces** (e.g. `default`, `label`, `value`). Views bind targets to DOM elements, and Core selection chooses which target is focused.
- **Views are intent-driven**. Keyboard input is normalized into semantic intents (`NAV`, `TAB`, `TYPE`, etc) and routed to the active view.
- **Nested views behave like one app**. At any time there is one active view receiving intents ("window model").

UI rules:

- `.ui-main` is the only tabbable element.
- Selection-driven updates MUST be styling-only and MUST NOT remount item frames.
- Views MUST bind stable focus targets to DOM elements (via `core.attachTarget(...)` / `ctx.target(...)`).

## Authoritative docs

Architecture and behavior contracts:

- `docs/core-api.md`
- `docs/ui-contracts.md`
- `docs/ui-runtime.md`
- `docs/ui-views.md`

Repository conventions and contributor workflow:

- `conventions.md`
- `AGENTS.md`
