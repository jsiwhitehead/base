# Base

## What this repo is

Base is a layered TypeScript system for modelling and interacting with grouped, labelled, and connected information through composable views, designed to support cumulative understanding through stable structure, safe revision, and coherent interaction.

Work in progress.

## Quickstart

```sh
bun install
bun run app
```

## Validation (run from repo root)

```sh
bun run typecheck
bun test
bun run format
```

## Repo map (at a glance)

- `src/main.ts`: browser bootstrap and demo/startup wiring.
- `src/setup.ts`: shared composition and app assembly (`Core` + DOM runtime + views).
- `src/core/`: core state, transactions, selection/focus, and intent routing.
- `src/dom/`: shared DOM runtime and reusable controls.
- `src/views/`: view implementations (`outline`, `table`, `slider`).

## Key docs

- `CONTRIBUTING.md`: contributor workflow and review expectations.
- `AGENTS.md`: coding-agent guardrails for safe, repo-consistent changes.
- `ROADMAP.md`: capability-domain roadmap for how the system should mature.
- `docs/architecture.md`: canonical architecture and invariant contracts.
- `docs/core-api.md`: Core API and state/transaction semantics.
- `docs/dom-runtime.md`: runtime lifecycle, mounting, and shared controls.
- `docs/views-spec.md`: view behavior and interaction specifics.
- `docs/content-editable.md`: contenteditable event pipeline, text sync, and DOM contracts.
- `docs/style-system.md`: deep feel, visual grammar, and styling conventions.

## Common tasks (links-first)

- Understand system invariants: `docs/architecture.md`
- Work with Core state/transactions: `docs/core-api.md`
- Understand rendering/runtime: `docs/dom-runtime.md`
- Work with contenteditable behavior: `docs/content-editable.md`
- Add a view: `docs/views-spec.md`
- Work with styling: `docs/style-system.md`
