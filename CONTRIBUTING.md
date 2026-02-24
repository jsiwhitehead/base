# Contributing

This guide explains how to contribute effectively to this repository: workflow, review expectations, house style, and practical change patterns. `CONTRIBUTING.md` owns contributor workflow/conventions, `AGENTS.md` provides agent-specific guardrails, and architecture invariants plus technical must/must-not contracts are defined in `docs/architecture.md`.

## Principles for changes

- Keep changes small, scoped, and reversible.
- Prefer local reasoning, explicit data flow, and clear ownership boundaries.
- Reuse existing abstractions before adding new ones.
- Treat docs as part of the change when behavior or contracts shift.
- Use `docs/architecture.md` as the canonical contract for invariants.

### Scope and tidy policy

- Tidy passes are allowed (formatting, ordering, sorting).
- Apply tidy rules when touching a file.
- Avoid large repo-wide reordering unless the change is intentionally a tidy-only PR.
- Avoid renaming or moving files unless required for the change.

## Development workflow

- Start from a focused task and avoid mixing unrelated refactors.
- Place code by ownership:
  - core semantics/state/transactions: `src/core/`
  - shared DOM/runtime/controls: `src/dom/`
  - view behavior/layout: `src/views/`
  - shared app composition/setup: `src/setup.ts`
  - bootstrap/demo wiring: `src/main.ts`
  - tests/helpers: `test/`
- Run local validation from repo root:

```sh
bun run typecheck
bun test
bun run format
```

- Add tests when behavior changes are regression-prone or non-trivial.
- For pull requests:
  - Keep diffs reviewable.
  - Describe what changed and which invariants might be impacted.
  - Include screenshots for visible UI changes.

## Review standards (definition of done)

Before requesting review:

- Validation commands pass.
- No architecture violations against `docs/architecture.md`.
- Conventions in this file are followed.
- Relevant docs are updated if contracts/behavior changed.
- Diff is scoped to the task and easy to review.

PR checklist:

- What changed in one sentence?
- Which invariants were touched (if any)?
- Which docs were updated?
- Which validation commands were run?

## Conventions (house style)

- Spelling: use American English in code and documentation.
- Naming: keep domain vocabulary stable; avoid synonyms for core concepts.
- Constants MUST use `SCREAMING_SNAKE_CASE`.
- Types:
  - discriminated unions MUST use `type` as discriminant; keep variant casing consistent within a union family
  - switch/if chains over discriminated unions MUST be exhaustive in core/domain logic
  - elsewhere, exhaustive handling SHOULD be preferred
  - exhaustive defaults SHOULD use `assertNever(...)`
  - use inline structural types for local, obvious, single-use shapes
  - use named types for reused shapes (2+ use sites), exported/public contracts, or domain-significant concepts
  - promote an inline shape to a named type once it is used in 2 or more places
  - name types by role/meaning (not just structure) and prefer established suffixes (for example `XOpts`, `XState`, `XSpec`)
  - avoid exporting anonymous inline object types; prefer named exported types
- Imports:
  - use `import type` for type-only imports
  - prefer layer entrypoints across boundaries
  - avoid deep cross-layer imports when a stable entrypoint exists
  - group external imports, then one blank line, then internal imports
  - sort imports by module path alphabetically within each group
  - sort imported names alphabetically
- Exports:
  - prefer named exports
  - avoid default exports
  - avoid wildcard re-exports in public surfaces
  - avoid `export *` in public entrypoints; prefer explicit re-exports
- Files:
  - prefer `kebab-case.ts`
  - use `index.ts` for intentional entrypoints only
  - name files by responsibility, not implementation detail
  - avoid generic buckets such as `utils.ts`, `helpers.ts`, `misc.ts` unless already established
  - avoid re-export chains that obscure symbol ownership
- In-file ordering:
  - imports
  - local types
  - local constants
  - pure helpers
  - main exported functions
  - remaining exports
- Functions:
  - exported functions MUST declare explicit return types
  - prefer the prefix vocabulary: `createX`, `buildX`, `bindX`, `parseX`, `formatX`, `isX`, `toX`
  - avoid boolean parameters in public functions; prefer options objects or separate functions
- Testing:
  - tests live in `test/` and use the `.test.ts` suffix
  - prefer small, focused tests and avoid duplicated helpers
  - test names SHOULD follow `"<area>: <behaviour>"`
  - shared test helpers SHOULD live in `test/`, not `src/`
  - prefer a small number of obvious helper modules (for example `test/core-test-utils.ts` and `test/dom-test-utils.ts`)
  - helper naming patterns: `mkX`, `setX`, `expectX`, `requireX`
- Docs:
  - keep sections short and scannable
  - link to authoritative docs instead of duplicating specs
  - if something is a technical must/must-not contract, it belongs in `docs/architecture.md`; `CONTRIBUTING.md` should link, not restate

## Public surfaces and entrypoints

- Layer `index.ts` files are treated as public entrypoints.
- Cross-layer imports SHOULD prefer entrypoints.
- Deep cross-layer imports SHOULD be avoided unless intentional.
- If an internal module becomes widely imported, it SHOULD be promoted into an entrypoint or moved.
- Widening exports in an entrypoint SHOULD be treated as a contract change.

## Canonical vocabulary

Canonical domain terms (do not invent synonyms):

- entry, label, view, shape
- connected, formula, query
- item, content, mode
- group, value, issue
- parent, child, sibling, location
- intent, selection, focus, container, target, caret
- frame, header, body

## Common change patterns (how-tos)

### Add a new view

- Change locations: `src/views/`, `src/setup.ts` for shared registration/composition, and possibly `src/main.ts` for demo/bootstrap-only wiring.
- Check contracts: `docs/architecture.md`, `docs/views-spec.md`.
- Update docs: `docs/views-spec.md` if behavior changes.
- Validate: run typecheck, tests, format.

### Add a new component or control

- Change locations: shared controls/runtime in `src/dom/`, view-local UI in `src/views/`.
- Check contracts: `docs/architecture.md`, `docs/dom-runtime.md`.
- Update docs: `docs/dom-runtime.md` if shared behavior/contracts changed.
- Validate: run typecheck, tests, format.

### Add or modify styling

- Change locations: style tokens/patterns and related view code.
- Check contracts: `docs/architecture.md`, `docs/style-system.md`.
- Update docs: `docs/style-system.md` when style contracts/tokens change.
- Validate: run typecheck, tests, format.

### Extend Core APIs safely

- Change locations: `src/core/` and boundary call sites.
- Check contracts: `docs/architecture.md`, `docs/core-api.md`.
- Update docs: `docs/core-api.md` for API/semantic changes.
- Validate: run typecheck, tests, format.

## Pitfalls / anti-patterns

- Breaking layer boundaries with deep imports instead of stable entrypoints (`docs/architecture.md`).
- Implementing behavior in ad-hoc raw DOM `keydown` handlers (`docs/architecture.md`).
- Causing selection-driven remounts or structural churn (`docs/architecture.md`).
- Copy/pasting view logic and letting behavior drift across views (`docs/views-spec.md`, `docs/architecture.md`).
- Adding targets without clear ownership mapping (`docs/architecture.md`).
- Expanding public entrypoints casually and increasing surface-area churn (`docs/architecture.md`).

## Appendix: Markdown formatting details

### Markdown structure and style

- Exactly one `#` title per document.
- Title followed by a 1-3 sentence scope paragraph.
- Document title MUST be Title Case.
- Section and subsection headings MUST be sentence case.
- Use unnumbered headings.
- Avoid headings deeper than `###`.
- Prefer short sections and lists.
- Prefer rules-first, rationale-second ordering.
- Use normative language consistently: MUST/MUST NOT, SHOULD, MAY.
- Code fences MUST specify language.

### Separators

- `---` MAY separate major sections when headings alone are not enough.
- Do not use `---` between routine sections.

### Label blocks

- Prefer label blocks for grouped lists.
- Common labels: `Rules:`, `Notes:`, `Examples:`, `Types:`.

### Inline code

Use backticks for:

- symbols (for example `createComponent`)
- literal tokens (for example `DEFAULT_TARGET`)
- CSS classes (for example `.ui-frame`)
- file paths (for example `docs/core-api.md`)

### Code fence language mapping

- `ts` for TypeScript.
- `text` for trees, DOM shapes, and layouts.
- `sh` for commands.

### Lists and punctuation

- Use `-` for unordered lists and `1.` for ordered lists.
- Keep punctuation consistent within a list level.
- Sentence-style bullets SHOULD end with `.`.
- Inventory bullets (symbols/tokens) omit `.`.
- Use `:` when introducing a nested list.
- Use one blank line around lists and code fences.

### Tables

- Tables are allowed and encouraged for structured comparisons.
- Keep tables simple and avoid large paragraphs inside cells.

### Markdown feature usage

- Avoid raw HTML.
- Avoid deeply nested blockquotes.
- Avoid embedding images in core technical docs.

### Links and references

- Prefer backticked repo paths for internal references.
- Use Markdown links for external references.

### Whitespace and typography

- One blank line after headings.
- One blank line around lists and code fences.
- No trailing spaces. No tabs.
- Prefer ASCII punctuation in technical docs (`'`, `"`, `--`).
- Typographic punctuation is allowed for prose-heavy sections if used consistently.
- Avoid mixing punctuation styles within a section.
