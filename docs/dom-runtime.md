# UI Runtime (`dom/`)

This document is the normative external specification for the `dom/` layer.

## Scope

This document defines:

- Public API exported from `dom/index`.
- Required DOM/class outputs for runtime-provided subtrees.
- Observable runtime behavior (focus integration, yielding, disposal, reconciliation).

## Audience

Primary audience:

- Authors of views/components consuming `dom/`.
- Authors extending shared `dom/` helpers.

## Exports index (`dom/index`)

Base helpers:

- `createComponent`: lifecycle-safe component factory.
- `el`: small DOM element constructor helper.
- `bindItemFrame`: canonical `.ui-frame` binding helper.
- `setBodyClasses`: canonical body-root class helper.

Controls/editing helpers:

- `buildTextField`: canonical shared text editor component.
- `caret0`, `caretAt`, `caretEnd`: caret constructors.
- `insertTextIntoActiveEditor`: text insertion helper for active native editors.
- `enterEditOnType`: shared type-to-edit transition helper.
- `toggleEditOnConfirm`: shared confirm-toggle helper between default/edit targets.

Connected header helpers:

- `buildItemHeader`: canonical header subtree component.
- `fieldsFromConn`: connected-mode field derivation helper.
- `patchConn`: single-field connected patch helper.

## Component model

A component is the smallest disposable UI unit:

```ts
type Component = { el: HTMLElement; dispose(): void };
```

Rules:

- A component MUST expose exactly one root element (`el`).
- `dispose()` MUST stop all effects registered via `ctx.effect`.
- `dispose()` MUST remove all event listeners registered via `ctx.on`.
- `dispose()` MUST dispose all mounted children registered via `ctx.mount`, `ctx.slot`, and `ctx.list`.
- `dispose()` MUST detach all targets registered via `ctx.target`.
- `dispose()` MUST remove any component-owned DOM under the component root element.

## `createComponent(core, build)`

Canonical component factory:

```ts
createComponent(core: Core, build: (ctx: Ctx) => HTMLElement): Component
```

Rules:

- `build(ctx)` MUST be called once per component instance.
- The returned `HTMLElement` is the component root.
- All resource lifetime MUST be bound to `dispose()` through `Ctx` APIs.

## `Ctx` runtime contract

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

### `ctx.on(target, type, handler, opts?)`

Registers a DOM listener and guarantees cleanup on disposal.

Rules:

- Listener MUST be removed when the parent component is disposed.
- Handler receives the typed DOM event for the registered event name.

### `ctx.effect(run)`

Registers a reactive effect.

Rules:

- Effect MUST rerun when its reactive dependencies change.
- If `run` returns a cleanup function, that cleanup MUST run before reruns.
- Effect cleanup MUST run on component disposal.

### `ctx.mount(host, child)`

Mounts a static child component.

Rules:

- `child.el` is appended to `host`.
- `child.dispose()` MUST run when the parent component disposes.

### `ctx.slot(host, getComponent)`

Manages an optional child component region inside `host`.

Rules:

- At most one child component is mounted at a time.
- On recompute, the runtime clears the region, disposes the previous child, then mounts the next child if non-null.
- If `getComponent()` returns `null`, the slot region becomes empty.
- Runtime guarantees no stale child components remain mounted.
- The slot occupies a stable position in host; only the slot's contents are managed/cleared.

### `ctx.list(host, getIds, buildById)`

Manages a keyed child component list inside `host`.

Rules:

- Keys MUST be unique per render.
- Keys SHOULD be stable across updates for the same logical child.
- Child identity is stable per key.
- Removing a key MUST dispose that child component.
- DOM order MUST match `getIds()` order.
- Reordering MUST move existing nodes; it MUST NOT force remount for retained keys.
- The list occupies a stable position in host; only the list's contents are reconciled.

### `ctx.target(focus, target, getEl, opts?)`

Registers a focus target with Core.

Rules:

- The target registration lifetime is bound to component disposal.
- `getEl()` resolves the element Core should focus.
- If `opts.caret` is provided, it is used for caret/selection restore behavior.

## Regions (`ctx.slot`, `ctx.list`)

Consumer policy:

- Once a host contains a runtime-managed region (`slot` or `list`), consumers SHOULD NOT clear that host manually or replace its children wholesale.
- Avoid manually inserting/removing nodes intended to live inside a runtime-managed region; let slot/list own that subtree.
- Doing so bypasses region reconciliation/disposal behavior and can leave the UI in an inconsistent state.

## Base DOM helpers

### `el(tag, className?, text?)`

Creates an element with optional class/text.

Rules:

- Creates `document.createElement(tag)`.
- If `className` is provided, sets `element.className = className`.
- If `text` is provided (including empty string), sets `element.textContent = text`.

## Frame binding (`bindItemFrame`)

### `bindItemFrame(ctx, spec, frameEl)`

Canonical `.ui-frame` behavior contract.

Rules:

- Adds class `ui-frame`.
- Sets `data-id = focus.item`.
- If `tabindex` is absent, sets `tabIndex = -1`.
- Registers `DEFAULT_TARGET` on `frameEl` via `ctx.target`.
- On `pointerdown`, MUST focus Core on `DEFAULT_TARGET` for the same focus surface.
- On `pointerdown`, MUST NOT set caret.
- On `pointerdown`, MUST call `stopPropagation()`.
- Pointerdown handling MUST apply only when the event reaches the frame (that is, it was not already handled/stopped by an inner control).
- MUST reactively toggle `.is-focused`.
- MUST reactively toggle `.is-issue`.

## Body/root helper

### `setBodyClasses(root, view)`

Rules:

- Adds `ui-body`.
- Adds `ui-${view}`.

## Editing helpers

Intent routing:

- Views MUST NOT receive `CANCEL` intents.

### Caret constructors

- `caret0()` returns `{ start: 0, end: 0 }`.
- `caretAt(pos)` returns `{ start: pos, end: pos }`.
- `caretEnd()` returns end-sentinel caret (`Number.MAX_SAFE_INTEGER`).

### `insertTextIntoActiveEditor(text)`

Rules:

- Only affects active `input`/`textarea` (`document.activeElement`).
- No-op unless the active element is an `input` or `textarea`, and it is not `readOnly`/`disabled`.
- Inserts with `setRangeText`.
- Dispatches bubbling `InputEvent("input")`.

### `enterEditOnType({ core, sel, char, getPrimaryTarget })`

Preconditions:

- Selection is focused.
- Current target is `DEFAULT_TARGET`.
- Primary target exists and is not `DEFAULT_TARGET`.

Behavior:

- Focuses primary target with `SELECT_ALL`.
- Queues microtask insertion of typed character into the active editor.
- Returns `true` when handled, else `false`.

### `toggleEditOnConfirm({ core, sel, getPrimaryTarget, caretForTarget? })`

Behavior:

- If current target is not `DEFAULT_TARGET`, focuses `DEFAULT_TARGET` and returns `true`.
- Otherwise, focuses primary target when available.
- Entry caret defaults to `caretEnd()` when `caretForTarget` is not provided.
- Returns `true` when focus changed, else `false`.

## `buildTextField` contract

Canonical shared text-editing component.

### Signature and return

```ts
buildTextField(core, {
  focus,
  target,
  multiline,
  autosize?,
  className?,
  inputClassName?,
  editModel?, // "draft" | "live"
  yieldNav?,
  commit(text),
  getState(), // { text: string; readOnly: boolean }
}): Component & { focusEl: HTMLInputElement | HTMLTextAreaElement };
```

Rules:

- Returns a `Component` plus `focusEl` pointing to the input/textarea element.

### DOM/class contract

Canonical produced structure:

```text
.ui-textfield[.<opts.className>?]
  .ui-textfield-mirror (optional; aria-hidden="true")
  input.ui-textfield-input[.<opts.inputClassName>?] | textarea.ui-textfield-input[.<opts.inputClassName>?]
```

Rules:

- Wrapper MUST always have `.ui-textfield`.
- Wrapper MUST include `opts.className` when provided.
- Input element MUST always have `.ui-textfield-input`.
- Input MUST include `opts.inputClassName` when provided.
- Input MUST set `data-target = opts.target`.
- Input MUST always have `tabIndex = -1`.
- Input MUST disable `autocomplete`, `autocorrect`, and spellcheck.
- In autosize mode, `.ui-textfield-mirror` MUST be present and set `aria-hidden="true"`.

### Behavioral contract

Edit models:

- `live`: commit on every `input`; no draft session.
- `draft` (default): local session with baseline/draft/dirty state.

Draft model semantics:

- Session starts when focused and editable.
- Baseline captures committed text at session start.
- `input` updates draft and sets dirty.
- Cancel resets draft to baseline.
- Commit sends current draft and clears dirty.

Read-only semantics:

- Read-only state prevents opening/editing draft sessions.
- Commit operations are ignored while read-only.

Sync rules:

- When not focused on this target, input value syncs from committed state.
- When focused, local draft is preserved except when committed state changes while draft is clean.

Mirror rules:

- Mirror reflects current displayed text (draft or committed).
- When text ends with newline, mirror appends a trailing zero-width space (`\u200B`) for sizing.

### Yield navigation (`yieldNav`)

- `yieldNav=false` means the field consumes all keydowns locally (does not bubble), except Escape.
- `yieldNav=true` means the field yields arrow and delete-boundary keys at boundaries so the active view can handle navigation and structural edits.

Propagation-gating rules:

- Locally handled keydowns MUST call `stopPropagation()` so they do not reach global key routing.
- Yielded keydowns MUST NOT call `stopPropagation()` so they bubble to Core.
- When yielding, the runtime MUST perform the listed commit/cancel behavior and call `preventDefault()` where specified.
- Text fields MUST NOT stop propagation for Escape. Draft fields MAY cancel local edits, but Escape always bubbles to the global Cancel ladder.

Events that trigger commit/yield behavior:

- `Escape`: Cancels the draft session in draft mode and MUST NOT call `preventDefault()`.
- `Tab`: Commits the draft and MUST call `preventDefault()`. If `yieldNav=true`, it MUST bubble (so views may handle indent/outdent). If `yieldNav=false`, it MUST NOT bubble.
- `Enter`: Commits the draft and MUST call `preventDefault()`. Exception: a `textarea` with `metaKey` or `ctrlKey` allows newline.
- Arrow keys: MUST yield only at text boundaries. Left yields at absolute start, right yields at absolute end, up yields on the first line for `textarea` (always for single-line input), and down yields on the last line for `textarea` (always for single-line input). When yielding, the runtime MUST commit the draft and call `preventDefault()`.
- `Backspace` at start: MUST commit the draft and call `preventDefault()`.
- `Delete` at end: MUST commit the draft and call `preventDefault()`.

### Pointerdown + focus integration

Rules:

- On `pointerdown`, focuses Core on this target and calls `stopPropagation()`.
- Pointer interactions inside a textfield therefore do not trigger enclosing frame pointerdown behavior.
- Caret placement is handled by the native input/textarea (browser default) when it receives focus.
- Pointerdown on the input/textarea MUST NOT override the browser's selection behavior.
- `focus` MUST start the draft session when applicable.
- Target MUST be registered via `ctx.target` with the default text caret adapter.

## Connected header helpers

### `fieldsFromConn(conn)`

Canonical connected field derivation.

Rules:

- For `formula`: returns one field `expr`.
- For non-formula connected definitions: returns `from`, `where`, `orderBy`.
- Field metadata includes key, label text, multiline flag, and current text.
- Field order MUST be canonical and stable.

### `patchConn(conn, key, text)`

Single-field patch helper.

Rules:

- Returns an updated connected object when `key` is recognized.
- For unknown keys, returns the original object unchanged.

### `buildItemHeader(core, args)`

Canonical header component for item UI.

#### DOM/class contract

Canonical produced structure:

```text
.ui-header
  .ui-header-label
    [.ui-textfield subtree for label]
  .ui-header-conn
    .ui-header-conn-row (0..n)
      .ui-header-conn-key
      .ui-header-conn-val
        [.ui-textfield subtree for connected field]
```

#### Behavioral contract

Rules:

- Label text field uses target `LABEL_TARGET`.
- The label text field MUST use `buildTextField` with `yieldNav=false` (consumes Tab/arrows/Enter/Delete locally; only Escape bubbles).
- Connected rows render only when `item.mode.type === "connected"`.
- Each connected field MUST use `connTarget(field.key)` as target.
- Each connected field MUST use `buildTextField` with autosize enabled.
- Each connected field MUST commit through `commitConnField(field.key, text)`.
- Connected rows are keyed by `field.key` and reconciled with `ctx.list`.
- Render order matches `fieldsFromConn(conn)`.

## Key parsing boundary

Key parsing is part of Core/system routing docs.

## Non-goals and integration points

Runtime (`dom/`) provides:

- Safe component lifecycle/disposal primitives.
- Safe dynamic mounting primitives (`slot`, `list`).
- Canonical editing and header widgets.

System design docs define:

- View architecture and composition.
- Focus/selection routing policy.
- Visual language and layout rules.
