# UI System

This document defines the UI system contract layered on Core: shared UI structure, runtime mounting model, selection/targets integration, interaction semantics, and cross-view visual invariants. It is intentionally view-agnostic. View-specific behavior belongs in `docs/ui-views.md`. Core API contracts belong in `docs/core-api.md`.

## Scope

This document covers:

- Shared UI architecture and ownership boundaries.
- Runtime mounting and reactivity contracts.
- Shared interaction and editing semantics.
- Cross-view styling and rails/header invariants.

This document does not cover:

- View-specific keymaps and behaviors.
- Core API semantics.
- Styling details that are purely local to one view.

## Core principles

Rules:

- Core MUST be the source of truth.
- Selection MUST be the single focus truth.
- Frame structure MUST remain stable while body content MAY swap.
- Interaction SHOULD be semantic (intent-driven), not DOM-event-driven.
- Tab handling MUST be an app command, not browser tab-order navigation.

## Summary of invariants

Structure and ownership:

- Each rendered item MUST map to exactly one `.ui-frame`.
- The frame element MUST own `DEFAULT_TARGET`.
- The header MUST own `label` and `conn:*`.
- The body MUST own `value`.
- `.ui-frame` identity MUST remain stable across selection changes.
- Selection-driven updates MUST be styling-only.

Focus and interaction:

- The app MUST expose one tabbable element: `.ui-app-main`.
- `Tab`/`Shift+Tab` MUST be app commands.
- Core MUST route `TAB` intents to the active view handler.
- Interaction SHOULD be intent-driven.
- Label editing SHOULD remain pointer-only and MUST NOT yield navigation intents.

Mounting and reactivity:

- Dynamic subtrees MUST mount through `ctx.slot` and `ctx.list`.
- Hosts with regions MUST NOT be manually cleared or replaced.

Visual language:

- Item state MUST be expressed through `.is-focused` and `.is-issue`.
- Rails and header visuals MUST derive from state-driven tokens (`--rails-tint`, `--header-fill`).
- Rails MUST remain segmented and local; sibling state bleed is disallowed.

## UI architecture

### App container DOM

Canonical app frame (debug panel omitted):

```text
#root
  .ui-app
    .ui-app-main                                (tabIndex=0; only tabbable element)
      .ui-frame                                 (root item frame; target: DEFAULT_TARGET)
        [.ui-body.<root-view> subtree]          (mounted root view body)
```

Rules:

- `.ui-app-main` MUST be the only tabbable element.
- All other focus changes MUST be programmatic via Core targets.

Notes:

- The root `.ui-app` wrapper is optional but recommended as a stable styling boundary.
- `.ui-body.<root-view>` is the view root for routing and intent handling.

## Mental model: rails, header, body

Each item is expressed with three structural parts:

- **rails**: structure marker ("where am I?")
- **header**: identity + definition UI ("what is this?" / "what drives it?")
- **body**: view-specific content ("what does it contain / do?")

Rendering is split across two cooperating views:

- The **outer view** renders the stable `.ui-frame` plus rails + header, and mounts the body.
- The **item view** renders the body as a `.ui-body.<view-name>` subtree and interprets intents.

The `.ui-body.<view-name>` element is the boundary used to determine the **active view** for keyboard routing.

## Frame element (`.ui-frame`)

The frame element is the stable DOM anchor for an item.

Rules:

- Each rendered item MUST have exactly one `.ui-frame`.
- `.ui-frame` MUST remain stable across selection changes.
- Selection-driven effects MUST NOT replace, remount, or reorder `.ui-frame` elements.
- Universal item state classes MUST apply to `.ui-frame`.
- `.ui-frame` SHOULD set a stable `data-id` attribute (recommended).

Implementation note:

- Shared frame behavior SHOULD be implemented via a helper (for example `bindUiFrame(ctx, { core, focus }, frameEl)`), to keep pointer/selection/state logic consistent across views.

## Header and body ownership

### Header

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
- Header MAY be mounted/unmounted by the outer view, but ownership rules remain fixed.

### Body

The body is view-specific UI rendered by the item view.

Body responsibilities:

- Render the `.ui-body.<view-name>` root element.
- Render view-specific structure and controls.
- Render composed children.
- Attach body-owned targets.

Body-owned targets:

- `value`
- future body-specific targets

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
- `plain` versus `connected` MUST determine available edit targets (`value` versus `conn:*`).
- Mode conversion MAY occur but SHOULD be explicit.

UI terminology:

- **connected definition**: the Core `Connected` value (formula/query/etc.).
- **definition fields**: the header controls that edit the connected definition.

## Runtime model

### Component model

```ts
type Component = { el: HTMLElement; dispose(): void };
```

Creation rule:

- Components SHOULD be created with `createComponent(core, (ctx) => HTMLElement)`.

Teardown guarantees:

- `ctx.on` listeners MUST be cleaned up.
- `ctx.effect` reactions MUST be cleaned up.
- `ctx.target` bindings MUST be cleaned up.
- Mounted child components and reactive regions MUST be disposed.

## Ctx API

`createComponent` provides the minimal safe mounting API.

Contracts:

- `ctx.on`: register DOM listeners with automatic cleanup.
- `ctx.effect`: register reactive effects with rerun/dispose cleanup.
- `ctx.target`: bind Core target focus surfaces to DOM elements.
- `ctx.mount`: mount a static child component once.
- `ctx.slot`: mount zero/one reactive child subtree.
- `ctx.list`: mount keyed reactive child lists.

Rules:

- Views SHOULD use `ctx.on` instead of raw `addEventListener`.
- Views MUST use `ctx.target(...)` for DOM-to-Core focus integration.
- Structural mounting and reconciliation MUST use `ctx.slot` / `ctx.list`, not ad-hoc child management.

## Regions and insertion stability

`ctx.slot` and `ctx.list` provide region-based mounting.

Rules:

- Regions MUST preserve DOM order relative to static siblings and other regions.
- Region updates MUST dispose removed children.
- Once a region exists in a host, callers MUST NOT clear or replace host children manually (for example `replaceChildren`, `innerHTML = ""`).

`ctx.slot(host, getComponent)`:

- MUST mount zero or one component in a stable region.
- MUST dispose previous child before mounting replacement.
- SHOULD be used for conditional header/body switching.

`ctx.list(host, getIds, mountById)`:

- MUST reconcile by key.
- MUST preserve order exactly as returned by `getIds()`.
- SHOULD be used for repeated UI structures (for example rows, children, schema-driven lists).

## Reactivity and stability rules

Rules:

- Selection-driven effects SHOULD only toggle classes, datasets, or caret/editor state.
- Selection-driven effects MUST NOT remount frames, bodies, or lists.
- Structural swaps SHOULD be gated by stable discriminators (for example `"group" | "value"`, or a view name).
- One region SHOULD own one responsibility (`slot` for one conditional surface, `list` for one keyed sequence).

## Programmatic focus

Rules:

- Focus targets MUST be applied programmatically from Core selection.
- Inputs MAY receive focus for caret and text behavior.
- Inputs MUST NOT participate in browser tab-order traversal.

## Intent model

Shared intent vocabulary:

- `NAV { dir, mode }`
- `TAB { shift }`
- `CONFIRM { caret? }`
- `CANCEL`
- `TYPE { char }`
- `DELETE { dir }`
- `DELETE_BOUNDARY { dir }`

Rules:

- Views MUST interpret intents.
- Controls SHOULD emit intents.

## Keyboard routing

Global routing rules:

- Core MUST own the global `keydown` listener.
- Core MUST parse key events into intents.
- Core MUST route view intents to the active view handler.
- Core MAY handle explicit global commands while text editors are focused.

Editor yielding rules:

- Text editors MAY yield semantic intents when yielding is enabled.
- Yielding applies to `conn:*` and `value`, not `label`.
- Yielding SHOULD be semantic (intent emission), not key-event bubbling.

## Pointer routing

Frame pointerdown:

- `.ui-frame` SHOULD focus `DEFAULT_TARGET`.
- Frames SHOULD capture caret when pointerdown hits text-editing surfaces.
- Frame handling SHOULD stop propagation.

Editor/control pointerdown:

- Editors and controls SHOULD focus their own target.
- Editors SHOULD use caret-from-target logic for caret placement.
- Editor/control handling SHOULD stop propagation.

## Shared text editing control

The shared text editor control is `buildTextField`.

Capabilities:

- Multiline mode (`input` or `textarea`).
- Autosize mode (`autosize: true`) via mirror sizing.
- Edit models: `live` and `draft`.
- Optional yielding (`yieldNav`).

Canonical DOM:

```text
.ui-textfield
  .ui-textfield-mirror                          (optional; aria-hidden="true")
  input.ui-textfield-input | textarea.ui-textfield-input
```

Autosize rules:

- Mirror MUST drive size while remaining visually hidden.
- Input and mirror SHOULD receive matched padding.
- Autosize controls SHOULD opt out of global `width: 100%` defaults when needed.

Integration rules:

- `buildTextField` instances MUST attach targets with `ctx.target(...)`.
- Editors MUST respect readonly behavior.
- Editors SHOULD rely on frame issue state (`.ui-frame.is-issue`).

## Editor commit models

`live` model:

- Commits on every `input`.
- Does not maintain local draft state.
- `CANCEL` does not revert.

`draft` model:

- Maintains local draft while focused.
- Commits on `CONFIRM`, `TAB`, yielded `NAV`, and `blur`.
- Cancels on `CANCEL`.
- Resets to committed state when focus leaves.

## Multiline Enter behavior

Rules:

- In multiline editors, `Enter` SHOULD map to `CONFIRM` by default.
- `Ctrl+Enter` or `Meta+Enter` SHOULD insert a newline.

## Universal interaction rules

Escape ladder:

- If focused on a non-default target, Core SHOULD focus `DEFAULT_TARGET`.
- Otherwise, Core SHOULD blur selection.

Typing from `DEFAULT_TARGET`:

- `TYPE` SHOULD enter the first item edit target when available.
- Entering by `TYPE` SHOULD select all and insert the typed character.

Confirm from `DEFAULT_TARGET`:

- `CONFIRM` SHOULD enter first item edit target when available.
- If no edit target exists, `CONFIRM` SHOULD run the view structural default.

Navigation rule:

- Navigation MUST NOT implicitly enter edit mode.

Tab routing context:

- Outer-focused targets MUST route `TAB` to the outer view.
- Inner-focused targets MUST route `TAB` to the item view.

## Visual language invariants

### Visual foundations

Rules:

- Global design tokens SHOULD be defined in `:root`.
- Views SHOULD consume token values rather than hardcode raw values.

Token categories:

- Typography.
- Geometry.
- Colors.

## Two visual layers

Frame layer:

- Outer-view-owned.
- Contains rails and optional header.
- MUST express focus and issue state.
- MUST NOT depend on body internals.

Body layer:

- Item-view-owned.
- Contains the `.ui-body.<view-name>` subtree.
- SHOULD remain neutral by default.
- MUST NOT redefine shared rails/header language.

## Universal state classes

State classes:

- `.is-focused`
- `.is-issue`

Rules:

- State classes MUST apply on `.ui-frame`.
- Frame state MUST use one priority stack: issue overrides focus.
- Focus indication SHOULD be rails-tint based.
- Path context SHOULD be local and subtle.
- Siblings MUST NOT inherit another item's state styling.

## Rails and header state derivation

Rules:

- `.ui-frame` MUST define item state via `.is-focused` and `.is-issue`.
- Rails MUST consume `--rails-tint`.
- Header MUST consume `--header-fill`.
- `.is-issue` MUST override `.is-focused` for both rails and header derived values.

## Rails language

Rules:

- Rails MUST be the primary structural marker.
- Each item MUST have one rail segment at its depth.
- Rail state MUST be local to each item segment.
- Rails MUST NOT behave like card borders.

## Styling boundaries and invariants

Rules:

- Rails/header styling MUST NOT rely on body internals.
- Body styling MUST NOT restyle rails/header primitives.
- Selection-driven visual changes SHOULD be class toggles only.
- View-specific state classes SHOULD be added only for new semantics.
- CSS values SHOULD be token-driven.
- In shrinkable flex/grid layouts, text overflow handling SHOULD be applied on text elements with `min-width: 0` on shrinkable containers.

## Recommended CSS structure

Layer order:

1. Reset.
2. Tokens (`:root`).
3. Base primitives (`.ui-frame`, `.ui-body`, `.ui-textfield`).
4. Components (`.ui-header`).
5. Views (layout/composition only).

## Shared view authoring conventions

### Targets and focus surfaces

Rules:

- Views MUST attach targets through `ctx.target(...)`.
- Views MUST respect frame/header versus body target ownership.
- Every rendered item MUST expose `DEFAULT_TARGET`.

### Standard frame behavior

Rules:

- Frames SHOULD use shared frame behavior (for example `bindUiFrame`).
- Frames SHOULD keep pointer, selection, and state-class behavior consistent.

### Selection-driven performance

Rules:

- Selection changes MUST NOT remount frames.
- Selection changes MUST NOT rebuild lists.
- Selection changes MUST NOT switch body subtrees.

### Dynamic subtree mounting

Rules:

- Conditional subtree mounting MUST use `ctx.slot`.
- Repeated keyed subtree mounting MUST use `ctx.list`.
- Manual child reconciliation in effects SHOULD be avoided.

### Shared intent usage

Rules:

- Views SHOULD avoid direct raw `keydown` handling for behavior semantics.
- Views SHOULD implement behavior by interpreting shared intents.

### Shared text control usage

Rules:

- Text editing SHOULD use `buildTextField`.
- Value and connected editors SHOULD enable yielding where appropriate.
- Label editors SHOULD keep yielding disabled.

## Rationale

This system avoids common editor failure modes: focus instability, inconsistent keyboard behavior, leaked effects/listeners, and styling drift. It remains robust by keeping a small set of contracts strict and view-local behavior explicit.
