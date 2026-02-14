# UI Contracts

This document defines the **system-level UI contracts** layered on Core.

It is the authoritative reference for:

- Canonical UI architecture and DOM conventions.
- Ownership boundaries (outer view vs item view).
- Target ownership and focus surfaces.
- Structural stability rules (selection-driven rendering constraints).
- Focus, routing, and pointer contracts.
- Universal interaction semantics (intent-level).
- Cross-view visual language invariants.

This document does **not** define:

- The UI runtime API (`dom/`). See `docs/ui-runtime.md`.
- View-specific behavior. See `docs/ui-views.md`.
- Core types and semantics. See `docs/core-api.md`.

## System principles (non-negotiables)

Rules:

- Core MUST be the single source of truth for state.
- Selection MUST be the single source of truth for focus.
- The UI MUST be target-driven, not tab-order-driven.
- UI structure MUST be stable across selection changes.
- Interaction SHOULD be semantic (intent-driven), not raw DOM-key-driven.

## Canonical UI architecture

### App container DOM

Canonical app frame (debug panel omitted):

```text
#root
  .ui-root
    .ui-main.ui-frame                           (tabIndex=0; only tabbable element; root item target: DEFAULT_TARGET)
      [.ui-body.<root-view> subtree]            (mounted root view body)
```

Rules:

- `.ui-main` MUST be the only tabbable element.
- All other focus changes MUST be programmatic via Core targets.

Notes:

- `.ui-main` and the root `.ui-frame` MAY be the same element.
- `.ui-body.<root-view>` is the view root used for active view resolution.

### Outer view vs item view (layer split)

Rendering is split across two cooperating layers:

**Outer view responsibilities:**

- Render the stable `.ui-frame`.
- Render rail UI.
- Render header UI (label + connected definition fields).
- Mount the body subtree for the item view.
- Attach outer-view-owned targets.

**Item view responsibilities:**

- Render `.ui-body.<view>` as the body root.
- Render view-specific structure and controls.
- Interpret intents and translate them into Core operations.
- Attach body-owned targets.

Rules:

- Views MUST respect this ownership split.
- View code MUST NOT mix header-owned and body-owned targets.

## Canonical DOM contracts

### Frame (`.ui-frame`)

The frame element is the stable DOM anchor for an item.

Rules:

- Each rendered item MUST have exactly one `.ui-frame`.
- `.ui-frame` MUST remain stable across selection changes.
- Selection-driven effects MUST NOT replace, remount, or reorder `.ui-frame` elements.
- Universal item state classes MUST apply to `.ui-frame`.
- `.ui-frame` SHOULD set a stable `data-id` attribute.

### Header (`.ui-header`)

The header is stable, view-agnostic UI rendered by the outer view.

Header responsibilities:

- Render the item label UI.
- Render connected definition fields when the item is in connected mode.
- Attach header-owned targets.

Header-owned targets:

- `label`
- `conn:*`

Rules:

- The header MUST use `.ui-header`.
- The header MUST NOT attach the `value` target.
- Label editing MUST keep yielding disabled.

Canonical header DOM contract:

```text
.ui-header
  .ui-header-label
    [.ui-textfield subtree]                    (target: label)
  .ui-header-conn
    .ui-header-conn-row                        (repeated)
      .ui-header-conn-key
      .ui-header-conn-val
        [.ui-textfield subtree]                (target: conn:<fieldKey>)
```

Rules:

- This structure is the canonical system-level shape for header chrome.
- Views MAY style or conditionally mount parts of the header.
- Target ownership and row semantics MUST remain consistent.

### Body (`.ui-body.<view>`)

The body is view-specific UI rendered by the item view.

Body responsibilities:

- Render the `.ui-body.<view-name>` root element.
- Render view-specific structure and controls.
- Render composed children.
- Attach body-owned targets.

Body-owned targets:

- `value`.
- Future body-specific targets.

Rules:

- The body MUST NOT attach `label` or `conn:*`.
- The body MUST remain structurally stable across selection changes.

## Target ownership contract

Rules:

- `.ui-frame` MUST own `DEFAULT_TARGET`.
- Header MUST own `label` and `conn:<fieldKey>`.
- Body MUST own `value` and any future body-specific targets.
- Body MUST NOT attach `label` or `conn:*`.
- Header MUST NOT attach `value`.

## Editability and mode

Core defines item modes and editability.

Rules:

- `readonly` MUST be treated as a hard stop for editing.
- `plain` versus `connected` MUST determine available edit targets:
  - `value` for plain
  - `conn:*` for connected

- Mode conversion MAY occur but SHOULD be explicit.

## Structural stability rules (selection + rendering)

The UI must remain stable while selection changes.

Rules:

- Selection changes MUST NOT remount frames.
- Selection changes MUST NOT rebuild lists.
- Selection changes MUST NOT switch body subtrees.
- Selection-driven updates MUST be styling-only (class toggles).

Dynamic mounting rules:

- Conditional subtree mounting MUST use runtime regions (`ctx.slot`).
- Repeated keyed subtree mounting MUST use runtime regions (`ctx.list`).
- Hosts that contain regions MUST NOT be manually cleared or replaced.
- Manual child reconciliation in effects SHOULD be avoided.

## Focus, routing, and pointer contracts

### Global keyboard routing (Core-driven)

Rules:

- Core MUST own the global `keydown` listener.
- Core MUST parse key events into intents.
- Core MUST route view intents to the active view handler.
- If Core routes an intent, it MUST consume/prevent the original DOM key event.

Notes:

- Native editors (`input`, `textarea`, `contenteditable`) SHOULD process local edits first.
- Core MAY still handle explicit global commands while focus is in native editors.

### Active view resolution

Rules:

- Active view MUST be derived from the element focused via target binding (`getEl()`), not pointer event targets.
- Active view MUST resolve to the closest mounted view root containing that element.

### Programmatic focus

Rules:

- Focus targets MUST be applied programmatically from Core selection.
- Inputs MUST NOT participate in browser tab-order traversal.
- `.ui-main` MUST be the only tabbable element.

### Pointer routing

Frame pointerdown:

Rules:

- `.ui-frame` MUST focus `DEFAULT_TARGET`.
- Frames MUST capture caret when pointerdown hits text-editing surfaces.
- Frame handling MUST stop propagation.

Editor/control pointerdown:

Rules:

- Editors and controls MUST focus their own target.
- Editor/control handling MUST stop propagation.

Notes:

- `bindItemFrame` in `ui-runtime.md` is the canonical implementation for frames.

## Universal interaction semantics (intent-level)

These rules are shared across views. Views MAY refine them, but MUST remain consistent with them.

### Escape ladder (`CANCEL`)

Rules:

- `CANCEL` SHOULD call `escapeLadder(core)`.
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
2. otherwise `value` when plain scalar
3. otherwise none

### Confirm-to-edit from `DEFAULT_TARGET`

Rules:

- When focused on `DEFAULT_TARGET`, `CONFIRM` SHOULD:
  - enter the primary edit target if one exists
  - otherwise run the view's structural default action

### Navigation invariant

Rules:

- `NAV` MUST NOT implicitly enter edit mode.

### Yielding policy (system-level)

Rules:

- Value and connected editors SHOULD enable yielding where appropriate.
- Label editors MUST keep yielding disabled.
- Yielding MUST be semantic (intent-level), not dependent on bubbling raw DOM key events.

(Shared editor behavior is defined in `ui-runtime.md`.)

## Cross-view visual language

This section defines the shared visual language. Views MUST compose within it.

### Visual foundations (tokens)

Rules:

- Global design tokens SHOULD be defined in `:root`.
- Views SHOULD consume token values rather than hardcode raw values.

Token categories:

- Typography.
- Geometry.
- Colors.

### Two visual layers

**Frame layer:**

- Outer-view-owned.
- Contains rail and optional header.
- MUST express focus and issue state.
- MUST NOT depend on body internals.

**Body layer:**

- Item-view-owned.
- Contains `.ui-body.<view-name>`.
- SHOULD remain neutral by default.
- MUST NOT redefine shared rail/header language.

### Universal state classes

State classes:

- `.is-focused`
- `.is-issue`

Rules:

- State classes MUST apply on `.ui-frame`.
- Frame state MUST use one priority stack: issue overrides focus.
- Focus indication SHOULD be rail-tint based.
- Path context SHOULD be local and subtle.
- Siblings MUST NOT inherit another item's state styling.

### Rail and header state derivation

Rules:

- `.ui-frame` MUST define item state via `.is-focused` and `.is-issue`.
- Rail MUST consume `--rail-tint`.
- Header MUST consume `--header-fill`.
- `.is-issue` MUST override `.is-focused` for both rail and header derived values.

### Rail language

Rules:

- Rail MUST be the primary structural marker.
- Each item MUST have one rail segment at its depth.
- Rail state MUST be local to each item segment.
- Rail MUST NOT behave like card borders.
- Rail MUST be segmented per frame and MUST NOT bleed vertically across sibling frame boundaries.
- Rail segments SHOULD be square-ended by default.
- Rounded rail ends SHOULD be used only at contiguous run boundaries.
- Selection overlays (for example a pill effect) MUST be local to the frame segment and MUST NOT alter sibling segment geometry.
- Rail hit targets MAY be wider than the visible rail strip to preserve pointer usability without changing visible geometry.

### Styling boundaries and invariants

Rules:

- Rail/header styling MUST NOT rely on body internals.
- Body styling MUST NOT restyle rail/header primitives.
- Selection-driven visual changes SHOULD be class toggles only.
- View-specific state classes SHOULD be added only for new semantics.
- CSS values SHOULD be token-driven.
- In shrinkable flex/grid layouts, text overflow handling SHOULD be applied on text elements with `min-width: 0` on shrinkable containers.

### Recommended CSS structure

Layer order:

1. Reset.
2. Tokens (`:root`).
3. Base primitives (`.ui-frame`, `.ui-body`, `.ui-textfield`).
4. Components (`.ui-header`).
5. Views (layout/composition only).

## View authoring checklist

Rules:

- Views MUST use the shared runtime primitives:
  - targets (`ctx.target`)
  - regions (`ctx.slot`, `ctx.list`)
  - shared controls (`buildTextField`, `buildItemHeader`)

- Views MUST attach targets through `ctx.target(...)`.
- Views MUST respect frame/header versus body target ownership.
- Every rendered item MUST expose `DEFAULT_TARGET`.
- Frames SHOULD use shared frame behavior (for example `bindItemFrame`) to keep pointer, focus, and state-class behavior consistent.
- Selection changes MUST NOT remount frames.
- Selection changes MUST NOT rebuild lists.
- Selection changes MUST NOT switch body subtrees.
- Views SHOULD avoid direct raw `keydown` handling for behavior semantics.
- Views SHOULD implement behavior by interpreting intents.

## Rationale (brief)

This UI contract avoids common editor failure modes:

- Focus instability.
- Inconsistent keyboard behavior.
- Selection-driven remount churn.
- Leaked listeners/effects.
- Styling drift across views.

It stays robust by keeping a small set of contracts strict, and making view-specific behavior explicit in `docs/ui-views.md`.
