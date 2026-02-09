# Core API Overview

This document defines the public API and behavior of Core. All behavior described here is stable and supported.

Core provides:

- A reactive tree of items.
- A uniform read model.
- A transactional edit model.
- Selection and focus state.
- Undo/redo.
- View mounting.

## Creating core

```ts
createCore(opts): { core: Core, rootId: ItemId }
```

Creates a new Core instance.

- `rootId` is the ID of the root item.
- The root item always exists.
- The root item cannot be removed.
- `createCore` accepts an optional collaboration adapter that receives committed transactions and can apply remote transactions.
- A Core instance owns all state and must be explicitly disposed.

## Reactivity model

Core is reactive.

The following methods are reactive when called inside a reactive context:

- `core.item(id)`
- `core.selection()`
- `core.locate(id)`
- `core.view(id)`

When the underlying state they depend on changes, the reactive context re-runs. Each call returns the current snapshot at the time of evaluation. All other Core methods are non-reactive commands.

## Item IDs

```ts
type ItemId = string
```

An `ItemId` uniquely identifies an item.

- IDs are stable for the lifetime of the item.
- IDs returned by Core can always be passed back to Core.
- Undo/redo preserve item IDs for items that continue to exist.

## Items

```ts
type Item = {
  id: ItemId
  label?: string
  content: Content
  mode: Mode
}
```

```ts
core.item(id): Item
```

Returns the current state of an item.

If the ID does not exist or cannot be resolved, Core returns an item with:

- `content.kind === "issue"`
- `mode.kind === "readonly"`

This ensures `core.item` always succeeds.

## Item content

```ts
type Content =
  | { kind: "scalar", value: Scalar | null }
  | { kind: "group", children: readonly ItemId[] }
  | { kind: "issue", message: string }
```

### Scalar

- Represents a single value.
- `null` represents blank.

### Group

- Represents an ordered list of child items.
- Child order is stable unless explicitly changed by edits.

### Issue

- Represents an error state.

## Item modes and editability

```ts
type Mode =
  | { kind: "readonly" }
  | { kind: "direct" }
  | { kind: "source", source: Source }
```

### Editability rule

An item is editable if and only if:

```ts
item.mode.kind !== "readonly"
```

Core does not pre-filter edits by mode. Transactions may still fail (throw) if the model rejects them.

### Meaning of modes

Modes describe what kind of content an item currently has and what editing UI should be shown. They do not restrict what edits are allowed beyond the readonly rule.

### Readonly

- Item cannot be edited.
- Content is derived, computed, or invalid.

### Direct

- Item currently stores content directly.
- UI may present direct editing controls.
- Any edit may replace the item’s content.
- Converting to or from a group is allowed only if the group is empty.

### Source

- Item’s content is currently generated from a source.
- Source fields are editable.
- Any edit may replace the item’s content, including replacing the source with direct content.
- Converting to or from a group is allowed only if the group is empty.

## Sources

```ts
type Source =
  | { type: "derived", expr: string }
  | { type: "lens", from: string, where: string, orderBy: string }
```

Sources define how an item’s content is computed.

- `derived`: produces content from an expression.
- `lens`: selects and transforms items from a group.

The result of a source determines the item’s visible content kind (scalar or group).

## Editing

Edits are performed using transactions.

```ts
core.commit(tx => {
  // operations
}): ApplyResult
```

All operations inside a commit:

- Are applied atomically.
- Trigger reactive updates.
- Are recorded for undo/redo.

If a commit produces no ops, undo history is not extended.

### Transaction operations

```ts
tx.setLabel(id, label)
tx.setView(id, view)
tx.setScalar(id, value)
tx.setSource(id, source)
tx.insertChild(ownerId, opts)
tx.move(id, toOwnerId, opts)
tx.remove(id)
```

`setLabel`:

- Sets or replaces the item’s label.
- Within a single parent group, non-blank labels must be unique after trimming whitespace.
- If a label change would create a duplicate, the commit throws.

`setView`:

- Sets the preferred view for the item.

`setScalar`:

- Replaces the item’s content with a scalar value or blank.

`setSource`:

- Replaces the item’s content with a source definition.

`insertChild`:

- `opts?: { at?: number, kind?: "blank" | "group" }`
- Creates a new child item under `ownerId`.
- `kind: "blank"` → blank scalar item.
- `kind: "group"` → empty group item.
- If `at` is omitted, the item is appended.
- Returns the newly created item’s ID.

`move`:

- Moves an item to a new parent and/or index.
- If `toOwnerId` is `null`, the item is removed from its parent.
- `at` is the destination index; omitted means append.
- If a move would violate label uniqueness, the commit throws.

`remove`:

- Removes the item from the tree.

### ApplyResult

```ts
type ApplyResult = {
  created: readonly ItemId[]
  touched: readonly ItemId[]
  moved: readonly {
    fromOwnerId: ItemId | null
    toOwnerId: ItemId | null
    fromIndex: number | null
    toIndex: number | null
  }[]
}
```

Returned by:

- `commit`
- `undo`
- `redo`

This information may be used to coordinate follow-up behavior such as selection changes or animations.

## Location and structure

```ts
core.locate(id): {
  ownerId: ItemId
  index: number
  siblings: readonly ItemId[]
} | null
```

Returns the item’s position within its parent group.

- `siblings` reflects the full ordered list at the time of the call.
- Returns `null` if the item has no parent.

## Selection

```ts
type Selection =
  | { kind: "idle" }
  | { kind: "focused", focus: Focus, target: string, caret?: Caret }

type Focus = { container: ItemId, item: ItemId }
type Caret = { start: number, end: number }
```

### Reading

```ts
core.selection()
```

Returns the current selection state.

### Updating

```ts
core.focus(focus, target?, opts?)
core.blur()
```

- `focus` selects an item within a container.
- `target` selects a specific sub-target.
- `caret` sets the text cursor position.
- If `target` is omitted, Core uses `DEFAULT_TARGET`.
- If `opts` is omitted (or `opts.caret` is omitted), selection is focused without a caret.

If edits invalidate the current selection, Core automatically repairs selection to a valid state.

## Focus binding

```ts
core.attachTarget({
  focus,
  target,
  getEl,
  caret?
})
```

Registers a binding for a specific `(focus, target)` pair.

- `getEl()` returns the concrete DOM element to focus when selection matches `(focus, target)`.
- `caret` (if provided) allows Core to position the text cursor when this target is focused.
- Returns a cleanup function that must be called when the binding is no longer valid.
- One active binding per `(focus, target)`; new registrations replace the old.
- Replacement is per `(focus, target)` pair (independent of view nesting); the most recently attached binding wins until disposed.

### Selection application (DOM focus)

When selection is updated via `core.focus(...)`, Core applies it by:

- Resolving the registered `(focus, target)` binding (falling back to `(focus, DEFAULT_TARGET)` when needed).
- Focusing the returned DOM element.
- Applying caret state when supported.
- If no binding exists (or `getEl()` returns `null`), selection state still updates, but DOM focus may not move.
- Caret application is best-effort and only runs when the focused element supports it.

## Views and mounting

```ts
core.view(id): ViewName
core.mountView({ id, focus?, view: ViewName }): Component
```

`core.view(id)` returns the current view name for an item.

If the ID does not exist or the stored view cannot be resolved, Core returns the default view name.

`core.mountView(...)` mounts the requested view for an item and returns:

```ts
type Component = { el: HTMLElement, dispose(): void }
```

Calling `dispose` must release all resources associated with the view.

### View semantics

Some views have built-in meaning and behavior that Core enforces automatically.

### Active view and keyboard routing

When `core.focus(...)` updates selection, Core sets the active view from the focused DOM element.

- Active view is derived from the element focused via the `(focus, target)` binding (`getEl()`), not from pointer event targets.
- The active view is the closest mounted view root that contains the focused element.
- View routing therefore depends on bindings targeting an element inside the intended mounted view root.
- Global keyboard input is routed to `activeView.onKeyDown(...)` when the focused element is not a native text editor.
- Native text editors (`input`, `textarea`, `contenteditable`) handle text editing locally and may explicitly yield navigation intents to the view.

#### Table view

When an item’s view is `"table"`, Core treats it as a table:

- The table item is always a group.
- Each direct child is a row and is always a group.
- If the table item or a row is not already a group, Core coerces it into an empty group.
- Coercion occurs while applying edits and invariant repair (including commit/undo/redo), not as a read-time projection.
- Children of each row are columns, identified by their normalized, non-empty labels.

Core keeps all rows in the table structurally consistent:

- All rows share the same set and order of labeled columns.
- When one row changes, Core may create missing columns in other rows (as blank entries), reorder columns to match the table’s column order, and detach columns that are no longer part of the table shape.

These updates happen automatically and may create, move, or touch additional items beyond the original edit.

## Undo/redo

```ts
core.undo(): ApplyResult
core.redo(): ApplyResult
```

Undo/redo restore:

- Item content.
- Item structure.

Selection is repaired to remain valid, but is not historically restored. Undo history is linear; new edits clear the redo stack.

## Lifecycle

```ts
core.dispose()
```

Disposes all internal state.

- All reactive resources are released.
- All focus bindings are detached.
- No further calls are valid after disposal.

## Public Core API surface

The following exports constitute the supported Core API.

Core:

- `createCore`
- `core.item`
- `core.selection`
- `core.locate`
- `core.view`
- `core.commit`
- `core.undo`
- `core.redo`
- `core.focus`
- `core.blur`
- `core.attachTarget`
- `core.mountView`
- `core.dispose`

Types:

- `ItemId`
- `Item`
- `Content`
- `Mode`
- `Source`
- `Selection`
- `Focus`
- `Caret`
- `Component`
- `ViewName`
- `ViewKind`

Constants:

- `DEFAULT_TARGET: string`: Default focus target used when none is specified.

Scalar helpers:

- `parseScalar(text): Scalar | null`: Converts user-entered text into a scalar value.
