# UI Runtime (`dom/`)

This document defines the **shared UI runtime** in `dom/`.

It is the authoritative reference for:

- The component model (`Component`).
- Safe mounting (`createComponent`, `Ctx`).
- Region-based dynamic mounting (`ctx.slot`, `ctx.list`).
- Target binding (`ctx.target`) and focus helpers.
- Shared intent helpers (`insertTextIntoActiveEditor`, `enterEditOnType`, `toggleEditOnConfirm`).
- Shared controls (`buildTextField`, `buildItemHeader`).
- Connected definition helpers (`fieldsFromConn`, `patchConn`).
- The supported export surface (`dom/index`).

This document does **not** define:

- Frame/header/body ownership rules.
- Cross-view structural invariants.
- Cross-view visual language.
- Per-view behavior.

Those belong in `docs/ui-contracts.md` and `docs/ui-views.md`.

## Component model

A UI component is the smallest disposable unit of UI.

```ts
type Component = { el: HTMLElement; dispose(): void };
```

Rules:

- A component MUST expose exactly one root element (`el`).
- A component MUST release all resources on `dispose()`.
- A disposed component MUST leave no component-owned DOM nodes mounted.

## `createComponent(core, build)`

`createComponent` is the canonical way to build UI components.

Signature:

```ts
createComponent(core: Core, build: (ctx: Ctx) => HTMLElement): Component
```

Rules:

- `build(ctx)` MUST be called exactly once.
- The returned `HTMLElement` MUST be the component root.
- `dispose()` MUST:
  - run all registered cleanups
  - dispose mounted child components
  - detach all targets
  - stop all reactive effects
  - remove all region anchors
  - empty the root element (`replaceChildren()`)

Notes:

- Cleanup ordering is last-in-first-out (reverse registration order).

## `Ctx` (safe mounting context)

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

The `Ctx` API exists to make cleanup correct by default.

### `ctx.on(target, type, handler, opts?)`

Registers a DOM listener with automatic cleanup.

Rules:

- The listener MUST be removed on component disposal.
- View code SHOULD use `ctx.on` instead of raw `addEventListener`.

### `ctx.effect(run)`

Registers a reactive effect with automatic cleanup.

Rules:

- The effect MUST stop on component disposal.
- The effect MUST re-run when reactive dependencies change.
- If `run()` returns a cleanup function, it MUST be invoked:
  - before re-running
  - on disposal

### `ctx.mount(host, child)`

Mounts a static child component.

Rules:

- `child.el` MUST be appended to `host`.
- `child.dispose()` MUST be called on parent disposal.

## Regions: `ctx.slot` and `ctx.list`

`ctx.slot` and `ctx.list` provide region-based dynamic mounting.

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

### `ctx.slot(host, getComponent)`

Mounts zero or one reactive child subtree.

Rules:

- `getComponent()` MUST be evaluated in a reactive effect.
- On each reactive evaluation:
  - the previous component MUST be disposed
  - the region MUST be cleared
  - if non-null, the new component MUST be inserted into the region

- If `getComponent()` returns `null`, the region MUST become empty.

Use cases:

- Conditional mounting.
- Swapping one subtree by discriminator.

### `ctx.list(host, getIds, buildById)`

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
- Keys MUST be `string | number`.
- Keys MUST be unique within the list.
- Keys MUST be stable across updates for the same logical child.
- Child components MUST be cached by key.
- Removed keys MUST be disposed immediately.
- DOM order MUST exactly match the order returned by `getIds()`.
- When order changes, DOM nodes MUST be moved, not recreated.

Key stability policy (critical):

- The system assumes keys represent identity, not position.
- Using unstable keys (for example array indices) will cause focus loss, incorrect caching, and disposal churn.

## Target integration: `ctx.target(...)`

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

## Base DOM helpers (`dom/base`)

### `el(tag, className?, text?)`

Creates a DOM element.

Rules:

- If `className` is provided, it MUST be applied.
- If `text` is provided (including empty string), it MUST be applied as `textContent`.

### `caretFromTarget(target)`

Extracts a text caret from an event target.

Rules:

- If `target` is an `HTMLInputElement` or `HTMLTextAreaElement`, it MUST return:
  - `{ start: selectionStart, end: selectionEnd }` (best-effort)

- Otherwise it MUST return `{ start: 0, end: 0 }`.

Notes:

- This is used for pointerdown focus so caret placement feels natural.
- It intentionally does not attempt to support `contenteditable`.

## Frame binding helpers

### `bindItemFrame(ctx, spec, frameEl)`

`bindItemFrame` implements the canonical `.ui-frame` behavior for an item.

Signature:

```ts
bindItemFrame(ctx, { core, focus }, frameEl);
```

Rules:

- `frameEl` MUST receive `.ui-frame`.
- `frameEl.dataset.id` MUST be set to `focus.item`.
- If `frameEl` does not have `tabindex`, it MUST be assigned `tabIndex = -1`.
- The frame MUST attach `DEFAULT_TARGET` via `ctx.target`.
- On `pointerdown`:
  - the frame MUST focus `DEFAULT_TARGET`
  - caret MUST be derived via `caretFromTarget(e.target)`
  - propagation MUST be stopped

- Frame state classes MUST be applied:
  - `.is-focused` when selection matches the item focus
  - `.is-issue` when `item.content.type === "issue"`

### `setBodyClasses(root, view)`

Applies the canonical body classes to a view root.

Rules:

- MUST add `.ui-body`.
- MUST add `.ui-${view}`.

## Shared controls (`dom/controls`)

### Intent vocabulary

Intent vocabulary is defined in Core and used by:

- Core keyboard routing.
- View intent handlers.
- Shared controls (for target/caret behavior).

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

type ViewIntent = Exclude<Intent, { type: "CANCEL" }>;
```

Rules:

- Core MUST handle `CANCEL` before dispatching to views.
- Views MUST receive only `ViewIntent` (no `CANCEL`).
- Shared controls MUST NOT route intents directly.

### Core key parsing (`parseKeydownIntent(e)`)

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
- If no mapping applies, it MUST return `null`.

### Caret helpers

Exports:

- `SELECT_ALL`
- `caret0()`
- `caretAt(pos)`
- `caretEnd()`

Rules:

- `SELECT_ALL` MUST be treated as "select all text".
- `caretAt(pos)` MUST represent a collapsed caret.
- `caretEnd()` MUST represent a collapsed caret at the end of text.

### Target constants

Exports:

- `DEFAULT_TARGET = "default"`
- `LABEL_TARGET = "label"`
- `VALUE_TARGET = "value"`
- `connTarget(key) = "conn:" + key`

Rules:

- These strings are canonical and MUST be used consistently across views.
- Canonical ownership is Core (`core/runtime`), and `dom/index` re-exports them for convenience.

### `insertTextIntoActiveEditor(text)`

Inserts text into the currently focused native editor.

Rules:

- It MUST only operate when `document.activeElement` is an `<input>` or `<textarea>`.
- It MUST no-op for readonly or disabled inputs.
- It MUST insert via `setRangeText`.
- It MUST dispatch a bubbling `InputEvent("input")`.

Use cases:

- Implementing type-to-edit from container focus.

### `enterEditOnType({ core, sel, char, getPrimaryTarget })`

Shared type-to-edit helper from container focus.

Rules:

- It only activates from `DEFAULT_TARGET`.
- It resolves the edit target with `getPrimaryTarget(id)`.
- It no-ops if no editable target exists.
- On success, it focuses with `SELECT_ALL` and inserts the typed char in a microtask.

### `toggleEditOnConfirm({ core, sel, getPrimaryTarget, caretForTarget? })`

Shared `CONFIRM` toggle between container and edit targets.

Rules:

- From edit focus (`sel.target !== DEFAULT_TARGET`), it focuses `DEFAULT_TARGET`.
- From `DEFAULT_TARGET`, it focuses the primary edit target when available.
- If `caretForTarget` is missing, entry caret defaults to `caretEnd()`.
- Returns `true` when handled, otherwise `false`.

## Shared text editing control: `buildTextField`

`buildTextField` is the canonical shared text editor control.

It provides:

- Single-line (`<input>`) or multiline (`<textarea>`).
- Optional autosize via a mirror element.
- Two commit models: `live` and `draft`.
- Optional yielding of boundary/navigation keys to Core intent routing.

Canonical DOM:

```text
.ui-textfield
  .ui-textfield-mirror                          (optional; aria-hidden="true")
  input.ui-textfield-input | textarea.ui-textfield-input
```

Rules:

- The input element MUST set `tabIndex = -1`.
- The input element MUST have `data-target = <target>`.

### Options

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
})
```

`getState()` returns:

```ts
{
  text: string;
  readOnly: boolean;
}
```

Rules:

- The editor MUST set `readOnly` based on state.
- The editor MUST synchronise its visible value from `state.text`.

### Edit models

#### Live model

Rules:

- Commits MUST occur on every `input`.
- No draft state MUST be maintained.
- `CANCEL` MUST NOT revert.

#### Draft model (default)

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

- yielded `CONFIRM`/`TAB`/`NAV`
- `blur`

Cancel trigger:

- local `Escape` MUST revert to baseline and clear dirty.

Focus loss rule:

- When the target is no longer focused, draft state MUST reset to committed state.

### Yielding and key handling

Yielding applies only when:

- `yieldNav !== false`

Keyboard-driven draft commit/cancel uses preventDefault-based yielding; `blur` commit remains independent.

Rules:

- `Tab` MUST commit draft and call `preventDefault()`.

- `Escape` MUST cancel local draft and MUST NOT call `preventDefault()`.

- `Enter` MUST commit draft and call `preventDefault()`
  - except: multiline editor with `ctrlKey` or `metaKey` MUST insert newline

- Arrow keys MAY yield when caret is at the boundary:
  - left at start
  - right at end
  - up on first line (textarea)
  - down on last line (textarea)

- Backspace at start MUST commit draft and call `preventDefault()`.

- Delete at end MUST commit draft and call `preventDefault()`.

Notes:

- Yielding is semantic via `preventDefault()` and bubbling to Core's global keydown handler.

### Target integration

Rules:

- `buildTextField` MUST attach its target via `ctx.target`.
- `defaultTextCaret()` SHOULD be used for caret placement.

Pointer rule:

- On `pointerdown`, the editor MUST focus its own target and stop propagation.

## Shared header control: `buildItemHeader`

`buildItemHeader` renders the canonical header subtree for an item.

It is view-agnostic and is intended to be used by:

- outer views
- table schema contexts

Behavior:

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

## Connected helpers

### `fieldsFromConn(conn)`

`fieldsFromConn` returns the connected definition field list for a connected item.

Rules:

- Field order MUST match the canonical connected model:
  - formula: `expr`
  - query: `from`, `where`, `orderBy`

- Returned fields MUST include:
  - stable `key`
  - display label
  - multiline flag (when needed)

### `patchConn(conn, key, text)`

`patchConn` applies a single-field patch to a connected definition.

Rules:

- It MUST treat the canonical field keys as authoritative.
- It MUST apply only the targeted field change.

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
- `caretEnd`
- `SELECT_ALL`

Types:

- `Intent`
- `ViewIntent`
- `NavDir`

Intent + editor helpers:

- `insertTextIntoActiveEditor`
- `enterEditOnType`
- `toggleEditOnConfirm`

Shared controls:

- `buildTextField`
- `buildItemHeader`

Connected helpers:

- `fieldsFromConn`
- `patchConn`

Rules:

- View code SHOULD treat these exports as the canonical shared UI building blocks.
- View code SHOULD NOT re-implement variants unless view-specific behavior requires it.

## Usage patterns (recommended)

### Conditional subtree mounting

Use `ctx.slot` for a conditional subtree that must dispose cleanly.

Rules:

- Callers MUST NOT clear the host manually.
- Callers MUST NOT "toggle" by replacing host children.

(Implementation details are handled by the region.)

### Keyed lists

Use `ctx.list` for any dynamic list where children have stable identity.

Rules:

- Callers MUST NOT use array indices as keys.
- Callers MUST NOT manually reconcile DOM in effects.

### Text editing

Use `buildTextField` for any inline editor that must participate in:

- target-driven focus
- semantic yielding
- correct disposal

Rules:

- The editor MUST NOT be tabbable.
- The editor MUST stop pointer propagation.
