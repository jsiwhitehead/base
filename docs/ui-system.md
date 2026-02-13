# UI System

This document defines the UI system contract layered on Core: shared architecture, runtime model, interaction semantics, visual language, and cross-view invariants. It is intentionally view-agnostic. View-specific behavior belongs in `docs/ui-views.md`, and Core API contracts belong in `docs/core-api.md`.

## Scope

This document covers:

- Shared UI architecture and ownership boundaries.
- Runtime mounting and reactivity contracts.
- Shared interaction and editing semantics.
- Cross-view styling and chrome invariants.

This document does not cover:

- View-specific keymaps and behaviors.
- Core API semantics.
- Styling details that are purely local to one view.

## Core principles

Rules:

- Core MUST be the source of truth.
- Selection MUST be the single focus truth.
- Item shell structure MUST remain stable while body content MAY swap.
- Interaction SHOULD be semantic (intent-driven), not DOM-event-driven.
- Tab handling MUST be an app command, not browser tab-order navigation.

## Summary of invariants

Structure and ownership:

- One item presentation MUST map to exactly one `.ui-item` shell.
- Shell/meta MUST own `DEFAULT_TARGET`, `label`, and `conn:*`.
- Body MUST own `value`.
- `.ui-item` identity MUST remain stable across selection changes.
- Selection-driven updates MUST be styling-only.

Focus and interaction:

- The app MUST expose one tabbable element: `.ui-shell-main`.
- `Tab`/`Shift+Tab` MUST be app commands.
- Core MUST route `TAB` intents to the active view handler.
- Interaction SHOULD be intent-driven.
- Label editing SHOULD remain pointer-only and MUST NOT yield navigation intents.

Mounting and reactivity:

- Dynamic subtrees MUST mount through `ctx.slot` and `ctx.list`.
- Hosts with regions MUST NOT be manually cleared or replaced.

Visual language:

- Chrome state MUST be expressed through `.is-focused` and `.is-issue`.
- Chrome fill MUST derive from one value (`--chrome-color`).
- Rails MUST remain segmented and local; sibling state bleed is disallowed.

## UI architecture

### App frame and shell DOM

Canonical app frame (debug panel omitted):

```text
#root
  .ui-shell
    .ui-shell-main                              (tabIndex=0; only tabbable element)
      .ui-app.ui-item                           (root item shell; target: DEFAULT_TARGET)
        [.ui-body.<root-view> subtree]          (mounted root view body)
```

Rules:

- `.ui-shell-main` MUST be the only tabbable element.
- All other focus changes MUST be programmatic via Core targets.

### Two-layer model: shell and body

Every item presentation uses two layers.

Shell responsibilities:

- Represent exactly one item presentation.
- Add `.ui-item`.
- Set a stable `data-id` (recommended).
- Be programmatically focusable.
- Attach `DEFAULT_TARGET`.
- Handle pointer selection.
- Apply selection-driven state classes.
- Render chrome (rails and optional meta).

Implementation note:

- Shared shell behavior SHOULD be implemented via `bindUiItemShell(ctx, { core, focus }, shellEl)`.

Body responsibilities:

- Render `.ui-body` (or an equivalent body-stamped root).
- Render view-specific structure and controls.
- Render composed children.
- Attach body-owned targets.

Mounting rule:

- View bodies SHOULD mount through `core.mountView({ id, focus, view: core.view(id) })`.

### Meta ownership

Meta is item chrome owned by parent/context and is not view-specific.

Meta targets:

- `label`.
- `conn:*`.

Rendering policy:

- Parent/context MAY mount or unmount meta.
- Remounting meta SHOULD initialize editors from committed state.

Canonical meta structure:

```text
.ui-meta
  .ui-meta-label
    [.ui-textfield subtree]                     (target: label)
  .ui-meta-conn
    .ui-meta-conn-row                           (repeated)
      .ui-meta-conn-key
      .ui-meta-conn-val
        [.ui-textfield subtree]                 (target: conn:<fieldKey>)
```

### Target ownership contract

Rules:

- Shell/meta MUST own `DEFAULT_TARGET`, `label`, and `conn:<fieldKey>`.
- Body MUST own `value` and future body-specific targets.
- Body MUST NOT attach `label` or `conn:*`.
- Shell/meta MUST NOT attach `value`.

### Editability and mode

Rules:

- `readonly` MUST be treated as a hard stop for editing.
- `plain` versus `connected` MUST determine available edit targets (`value` versus `conn:*`).
- Mode conversion MAY occur but SHOULD be explicit.

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

### Ctx API

`createComponent` provides the minimal safe mounting API.

Contracts:

- `ctx.on`: register DOM listeners with automatic cleanup.
- `ctx.effect`: register reactive effects with rerun/dispose cleanup.
- `ctx.target`: bind Core target focus surfaces to DOM elements.
- `ctx.mount`: mount a static child component once.
- `ctx.slot`: mount zero/one reactive child subtree.
- `ctx.list`: mount keyed reactive child lists.

`ctx.on(el, type, handler, opts?)`:

- Views SHOULD use this instead of raw `addEventListener`.

`ctx.effect(run)`:

- `run` MAY return a cleanup function.
- Effects SHOULD produce idempotent DOM updates.

`ctx.target(focus, target, getEl, opts?)`:

- MUST be used for DOM-to-Core focus integration.

`ctx.mount(host, child)`:

- MUST append `child.el`.
- MUST dispose child when parent disposes.

### Regions and insertion stability

`ctx.slot` and `ctx.list` provide region-based mounting.

Rules:

- Regions MUST preserve DOM order relative to static siblings and other regions.
- Region updates MUST dispose removed children.
- Once a region exists in a host, callers MUST NOT clear or replace host children manually (for example `replaceChildren`, `innerHTML = ""`).

`ctx.slot(host, getComponent)`:

- MUST mount zero or one component in a stable region.
- MUST dispose previous child before mounting replacement.
- SHOULD be used for conditional chrome and body switching.

`ctx.list(host, getIds, mountById)`:

- MUST reconcile by key.
- MUST preserve order exactly as returned by `getIds()`.
- SHOULD be used for repeated UI structures (for example rows, children, schema-driven lists).

### Reactivity and stability rules

Rules:

- Selection-driven effects SHOULD only toggle classes, datasets, or caret/editor state.
- Selection-driven effects MUST NOT remount shells, bodies, or lists.
- Structural swaps SHOULD be gated by stable discriminators (for example `"group" | "value"`, or a view name).
- One region SHOULD own one responsibility (`slot` for one conditional surface, `list` for one keyed sequence).

### DOM helper conventions

Helper inventory:

- `el(tag, className?, text?)`
- `setData(el, key, value)`
- `caretFromTarget(eventTarget)`

Rule:

- Structural mounting and reconciliation MUST use `ctx.slot`/`ctx.list`, not ad-hoc child management.

## Interaction and editing system

### Programmatic focus

Rules:

- Focus targets MUST be applied programmatically from Core selection.
- Inputs MAY receive focus for caret and text behavior.
- Inputs MUST NOT participate in browser tab-order traversal.

### Intent model

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

### Keyboard routing

Global routing rules:

- Core MUST own the global `keydown` listener.
- Core MUST parse key events into intents.
- Core MUST route view intents to the active view handler.
- Core MAY handle explicit global commands while text editors are focused.

Editor yielding rules:

- Text editors MAY yield semantic intents when `yieldNav` and `onIntent` are enabled.
- Yielding applies to `conn:*` and `value`, not `label`.
- Yielding SHOULD be semantic (intent emission), not key-event bubbling.

### Pointer routing

Shell pointerdown:

- `.ui-item` shells SHOULD focus `DEFAULT_TARGET`.
- Shells SHOULD capture caret when pointerdown hits text-editing surfaces.
- Shell handling SHOULD stop propagation.

Editor pointerdown:

- Editors SHOULD focus their own target.
- Editors SHOULD use `caretFromTarget(e.target)` for caret placement.
- Editor handling SHOULD stop propagation.

### Text editing control

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
- Editors SHOULD rely on shell issue state (`.ui-item.is-issue`).

### Editor commit models

`live` model:

- Commits on every `input`.
- Does not maintain local draft state.
- `CANCEL` does not revert.

`draft` model:

- Maintains local draft while focused.
- Commits on `CONFIRM`, `TAB`, yielded `NAV`, and `blur`.
- Cancels on `CANCEL`.
- Resets to committed state when focus leaves.

### Multiline Enter behavior

Rules:

- In multiline editors, `Enter` SHOULD map to `CONFIRM` by default.
- `Ctrl+Enter` or `Meta+Enter` SHOULD insert a newline.

### Universal interaction rules

Escape ladder:

- If focused on non-default target, Core SHOULD focus `DEFAULT_TARGET`.
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

- Outer focused targets SHOULD route `TAB` to parent/context view.
- Inner focused targets SHOULD route `TAB` to child/owned view.

## Shared chrome and visual language

### Visual foundations

Rules:

- Global design tokens SHOULD be defined in `:root`.
- Views SHOULD consume token values rather than hardcode raw values.

Token categories:

- Typography.
- Geometry.
- Colors.

### Two visual layers

Chrome layer:

- Context-owned.
- Contains rails and optional `.ui-meta`.
- MUST express focus and issue state.
- MUST NOT depend on body internals.

Content layer:

- View-owned `.ui-body` subtree.
- SHOULD remain neutral by default.
- MUST NOT redefine universal chrome language.

### Universal state classes

State classes:

- `.is-focused`
- `.is-issue`

Rules:

- State classes MUST apply on `.ui-item` shells.
- Chrome MUST use one priority stack: issue overrides focus.
- Focus indication SHOULD be chrome-fill based.
- Path context SHOULD be local and subtle.
- Siblings MUST NOT inherit another item's state styling.

### Chrome fill derivation

Rules:

- `.ui-item` MUST derive shared chrome fill from `--chrome-color`.
- `.is-focused` and `.is-issue` MUST override that value.
- Rails and meta MUST consume derived value, not raw state tokens.

### Rails language

Rules:

- Rails MUST be the primary structural marker.
- Each item MUST have one rail segment at its depth.
- Rail state MUST be local to each item segment.
- Rails MUST NOT behave like card borders.

### Styling boundaries and invariants

Rules:

- Chrome styling MUST NOT rely on body internals.
- Body styling MUST NOT restyle chrome primitives (`.ui-meta`, rails).
- Selection-driven visual changes SHOULD be class toggles only.
- View-specific state classes SHOULD be added only for new semantics.
- CSS values SHOULD be token-driven.
- In shrinkable flex/grid layouts, text overflow handling SHOULD be applied on text elements with `min-width: 0` on shrinkable containers.

### Recommended CSS structure

Layer order:

1. Reset.
2. Tokens (`:root`).
3. Base primitives (`.ui-item`, `.ui-body`, `.ui-textfield`).
4. Components (`.ui-meta`).
5. Views (layout/composition only).

## Shared view authoring conventions

### Targets and focus surfaces

Rules:

- Views MUST attach targets through `ctx.target(...)`.
- Views MUST respect shell/meta versus body target ownership.
- Every presented item MUST expose `DEFAULT_TARGET`.

### Standard shell behavior

Rules:

- Item shells SHOULD use shared shell behavior (`bindUiItemShell`).
- Shells SHOULD keep pointer, selection, and state-class behavior consistent.

### Selection-driven performance

Rules:

- Selection changes MUST NOT remount shells.
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

### Checklist for adding a new view

Structure:

- [ ] Root is `.ui-body.<view-name>`.
- [ ] Each presented item has one stable `.ui-item` shell.
- [ ] Shell behavior uses `bindUiItemShell`.
- [ ] Target ownership is respected.

Mounting:

- [ ] Conditional subtree uses `ctx.slot`.
- [ ] Repeated keyed subtree uses `ctx.list`.
- [ ] Region hosts are not manually cleared.

Interaction:

- [ ] View documents intent handling for `NAV`, `TAB`, `CONFIRM`, `TYPE`, `DELETE`, `CANCEL`, and `DELETE_BOUNDARY`.
- [ ] Text editors use `buildTextField` and semantic yielding.

Styling:

- [ ] Uses shared tokens.
- [ ] Uses `.is-focused` and `.is-issue` for shared state.
- [ ] Keeps view CSS layout-focused without redefining shared chrome.

### Rationale

This system avoids common editor failure modes: focus instability, inconsistent keyboard behavior, leaked effects/listeners, and styling drift. It remains robust by keeping a small set of contracts strict and view-local behavior explicit.
