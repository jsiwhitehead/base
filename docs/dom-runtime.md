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
- `buildItemHeader`: canonical header subtree component.
- `NavDirection`: shared item-navigation direction type.
- Core runs shared item-selection `TYPE`/`CONFIRM` handoff before view delegation.
- `resolveFocusAfterRemove`: canonical post-remove destination helper.

Contenteditable helpers:

- `createSuppressionFlag`, type `SuppressionFlag`
- `renderPlainTextToContentEditable`, `readPlainTextFromContentEditable`
- `domPointToTextOffset`, `textOffsetToDomPoint`
- `setDomSelectionRange`, `setDomCaret`
- `getDomSelectionPointsInRoot`, `getMappedSelectionPointsInRoot`
- `getDomRangeInRoot`, `getMappedSelectionRangeInRoot`
- `getMappedRange`
- `getCollapsedCaretRectInSurface`, `getTextSurfaceLineRects`, `getDomPointFromViewport`
- `hasActiveSelectionInSurface`
- `getSurfaceFromNodeInRoot`, `getTextNodeFromMutationRecord`
- `getPlainTextFromDataTransfer`, `writePlainTextClipboard`

Drag helpers:

- `createDragController`: creates the drag-and-drop controller.
- `buildDropIndicator`: builds the drop-position indicator component.

Runtime integration helpers/types:

- `UiCore`: DOM-facing composed API (`Core` plus runtime-backed methods such as view mounting and target binding).
- `bindUiRuntime`: composes a headless `Core` with the DOM runtime and returns `{ core: UiCore, runtime }`.
- `defineView`, `defineShapedView`: view-definition helpers for DOM-backed views.
- `Component`, `DomView`, `ViewRegistration`, `ViewFactory`: runtime-facing DOM view types.
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
  target(location, target, getEl, opts?);
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

### `ctx.target(location, target, getEl, opts?)`

Registers a focus target with Core.

Rules:

- The target registration lifetime is bound to component disposal.
- `getEl()` resolves the element Core should focus.
- `opts.primary`, when `true`, marks this binding as the location's primary body target.
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
- Sets `data-id = location.item`.
- If `tabindex` is absent, sets `tabIndex = -1`.
- Registers `ITEM_TARGET` on `frameEl` via `ctx.target`.
- On `pointerdown`, MUST focus Core on `ITEM_TARGET` for the same item location.
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

- Editing selection resolves from the exact bound `(location, target)`.
- Item selection resolves from bound `ITEM_TARGET`s at both endpoints.
- Non-root item selection must resolve to a mounted view.
- Exact root item selection does not resolve through a mounted view; it routes to the root outer handler.
- Missing bindings or mixed/cross-view item selection are invariant violations.

### Shared item-selection handoff

- Core runs this before view-specific intent delegation.
- It resolves the primary target from registered body targets first, then header text targets.
- `TYPE` only hands off when the primary target is `content:text`; it inserts the character and focuses that target.
- `CONFIRM` enters the primary target with the caret at end.

### `resolveFocusAfterRemove(core, removedId, prefer, portals)`

Behavior:

- Landing order after remove: preferred sibling, opposite sibling, then parent.
- Parent fallback is valid only if that parent survives the same remove/prune commit.
- Returns `null` when no live destination exists (caller/Core repair handles fallback).
- Returned location keeps the same `portals`.
- Local remove handlers SHOULD pass the current selection portals.
- Use `portals: []` only for explicit Core root/repair fallback, not normal view landing.

## `buildTextField` contract

Canonical shared text-editing component.

### Signature and return

```ts
buildTextField(core, {
  location,
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

- `kind="isolated"` means the field consumes all keydowns locally (does not bubble), except Escape and explicit Core-global modifier shortcuts.
- `kind="traversable"` means the field yields arrow and delete-boundary keys at boundaries so the active view can handle navigation and structural edits.
- `onExitToItem` MAY be provided for isolated fields. When Enter or Tab is pressed, the field commits, prevents default, and calls this callback.

Propagation-gating rules:

- Locally handled keydowns MUST call `stopPropagation()` so they do not reach global key routing.
- Yielded keydowns MUST NOT call `stopPropagation()` so they bubble to Core.
- When yielding, the runtime MUST perform the listed commit/cancel behavior and call `preventDefault()` where specified.
- Text fields MUST NOT stop propagation for Escape. Draft fields MAY cancel local edits, but Escape always bubbles as `NAV/out` for global/view NAV-out handling.
- Text fields MUST NOT stop propagation for Core-global modifier shortcuts such as `Cmd/Ctrl+.`.

Events that trigger commit/yield behavior:

- `Escape`: Cancels the draft session in draft mode and MUST NOT call `preventDefault()`.
- `Cmd/Ctrl+.`: MUST bubble unchanged to Core global routing.
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
- Header root (`.ui-header`) MUST set `contenteditable="false"` when mounted inside a `contenteditable="true"` editing surface.
- The label text field MUST use `buildTextField` with `kind="isolated"` (consumes Tab/arrows/Enter/Delete locally; only Escape bubbles).
- Connected rows render only when `item.mode.type === "connected"`.
- Each connected field MUST use `connTarget(field.key)` as target.
- Each connected field MUST use `buildTextField` with autosize enabled.
- Each connected field MUST commit through `commitConnField(field.key, text)`.
- Connected rows are keyed by `field.key` and reconciled with `ctx.list`.
- Render order matches `fieldsFromConn(conn)`.

## Drag system

Uses `pointerdown/pointermove/pointerup` exclusively — no HTML5 Drag and Drop API (`dragstart`/`drop`). Structural drag (pointer events) and contenteditable text drag (HTML5 DnD) operate on separate browser event channels and do not conflict.

### Types

```ts
type DragState =
  | { type: "idle" }
  | {
      type: "pending";
      cleanupType: DragType;
      itemId: ItemId;
      pointerId: number;
      startX: number;
      startY: number;
    }
  | {
      type: "active";
      cleanupType: DragType;
      itemId: ItemId;
      drop: DropTarget | null;
    };

type DragType = "reorder" | "slot";

type DropTarget =
  | {
      type: "gap";
      parentId: ItemId;
      at: number;
      side: "before" | "after";
      anchorEl: HTMLElement;
      referenceItemId?: ItemId;
    }
  | { type: "replace"; itemId: ItemId; anchorEl: HTMLElement };

type DragController = {
  state: Signal<DragState>;
  dispose(): void;
};
```

### `createDragController(core)`

```ts
createDragController(core: Core): DragController
```

Creates the structural pointer-drag controller.

Rules:

- Attaches global `pointerdown`, `pointermove`, `pointerup`, and `pointercancel` listeners.
- Drag start is opt-in via `data-drag="reorder" | "slot"` on a drag surface or frame.
- Drags do not start on interactive elements, readonly frames, or explicit `contenteditable="true"` edit surfaces.
- `DragState` transitions `idle -> pending -> active -> idle`.
- Successful drag start captures the active pointer on the source frame and releases capture through the shared cancel/finish path.
- While pending or active, `document.documentElement.dataset.dragState` is `"pending"` or `"active"`.
- The source frame receives `is-dragging` while active.
- Escape cancels an active drag.
- `pointerup` while active commits the resolved drop atomically through `core.commit(...)`.
- `dispose()` MUST remove all global listeners.

Drop rules:

- `data-drag="reorder"` on the source removes the source item on success and prunes newly empty source ancestors when needed.
- `data-drag="slot"` on the source clears the source slot on success.
- Hovered `data-drag="reorder"` resolves a vertical `gap` from the upper/lower half.
- Hovered `data-drag="slot"` resolves `replace` in the middle band and parent-level `gap` in the top/bottom bands.
- `slot` edge-band `gap` drops insert a new parent-level group entry and move the dragged item into it.

Drag contract:

- `data-drag="reorder"` marks a reorder drag surface.
- `data-drag="slot"` marks a slot drag surface.

### `buildDropIndicator(dragState)`

```ts
buildDropIndicator(dragState: Signal<DragState>): Component
```

Builds a fixed-position drop indicator component.

Rules:

- Tracks `dragState` reactively.
- Hidden when drag is not active or no drop target is resolved.
- `replace` highlights `anchorEl` with `is-drop-target` and hides the line indicator.
- `gap` shows the line indicator at the near vertical edge of `anchorEl`.
- `dispose()` removes `is-drop-target` and stops the effect.

### Observable DOM outputs

- `document.documentElement.dataset.dragState`: `"pending"` or `"active"` while dragging; absent when idle.
- `.is-dragging`: on the source `.ui-frame` during an active drag.
- `.is-drop-target`: on the current replace target.
- `.ui-drop-indicator`: the fixed-position gap indicator.

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
