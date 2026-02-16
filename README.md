# Base

## What this repo is

Base is a layered TypeScript system for modelling and interacting with grouped, labelled, and connected information through composable views, designed to support cumulative understanding through stable structure, safe revision, and coherent interaction.

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
- `docs/style-system.md`: deep feel, visual grammar, and styling conventions.
- `docs/views-spec.md`: view behavior and interaction specifics.

## Common tasks (links-first)

- Add a view: `docs/views-spec.md`
- Work with styling: `docs/style-system.md`
- Understand rendering/runtime: `docs/dom-runtime.md`
- Work with Core state/transactions: `docs/core-api.md`
- Understand system invariants: `docs/architecture.md`
