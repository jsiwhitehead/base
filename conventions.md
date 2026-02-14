# Repository Conventions

This document defines **repository-wide conventions** for code and documentation in this repository. It exists to keep the codebase and docs **simple, consistent, predictable, and easy to extend** as the system grows.

This is a **meta** guide: it covers naming, structure, organization, and documentation formatting. It does not define runtime behavior or UI semantics.

## Scope

This document covers:

- Repository structure and module boundaries.
- Public vs internal API discipline.
- Naming conventions (types, discriminants, functions, variables).
- Import/export conventions.
- File and symbol organization.
- Documentation conventions (style, structure, formatting).
- Testing conventions (file naming, naming patterns, helper naming).

## Non-goals

This document intentionally does not cover:

- Code formatting (handled by Prettier).
- Runtime behavior or UI semantics (covered by the system docs).
- Contribution workflow / process (covered by `AGENTS.md`).
- Styling system design (covered by the UI system docs).

## Design principles

These principles are the intent behind the rules below.

- Prefer local reasoning over global coordination.
- Prefer explicit state and explicit data flow over implicit coupling.
- Prefer clear boundaries and ownership over convenience access.
- Prefer small, stable public surfaces over widespread internal imports.
- Prefer one obvious way to implement common patterns.
- Prefer consistency and predictability over cleverness.
- Prefer stable domain vocabulary over "natural" synonyms.
- Prefer reducing concept count over accumulating special cases.
- Prefer shallow dependency graphs and avoid cycles.

## Language and spelling

- Code and documentation SHOULD use American English spelling.

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

Additional constraints:

- Cyclic dependencies MUST NOT be introduced.
- If a change requires breaking these rules, the design SHOULD be reconsidered.

### Public vs internal API discipline

This repository treats most modules as **internal implementation** by default.

Definitions:

- **Public entrypoints** are the intended import surfaces at layer boundaries.
- **Internal modules** are everything else.

Conventions:

- Cross-layer imports SHOULD go through layer entrypoints.
- Importing internal modules across layers MUST be intentional and SHOULD be avoided.
- If an internal module starts being imported widely, it SHOULD be promoted into an entrypoint or moved into a more appropriate layer.
- Widening exports in an entrypoint SHOULD be treated as a contract change.

Canonical entrypoints:

- Each layer SHOULD provide an `index.ts` entrypoint intended for cross-layer imports.
- Cross-layer imports SHOULD prefer `core`, `dom`, and `views` entrypoints over deep paths.

Notes:

- Additional entrypoints MAY exist, but cross-layer imports SHOULD default to layer entrypoints unless there is a clear reason not to.

## Naming conventions (code)

Naming is one of the highest-leverage ways to keep this codebase readable and coherent.

### General rules

- Prefer clear, concrete names over abbreviations.
- Avoid inventing synonyms for established concepts.
- Prefer consistency over cleverness.
- Prefer nouns for values and verbs for functions.
- Prefer `camelCase` for values/functions and `PascalCase` for types.

### Canonical domain terms ("vocabulary lock")

These terms have specific meanings in this codebase and MUST remain stable:

- **item**: a Core entity identified by `ItemId`.
- **content**: an item's content shape (`value`, `group`, or `issue`).
- **value**: a scalar item payload (or blank) inside `content.type === "value"`.
- **group**: an ordered list of child items inside `content.type === "group"`.
- **issue**: an error-state item inside `content.type === "issue"`.
- **mode**: edit semantics for an item (`readonly`, `plain`, `connected`).
- **connected**: a definition that generates item content (`formula` or `query`).
- **entry**: an internal model entity identified by `EntryId`.
- **scalar**: an internal primitive payload (`true | number | string`) used by model/eval.
- **result**: an internal evaluator output that maps to API content.
- **transaction**: an atomic set of edits committed through `core.commit(...)`.
- **location**: `{ parentId, index, siblings }` returned by `core.locate(...)`.
- **focus**: `{ container, item }`, describing an item in a container context.
- **selection**: the global focus state (`idle` or `focused`) plus active target and optional caret.
- **target**: a named focus surface within a focused item (`label`, `value`, `conn:*`, etc.).
- **caret**: `{ start, end }`, a text selection range for text targets.
- **binding / target binding**: a registered `(focus, target)` -> DOM element mapping (`core.attachTarget(...)`).
- **view name**: a stable identifier for a registered view (for example `"outline"`, `"table"`).
- **view**: a mounted UI body for an item.
- **frame**: the stable outer DOM anchor for an item (`.ui-frame`).
- **header**: the frame sub-UI owning `label` and `conn:*` targets (`.ui-header`).
- **body**: the view-owned subtree root (`.ui-body.<view>`), owning `value`.
- **intent**: a semantic input event routed by Core to the active view (`NAV`, `CONFIRM`, etc.).
- **active view**: the view determined from the focused DOM element for intent routing.

Conventions:

- Avoid introducing synonyms for these concepts.
- If a new concept becomes foundational, add it to this list.
- Prefer existing terms even if alternatives feel natural.

Notes:

- When avoiding certain names (like "node"), this applies to **domain terminology** (Core/model concepts), not UI structure or CSS.
- UI structure may use names like "node" when they are clearly presentation-level.

### Discriminated unions (repo-wide)

Discriminated unions SHOULD use a single explicit discriminant field.

Discriminant key:

- Use **`type`** as the discriminant key for **all** discriminated unions in the repository.

Rules:

- Discriminants MUST be stable explicit string literals.
- Local unions SHOULD use inline discriminant literals (for example `type: "group"`).
- Shared discriminant constants SHOULD be used only for cross-module reuse or external protocol contracts.
- Prefer explicit union cases over optional properties or boolean flags.
- `switch` / `if` chains over discriminated unions MUST be exhaustive in core/domain logic.
- `switch` / `if` chains over discriminated unions SHOULD be exhaustive elsewhere.
- Exhaustive `switch` defaults SHOULD use `return assertNever(value, "Unhandled variant");` with `assertNever(_exhaustive: never, message: string): never`.

Notes:

- This repository uses discriminant casing to communicate category:
  - Domain/state variants typically use lowercase tokens (for example `"text"`, `"table"`).
  - Event/protocol/intents/messages typically use `SCREAMING_SNAKE_CASE` (for example `"NAV"`, `"CONFIRM"`).
- Do not mix casing styles within the same union family.

### Type naming

Use consistent suffixes for common type roles:

- `XOpts`: configuration options.
- `XState`: runtime state snapshot.
- `XSpec`: declarative specification for building/binding.
- `XSignals`: grouped reactive values.
- `XMountCtx`: grouped construction context (often view/component building).

Conventions:

- Avoid "Manager" unless the type owns lifecycle and disposal.
- Avoid "Data" and "Info" as generic suffixes unless they carry clear meaning.

### Inline vs named types

Conventions:

- Use inline structural types for local, obvious, single-use shapes.
- Use named types for reused shapes, exported/public contracts, or domain-significant concepts.
- Promote an inline shape to a named type once it is used in 2 or more places.
- Name types by role/meaning (not just structure), and use established suffixes (`XOpts`, `XState`, `XSpec`, etc.) when applicable.

### Function naming

Use these prefixes consistently:

- `createX(...)`: creates a long-lived object (core, view, component).
- `buildX(...)`: constructs a DOM/component subtree.
- `bindX(...)`: attaches behavior to an existing element.
- `parseX(...)`: parses external representation into internal form.
- `formatX(...)`: formats internal form into external representation.
- `isX(...)`: boolean predicate.
- `toX(...)`: conversion (possibly lossy).

Conventions:

- Avoid boolean parameters in public functions.
- Prefer options objects or separate functions when branching behavior is meaningful.

### Function return types

- Exported functions MUST declare explicit return types.
- Local functions SHOULD use inferred return types unless an annotation improves clarity.
- Use explicit `: void` when no return value is part of the contract (for example handlers and mutators).
- Do not require explicit return types for every local function.

### Variable naming

Use short, consistent nouns in DOM and layout code.

Conventions:

- Prefer names that reflect responsibility (`root`, `host`, `wrap`, `row`, `cell`).
- Use `fooEl` suffix for raw `HTMLElement`s when ambiguity exists.
- Use `fooComp` suffix for `Component`s only when needed.

### Constants

- Constants MUST use `SCREAMING_SNAKE_CASE`.
- For discriminants, prefer inline literals by default; use constants only for cross-module reuse or external protocol contracts.

## File and symbol organization

This repository prefers modules with clear responsibilities and predictable shape.

### Source file naming

This repository has a preferred source file naming convention.

Conventions:

- Source files SHOULD use `kebab-case.ts` (repo convention).
- `index.ts` SHOULD be used only for intentional module entrypoints and small, local re-export hubs.
- Avoid creating re-export chains that obscure where symbols live.

Notes:

- Existing non-conforming files SHOULD NOT be renamed unless already being touched for a task.

### Coherent modules (not necessarily small)

Files SHOULD have a clear responsibility and coherent scope.

"Small, focused modules" is a preference over time, but the repository may contain intentionally large orchestrator modules (for example: a primary view implementation, a language module, or a core surface module) where the cohesion is high and splitting would harm readability.

Guidance:

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

Guidance:

- Avoid "helper drift" where generic helpers remain buried in a single module.
- Avoid extracting helpers that are used only once unless it improves readability.

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

- Separate external and internal imports with a single blank line.
- Within each block, sort imports alphabetically by module path.
- Within an import, sort imported names alphabetically.

Example:

```ts
import { computed } from "@preact/signals-core";

import type { Core, Focus } from "../core";
import { createComponent, el } from "../dom";
```

### Import path conventions

- Prefer importing from stable module entrypoints at layer boundaries.
- Within a folder, direct file imports are acceptable when they improve clarity or avoid circular dependencies.
- Avoid deep relative imports across layers.

Notes:

- If a symbol is needed across many modules, prefer promoting it into an entrypoint rather than importing deep paths.

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

## State and effects conventions (structural)

This section defines structural conventions only. Runtime semantics are defined in the system docs.

- Side effects SHOULD be isolated to boundary modules (DOM wiring, storage, bootstrap).
- Core logic SHOULD prefer pure functions and explicit inputs/outputs.
- Mutations SHOULD be scoped to explicit transaction-like APIs where available.

## Documentation conventions

Documentation is treated as part of the system.

Docs should remain small, structured, and consistent.

### Writing style

Docs SHOULD:

- Prefer short sections.
- Prefer bullet lists and tables over long prose.
- Prefer "rules first, rationale second".
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
- Documents SHOULD assume canonical terminology from `conventions.md` and avoid repeating full glossary/terminology sections.

### Code references in docs

When referencing code:

- Use backticks for symbols (`createComponent`, `Intent`, `DEFAULT_TARGET`).
- Prefer referencing exported symbols rather than internal local variables.
- When referencing a module, use its repo path (`dom/controls`, `views/outline`).

### Documentation update triggers

If a change modifies a contract, the authoritative documentation MUST be updated in the same change.

Documentation MUST remain consistent with code behavior and public API surfaces.

## Markdown formatting (uniform across docs)

The following formatting rules apply to all Markdown documents in this repository.

### Structure

- Each document MUST start with exactly one top-level title (`# ...`).
- The title MUST be followed by a short scope paragraph (1-3 sentences).
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
  - Sentence-style bullets SHOULD end with `.`
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

Avoid advanced or inconsistent Markdown features unless there is a clear need.

- Avoid raw HTML in Markdown.
- Avoid deeply nested blockquotes.
- Avoid embedding images in core technical docs.

### Links and references

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

Tests are part of the repository's public contract. Keep them consistent and readable.

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

Guidance:

- Keep helpers narrowly scoped.
- Avoid large "do everything" helpers.
