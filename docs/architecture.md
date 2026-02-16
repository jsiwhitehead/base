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
- Interpret routed intents and translate them into Core operations.
- Attach body-owned targets only.
- Item views MUST NOT attach header-owned targets (`label`, `conn:*`).

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

### Universal semantics (cross-view)

- `CANCEL` MUST be handled by Core dispatch.
- `CANCEL` MUST follow the escape ladder: non-default target to `DEFAULT_TARGET`, then blur.
- `TYPE` from `DEFAULT_TARGET` SHOULD enter the primary edit target and insert typed text via `insertTextIntoActiveEditor(...)` (defined in `docs/dom-runtime.md`).
- `CONFIRM` from `DEFAULT_TARGET` SHOULD enter the primary edit target, else run structural default action.
- `NAV` MUST NOT implicitly enter edit mode.

Primary edit target order:

1. First `conn:*` field when connected and editable.
2. Otherwise `value` when plain scalar and editable.
3. Otherwise none.

### Editability and target exposure

- `readonly` MUST be a hard stop for editing.
- Mode MUST determine edit targets: `plain` to `value`, `connected` to `conn:*`.
- `readonly` items MUST expose only `DEFAULT_TARGET`.
- Derived/output-only bodies MUST NOT expose body edit targets.

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
