# UI Architecture & Contracts

This document defines the **system-level UI contracts** layered on Core.

It is the authoritative reference for:

- The cross-cutting UI model (selection, focus, targets).
- Ownership boundaries between Core, the UI runtime, and views.
- Structural stability rules (selection-driven rendering constraints).
- Focus, routing, and pointer contracts.
- Universal interaction semantics (intent-level).
- Editability and target exposure rules.

This document does **not** define:

- Core types and semantics. See `docs/core-api.md`.
- The UI runtime API (`dom/`). See `docs/dom-runtime.md`.
- The visual language, tokens, and styling invariants. See `docs/style-system.md`.
- View-specific behavior. See `docs/views-spec.md`.


## Golden rules (non-negotiables)

These rules are strict. The system depends on them.

### Sources of truth

- Core MUST be the single source of truth for state.
- Selection MUST be the single source of truth for focus.

Meaning:

- The DOM is not authoritative.
- CSS MUST NOT treat `:focus` / `:focus-visible` as authoritative.

### Target-driven UI model

- The UI MUST be target-driven, not tab-order-driven.
- Focus is defined by `(itemId, target)`.

### Structural stability under selection

- UI structure MUST be stable across selection changes.
- Selection-driven updates MUST be styling-only (class toggles), not structural.

### Semantic interaction

- Interaction SHOULD be semantic (intent-driven), not raw DOM-key-driven.


## System model (core concepts)

### Items and views

- The UI renders a tree of items.
- Each item is rendered through a view.
- Views are responsible for layout and interpreting intents into Core operations.

View-specific behavior is defined in `docs/views-spec.md`.

### UI regions per item (conceptual)

Each rendered item is conceptually split into three regions:

- **Frame**: stable DOM anchor for the item.
- **Header**: stable, view-agnostic identity surface (label + connected fields).
- **Body**: view-specific content surface.

This is a conceptual split that defines ownership and stability rules. It does not require a specific DOM structure beyond the minimal contracts below.

### Targets

Targets are the system's canonical focus surfaces.

- Targets are stable identifiers.
- Core uses targets for:
  - programmatic focus
  - intent routing
  - edit traversal and focus continuity


## Ownership boundaries

### Layer responsibilities

Core:

Core owns:

- selection state
- focus application (via selection -> targets)
- global keyboard routing:
  - parse `keydown` into intents
  - handle global intents
  - route view intents to the active view handler

Core semantics are defined in `docs/core-api.md`.

UI runtime (`dom/`):

The runtime provides:

- safe mounting and disposal
- stable dynamic mounting primitives (`ctx.slot`, `ctx.list`)
- shared controls (text fields, header builder)
- canonical frame binding behavior

Runtime behavior is defined in `docs/dom-runtime.md`.

Views:

Views own:

- view-level layout and composition
- the body subtree (`.ui-body.<view>`)
- body-local controls
- view intent interpretation (within the global invariants)

View behavior is defined in `docs/views-spec.md`.


### Outer view vs item view (layer split)

Rendering is split across two cooperating layers.

Outer view responsibilities:

- Render the stable frame.
- Render rail UI.
- Render header UI (label + connected definition fields).
- Mount the body subtree for the item view.
- Attach outer-view-owned targets.

Item view responsibilities:

- Render the body root (`.ui-body.<view>`).
- Render view-specific structure and controls.
- Interpret intents and translate them into Core operations.
- Attach body-owned targets.

Rules:

- Views MUST respect this ownership split.
- View code MUST NOT mix header-owned and body-owned targets.


## Target ownership contract (hard rules)

Target ownership is the central system contract.

### Target taxonomy

The system defines these shared targets:

- `DEFAULT_TARGET`
- `label`
- `conn:*`
- `value`

### Ownership matrix

- The frame MUST own `DEFAULT_TARGET`.
- The header MUST own:
  - `label`
  - `conn:<fieldKey>`

- The body MUST own:
  - `value`
  - any future body-specific targets

### Mutual exclusions

- The body MUST NOT attach `label` or `conn:*`.
- The header MUST NOT attach `value`.
- A target MUST NOT have multiple owners.


## Structural contracts (stability and composition)

### Frame stability

The frame element is the stable DOM anchor for an item.

Rules:

- Each rendered item MUST have exactly one frame.
- The frame MUST remain stable across selection changes.
- Selection-driven effects MUST NOT replace, remount, or reorder frames.

Notes:

- Runtime provides canonical frame behavior via `bindItemFrame(...)`.

### Header stability and purpose

The header is stable, view-agnostic UI rendered by the outer view.

Rules:

- Header MUST NOT attach the `value` target.
- Header-owned targets MUST remain consistent (`label`, `conn:*`).

Notes:

- The canonical header DOM/control implementation is provided by the runtime (`buildItemHeader`).

### Body ownership and allowed dynamism

The body is view-specific UI rendered by the item view.

Rules:

- The body MUST NOT attach `label` or `conn:*`.
- The body MUST remain structurally stable across selection changes.


### Structural stability rules (selection + rendering)

The UI must remain stable while selection changes.

Rules:

- Selection changes MUST NOT remount frames.
- Selection changes MUST NOT rebuild lists.
- Selection changes MUST NOT switch body subtrees.
- Selection-driven updates MUST be styling-only (class toggles).

Dynamic mounting rules:

When structure must be conditional or keyed, it MUST use runtime regions.

Rules:

- Conditional subtree mounting MUST use runtime regions (`ctx.slot`).
- Repeated keyed subtree mounting MUST use runtime regions (`ctx.list`).
- Hosts that contain regions MUST NOT be manually cleared or replaced.
- Manual child reconciliation in effects SHOULD be avoided.


## Interaction and routing contracts

### Core-driven keyboard routing (global)

Rules:

- Core MUST own the global `keydown` listener.
- Core MUST parse key events into intents.
- Core MUST handle global commands (notably `CANCEL`) before view routing.
- Core MUST route non-global view intents to the active view handler.
- If Core routes an intent, it MUST prevent the original DOM key event.

Notes:

- Native editors (`input`, `textarea`, `contenteditable`) SHOULD handle keydown locally unless the event is `defaultPrevented`.
- Controls MAY yield keys by calling `preventDefault()`; yielded keys are then routed by Core.

### Active view resolution

Rules:

- Active view MUST resolve to the closest mounted view root containing the event/focus target.
- Active view MUST update to the nearest containing view root on both:
  - pointer interactions
  - programmatic focus application

### Programmatic focus

Rules:

- Focus is defined by `(itemId, target)`.
- Focus targets MUST be applied programmatically from Core selection.
- Inputs MUST NOT participate in browser tab-order traversal.
- `.ui-main` MUST be the only tabbable element.

### App container DOM (canonical)

Canonical structure:

```text
#root
  .ui-root
    .ui-main.ui-frame                           (tabIndex=0; only tabbable element; root item target: DEFAULT_TARGET)
      [.ui-body.<root-view> subtree]            (mounted root view body)
```

Rules:

- `.ui-main` is the only tabbable element.
- `.ui-main` is the root `.ui-frame` for the root item.
- `.ui-body.<root-view>` is the view root used for active view resolution.

### Pointer routing

Frame pointerdown:

Rules:

- The frame MUST focus `DEFAULT_TARGET`.
- Frames MUST capture caret when pointerdown hits text-editing surfaces.
- Frame handling MUST stop propagation.

Editor/control pointerdown:

Rules:

- Editors and controls MUST focus their own target.
- Editor/control handling MUST stop propagation.

Notes:

- `bindItemFrame` in `dom-runtime.md` is the canonical implementation for frames.

### Yielding contract (system-level)

Yielding is a cross-cutting contract between editors/controls and Core routing.

Rules:

- Value and connected editors SHOULD enable yielding where appropriate.
- Label editors MAY also yield when view behavior requires it.
- Yielding MUST be implemented via editor-side `preventDefault()` plus Core global routing.

Notes:

- Shared editor behavior is defined in `docs/dom-runtime.md`.


## Universal semantics (cross-view behaviors)

These rules are shared across views.

Views MAY refine them, but MUST remain consistent with them.

### Escape ladder (`CANCEL`)

Rules:

- `CANCEL` MUST be handled by Core dispatch.
- If focused on a non-default target, it exits to `DEFAULT_TARGET`.
- Otherwise it blurs.

### Type-to-edit from `DEFAULT_TARGET`

Rules:

- When focused on `DEFAULT_TARGET`, `TYPE` SHOULD:
  - enter the primary edit target
  - select all
  - insert the typed character using `insertTextIntoActiveEditor(...)`

Primary edit target order:

1. first connected definition field (`conn:*`) when connected
2. otherwise `value` when plain scalar and editable
3. otherwise none

### Confirm-to-edit from `DEFAULT_TARGET`

Rules:

- When focused on `DEFAULT_TARGET`, `CONFIRM` SHOULD:
  - enter the primary edit target if one exists
  - otherwise run the view's structural default action

### Navigation invariant

Rules:

- `NAV` MUST NOT implicitly enter edit mode.


## Editability and target exposure policy

Core defines item modes and editability.

This section defines how the UI must interpret them.

### Read-only behavior

Rules:

- `readonly` MUST be treated as a hard stop for editing.

Meaning:

- The UI must not allow entering edit targets for readonly items.
- This prevents "read-only edit focus" states.

### Mode determines available edit targets

Rules:

- `plain` versus `connected` MUST determine available edit targets:
  - `value` for plain
  - `conn:*` for connected

### Target exposure rules (readonly + derived output)

Rules:

- `readonly` items MUST expose only `DEFAULT_TARGET` and MUST NOT expose any edit targets.
- Items whose body is derived/output-only MUST NOT expose body edit targets (for example `value`).
- If a derived/output-only body renders a tree, all rendered descendants MUST be treated as `readonly`.

### Mode conversion policy

Rules:

- Mode conversion MAY occur but SHOULD be explicit.


## Extension rules (how to add new things safely)

This section defines what is safe to extend, and what must remain invariant.

### Adding a new view

A new view:

- MUST obey:
  - the outer view vs item view split
  - the target ownership contract
  - the structural stability rules
  - the global routing model
  - the universal semantics

- SHOULD:
  - interpret intents rather than raw DOM key events

### Adding a new target

A new target:

- MUST have a single owner.
- MUST fit the header/body ownership model.
- MUST remain stable across selection changes.
- MUST not introduce implicit edit entry via navigation.

### Adding a new editor/control

An editor/control:

- MUST attach focus via targets (not tab order).
- MUST follow pointer propagation rules (stop propagation).
- MUST obey the yielding contract.
- MUST remain consistent with the escape ladder.


## Compliance checklist (quick validation)

Use this list to validate new views, new editors, and refactors.

### Focus model

- Selection is the single source of truth for focus.
- Focus is expressed as `(itemId, target)`.
- `.ui-main` is the only tabbable element.

### Ownership

- Outer view owns frame + header.
- Item view owns body subtree.
- Frame owns `DEFAULT_TARGET`.
- Header owns `label` and `conn:*`.
- Body owns `value`.

### Stability

- Selection changes do not remount frames.
- Selection changes do not rebuild lists.
- Selection changes do not switch body subtrees.
- Dynamic mounting uses `ctx.slot` / `ctx.list`.

### Routing

- Core owns global `keydown` parsing and intent routing.
- If Core routes an intent, it prevents the DOM event.
- Frames focus `DEFAULT_TARGET` on pointerdown and stop propagation.
- Editors focus their own targets on pointerdown and stop propagation.

### Universal semantics

- `CANCEL` follows the escape ladder.
- Type-to-edit works from `DEFAULT_TARGET`.
- Confirm-to-edit works from `DEFAULT_TARGET`.
- `NAV` never implicitly enters edit mode.

### Editability

- `readonly` is a hard stop for editing.
- Mode determines edit target availability (`plain`->`value`, `connected`->`conn:*`).


## Rationale (brief)

This UI contract avoids common editor failure modes:

- Focus instability.
- Inconsistent keyboard behavior.
- Selection-driven remount churn.
- Leaked listeners/effects.
- Behavior drift across views.

It stays robust by keeping a small set of contracts strict, and making view-specific behavior explicit in `docs/views-spec.md`.
