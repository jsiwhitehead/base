# UI Runtime (`dom/`)

This document is the normative external specification for the `dom/` layer.

## Scope

This document defines:

- Public API exported from `dom/index`.
- The DOM runtime adapter contract over headless Core.
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
- `handleItemIntent`: shared item-selection `TYPE`/`CONFIRM` adaptor for views.
- `moveWithinItemEditTargets`: intra-item traversable-target movement helper.
- `resolveFocusAfterRemove`: canonical remove-focus destination helper.

Contenteditable helpers:

- `createSuppressionFlag`, type `SuppressionFlag`
- `renderPlainTextToContentEditable`, `readPlainTextFromContentEditable`
- `domPointToTextOffset`, `textOffsetToDomPoint`
- `setDomSelectionRange`, `setDomCaret`
- `getDomSelectionPointsInRoot`, `getMappedSelectionPointsInRoot`
- `getMappedSelectionSnapshotInRoot`, `getDomRangeInRoot`, `getMappedSelectionRangeInRoot`
- `getCollapsedCaretRectInSurface`, `getTextSurfaceLineRects`, `getDomPointFromViewport`
- `getSurfaceFromNodeInRoot`, `getTextNodeFromMutationRecord`
- `getPlainTextFromDataTransfer`, `writePlainTextClipboard`

Connected header helpers:

- `buildItemHeader`: canonical header subtree component.

Drag helpers:

- `createDragController`: creates the drag-and-drop controller.
- `buildDropIndicator`: builds the drop-position indicator component.
- Types: `DragController`, `DragState`, `DropTarget`.

Runtime integration helpers/types:

- `UiCore`: DOM-facing composed API (`Core` plus runtime-backed methods such as view mounting and target binding).
- `bindUiRuntime`: composes a headless `Core` with the DOM runtime and returns `{ core: UiCore, runtime }`.
- `createRuntime`: low-level DOM runtime factory used by `bindUiRuntime`.
- `DomRuntime`: runtime adapter type (selection sync, target binding, view mounting, listeners, disposal).

## Core/runtime boundary

Rules:

- `dom/` owns DOM listeners, target bindings, mounted-view tracking, and DOM focus/caret effects.
- `dom/` MUST NOT own canonical state or canonical selection; Core remains the source of truth.
- Runtime selection/focus behavior MUST be driven by Core selection updates (for example via `runtime.syncSelection(...)`).
- View mounting and target binding are `UiCore`/runtime responsibilities, not pure `Core` API responsibilities.
- Runtime code MUST treat `ItemId` as opaque (see `docs/core-api.md`).

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
createComponent(core: UiCore, build: (ctx: Ctx) => HTMLElement): Component
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

- `target` MAY be an `HTMLElement`, `Document`, or `Window`.
- Listener MUST be removed when the parent component is disposed.
- Handler receives the typed DOM event for the registered event name.

### `ctx.effect(run)`

Registers a reactive effect.

Rules:

- Effect MUST rerun when its reactive dependencies change.
- If `run` returns a cleanup function, that cleanup MUST run before reruns.
- Effect cleanup MUST run on component disposal.
- If `run` throws a typed Core read invalidation error during teardown/update races, the runtime MAY stop that effect and dispose it instead of rethrowing; other errors MUST still surface.

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
- `opts.setCaret`, when provided, is used for caret/selection restore behavior.
- `opts.getCaret`, when provided, MAY be called by runtime to capture caret during local repair-anchor capture. This is mainly for live `contenteditable` surfaces.

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
- Registers `ITEM_TARGET` on `frameEl` via `ctx.target`.
- On `pointerdown`, MUST focus Core on `ITEM_TARGET` for the same focus surface.
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

- Escape is represented as `NAV/out` and may be handled by the active view after Core global handling.

### `handleItemIntent({ core, sel, intent })`

Behavior:

- Handles item-selection `TYPE` and `CONFIRM` for **input-based edit targets** (`value`, `label`, `conn:*` when those targets are bound to text inputs).
- For `TYPE`, applies the character to the item's primary target model-side (`applyTypeToPrimaryTarget`) and focuses the resulting editing target with the returned caret.
- For `TYPE "="` on an empty plain value item, converts to formula and focuses `conn:expr`.
- For `CONFIRM`, enters primary edit target with caret at end.
- Returns `true` when handled, else `false`.
- **contenteditable value surfaces do not use this helper for `TYPE`.** Views with a contenteditable `value` target handle `TYPE` model-side: commit the character directly (`t.setValue(id, char)`) and focus `VALUE_TARGET` at the new caret. This is the same pattern the empty-group case already uses.

### `moveWithinItemEditTargets(core, id, fromTarget, dir)`

Behavior:

- Moves to the previous/next edit target within the same item.
- Returns `null` if `fromTarget` is not in the item target list or if there is no target in `dir`.
- On forward move, returns `{ target, caret: 0 }`.
- On backward move, returns `{ target, caret: endOfTargetText }`.

### `resolveFocusAfterRemove(core, removedId, prefer, portals)`

Behavior:

- Landing order after remove: preferred sibling, opposite sibling, then parent.
- Parent fallback is valid only if that parent survives the same remove/prune commit.
- Returns `null` when no live destination exists (caller/Core repair handles fallback).
- Returned location keeps the same `portals`.
- Local remove/navigation handlers SHOULD pass the current selection portals.
- Use `portals: []` only for explicit Core root/repair fallback, not normal view landing.

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
  kind?, // "isolated" | "traversable"
  onExitToItem?,
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
- Wrapper MUST toggle `.is-stale` when committed text diverges from baseline during a dirty draft session.
- Wrapper MUST include `opts.className` when provided.
- Input MUST always have `.ui-textfield-input`.
- Input MUST include `opts.inputClassName` when provided.
- Input MUST set `data-target = opts.target`.
- Input MUST always have `tabIndex = -1`.
- Input MUST disable `autocomplete`, `autocorrect`, and spellcheck.
- In autosize mode, `.ui-textfield-mirror` MUST be present with `aria-hidden="true"`.

### Behavioral contract

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

- When this target is not focused, input value syncs from committed state.
- When focused, local draft is preserved.
- If committed text changes while draft is clean, the field syncs to committed text.
- If draft is dirty, visible input remains the local draft; external committed updates are not pushed into the field mid-session.
- If draft is dirty and committed text diverges from baseline, wrapper MUST have `.is-stale`.
- `.is-stale` MUST clear on commit, cancel, or draft-session end (for example blur, focus moved away, read-only transition, or target invalidation).
- If the focused editing target becomes invalid (for example item/target removed or focus repaired away), the draft session ends and subsequent renders reflect committed state.

Mirror rules:

- Mirror reflects current displayed text (draft or committed).
- When text ends with newline, mirror appends a trailing zero-width space (`\u200B`) for sizing.

### Field kind (`kind`)

- `kind="isolated"` means the field consumes all keydowns locally (does not bubble), except Escape.
- `kind="traversable"` means the field yields arrow and delete-boundary keys at boundaries so the active view can handle navigation and structural edits.
- `onExitToItem` MAY be provided for isolated fields. When Enter or Tab is pressed, the field commits, prevents default, and calls this callback.

Propagation-gating rules:

- Locally handled keydowns MUST call `stopPropagation()` so they do not reach global key routing.
- Yielded keydowns MUST NOT call `stopPropagation()` so they bubble to Core.
- When yielding, the runtime MUST perform the listed commit/cancel behavior and call `preventDefault()` where specified.
- Text fields MUST NOT stop propagation for Escape. Draft fields MAY cancel local edits, but Escape always bubbles as `NAV/out` for global/view NAV-out handling.

Events that trigger commit/yield behavior:

- `Escape`: Cancels the draft session in draft mode and MUST NOT call `preventDefault()`.
- `Tab`: Commits the draft and MUST call `preventDefault()`. For `traversable` fields it MUST bubble. For `isolated` fields it MUST NOT bubble.
- `Enter`: Commits the draft and MUST call `preventDefault()`. For `isolated` fields it MUST NOT bubble. For `traversable` multiline fields, `metaKey`/`ctrlKey` allows newline and does not yield.
- Arrow keys: MUST yield only at text boundaries. Left yields at absolute start, right yields at absolute end, up yields on the first line for `textarea` (always for single-line input), and down yields on the last line for `textarea` (always for single-line input). When yielding, the runtime MUST commit the draft and call `preventDefault()`.
- `Backspace` at start: MUST commit the draft and call `preventDefault()`.
- `Delete` at end: MUST commit the draft and call `preventDefault()`.

### Pointerdown + focus integration

Rules:

- On `pointerdown`, focuses Core on this target and calls `stopPropagation()`.
- Pointer interactions inside a textfield therefore do not trigger enclosing frame pointerdown behavior.
- Caret placement is handled by the native input/textarea (browser default) when it receives focus.
- Pointerdown on the input/textarea MUST NOT override the browser's selection behavior.
- `focus` MUST synchronize Core selection to this field target.
- `focus` MUST start the draft session when applicable.
- Target MUST be registered via `ctx.target` with the default text caret adapter.

## Connected header helpers

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
- Header root (`.ui-header`) MUST set `contenteditable="false"` when mounted in contenteditable-hosted views.
- The label text field MUST use `buildTextField` with `kind="isolated"` (consumes Tab/arrows/Enter/Delete locally; only Escape bubbles).
- Connected rows render only when `item.mode.type === "connected"`.
- Each connected field MUST use `connTarget(field.key)` as target.
- Each connected field MUST use `buildTextField` with autosize enabled.
- Each connected field MUST commit through `commitConnField(field.key, text)`.
- Connected rows are keyed by `field.key` and reconciled with `ctx.list`.
- Render order matches `fieldsFromConn(conn)`.

## Drag system

Uses `pointerdown/pointermove/pointerup` exclusively — no HTML5 Drag and Drop API (`dragstart`/`drop`). Structural drag (pointer events) and CE text drag (HTML5 DnD) operate on separate browser event channels and do not conflict.

### Types

```ts
type DragState =
  | { type: "idle" }
  | {
      type: "pending";
      itemId: ItemId;
      pointerId: number;
      startX: number;
      startY: number;
    }
  | { type: "active"; itemId: ItemId; drop: DropTarget | null };

type DropTarget =
  | {
      type: "gap";
      parentId: ItemId;
      at: number;
      side: "before" | "after";
      axis: "horizontal" | "vertical";
      anchorEl: HTMLElement;
    }
  | { type: "slot"; itemId: ItemId; anchorEl: HTMLElement };

type DragController = {
  state: Signal<DragState>;
  dispose(): void;
};
```

### `createDragController(core)`

```ts
createDragController(core: Core): DragController
```

Creates a drag controller that manages pointer-driven item reordering.

Rules:

- Attaches global `pointerdown`, `pointermove`, `pointerup`, and `pointercancel` listeners.
- Drags MUST NOT start when the event target is inside an element marked `data-drag-start="block"`.
- Drags MUST NOT start on interactive elements (`input`, `textarea`, `select`, `button`) or readonly frames.
- Drags MUST NOT start on explicit `contenteditable="true"` edit surfaces (defensive guard; marker-based blocking remains the primary contract).
- `DragState` transitions: `idle` -> `pending` -> `active` -> `idle`.
- While pending/active, `document.documentElement.dataset.dragState` is `"pending"` or `"active"`.
- The dragged frame receives `is-dragging` while active.
- Escape cancels an active drag without committing.
- On `pointerup` while active, commits the drop atomically via `core.commit(...)`.
- `dispose()` MUST remove all global listeners.

Drop commit rules:

- `gap` drop: moves the item to the target position; cleans up the source vacancy.
- `slot` drop: swaps the item into the slot; labels are exchanged and the displaced item is removed.
- Newly-empty ancestor groups at the source are pruned (non-slot sources only).

Drag metadata contract:

- `data-drag-start="block"` marks a subtree as drag-start blocked while preserving normal pointer behavior. Views SHOULD use this marker explicitly for all non-draggable editing/chrome subtrees.
- `data-drag-slot="true"` marks a frame as eligible for slot-drop resolution.
- `data-drag-axis="horizontal" | "vertical"` hints the parent frame axis for gap placement; default is vertical.

### `buildDropIndicator(dragState)`

```ts
buildDropIndicator(dragState: Signal<DragState>): Component
```

Builds a fixed-position drop indicator component.

Rules:

- Tracks `dragState` reactively.
- When `dragState` is not `active` or has no drop target, the indicator is hidden.
- For `slot` drop targets, the indicator is hidden and `is-drop-target` is added to `anchorEl`.
- For `gap` drop targets, the indicator is shown at the near edge of `anchorEl`; `dataset.side` and `dataset.axis` are set for CSS targeting.
- `dispose()` removes `is-drop-target` from any slot element and stops the effect.

### Observable DOM outputs

- `document.documentElement.dataset.dragState`: `"pending"` or `"active"` while dragging; absent when idle.
- `.is-dragging`: on the source `.ui-frame` during an active drag.
- `.is-drop-target`: on a slot `anchorEl` when it is the current drop target.
- `.ui-drop-indicator`: the fixed-position indicator element managed by `buildDropIndicator`.

## Key parsing boundary

Key parsing is part of Core/system routing docs.

## Non-goals and integration points

Runtime (`dom/`) provides:

- Safe component lifecycle/disposal primitives.
- Safe dynamic mounting primitives (`slot`, `list`).
- Canonical editing and header widgets.

System design docs define:

- View architecture and composition.
- Location/selection routing policy.
- Visual language and layout rules.
