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
- Any code that needs selection inside a component should prefer a local primitive computed (e.g. `isFocused`) rather than reading `core.selection()` in broad effects.
- When swapping child components via `slot.set(...)`, gate swaps with a stable discriminator (e.g. `view`, `kind`) so reactive reruns do not remount unchanged structure.
- The body component is swapped only when `core.view(id)` (or another item-driven discriminator such as `kind`) changes, not when selection changes.

### Views do not track focus manually

- Views attach logical targets to DOM elements via `core.attachTarget(...)`.
- Runtime focuses the correct DOM element when selection changes.
- Global keydown is delivered to the current root `DomView.onKeyDown`.
- Root view behavior is selection-driven and updates selection.
- Views must not store module-level “active view” state.

## Two layers: Shell vs Body

### Shell (owned by the parent/context view)

Shell renders exactly one wrapper element for each presented item. That wrapper is the `.ui-item`.

Shell responsibilities:

- Add `.ui-item` class.
- Apply `applyUiItemState(.ui-item, { id, view, kind, mode, part? })` using `core.item(id)` and `core.view(id)`.
- Maintain `data-focused`.
- Attach `DEFAULT_TARGET` to the shell:

```ts
ctx.target(focus, DEFAULT_TARGET, () => shellEl)
```

- Handle pointer selection on the shell:

```ts
core.focus(focus, DEFAULT_TARGET, { caret? })
```

- Shell must not mount/unmount body content based on selection.
- Shell keeps one stable element instance for that presented item.

Shell constraints:

- Shell attaches `DEFAULT_TARGET` only.
- Shell must not attach any non-default targets.

### Body (owned by the item’s view)

Body is the mounted item view implementation.

Body responsibilities:

- Render the inner content only (value/body UI) inside the shell.
- Attach only non-default targets.
- Render the item’s internal structure, controls, and editors.

Non-default targets include:

- `value`
- `label`
- `source:*`

Body constraints:

- Body never attaches `DEFAULT_TARGET`.
- Body may still call `core.focus(...)` to move to shell/`DEFAULT_TARGET` when appropriate.
- Body may include chrome only when it is truly body-owned; otherwise keep chrome in the parent/context view.
- Body must not mount/unmount structural subtrees based on selection; selection may affect styling, caret/selection ranges, and editor state.

## Item ownership and view composition

### One item → one shell + one body at a time

- Each Core item is presented by exactly one parent/context at a time, which owns the `.ui-item` shell.
- The mounted view owns only the body subtree inside that shell.
- A view's `DomView.root` renders body only; its parent/context provides the `.ui-item` shell.

### Nesting uses `core.view(...)` + `core.mountView(...)`

When a view wants to render a child item:

```ts
const shell = el("div", "ui-item")
bindUiItemShell(ctx, { core, focus, part }, shell)

const body = core.mountView({ id, focus, view: core.view(id) })
shell.append(body.el)
ctx.cleanup(() => body.dispose())
```

- `core.view(id)` decides the desired view name (reactive when read in a reactive context).
- `core.mountView(...)` mounts exactly the requested view.
- Continue/fallback behavior is handled by the hosting view, not by Core.
- The returned component’s `.el` is body content mounted inside the shell.

### Parent/context always supplies the shell around body

Regardless of whether body came from:

- `core.mountView(...)`, or
- Parent continuing rendering itself,

The parent/context still creates the same `.ui-item` shell and attaches `DEFAULT_TARGET` there.

## `.ui-item` contract

### `.ui-item` semantics

`.ui-item` represents:

- Exactly one Core item.
- As presented in exactly one parent/context.

### Required state on `.ui-item`

`applyUiItemState` sets:

- `data-id`
- `data-view` (derived from `core.view(id)`)
- `data-kind`
- `data-mode`

`data-view` is the view currently mounted as the item's body (from `core.view(id)`), not the parent/context view.

Optional:

- `data-part` (only when a view renders multiple meaningful item roles)

Focus styling sets:

- `data-focused`

Focus (`data-focused`) is derived from selection and must not force structural work.

The shell applies this state and serves as the item focus surface. No other element represents an item.

## Mode vs editability (UI contract)

### Core truth

From Core’s perspective:

- An item is editable iff `item.mode.kind !== "readonly"`.
- Core exposes mode state; UI must respect readonly.
- Core does not pre-filter edits by mode.
- UI should not rely on exceptions for user-input validation.
- Invalid user input should round-trip through Core issue state and be rendered from Core.
- Core may still throw for programmer errors or invariant violations.

### UI default behavior

UI behavior should generally follow `item.mode.kind`:

- `direct`: render direct content editors.
- `source`: render source-related editors; derived output is not directly edited by default.
- `readonly`: render read-only views only.

`readonly` is the hard stop. `direct` vs `source` determines which editor targets exist.

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

- Shell attaches `DEFAULT_TARGET`.
- Body attaches all non-default targets.

### Caret rules

- Caret values are meaningful only for targets that support text cursor placement (typically edit targets).

## Tabbability and keyboard routing

### One tabbable element total

- Exactly one tabbable element in the whole app: the top-level app root.
- No browser tab-order navigation is used.

### Tab / Shift+Tab are always app commands

- Tab is never used for browser focus traversal.
- Even when editing text, Tab is defined by the view.

### Programmatic focus only

- Shell/body targets may be focusable programmatically.
- Targets other than the app root are not tabbable.

### Keyboard routing

- Global keydown routes to the currently mounted root view instance.
- Views interpret selection and dispatch navigation/edit intents.

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
- `TAB`
- `CONFIRM`
- `CANCEL`
- `DELETE`
- `DELETE_BOUNDARY`
- `TYPE`

This allows view-specific rules to be implemented cleanly.

## Universal interaction rules

### Escape ladder

- If `sel.kind === "focused"` and `sel.target !== DEFAULT_TARGET` → Escape moves to `DEFAULT_TARGET`.
- Otherwise Escape blurs to idle (`core.blur()`).

### Pointer (click) behavior

- `.ui-item` shells should handle `pointerdown` by focusing `DEFAULT_TARGET`.

### Enter and typing from `DEFAULT_TARGET`

When focused on `DEFAULT_TARGET`:

- Enter (`CONFIRM`) enters edit using the first edit target (if any), usually caret at end.
- Typing (`TYPE`) enters edit using the first edit target and replaces existing text (select-all then type).
- These are distinct entry modes: Enter is not select-all.

### Editor commit models

- Live editors commit on `input` (and only on `input`).
- Draft editors keep local draft while focused; commit on `CONFIRM`, `TAB`, yielded `NAV`, or `blur`.
- Draft editors cancel on `CANCEL`.
- Draft state exists only for the focused edit session; once focus leaves, draft resets to the committed Core value.
- In multiline editors, `Enter` commits and `Mod+Enter` inserts newline.

### Navigation does not implicitly enter edit

When a navigation command moves to a different item:

- The destination is focused in `DEFAULT_TARGET` mode.
- Navigation never auto-enters edit as a side effect.

## View-specific navigation principles

### Outline

Outline has two related but distinct position spaces:

1. Shell geometry (structural selection over items).
2. Edit-flow geometry (editing traversal over edit targets).

`DEFAULT_TARGET` navigation:

- Up/Down = previous/next presented item in outline order.
- Left = parent (if any).
- Right = first child (if any).

Entering edit:

- From `DEFAULT_TARGET`, Enter/typing enters first edit target if present.
- If item has no edit targets, Enter performs the view's structural default.

Edit-flow traversal (outline only):

- When focused on an edit target, Arrow keys traverse the edit-flow space.
- Traversal moves to the next/previous edit stop and stays in edit (target remains non-default).
- Caret policy: forward sets caret at start; backward sets caret at end.

Edit stops:

- DFS over presented outline items.
- For each item, the view defines 0..N edit stops (targets).
- Readonly outputs contribute 0 edit targets and are naturally skipped.

Structural edits:

- Tab / Shift+Tab = indent / outdent (from edit or `DEFAULT_TARGET`).

### Table

Table is primarily structural/spatial.

`DEFAULT_TARGET` navigation:

- Arrows move spatially across the grid (row/column).
- Tab / Shift+Tab = prev/next column (cell selection movement, landing on `DEFAULT_TARGET`).
- Enter = enter edit (first edit target), caret at end.
- Typing = enter edit + replace.

Edit navigation (cell editor focused):

- Text editing is standard inside the field.
- Enter commits/exits edit and moves down one row in the same column, landing on destination `DEFAULT_TARGET`.
- Tab / Shift+Tab move to next/prev column, landing on destination `DEFAULT_TARGET`.
- Arrow keys may move out of the editor at boundaries (yield), landing on destination `DEFAULT_TARGET`.

## Styling conventions

### Data-driven styling

Styling is driven primarily by `.ui-item` data attributes (state from `applyUiItemState`, plus `data-focused` and optional `data-part`).

### Layout + chrome live on the shell

- The `.ui-item` shell provides geometry and chrome.
- Styling reads directly from `.ui-item[data-*]`.

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

- One item → exactly one `.ui-item` shell (created by the parent/context that presents it).
- `.ui-item` shell applies state (`applyUiItemState`), attaches `DEFAULT_TARGET`, and handles `pointerdown` focus.
- `applyUiItemState` always applies to the `.ui-item` root.
- Two layers everywhere: Shell vs Body.
- Shell attaches `DEFAULT_TARGET` only.
- Body attaches non-default targets only.
- One tabbable element total (app root).
- No browser tab-order navigation.
- Tab / Shift+Tab are always app commands.
- Nested view composition is driven by `core.view(id)` + `core.mountView(...)`.
- Focus is item-based and routed by Core.
- Global keydown routes to the stable mounted root view instance (no mount-per-key).
- Selection changes must not replace `.ui-item` shell nodes; tests assert DOM node identity stability across navigation.
- Item-driven structure changes may replace descendants below `.ui-item`, but `.ui-item` root identity remains stable unless the mounted view changes.
