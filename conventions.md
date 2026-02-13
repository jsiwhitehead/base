# Repository Conventions

This document defines **repository-wide conventions** for code and documentation in this repository. It exists to keep the codebase and docs **simple, consistent, predictable, and easy to extend** as the system grows. This is a **meta** guide: it covers naming, structure, organization, and documentation formatting.

## Scope

This document covers:

- Repository structure and module boundaries.
- Naming conventions (types, discriminants, functions, variables).
- Import/export conventions.
- File and symbol organization.
- Documentation conventions (style, structure, formatting).
- Testing conventions (file naming, naming patterns, helper naming).

## Non-goals

This document intentionally does not cover:

- Code formatting (handled by Prettier).
- Runtime behavior or UI semantics (covered by the system docs).
- Contribution workflow / process.
- Styling system design (covered by the UI system docs).

## Repository structure and module boundaries

This repository is organized as a small layered system.

### Layering model

The intended layering is:

- **`core/`**: state model, transactions, view registry, selection/focus state.
- **`dom/`**: UI runtime primitives and reusable UI controls.
- **`views/`**: view-specific behavior (intent interpretation, composition).
- **`main.ts`**: application bootstrap and top-level wiring.

### Dependency rules (imports)

The dependency graph is intentionally one-way:

- `core/` MUST NOT import from `dom/` or `views/`.
- `dom/` MAY import from `core/`.
- `views/` MAY import from `core/` and `dom/`.
- `main.ts` MAY import from all.

If a change requires breaking this, the design should be reconsidered.

### Public vs internal API discipline

This repository treats most modules as **internal implementation** by default.

Public API surfaces SHOULD be:

- Small.
- Stable.
- Intentional.
- Easy to discover.

Conventions:

- Prefer importing via module entrypoints at layer boundaries (for example `dom/index.ts`, `views/index.ts`).
- Avoid importing deep internal files across layers unless that module is explicitly intended to be part of the public surface.
- If an internal module starts being imported widely, consider promoting it into an entrypoint (or moving it into a more appropriate layer).

## Naming conventions (code)

Naming is one of the highest-leverage ways to keep this codebase readable and coherent.

### General rules

- Prefer clear, concrete names over abbreviations.
- Avoid inventing synonyms for established concepts.
- Prefer consistency over cleverness.
- Prefer nouns for values, verbs for functions.
- Prefer `camelCase` for values/functions and `PascalCase` for types.

### Canonical domain terms (“vocabulary lock”)

These terms have specific meanings in this codebase and should remain stable:

- **item**: a Core entity identified by `ItemId`.
- **focus**: `{ container, item }`.
- **selection**: current focus state + active target.
- **target**: named focus surface within an item.
- **caret**: `{ start, end }` selection range in text.
- **intent**: semantic input event (`NAV`, `CONFIRM`, etc.).
- **view**: a mounted UI for an item.

Rules:

- Avoid introducing synonyms for these concepts.
- If a new concept becomes foundational, add it to this list.
- Prefer existing terms even if alternatives feel natural.

When avoiding certain names (like “node”), this applies to **domain terminology** (Core/model concepts), not UI structure or CSS. UI structure may use names like “node” when they are clearly presentation-level.

### Discriminated unions

Discriminated unions SHOULD use a single explicit discriminant field.

This repository uses two common discriminant names, by convention:

- Use **`kind`** for **domain/state** unions (model/state snapshots, persisted-ish entities, value kinds).
- Use **`type`** for **event/protocol** unions (intents/events/messages, command shapes, AST/protocol-like structures).

Rules:

- Do not mix `kind` and `type` within the same union family.
- Prefer stable, explicit string literals.
- Prefer explicit cases over optional fields or boolean flags.

Example style:

```ts
type Thing =
  | { kind: "a"; ... }
  | { kind: "b"; ... };

type Event =
  | { type: "START"; ... }
  | { type: "STOP"; ... };
```

### Type naming

Use consistent suffixes for common type roles:

- `XOpts`: configuration options.
- `XState`: runtime state snapshot.
- `XSpec`: declarative specification for building/binding.
- `XSignals`: grouped reactive values.
- `XMountCtx`: grouped construction context (often view/component building).

Avoid “Manager” unless the type owns lifecycle and disposal.

### Function naming

Use these prefixes consistently:

- `createX(...)`: creates a long-lived object (core, view, component).
- `buildX(...)`: constructs a DOM/component subtree.
- `bindX(...)`: attaches behavior to an existing element.
- `parseX(...)`: parses external representation into internal form.
- `formatX(...)`: formats internal form into external representation.
- `isX(...)`: boolean predicate.
- `toX(...)`: conversion (possibly lossy).

### Variable naming

Use short, consistent nouns for DOM and layout code:

- `root`, `shell`, `host`, `wrap`.
- `row`, `col`, `cell`.

For input elements:

- Prefer `inp` in dense editor/textfield code where brevity helps.
- `input` is acceptable (and often preferred) when it improves clarity, especially when multiple inputs exist.

When mixing DOM elements and components:

- Use `fooEl` suffix for raw `HTMLElement`s when ambiguity exists.
- Use `fooComp` suffix for `Component`s only when needed.

### Constants

- Constants MUST use `SCREAMING_SNAKE_CASE`.
- Strings that form stable protocol values SHOULD be constants rather than ad-hoc literals.

## File and symbol organization

This repository prefers modules with clear responsibilities and predictable shape.

### Coherent modules (not necessarily small)

Files SHOULD have a clear responsibility and coherent scope.

“Small, focused modules” is a preference over time, but the repository may contain intentionally large orchestrator modules (for example: a primary view implementation, a language module, or a core surface module) where the cohesion is high and splitting would harm readability.

A useful rule of thumb:

- Split when it improves clarity, reuse, or testability.
- Do not split purely to reduce line count.

### File responsibility naming

New files SHOULD be named after their responsibility, not their implementation detail.

Guidelines:

- Prefer feature- or concept-named modules over generic buckets (`util.ts`, `helpers.ts`, `misc.ts`).
- If a file name like `base.ts`, `controls.ts`, or `runtime.ts` exists, it SHOULD represent a real shared layer, not a dumping ground.
- Prefer extracting a new module over expanding a generic catch-all module.

### Symbol ordering within files

Within a file, prefer this general order:

1. Imports.
2. Local types.
3. Local constants.
4. Pure helpers.
5. Main exported functions.
6. Remaining exports.

This is not a strict rule, but consistency is preferred.

### Helpers

Helpers should be placed:

- Close to the code that uses them.
- At module scope if reused by multiple functions.
- Inside a function only if truly local.

Avoid “helper drift” where generic helpers remain buried in a single module.

## Import and export conventions

Imports and exports define the shape of the codebase. Keeping them consistent prevents long-term friction.

### Type-only imports

TypeScript type imports SHOULD use `import type`.

Example:

```ts
import type { Core, Focus } from "../core";
```

### Import blocks and ordering

Imports SHOULD be grouped and ordered consistently.

Rules:

- Separate external and internal imports with a single blank line.
- Within each block, sort imports alphabetically by module path.
- Within an import, sort imported names alphabetically.

Example:

```ts
import { computed } from "@preact/signals-core";

import type { Core, Focus } from "../core";
import { createComponent, el } from "../dom";
```

### Prefer named exports

- Prefer named exports everywhere.
- Avoid default exports.

This improves refactoring, searching, and tooling support.

### Avoid re-export wildcards

Avoid `export * from "./x"` in public entrypoints.

Prefer explicit re-exports so that public surfaces remain intentional and stable.

Example:

```ts
export { createComponent } from "./base";
export type { Intent } from "./controls";
```

### Import path conventions

- Prefer importing from stable module entrypoints at layer boundaries.
- Within a folder, direct file imports are acceptable when they improve clarity or avoid circular dependencies.
- Avoid long chains of re-exports that obscure where symbols actually live.

## Documentation conventions

Documentation is treated as part of the system.

Docs should remain small, structured, and consistent.

### Writing style

Docs SHOULD:

- Prefer short sections.
- Prefer bullet lists and tables over long prose.
- Prefer “rules first, rationale second”.
- Use consistent terminology matching the codebase.
- Stay explicit about scope and ownership.

Docs SHOULD NOT:

- Become narrative or tutorial-like unless explicitly intended.
- Duplicate large sections across multiple documents.

### Normative language

Use normative language consistently:

- Use **MUST / MUST NOT** for hard rules and invariants.
- Use **SHOULD** for strong defaults.
- Use **MAY** for optional behavior.

Avoid mixing hard rules and soft advice in the same list without clear grouping.

### Terminology consistency

Docs MUST use the canonical domain terms (item, focus, selection, target, intent, view) consistently.

Avoid introducing synonyms.

### Recommended section ordering

Most docs SHOULD follow this order where applicable:

1. Purpose / scope.
2. Key concepts / definitions (if needed).
3. Rules / invariants.
4. Details / examples.

Not every document needs every section, but the overall flow should be consistent.

### Linking and duplication

To keep docs maintainable:

- Prefer referencing the authoritative document rather than repeating content.
- If a concept is shared across multiple docs, it belongs in the most foundational one.

### Code references in docs

When referencing code:

- Use backticks for symbols (`createComponent`, `Intent`, `DEFAULT_TARGET`).
- Prefer referencing exported symbols rather than internal local variables.
- When referencing a module, use its repo path (`dom/controls`, `views/outline`).

## Markdown formatting (uniform across docs)

The following formatting rules apply to all Markdown documents in this repository.

### Structure

- Each document MUST start with exactly one top-level title (`# ...`).
- The title MUST be followed by a short scope paragraph (1–3 sentences).
- Headings SHOULD be unnumbered.

### Headings

- Use Title Case for the document title (`# ...`).
- Use sentence case for section and subsection headings (`##`, `###`).
- Use `##` and `###` for sections and subsections.
- Avoid going deeper than `###` unless a section truly needs it.

### Separators

- `---` MAY be used to separate major sections when headings alone are not visually sufficient.
- Do not use `---` between routine sections or subsections.
- A document with no `---` is acceptable if heading structure is clear.

### Lists

- Use `-` for unordered lists.
- Use `1.` for ordered lists.

List item style:

- Start bullet text with either sentence case or a backticked symbol/token.
- Keep punctuation consistent within a list level:
  - Sentence-style bullets end with `.`
  - Symbol/name-only bullets (API inventories) omit `.`

- Use `:` on a bullet when it introduces a nested sublist.
  - This `:` introducer is the allowed same-level exception to period uniformity.

Nested lists:

- Nested bullets MUST use the same marker (`-`), indented.

Whitespace:

- Use one blank line before and after each list block.
- Use a lead-in line ending in `:` before a list when the list enumerates that lead-in.

Guidance:

- For behavior/rules lists, prefer full sentence bullets with periods.
- For API/token inventories, prefer terse backticked bullets without periods.

### Label blocks

Label blocks are recommended for grouped lists.

Example:

```text
Rules:
- ...
Notes:
- ...
```

Keep labels short and stable. Common labels include:

- `Rules:`
- `Types:`
- `Notes:`
- `Examples:`

### Code blocks

- All fenced code blocks MUST specify a language.
- Use:
  - `ts` for TypeScript types/signatures/contracts/snippets
  - `text` for trees, DOM shapes, file layouts, and illustrative output
  - `sh` for shell commands

- Keep code fences minimal: show the smallest snippet that conveys the contract.

### Inline code and emphasis

- Use backticks for:
  - Identifiers and API names (`createComponent`, `Intent`)
  - Literal strings and tokens (`DEFAULT_TARGET`)
  - CSS classes (`.ui-item`)
  - File paths (`docs/core-api.md`)

- Use **bold** sparingly, only for critical warnings or hard rules.

### Tables

- Tables are allowed and encouraged for structured comparisons.
- Keep tables simple and scannable.
- Avoid large paragraphs inside table cells.

### Markdown feature usage

Avoid advanced or inconsistent Markdown features unless there is a clear need:

- Avoid raw HTML in Markdown.
- Avoid deeply nested blockquotes.
- Avoid embedding images in core technical docs.

### Links and references

Use the simplest, most standard Markdown link conventions:

- Links are allowed when they improve navigation.
- Prefer plain backticked repo paths for internal references (`docs/ui-system.md`).
- Use Markdown links for external references.

### Whitespace

- One blank line after headings.
- One blank line around lists and code fences.
- No trailing spaces. No tabs.

### Typography

- Prefer ASCII punctuation (`'`, `"`, `--`) in technical docs.
- Typographic punctuation (curly quotes, em dashes) is allowed for prose-heavy sections when used intentionally.
- Avoid mixing punctuation styles within the same section.

### Documentation file naming

- Documentation files SHOULD use `kebab-case.md`.
- Avoid parallel naming styles such as `snake_case.md` or dotted names like `ui.views.md`.

## Testing conventions

Tests are part of the repository’s public contract. Keep them consistent and readable.

### File naming and placement

- Test files SHOULD end in `.test.ts`.
- Shared test helpers SHOULD live under `test/` rather than in `src/`.
- Shared test helpers SHOULD live in a small number of obvious helper modules (for example `test/test-utils.ts`) rather than being duplicated.

### Test naming

Prefer test names that are specific and scannable.

A good default format is:

- `"<module>: <behavior>"`

Examples:

- `"outline: splits value on confirm"`
- `"table: tab wraps to next row"`

### Test helper naming

Prefer small helper functions with verb-oriented names.

Common patterns:

- `mkX` for builders/fixtures.
- `setX` for state setup.
- `expectX` for expectation helpers.
- `requireX` for assertions that should throw/fail if unmet.

Keep helpers narrowly scoped; avoid large “do everything” helpers.
