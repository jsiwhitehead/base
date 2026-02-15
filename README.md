# Base

## What this repo is

Base is a layered TypeScript system for modeling and interacting with grouped, labeled, and connected information through composable views. It provides a Core state/intent model, a shared DOM runtime, and view implementations intended for developers working on the system internals and behavior contracts.

Work in progress.

## Quickstart

```sh
bun install
bun run app
```

## Validation (run from repo root):

```sh
bun run typecheck
bun test
bun run format
```

## Repo map (at a glance)

- `src/core/`: core state, transactions, selection/focus, and intent routing.
- `src/dom/`: shared DOM runtime and reusable controls.
- `src/views/`: view implementations (`outline`, `table`, `slider`).
- `src/main.ts`: bootstrap and top-level wiring.

### Key docs

- `docs/architecture.md`: canonical architecture and invariant contracts.
- `CONTRIBUTING.md`: contributor workflow and review expectations.
- `AGENTS.md`: coding-agent guardrails for safe, repo-consistent changes.
- `docs/core-api.md`: Core API and state/transaction semantics.
- `docs/dom-runtime.md`: runtime lifecycle, mounting, and shared controls.
- `docs/style-system.md`: style tokens and visual-system conventions.
- `docs/views-spec.md`: view behavior and interaction specifics.

## Common tasks (links-first)

- Add a view: `docs/views-spec.md`
- Work with styling: `docs/style-system.md`
- Understand rendering/runtime: `docs/dom-runtime.md`
- Work with Core state/transactions: `docs/core-api.md`
- Understand system invariants: `docs/architecture.md`
