# Core API Overview

This document defines the supported Core API contract and the behavior that callers can rely on. It is the authoritative reference for Core types, commands, and invariants. UI-layer behavior is documented separately in `docs/ui-system.md` and `docs/ui-views.md`.

## Scope

This document covers:

- Public Core types and constants.
- Core commands and reactive reads.
- Structural, selection, and view-mounting invariants.

This document does not cover:

- UI ownership and DOM conventions.
- Styling behavior.
- View-specific interaction semantics beyond Core-enforced rules.

## Creating Core

```ts
createCore(opts): { core: Core; rootId: ItemId }
```

Creates a new Core instance.

Rules:

- `rootId` MUST reference the root item.
- The root item MUST always exist.
- The root item MUST NOT be removed.
- `createCore` MAY receive a collaboration adapter that receives committed transactions and can apply remote transactions.
- `createCore` MAY receive a view-factory registry used by `core.mountView(...)`.
- A Core instance owns all state and MUST be explicitly disposed.

## Reactivity model

Core exposes reactive reads and imperative commands.

The following methods are reactive when called inside a reactive context:

- `core.item(id)`.
- `core.selection()`.
- `core.locate(id)`.
- `core.view(id)`.

Rules:

- A reactive read MUST return the current snapshot at evaluation time.
- When underlying state changes, dependent reactive contexts MUST re-run.
- All other Core methods SHOULD be treated as non-reactive commands.

## Item IDs

```ts
type ItemId = string;
```

An `ItemId` uniquely identifies an item.

Rules:

- IDs MUST remain stable for the lifetime of the item.
- IDs returned by Core MUST always be valid inputs back into Core.
- Undo/redo MUST preserve IDs for items that continue to exist.

## Items

```ts
type Item = {
  id: ItemId;
  label?: string;
  content: Content;
  mode: Mode;
};
```

```ts
core.item(id): Item
```

Returns the current item snapshot.

Fallback behavior:

- If `id` cannot be resolved, `core.item(id)` MUST still return an `Item`.
- The fallback item MUST use `content.kind === "issue"`.
- The fallback item MUST use `mode.kind === "readonly"`.

## Item content

```ts
type Content =
  | { kind: "value"; value: Value | null }
  | { kind: "group"; children: readonly ItemId[] }
  | { kind: "issue"; message: string };
```

Kinds:

- `value`: Represents a single value. `null` means blank.
- `group`: Represents an ordered list of child items.
- `issue`: Represents an error state.

Rules:

- Group child order MUST remain stable unless changed by edits.

## Item modes and editability

```ts
type Mode =
  | { kind: "readonly" }
  | { kind: "plain" }
  | { kind: "connected"; conn: Connected };
```

Editability rule:

```ts
item.mode.kind !== "readonly";
```

Rules:

- An item MUST be editable if and only if the editability rule evaluates true.
- Core MUST NOT pre-filter edits by mode.
- Transactions MAY still fail if the model rejects them.

Meaning:

- `readonly`: item content is computed or invalid; editing is blocked.
- `plain`: item stores direct content.
- `connected`: item content is generated from a connected definition.

Notes:

- `plain` and `connected` describe current content semantics and UI intent.
- Except for `readonly`, modes do not add extra edit restrictions beyond model invariants.

## Connected definitions

```ts
type Connected =
  | { kind: "formula"; expr: string }
  | { kind: "query"; from: string; where: string; orderBy: string };
```

Connected definitions describe how item content is computed.

Rules:

- `formula` MUST compute content from `expr`.
- `query` MUST compute content from `from`/`where`/`orderBy`.
- The computed result MUST determine whether visible content is `value` or `group`.

## Editing and transactions

All edits are performed in transactions.

```ts
core.commit((tx) => {
  // operations
}): ApplyResult
```

Commit rules:

- Transaction operations MUST apply atomically.
- A successful commit MUST trigger reactive updates.
- A successful commit MUST be recorded for undo/redo.
- If a commit produces no ops, undo history MUST NOT be extended.

### Transaction operations

```ts
tx.setLabel(id, label);
tx.setView(id, view);
tx.setValue(id, value);
tx.setConnected(id, conn);
tx.setGroup(id);
tx.insertChild(parentId, opts);
tx.move(id, toParentId, opts);
tx.remove(id);
```

### Group conversion rule

Content may switch between `group` and non-group (`value`/`connected`) only when the group is empty.

Rule:

- If an operation would convert a non-empty group to non-group, the commit MUST throw.

### Operation contracts

`setLabel`:

- Sets or replaces the item label.
- Within one parent group, non-blank labels MUST be unique after trimming whitespace.
- If a label change would create a duplicate, the commit MUST throw.

`setView`:

- Sets the preferred view for the item.

`setValue`:

- Replaces content with a value or blank.
- MUST follow the group conversion rule.

`setConnected`:

- Replaces content with a connected definition.
- MUST follow the group conversion rule.

`setGroup`:

- Converts content to an empty group.
- MUST follow the group conversion rule.

`insertChild`:

- Signature option: `opts?: { at?: number }`.
- Creates a new child under `parentId`.
- New children MUST start as blank value items.
- If `at` is omitted, child insertion MUST append.
- MUST return the created item ID.

`move`:

- Moves an item to a new parent and/or index.
- `at` sets destination index; omitted means append.
- If move would violate label uniqueness, the commit MUST throw.

`remove`:

- Removes the item from the tree.
- If removed item content is `group`, its children MUST become orphans (`parentId = null`).

### ApplyResult

```ts
type ApplyResult = {
  created: readonly ItemId[];
  touched: readonly ItemId[];
  moved: readonly {
    fromParentId: ItemId | null;
    toParentId: ItemId | null;
    fromIndex: number | null;
    toIndex: number | null;
  }[];
};
```

Returned by:

- `core.commit(...)`.
- `core.undo()`.
- `core.redo()`.

Notes:

- This result MAY be used for follow-up behavior such as selection coordination or animation.

## Location and structure

```ts
core.locate(id): {
  parentId: ItemId
  index: number
  siblings: readonly ItemId[]
} | null
```

Returns the item position within its parent group.

Rules:

- `siblings` MUST reflect the full ordered sibling list at call time.
- If item has no parent, `core.locate(id)` MUST return `null`.

## Selection

```ts
type Selection =
  | { kind: "idle" }
  | { kind: "focused"; focus: Focus; target: string; caret?: Caret };

type Focus = { container: ItemId; item: ItemId };
type Caret = { start: number; end: number };
```

Read selection:

```ts
core.selection();
```

Update selection:

```ts
core.focus(focus, target?, opts?)
core.blur()
```

Rules:

- `focus` MUST select an item within a container.
- If `target` is omitted, Core MUST use `DEFAULT_TARGET`.
- If `opts` or `opts.caret` is omitted, selection MUST remain focused without a caret.
- If edits invalidate selection, Core MUST repair selection to a valid state.

## Focus binding

```ts
core.attachTarget({
  focus,
  target,
  getEl,
  caret?
})
```

Registers a focus binding for a `(focus, target)` pair.

Rules:

- `getEl()` MUST return the element to focus when selection matches the pair.
- `caret` MAY be provided to support text-cursor placement.
- `core.attachTarget(...)` MUST return a cleanup function.
- Callers MUST invoke cleanup when binding is no longer valid.
- Only one active binding MAY exist per `(focus, target)` pair.
- New binding registration for the same pair MUST replace the previous one.

Selection application behavior:

- Core MUST resolve exact `(focus, target)` binding first.
- If missing, Core MUST fall back to `(focus, DEFAULT_TARGET)`.
- Core MUST focus returned element when available.
- Caret application SHOULD be best-effort and only run on supported focused elements.
- If no binding exists, selection state MUST still update even if DOM focus does not move.

## Views and mounting

```ts
core.view(id): ViewName
core.mountView({ id, focus?, view: ViewName }): Component
```

```ts
type Component = { el: HTMLElement; dispose(): void };
```

`core.view(id)` behavior:

- Returns current view name for the item.
- If `id` is missing or stored view cannot be resolved, Core MUST return default view name (`"outline"`).

`core.mountView(...)` behavior:

- MUST return a `Component` for entry item IDs.
- MUST throw if `id` is not an entry item ID.
- MUST use requested view factory when present.
- MUST fall back to `"outline"` if requested factory is missing.
- MUST throw if no `"outline"` factory is registered.
- `dispose()` MUST release all resources for the mounted view.

### Active view and keyboard routing

When `core.focus(...)` updates selection, Core sets active view from focused DOM ownership.

Rules:

- Active view MUST be derived from element focused via target binding (`getEl()`), not pointer event targets.
- Active view MUST resolve to the closest mounted view root containing that element.
- Global keyboard input MUST be parsed and routed by Core to the active view intent handler.
- Native text editors (`input`, `textarea`, `contenteditable`) SHOULD process local text edits first.
- Core MAY still handle explicit global commands while focus is in native text editors.

### Table view semantics (Core-enforced)

When item view is `"table"`, Core enforces table structural semantics.

Rules:

- Table item MUST be a `group`.
- Each direct child row MUST be a `group`.
- If table item or row is not a group, Core MUST coerce it to an empty group.
- Coercion MUST occur during edit application and invariant repair (`commit`/`undo`/`redo`), not as a read-time projection.
- Row children MUST act as columns identified by normalized, non-empty labels.

Row consistency rules:

- All rows MUST share the same labeled column set and order.
- When one row changes, Core MAY create missing columns in other rows as blank entries.
- When one row changes, Core MAY reorder columns across rows to match table column order.
- When one row changes, Core MAY detach columns no longer in table shape.

Notes:

- These repairs are automatic and MAY create, move, or touch additional items beyond the initiating edit.

## Undo and redo

```ts
core.undo(): ApplyResult
core.redo(): ApplyResult
```

Rules:

- Undo/redo MUST restore item content and structure.
- Selection MUST be repaired to valid state.
- Selection MUST NOT be historically restored.
- Undo history MUST be linear.
- A new edit MUST clear the redo stack.

## Lifecycle

```ts
core.dispose();
```

Disposes Core resources.

Rules:

- Core MUST release all reactive resources.
- Core MUST detach all focus bindings.
- After disposal, Core methods MUST NOT be used.

## Public Core API surface

Core exports:

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

Type exports:

- `ItemId`
- `Item`
- `Content`
- `Mode`
- `Connected`
- `Selection`
- `Focus`
- `Caret`
- `Component`
- `ViewName`
- `ViewKind`

Constant exports:

- `DEFAULT_TARGET`

Helper exports:

- `parseValue(text): Value | null`
