# Architecture

This document is the canonical technical contract for the system. It defines the architecture layers, invariants, and extension rules that keep behavior stable across Core, runtime, and views. Specialized API/runtime/style/view details live in referenced docs.

## Overview

The architecture guarantees predictable focus and selection behavior, stable DOM structure under selection changes, consistent intent routing, and strict ownership boundaries. Interaction is semantic and intent-driven, not raw DOM-keydown-driven. It also enforces layered dependency direction, target ownership, and structural stability so behavior remains deterministic as features evolve.

## Core concepts and definitions

- Item: the primary state unit rendered in the UI tree.
- View: behavior and layout logic used to render an item body and interpret view-level intents.
- Component: reusable UI/runtime building block used inside views or shared DOM runtime utilities.
- State: canonical application data owned by Core.
- Rendering/runtime: DOM integration layer that mounts, updates, and disposes UI safely.
- Layer/boundary: architectural partition (`core/`, `dom/`, `views/`, `main.ts`) with explicit ownership and dependency direction.
- Selection: Core-owned current location in the item tree; source of truth for focus.
- Focus: target-level focus state represented as `(itemId, target)`.
- Target: stable identifier for a focus/edit surface (for example `DEFAULT_TARGET`, `label`, `conn:*`, `value`).
- Frame/header/body: conceptual UI regions per rendered item; frame is the stable anchor, header is stable identity surface, body is view-specific content. This split defines ownership and stability contracts and does not require rigid DOM shape beyond the documented container/region contracts.
- Intent: semantic interaction command parsed from input and routed by Core.

## Layering model

### Layers and ownership

`core/`

- Owns state and transactions.
- Owns selection and programmatic focus application.
- Owns global input parsing (`keydown` to intents).
- Owns global intent handling and routing to active views.

`dom/`

- Owns shared DOM runtime lifecycle (mount/patch/dispose).
- Owns stable dynamic mounting primitives (`ctx.slot`, `ctx.list`).
- Owns shared controls and canonical frame/header binding helpers.
- Enforces runtime-side structural and focus contracts.

`views/`

- Owns view-specific body layout and interaction behavior.
- Owns intent interpretation within view semantics.
- Owns mapping view intent outcomes to Core operations.
- Owns body target binding and body-local controls.

`main.ts`

- Owns app bootstrap and wiring across layers.
- Composes Core, runtime, and registered views.
- Defines root mount and startup lifecycle.

### Allowed dependencies

| Layer | May depend on    |
| ----- | ---------------- |
| core  | (none)           |
| dom   | core             |
| views | core, dom        |
| main  | core, dom, views |

### Outer view vs item view split

Outer view responsibilities:

- Render the stable frame.
- Render shared outer UI including header surfaces.
- Mount the item view body subtree.
- Attach outer-view-owned targets.

Item view responsibilities:

- Render `.ui-body.<view>` as the body root.
- Render view-specific structure and controls.
- Attach body-owned targets only.
- Item views MUST NOT attach header-owned targets (`label`, `conn:*`).

Intent-handling ownership:

- The outer view handles all container-focus intents and all yielded keys from edit focus.
- Item views mount the body field and define its input type. For text fields, this means `yieldNav=true` and boundary yielding. For non-text inputs (such as a slider's range input), the native input behavior applies.
- A view that is only ever used as an item view (like slider) never handles container, label, or conn targets. It only defines behavior for its body-owned targets.

## Invariants (must / must not)

### Sources of truth

- Core MUST be the single source of truth for state.
- Selection MUST be the single source of truth for focus.
- DOM and CSS MUST NOT be treated as authoritative focus/state sources.

### Target-driven focus model

- Focus MUST be represented as `(itemId, target)`.
- The UI MUST be target-driven, not tab-order-driven.
- `.ui-main` MUST be the only tabbable element.
- Targets MUST remain stable across selection changes.

### Ownership rules (frame/header/body)

Shared targets:

- `DEFAULT_TARGET`
- `label`
- `conn:*`
- `value`

- Frame MUST own `DEFAULT_TARGET`.
- Header MUST own `label` and `conn:*`.
- Body MUST own `value` and body-specific targets.
- Body MUST NOT own `label` or `conn:*`.
- Header MUST NOT own `value`.
- A target MUST NOT have multiple owners.

### Structural stability under selection

- Each rendered item MUST map to exactly one stable `.ui-frame`.
- Selection changes MUST be styling-only updates.
- Selection changes MUST NOT remount frames.
- Selection changes MUST NOT rebuild lists.
- Selection changes MUST NOT switch body subtrees.
- The body MUST remain structurally stable across selection changes.
- Conditional mounting MUST use `ctx.slot`.
- Repeated keyed mounting MUST use `ctx.list`.
- Region hosts MUST NOT be manually cleared/replaced.
- Manual child reconciliation in effects SHOULD be avoided.

### Routing and interaction

- Core MUST own the global `keydown` listener (bubble phase).
- Core MUST parse keydown events into intents.
- Core MUST handle global intents first (for example `CANCEL`).
- Core MUST route non-global view intents to the active view handler.
- If Core routes an intent, it MUST call `preventDefault()` on the original DOM event.
- Native editors (`input`, `textarea`, `contenteditable`) SHOULD handle keydown locally by preserving native behavior and calling `stopPropagation()` so the global handler does not receive the event.
- Controls MAY yield keys to Core by not calling `stopPropagation()` in the relevant key/case so the event bubbles to Core.
- When yielding, controls SHOULD call `preventDefault()` when native editor behavior is not the intended behavior.

### Pointer and propagation rules

- Frame `pointerdown` MUST focus `DEFAULT_TARGET` and stop propagation.
- Frame `pointerdown` MUST capture caret when the hit surface is text-editing content.
- Editors/controls MUST focus their own target and stop propagation.

### Universal controls model

This section defines the complete keyboard interaction semantics shared across all views. Views inherit these rules and define only their view-specific geometry, traversal scope, and edge behaviors (see `docs/views-spec.md`).

#### Target classification

Every focusable surface is one of three kinds:

| Kind        | Targets           | `yieldNav` | In edit traversal | Behavior                                               |
| ----------- | ----------------- | ---------- | ----------------- | ------------------------------------------------------ |
| Container   | `DEFAULT_TARGET`  | n/a        | No                | Structural commands: navigate, enter edit, delete, tab |
| Isolated    | `label`           | `false`    | No                | Self-contained text editing                            |
| Traversable | `conn:*`, `value` | `true`     | Yes               | Text editing with boundary yielding                    |

**Container** is the outer shell for structural interaction. **Traversable** targets are for content editing in flow — they yield keys at text boundaries so the outer view can handle traversal and structural actions. **Isolated** targets are for infrequent identity editing — the label field consumes all input locally with two exceptions: Escape bubbles to the Core escape ladder, and Enter commits text and exits to container focus.

#### Edit target list

Every item has an ordered list of traversable edit targets, derived from its mode:

| Item mode           | Edit target list                        |
| ------------------- | --------------------------------------- |
| Connected (formula) | `[conn:expr]`                           |
| Connected (query)   | `[conn:from, conn:where, conn:orderBy]` |
| Plain scalar        | `[value]`                               |
| Readonly or group   | `[]` (empty)                            |

The **primary edit target** is the first entry in this list, or `null` if empty. This determines whether CONFIRM and TYPE from container focus have an edit target to enter.

Readonly items have an empty edit target list. CONFIRM, TYPE, and DELETE from container focus are all no-ops for readonly items.

#### Intent handler ownership

| Target           | Owner  | Handler                                                     |
| ---------------- | ------ | ----------------------------------------------------------- |
| `DEFAULT_TARGET` | Frame  | Outer view                                                  |
| `label`          | Header | Self-contained (no view handling needed)                    |
| `conn:*`         | Header | Field yields at boundaries; outer view handles yielded keys |
| `value`          | Body   | Item view mounts the field; outer view handles yielded keys |

#### Behaviors from container focus

| Intent    | Condition                  | Behavior                                                                                                   |
| --------- | -------------------------- | ---------------------------------------------------------------------------------------------------------- |
| CONFIRM   | Primary target exists      | Enter edit on primary target, caret at end                                                                 |
| CONFIRM   | No primary target          | No-op                                                                                                      |
| TYPE char | Primary target exists      | Enter edit on primary target, select all, insert char                                                      |
| TYPE char | No primary target          | No-op                                                                                                      |
| TYPE `=`  | Item not a non-empty group | Convert to formula, focus `conn:expr` at start                                                             |
| NAV       | Always                     | Move by view navigation geometry, stay at container focus                                                  |
| TAB       | Always                     | View-specific structural action                                                                            |
| DELETE    | Item supports remove       | Remove item, focus next sibling at container; then previous sibling; then parent. If no destination, blur. |
| DELETE    | Item supports clear        | Clear item to blank, stay on same item at container focus                                                  |
| CANCEL    | Always                     | Core escape ladder (blur from container)                                                                   |

TYPE `=` overwrites existing content and converts the item to a formula-connected item. It is blocked only when the item is a non-empty group, since Core's group conversion rule prevents converting non-empty groups.

NAV and TAB are no-ops when the movement would go beyond the edge of the view's geometry (first item, last item, root parent, childless leaf, etc).

Whether DELETE removes or clears an item is determined by the view. Remove applies to items that are structural participants and can come and go. Clear applies to items that are positional slots in a fixed structure. DELETE is a no-op for readonly items.

#### Behaviors from traversable targets

Traversable fields (`conn:*`, `value`) handle text editing locally. Normal typing, cursor movement, and selection are handled by the native input. When the cursor reaches a text boundary and the user presses a navigation or structural key, the field commits any pending changes, calls `preventDefault`, and lets the event bubble. The outer view then handles the yielded key.

**NAV at boundary**: All four arrow directions collapse to **backward** (left, up) or **forward** (right, down) in a one-dimensional edit traversal. Within a multiline field, up and down move between lines normally and only yield on the first or last line.

When a boundary nav yields:

1. **Intra-item**: if there is an adjacent edit target in the item's edit target list, move to it. Backward places caret at end. Forward places caret at start.
2. **Inter-item**: if at the edge of the item's edit targets, behavior is view-specific (see `docs/views-spec.md`).

**Enter**: means "commit and advance one edit stop forward." It follows the same two-step resolution as boundary nav:

1. If there is a next edit target in the item's edit target list, move to it with caret at start.
2. If at the last edit target, behavior is view-specific.

**Tab**: commits and bubbles to the outer view, which performs its standard structural action — the same action as Tab from container focus. The outer view preserves the current target and clamps caret when possible after the structural change.

**Delete at boundary**: Backspace at text start or Delete at text end commits and yields. The outer view decides what to do — behavior is view-specific, default is no-op.

**Escape**: always bubbles to Core. Draft-mode fields cancel the local draft first, then Escape reaches the escape ladder and returns to container focus.

**Live and draft edit models**: Traversable fields use one of two edit models. This affects when Core state updates but does not change controls behavior:

| Model | Used by  | Core updates                           | Enter                | Escape                  |
| ----- | -------- | -------------------------------------- | -------------------- | ----------------------- |
| Live  | `value`  | Every keystroke                        | Advance              | Exit                    |
| Draft | `conn:*` | On commit (Enter, Tab, boundary yield) | Commit, then advance | Cancel draft, then exit |

Draft mode exists because intermediate values of formulas and queries would be invalid. From the user's perspective, all traversable targets behave the same way.

## Runtime boundary (DOM integration)

The runtime is the contract boundary between Core semantics and DOM behavior. It may manage mounting, patching, scheduling, and lifecycle, but must preserve architecture invariants.

Allowed at this boundary:

- Programmatic focus application from selection/target state.
- Stable dynamic region mounting via runtime primitives.
- Shared control behaviors that uphold routing and target contracts.

Forbidden at this boundary:

- Manual reconciliation that bypasses runtime region ownership.
- Replacing/clearing region hosts owned by runtime primitives.
- DOM-driven focus authority that diverges from Core selection.

### Canonical container DOM

```text
#root
  .ui-root
    .ui-main.ui-frame
      .ui-body.<root-view>
```

- `.ui-main` MUST be the root `.ui-frame` for the root item.
- `.ui-main` MUST be the only tabbable element (`tabIndex=0`).
- `.ui-body.<root-view>` MUST be the view root used for active view resolution.

API-level runtime details belong in `docs/dom-runtime.md`.

## Views model

Views are the item-level behavior model layered on Core and runtime.

Responsibilities:

- Define body layout and view-specific composition.
- Interpret routed intents semantically.
- Translate intents into Core operations.
- Bind body-owned targets consistently with ownership rules.

Composition model:

- Outer view renders stable frame/header surfaces and mounts the body root.
- Item view renders `.ui-body.<view>` and owns view-specific body structure.

View resolution/routing model:

- Active view resolves to the nearest containing mounted view root.
- Active view MUST update on pointer interactions.
- Active view MUST update on programmatic focus application.
- Core routes view intents to that active view handler.

View-specific behavior details belong in `docs/views-spec.md`.

## Extension points

### Adding a new view

- MUST preserve outer view vs item view ownership split.
- MUST preserve target ownership and structural stability invariants.
- MUST implement behavior via intents, not ad-hoc raw key routing.

### Adding a new target

- MUST define exactly one owner (frame/header/body).
- MUST remain stable under selection changes.
- MUST not introduce implicit edit entry via navigation.

### Adding a new editor/control

- MUST participate in target-driven focus (not tab order).
- MUST follow pointer propagation rules.
- MUST follow Core routing/yielding behavior.

### Adding a new subsystem/module

- MUST be placed in the correct layer and respect dependency direction.
- MUST use stable layer entrypoints instead of deep cross-layer imports.
- MUST avoid introducing cyclic dependencies.

Decision rules:

- Introduce a new abstraction when it clarifies ownership, reduces cross-layer coupling, or creates a stable reusable contract.
- Reuse existing abstractions when behavior already fits without widening public surface area.
- Promote something to a layer entrypoint only when it is a stable shared contract used across a layer boundary.

## Design rationale

- Target-driven focus prevents focus instability caused by DOM tab-order drift.
- Structural stability rules prevent selection-driven remount churn and identity loss.
- Core-owned intent routing prevents behavior drift across views.
- Runtime lifecycle constraints prevent leaked listeners/effects and orphan DOM state.
- Strict dependency direction prevents cyclic coupling and hidden cross-layer breakage.

## References

- `docs/core-api.md`
- `docs/dom-runtime.md`
- `docs/style-system.md`
- `docs/views-spec.md`
- `CONTRIBUTING.md`
- `AGENTS.md`
