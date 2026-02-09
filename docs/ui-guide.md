# UI Design Guide

This guide describes the UI system layered on Core. The goals are:

- Predictable (selection drives focus and interaction).
- Composable (nested views work without coupling).
- Minimal (small DOM + small set of conventions).
- Consistent across views.

## Core mental model

### Selection is the single source of truth

Core always has one selection:

- `idle`
- `focused: { focus: { container, item }, target, caret? }`

All navigation and editing is expressed as updates to selection via:

- `core.focus(...)`
- `core.blur()`

### Reactivity and DOM stability

Selection changes are frequent and must be cheap.

- Selection-driven updates must be styling-only (e.g. `data-focused`) and must not rebuild structure.
- Structural DOM updates must depend on item state (`core.item(id)`), not selection.
- Any code that needs selection inside a component should depend on a local primitive computed (e.g. `isFocused`) rather than reading `core.selection()` in broad effects.

### Views do not track focus manually

- Views attach logical targets to DOM elements via `core.attachTarget(...)`.
- Runtime focuses the correct DOM element when selection changes.
- Active view is derived from the focused DOM element (closest view root).
- No pointer-based “active view tracking” exists.

## Two roles everywhere: Presenter vs Content

### Presenter (owned by the parent/context view)

Presenter renders exactly one wrapper element for an item as presented inside a parent view.

Presenter responsibilities:

- Render exactly one wrapper element.
- Attach `DEFAULT_TARGET` to that wrapper:

```ts
ctx.target(focus, DEFAULT_TARGET, () => presenterEl)
```

- Place the child `.ui-item` directly inside the wrapper.
- Handle pointer selection on the wrapper:

```ts
core.focus(focus, DEFAULT_TARGET, { caret? })
```

- Style via `:has(> .ui-item[...])` (Presenter reads state from its child `.ui-item`).
- Presenter must not mount/unmount child content based on selection.

Presenter constraints:

- Presenter is not `.ui-item`.
- Presenter never calls `applyUiItemState`.
- Presenter never attaches non-default targets.

### Content (owned by the item’s view)

Content is the item view implementation.

Content responsibilities:

- Render exactly one root element: `.ui-item`.
- Call `applyUiItemState(.ui-item, { id, view, kind, mode, part? })` based on `core.item(id)`.
- Set `data-focused` separately from a local `isFocused` computed.
- Attach only non-default targets.
- Render the item’s internal structure, controls, and editors.

Non-default targets include:

- `value`
- `label`
- `source:*`

Content constraints:

- `.ui-item` never attaches `DEFAULT_TARGET`.
- Content may still call `core.focus(...)` to move to Presenter/`DEFAULT_TARGET` when appropriate.
- Content must not mount/unmount structural subtrees based on selection; selection may only affect styling or editor state.

## Item ownership and view composition

### One item → one Content view at a time

- Each Core item is rendered by exactly one view as Content at a time.
- That view owns the `.ui-item` subtree.

### Nesting uses `core.view(...)` + `core.mountView(...)`

When a view wants to render a child item:

```ts
const view = core.view(id)
const comp = core.mountView({ id, focus, view })
```

- `core.view(id)` decides the desired view name (reactive when read in a reactive context).
- `core.mountView(...)` mounts exactly the requested view.
- Continue/fallback behavior is handled by the hosting view, not by Core.
- The returned component’s `.el` is Content (a `.ui-item` root).

### Parent supplies Presenter around child Content

Regardless of whether child Content came from:

- `core.mountView(...)`, or
- Parent continuing rendering itself,

The parent still creates the Presenter wrapper for that child item and attaches `DEFAULT_TARGET` there.

This makes all parent/child pairings consistent.

### Embedded-only roles: Presenter optional

If an item is rendered in a role that is guaranteed to only ever appear inside one specific parent view context (not independently mountable or presented by arbitrary views), then:

- Content `.ui-item` may attach `DEFAULT_TARGET` directly.
- No Presenter wrapper is required.

Why: The normal rule exists to prevent conflicts when an item can be presented in multiple contexts. Embedded-only roles have no ambiguity, so skipping Presenter reduces DOM without risk.

This is an exception. The default pattern is always Presenter + Content.

## `.ui-item` contract

### `.ui-item` semantics

`.ui-item` represents:

- Exactly one Core item.
- In exactly one view context (the owning Content view).

### Required state on `.ui-item`

`applyUiItemState` sets:

- `data-id`
- `data-view` (owning view)
- `data-kind`
- `data-mode`

Optional:

- `data-part` (only when a view renders multiple meaningful item roles)

Focus styling sets:

- `data-focused`

Focus (`data-focused`) is derived from selection and must not force structural work.

No other element represents an item.

## Mode vs editability (UI contract)

### Core truth

From Core’s perspective:

- An item is editable iff `item.mode.kind !== "readonly"`.
- Core exposes mode state; UI must respect readonly.
- Core does not pre-filter edits by mode, and invalid transactions may still throw.

### UI default behavior

UI behavior should generally follow `item.mode.kind`:

- `direct`: render direct content editors.
- `source`: render source-related editors; derived output is not directly edited by default.
- `readonly`: render read-only views only.

### Mode conversion

The UI may intentionally convert mode (`direct` ↔ `source`), but:

- It must be explicit.
- It must be intentional.
- It must not happen implicitly during normal editing.

## Focus targets

### Targets per item

Each item exposes:

- Exactly one `DEFAULT_TARGET` focus target.
- 0..N edit targets.

Edit targets include:

- `value`
- `label`
- `source:<fieldKey>`

Views should not invent additional target patterns unless unavoidable.

The `label` target is a valid target, but it is not part of the normal Enter/typing-from-`DEFAULT_TARGET` edit flow.

### Target attachment rules

- Presenter attaches `DEFAULT_TARGET`.
- Content attaches all non-default targets.

### Caret rules

- Caret values are meaningful only for targets that support text cursor placement (typically edit targets).

## Tabbability and keyboard routing

### One tabbable element total

- Exactly one tabbable element in the whole app: the top-level app root.
- No browser tab-order navigation is used.

### Tab / Shift+Tab are always app commands

- Tab is never used for browser focus traversal.
- Even when editing text, Tab is defined by the view (e.g. outline indent).

### Programmatic focus only

- Presenter/content targets may be focusable programmatically.
- Targets other than the app root are not tabbable.

## Controls and yielding

### Controls

Controls are reusable UI building blocks.

Controls:

- Do not create `.ui-item`.
- Are always owned by a view.
- Participate in focus only via the view that contains them.

### Yielding is semantic, not bubbling

When an editor wants to yield to navigation/commands, it does not “bubble key events”. Instead it emits semantic intents like:

- `NAV`
- `ENTER`
- `TAB(shift)`
- `ESCAPE`
- `DELETE_AT_BOUNDARY`

This allows view-specific rules to be implemented cleanly.

## Universal interaction rules

### Escape ladder

- If focused on an edit target → Escape moves to `DEFAULT_TARGET`.
- If focused on `DEFAULT_TARGET` → Escape blurs to idle (`core.blur()`).

### Pointer (click) behavior

- Presenters should handle `pointerdown` by focusing `DEFAULT_TARGET`.

### Enter and typing from `DEFAULT_TARGET`

When focused on `DEFAULT_TARGET`:

- Enter enters edit using the first editable target (if any), caret at end.
- Typing enters edit using the first editable target and replaces existing text (select-all then type).

### Navigation does not implicitly enter edit

When a navigation command moves to a different item:

- The destination is focused in `DEFAULT_TARGET` mode.
- Navigation never auto-enters edit as a side effect.

## View-specific navigation principles

### Outline

Outline has two related but distinct position spaces:

1. Presenter geometry (structural selection over items).
2. Edit-flow geometry (editing traversal over editable targets).

`DEFAULT_TARGET` navigation:

- Up/Down = previous/next presented item in outline order.
- Left = parent (if any).
- Right = first child (if any).

Entering edit:

- From `DEFAULT_TARGET`, Enter/typing enters first editable target if present.
- If item has no edit targets, Enter advances like ArrowDown.

Edit-flow traversal (outline only):

When focused on an edit target, boundary-arrow moves may:

- Move to a different item.
- Remain in an edit target on the destination item (next edit stop).

Edit stops:

- DFS over presented outline items.
- For each item, `getEditableTargets(item)` contributes 0..N stops.
- Readonly outputs contribute 0 edit targets and are naturally skipped.

Structural edits:

- Tab / Shift+Tab = indent / outdent (from edit or `DEFAULT_TARGET`).

### Table

Table is primarily structural/spatial.

`DEFAULT_TARGET` navigation:

- Arrows move spatially across the grid (row/column).
- Tab / Shift+Tab = prev/next column (cell selection movement).
- Enter = enter edit (first editable target), caret at end.
- Typing = enter edit + replace.

Edit navigation (cell editor focused):

- Text editing is standard inside the field.
- Any command that moves to a different cell/item lands in `DEFAULT_TARGET` mode on the destination (e.g. Tab / Shift+Tab, Enter, arrows).

## Styling conventions

### Data-driven styling

Styling is driven primarily by `.ui-item` data attributes (state from `applyUiItemState`, plus `data-focused` and optional `data-part`).

### Layout + chrome live on Presenter

- Presenter provides geometry and chrome.
- Presenter styles itself based on its direct child `.ui-item` using `:has(...)`.

### CSS must not assume child view structure

- CSS should not assume a specific child view implementation.
- Views should not rely on other views’ DOM internals.

## Minimal DOM and composition rules

### Minimal DOM principle

- DOM structure should be minimal and intentional.
- Wrappers are introduced only when required.

### Composition rules

- Views are independent and composable.
- Views do not reach into other views’ DOM.
- Views do not special-case other views.
- Adding a new view must not require changes to existing views.

## Summary of invariants

- One item → one `.ui-item` (Content root).
- `.ui-item` is owned by its Content view.
- `applyUiItemState` always applies to the `.ui-item` root.
- Two roles everywhere: Presenter vs Content.
- Presenter attaches `DEFAULT_TARGET` only.
- Content attaches non-default targets only.
- One tabbable element total (app root).
- No browser tab-order navigation.
- Tab / Shift+Tab are always app commands.
- Nested view composition is driven by `core.view(id)` + `core.mountView(...)`.
- Focus is item-based and routed by Core.
- Selection changes must not replace `.ui-item` roots or presenter surfaces; tests assert DOM node identity stability across navigation.
- `pointerdown` should only change selection/focus state; it should not trigger mount/unmount.
