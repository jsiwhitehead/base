# UI Runtime (`dom/`)

This document is the normative external specification for the `dom/` layer.

## Scope

This document defines:

- Public API exported from `dom/index`.
- The DOM runtime adapter contract over headless Core.
- Required DOM/class outputs for runtime-provided subtrees.
- Observable runtime behavior (focus integration, yielding, disposal, reconciliation).

## Exports index (`dom/index`)

Base helpers:

- `createComponent`: lifecycle-safe component factory.
- `el`: small DOM element constructor helper.
- `bindItemFrame`: canonical `.ui-frame` binding helper.
- `setBodyClasses`: canonical body-root class helper.

Controls/editing helpers:

- `mountHeader`: canonical shared header subtree mount helper.
- `NavDirection`: shared item-navigation direction type.

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
- Editing selection MUST focus the bound edit target.
- Item selection MUST clear any active DOM document selection from `contenteditable` surfaces first, then focus the owning structural `ITEM_TARGET` surface (or the root shell for exact root item selection).
- Idle MUST clear DOM text selection and DOM focus.
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

- `child.dispose()` MUST run when the parent component disposes.

### `ctx.slot(host, getComponent)`

Manages an optional child component region inside `host`.

Rules:

- At most one child component is mounted at a time.
- On recompute, the runtime clears the region, disposes the previous child, then mounts the next child if non-null.
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
- On `pointerdown`, when the event reaches the frame, `bindItemFrame` MUST own the hit: it MUST call `stopPropagation()`, MUST NOT set caret, and MUST either focus Core on `ITEM_TARGET` for the same item location or preserve active nested editing.
- MUST reactively toggle `.is-selected` and `.is-item-selected` as selection state changes.
- MUST reactively toggle `.is-issue`.

## Body/root helper

### `setBodyClasses(root, view)`

Rules:

- Adds `ui-body`.
- Adds `ui-${view}`.

## Editing helpers

Routing and shared item-selection handoff follow `docs/architecture.md`.

Runtime-specific rules:

- Editing selection resolves from the exact bound `(location, target)`.
- Item selection resolves from bound `ITEM_TARGET`s at both endpoints.
- Non-root item selection must resolve to a mounted view.
- Exact root item selection does not resolve through a mounted view; it routes to the root outer handler.
- Missing bindings or mixed/cross-view item selection are invariant violations.

## Shared header helper

### `mountHeader(ctx, args)`

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

- `mountHeader` mounts the shared header subtree into `args.host`.
- `visibility: "always"` MUST always mount the header.
- `visibility: "auto"` MUST mount the header only when the item has a non-empty label, is in connected mode, or the current selection is editing the label target for the same location.
- Header root (`.ui-header`) MUST set `contenteditable="false"` when mounted inside a `contenteditable="true"` editing surface.
- Label field uses target `LABEL_TARGET` and stays local. `Enter` commits and exits to same-item item selection. `Escape` cancels and exits to same-item item selection. `Tab` / `Shift+Tab` commit and no-op.
- Connected rows render only when `item.mode.type === "connected"`.
- Connected rows are keyed by `field.key`, reconciled with `ctx.list`, and rendered in canonical shared-header field order for the connected mode.
- Each connected field MUST use `connTarget(field.key)` as target and commit through `commitConnField(field.key, text)`.
- Connected fields MUST autosize to their current text.
- Connected fields MUST commit on Enter/Tab, cancel on Escape, and move on Tab/Shift+Tab within the canonical shared-header field order when another field exists. Otherwise Tab/Shift+Tab commit and no-op.

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
