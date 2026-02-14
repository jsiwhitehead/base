# UI System

This document defines the UI system contract layered on Core.

It is the authoritative reference for:

- The shared UI runtime (`dom/`)
- Shared DOM structure and ownership boundaries
- Target integration and focus surfaces
- Shared interaction semantics (intents, text editing, escape ladder)
- Cross-view visual invariants (frame/header/body + state tokens)

View-specific behavior belongs in `docs/ui-views.md`.
Core API contracts belong in `docs/core-api.md`.

## Scope

This document covers:

- Shared UI architecture and DOM ownership boundaries.
- The shared DOM runtime API (the `dom/` folder).
- Component mounting and cleanup guarantees.
- Shared interaction semantics and intent vocabulary.
- Cross-view structural and styling invariants.

This document does not cover:

- View-specific keymaps, traversal rules, or commands.
- Core API semantics and data invariants.
- View-local styling.

## Rules summary

Rules:

- Core MUST be the single source of truth for state.
- Selection MUST be the single source of truth for focus.
- The UI MUST be target-driven, not tab-order-driven.
- The frame structure MUST remain stable while the body content MAY swap.
- Interaction SHOULD be semantic (intent-driven), not DOM-event-driven.
- Selection-driven updates MUST be styling-only.

## Summary of invariants

### Structure and ownership

- Each rendered item MUST map to exactly one `.ui-frame`.
- The frame element MUST own `DEFAULT_TARGET`.
- The header MUST own `label` and `conn:*`.
- The body MUST own `value`.
- `.ui-frame` identity MUST remain stable across selection changes.
- Selection-driven updates MUST be styling-only.

### Focus and interaction

- The app MUST expose one tabbable element: `.ui-main`.
- `Tab` and `Shift+Tab` MUST be app commands, not browser navigation.
- Core MUST route intents to the active view handler.
- Label editing MUST remain pointer-only and MUST NOT yield navigation intents.

### Mounting and reactivity

- Dynamic subtrees MUST mount through `ctx.slot` and `ctx.list`.
- Hosts that contain regions MUST NOT be manually cleared or replaced.

### Visual language

- Item state MUST be expressed through `.is-focused` and `.is-issue`.
- Rail and header visuals MUST derive from state-driven tokens (`--rail-tint`, `--header-fill`).
- Rail MUST remain segmented and local; sibling state bleed is disallowed.

## UI architecture

### App container DOM

Canonical app frame (debug panel omitted):

```text
#root
  .ui-root
    .ui-main.ui-frame                           (tabIndex=0; only tabbable element; root item frame target: DEFAULT_TARGET)
      [.ui-body.<root-view> subtree]            (mounted root view body)
```

Rules:

- `.ui-main` MUST be the only tabbable element.
- All other focus changes MUST be programmatic via Core targets.

Notes:

- `.ui-main` and the root `.ui-frame` MAY be the same element.
- `.ui-body.<root-view>` is the view root for routing and intent handling.

## Mental model: rail, header, body

Each item is expressed with three structural parts:

- **rail**: structure marker ("where am I?")
- **header**: identity + definition UI ("what is this?" / "what drives it?")
- **body**: view-specific content ("what does it contain / do?")

Rendering is split across two cooperating layers:

- The **outer view** renders the stable `.ui-frame` plus rail + header, and mounts the body.
- The **item view** renders the body as a `.ui-body.<view-name>` subtree and interprets intents.

The `.ui-body.<view-name>` element is the boundary used to determine the **active view** for keyboard routing.

## Frame element (`.ui-frame`)

The frame element is the stable DOM anchor for an item.

Rules:

- Each rendered item MUST have exactly one `.ui-frame`.
- `.ui-frame` MUST remain stable across selection changes.
- Selection-driven effects MUST NOT replace, remount, or reorder `.ui-frame` elements.
- Universal item state classes MUST apply to `.ui-frame`.
- `.ui-frame` SHOULD set a stable `data-id` attribute.

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
- Views MAY style or conditionally mount parts of the header, but target ownership and row semantics MUST remain consistent.

### Body

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
- `plain` versus `connected` MUST determine available edit targets (`value` versus `conn:*`).
- Mode conversion MAY occur but SHOULD be explicit.

UI terminology:

- **connected definition**: the Core `Connected` value.
- **definition fields**: the header controls that edit the connected definition.

## UI runtime model (`dom/`)

The `dom/` folder defines the shared UI runtime. It is view-agnostic.

It provides:

- A minimal component model.
- A safe mounting context (`Ctx`).
- Region-based dynamic mounting (`slot`, `list`).
- Target integration helpers.
- Shared controls (`buildTextField`, `buildItemHeader`).
- Intent parsing helpers.

### Component model

```ts
type Component = { el: HTMLElement; dispose(): void };
```

Rules:

- A component MUST expose one root element (`el`).
- A component MUST release all resources on `dispose()`.
- A disposed component MUST leave no component-owned DOM nodes mounted.

### `createComponent(core, build)`

`createComponent` is the canonical way to build UI components.

Signature:

```ts
createComponent(core: Core, build: (ctx: Ctx) => HTMLElement): Component
```

Rules:

- `build(ctx)` MUST be called exactly once.
- The returned `HTMLElement` MUST be the component root.
- `dispose()` MUST:
  - run all registered cleanups.
  - dispose mounted child components.
  - detach all targets.
  - stop all reactive effects.
  - remove all region anchors.
  - empty the root element (`replaceChildren()`).

Notes:

- Cleanup ordering is last-in-first-out (reverse registration order).

### The `Ctx` API

`createComponent` provides a minimal safe mounting API via `Ctx`.

```ts
type Ctx = {
  on(target, type, handler, opts?);
  effect(run);
  mount(host, child);
  slot(host, getComponent);
  list(host, getIds, buildById);
  target(focus, target, getEl, opts?);
};
```

`ctx.on(target, type, handler, opts?)`:

Registers a DOM listener with automatic cleanup.

Rules:

- The listener MUST be removed on component disposal.
- View code SHOULD use `ctx.on` instead of raw `addEventListener`.

`ctx.effect(run)`:

Registers a reactive effect with automatic cleanup.

Rules:

- The effect MUST stop on component disposal.
- The effect MUST be re-run when reactive dependencies change.
- If `run()` returns a cleanup function, it MUST be invoked before re-running and on disposal.

`ctx.mount(host, child)`:

Mounts a static child component.

Rules:

- `child.el` MUST be appended to `host`.
- `child.dispose()` MUST be called on parent disposal.

### Regions: `ctx.slot` and `ctx.list`

`ctx.slot` and `ctx.list` provide region-based mounting.

A **region** is a stable insertion boundary inside a host element.

Rules:

- Regions MUST preserve DOM order relative to static siblings and other regions.
- Regions MUST dispose removed children.
- Once a region exists in a host, callers MUST NOT clear or replace host children manually.

Implementation note:

- Regions are anchored using comment boundary nodes:
  - `<!-- region:start -->`
  - `<!-- region:end -->`

This enables multiple independent regions inside one host.

`ctx.slot(host, getComponent)`:

Mounts zero or one reactive child subtree.

Rules:

- `getComponent()` MUST be evaluated in a reactive effect.
- When the returned component instance changes:
  - the previous component MUST be disposed.
  - the region MUST be cleared.
  - the new component MUST be inserted into the region.

- If `getComponent()` returns `null`, the region MUST become empty.

Use cases:

- Conditional header/body mounting.
- Swapping one subtree by discriminator.

`ctx.list(host, getIds, buildById)`:

Mounts a keyed reactive list of child components.

Signature:

```ts
ctx.list<Id extends string | number>(
  host,
  getIds: () => readonly Id[],
  buildById: (id: Id) => Component,
)
```

Rules:

- `getIds()` MUST be evaluated in a reactive effect.
- Keys MUST be `string | number` (simple, standard, interoperable).
- Keys MUST be **unique** within the list.
- Keys MUST be **stable** across updates for the same logical child.
- Child components MUST be cached by key.
- Removed keys MUST be disposed immediately.
- DOM order MUST exactly match the order returned by `getIds()`.
- When order changes, DOM nodes MUST be moved, not recreated.

Key stability policy (critical):

- The system assumes keys represent identity, not position.
- Using unstable keys (for example array indices) will cause focus loss, incorrect caching, and disposal churn.
- Any view that renders tables MUST treat row/cell keys as stable identities, not indices.

Target integration: `ctx.target(...)`

`ctx.target` binds a Core focus surface to a DOM element.

Signature:

```ts
ctx.target(
  focus: Focus,
  target: string,
  getEl: () => HTMLElement | null,
  opts?: { caret?: { set(pos: number): void; getLength(): number } },
)
```

Rules:

- `ctx.target` MUST call `core.attachTarget(...)`.
- The returned cleanup MUST run on component disposal.
- `getEl()` MUST return the element that should receive DOM focus.
- Only one active binding may exist per `(focus, target)` pair.

Caret support:

- A caret adapter MAY be provided for text targets.
- Caret application is best-effort.

### Shared DOM helpers (`dom/base`)

`el(tag, className?, text?)`:

Creates a DOM element.

Rules:

- If `className` is provided, it MUST be applied.
- If `text` is provided (including empty string), it MUST be applied as `textContent`.

`caretFromTarget(target)`:

Extracts a text caret from an event target.

Rules:

- If `target` is an `HTMLInputElement` or `HTMLTextAreaElement`, it MUST return:
  - `{ start: selectionStart, end: selectionEnd }` (best-effort)

- Otherwise it MUST return `{ start: 0, end: 0 }`.

Notes:

- This is used for pointerdown focus so caret placement feels natural.
- It intentionally does not attempt to support `contenteditable`.

`bindItemFrame(ctx, spec, shell)`:

`bindItemFrame` implements the canonical `.ui-frame` behavior for an item.

Signature:

```ts
bindItemFrame(ctx, { core, focus }, shell);
```

Rules:

- `shell` MUST receive `.ui-frame`.
- `shell.dataset.id` MUST be set to `focus.item`.
- If `shell` does not have `tabindex`, it MUST be assigned `tabIndex = -1`.
- The frame MUST attach `DEFAULT_TARGET` via `ctx.target`.
- On `pointerdown`:
  - the frame MUST focus `DEFAULT_TARGET`
  - caret MUST be derived via `caretFromTarget(e.target)`
  - propagation MUST be stopped

- Frame state classes MUST be applied:
  - `.is-focused` when selection matches the item focus
  - `.is-issue` when `item.content.type === "issue"`

`setBodyClasses(root, view)`:

Applies the canonical body classes to a view root.

Rules:

- MUST add `.ui-body`.
- MUST add `.ui-${view}`.

### Shared controls (`dom/controls`)

Intent vocabulary:

```ts
type Intent =
  | {
      type: "NAV";
      dir: "left" | "right" | "up" | "down";
      mode: "step" | "jump";
    }
  | { type: "CONFIRM"; caret?: Caret }
  | { type: "CANCEL" }
  | { type: "TAB"; shift: boolean }
  | { type: "TYPE"; char: string }
  | { type: "DELETE"; dir: "backward" | "forward" }
  | { type: "DELETE_BOUNDARY"; dir: "backward" | "forward" };
```

Rules:

- Views MUST interpret intents.
- Shared controls SHOULD emit intents instead of directly calling view commands.

`parseKeydownIntent(e)`:

Parses a `KeyboardEvent` into an `Intent`.

Rules:

- `Escape` -> `CANCEL`
- `Tab` -> `TAB`
- `Enter` -> `CONFIRM`
- `Backspace` -> `DELETE backward`
- `Delete` -> `DELETE forward`
- Arrow keys -> `NAV`
  - `mode = "jump"` when `ctrlKey` or `metaKey` is held
  - otherwise `mode = "step"`

- Printable keys (no ctrl/meta/alt, `key.length === 1`) -> `TYPE`

If no mapping applies, it MUST return `null`.

Caret helpers:

Exports:

- `SELECT_ALL`
- `caret0()`
- `caretAt(pos)`

Rules:

- `SELECT_ALL` MUST be treated as "select all text".
- `caretAt(pos)` MUST represent a collapsed caret.

Target constants:

Exports:

- `LABEL_TARGET = "label"`
- `VALUE_TARGET = "value"`
- `connTarget(key) = "conn:" + key`

Rules:

- These strings are canonical and MUST be used consistently across views.

`insertTextIntoActiveEditor(text)`:

Inserts text into the currently focused native editor.

Rules:

- It MUST only operate when `document.activeElement` is an `<input>` or `<textarea>`.
- It MUST no-op for readonly or disabled inputs.
- It MUST insert via `setRangeText`.
- It MUST dispatch a bubbling `InputEvent("input")`.

Use cases:

- Implementing type-to-edit from container focus.

`escapeLadder(core)`:

Implements the shared escape ladder.

Rules:

- If there is no focused selection, it MUST blur (no-op safe).
- If focused and `sel.target !== DEFAULT_TARGET`, it MUST focus the same item on `DEFAULT_TARGET`.
- Otherwise it MUST blur.

### Shared text editing control: `buildTextField`

`buildTextField` is the canonical shared text editor control.

It provides:

- Single-line (`<input>`) or multiline (`<textarea>`).
- Optional autosize via a mirror element.
- Two commit models: `live` and `draft`.
- Optional yielding of semantic intents (nav/tab/confirm/cancel).

Canonical DOM:

```text
.ui-textfield
  .ui-textfield-mirror                          (optional; aria-hidden="true")
  input.ui-textfield-input | textarea.ui-textfield-input
```

Rules:

- The input element MUST set `tabIndex = -1`.
- The input element MUST have `data-target = <target>`.

Options:

```ts
buildTextField(core, {
  focus,
  target,
  multiline,
  autosize?,
  className?,
  inputClassName?,
  editModel?,      // "draft" | "live"
  yieldNav?,       // default true
  commit(text),
  getState(),
  onIntent?(intent),
})
```

`getState()` returns:

```ts
{
  text: string;
  readOnly: boolean;
  isIssue: boolean;
}
```

Rules:

- The editor MUST set `readOnly` based on state.
- The editor MUST synchronize its visible value from `state.text`.

Edit models:

Live model:

Rules:

- Commits MUST occur on every `input`.
- No draft state MUST be maintained.
- `CANCEL` MUST NOT revert.

Draft model (default):

Draft model maintains a local editing session.

Lifecycle rules:

- When the target becomes focused and is editable:
  - a draft session MUST begin
  - baseline MUST be set from committed text

- On `input`:
  - draft MUST update
  - dirty MUST become true

- On commit triggers:
  - if dirty, `commit(draft)` MUST be called
  - dirty MUST reset

Commit triggers:

- `CONFIRM`
- `TAB`
- `NAV` (yielded)
- `blur`

Cancel trigger:

- `CANCEL` MUST revert to baseline and clear dirty.

Focus loss rule:

- When the target is no longer focused, draft state MUST reset to committed state.

Yielding and key handling:

Yielding applies only when:

- `opts.onIntent` is provided
- `yieldNav !== false`

Rules:

- `Tab` MUST be consumed and emitted as `TAB`.
- `Escape` MUST be consumed and emitted as `CANCEL`.
- `Enter` MUST be consumed and emitted as `CONFIRM`
  - except: multiline editor with `ctrlKey` or `metaKey` MUST insert newline

- Arrow keys MAY yield `NAV` when caret is at the boundary:
  - left at start
  - right at end
  - up on first line (textarea)
  - down on last line (textarea)

- Backspace at start MUST yield `DELETE_BOUNDARY backward`.
- Delete at end MUST yield `DELETE_BOUNDARY forward`.

Notes:

- Yielding is semantic; it does not rely on bubbling raw key events.

Target integration:

Rules:

- `buildTextField` MUST attach its target via `ctx.target`.
- `defaultTextCaret()` SHOULD be used for caret placement.

Pointer rule:

- On `pointerdown`, the editor MUST focus its own target and stop propagation.

### Shared header control: `buildItemHeader`

`buildItemHeader` renders the canonical header subtree for an item.

It is view-agnostic and is intended to be used by outer views and table schema contexts.

`buildItemHeader` behavior:

Rules:

- The label field MUST exist and MUST attach `LABEL_TARGET`.
- If the item mode is connected, connected fields MUST be rendered.
- Connected fields MUST be keyed by field key and mounted via `ctx.list`.

Connected field semantics:

- Field order MUST be derived from `fieldsFromConn(conn)`.
- Each field MUST attach target `conn:<fieldKey>`.

Connected field model:

A connected definition is represented as:

- `formula` -> one field: `expr`
- `query` -> three fields: `from`, `where`, `orderBy`

Rules:

- These keys MUST be treated as canonical.
- Views MUST NOT invent alternate keys for the same meaning.

Helpers:

- `fieldsFromConn(conn)` returns the field list with labels and multiline flags.
- `patchConn(conn, key, text)` applies a single-field patch.

## Keyboard routing and focus rules

### Global keyboard routing

Rules:

- Core MUST own the global `keydown` listener.
- Core MUST parse key events into intents.
- Core MUST route view intents to the active view handler.
- If Core routes an intent, it MUST consume/prevent the original DOM key event.

Notes:

- Native editors (`input`, `textarea`) will process local edits first.
- Core MAY still handle explicit global commands while focus is in a native editor.

### Programmatic focus

Rules:

- Focus targets MUST be applied programmatically from Core selection.
- Inputs MUST NOT participate in browser tab-order traversal.
- `.ui-main` MUST be the only tabbable element.

### Pointer routing

Frame pointerdown:

Rules:

- `.ui-frame` SHOULD focus `DEFAULT_TARGET`.
- Frames SHOULD capture caret when pointerdown hits text-editing surfaces.
- Frame handling SHOULD stop propagation.

`bindItemFrame` is the canonical implementation.

Editor/control pointerdown:

Rules:

- Editors and controls SHOULD focus their own target.
- Editors SHOULD use caret-from-target logic for caret placement.
- Editor/control handling SHOULD stop propagation.

## Universal interaction rules

These rules are shared across views. Views MAY refine them, but MUST remain consistent with them.

### Escape ladder

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

### Navigation

Rules:

- `NAV` MUST NOT implicitly enter edit mode.

## Shared view authoring conventions

This section is an implementation checklist for view code.

Rules:

- Views MUST use the shared runtime primitives in this document (`ctx.target`, `ctx.slot`, `ctx.list`, `buildTextField`, `buildItemHeader`) instead of ad-hoc equivalents.
- Views MUST attach targets through `ctx.target(...)`.
- Views MUST respect frame/header versus body target ownership from `Target ownership contract`.
- Every rendered item MUST expose `DEFAULT_TARGET`.
- Frames SHOULD use shared frame behavior (for example `bindItemFrame`) and keep pointer/selection/state-class behavior consistent.
- Selection changes MUST NOT remount frames.
- Selection changes MUST NOT rebuild lists.
- Selection changes MUST NOT switch body subtrees.
- Conditional subtree mounting MUST use `ctx.slot`.
- Repeated keyed subtree mounting MUST use `ctx.list`.
- Manual child reconciliation in effects SHOULD be avoided.
- Views SHOULD avoid direct raw `keydown` handling for behavior semantics.
- Views SHOULD implement behavior by interpreting shared intents.
- Text editing SHOULD use `buildTextField`.
- Value and connected editors SHOULD enable yielding where appropriate.
- Label editors SHOULD keep yielding disabled.

## Visual language invariants

This section defines the cross-view visual language. Views MUST compose within it.

### Visual foundations

Rules:

- Global design tokens SHOULD be defined in `:root`.
- Views SHOULD consume token values rather than hardcode raw values.

Token categories:

- Typography.
- Geometry.
- Colors.

### Two visual layers

Frame layer:

- Outer-view-owned.
- Contains rail and optional header.
- MUST express focus and issue state.
- MUST NOT depend on body internals.

Body layer:

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

## Public UI runtime API surface (`dom/index`)

This is the supported export surface of the UI runtime module.

Component + mounting:

- `createComponent`
- `bindItemFrame`
- `setBodyClasses`
- `el`

Targets + focus helpers:

- `LABEL_TARGET`
- `VALUE_TARGET`
- `connTarget`
- `caret0`
- `caretAt`
- `SELECT_ALL`
- `escapeLadder`

Types:

- `Intent`
- `NavDir`

Intent + editor helpers:

- `parseKeydownIntent`
- `insertTextIntoActiveEditor`

Shared controls:

- `buildTextField`
- `buildItemHeader`

Connected helpers:

- `fieldsFromConn`
- `patchConn`

Rules:

- View code SHOULD treat these exports as the canonical shared UI building blocks.
- View code SHOULD NOT re-implement variants unless view-specific behavior requires it.

## Rationale

This UI system avoids common editor failure modes:

- Focus instability.
- Inconsistent keyboard behavior.
- Leaked listeners/effects.
- Selection-driven remount churn.
- Styling drift across views.

It stays robust by keeping a small set of contracts strict, and making view-specific behavior explicit in `docs/ui-views.md`.
