# Core API Overview

This document defines the supported Core API contract and the behavior that callers can rely on. It is the authoritative reference for Core types, commands, and invariants.

## Scope

This document covers:

- Public Core types and constants.
- Core commands and reactive reads.
- Structural, selection, and view-mounting invariants.

## Creating Core

```ts
createCore(opts): { core: Core; rootId: ItemId }
```

Creates a new Core instance.

Rules:

- `rootId` MUST reference the root item.
- The root item MUST always exist.
- The root item MUST NOT be removed.
- Core MUST be the single source of truth for state.
- `createCore` MAY receive a collaboration adapter that receives committed transactions and can apply remote transactions.
- Collaboration transactions use the exported `Transaction` wire type (model/entry-level ops), while normal editing APIs remain item-based (`core.commit(...)` and `tx.*`).
- `createCore` MUST receive a view registration registry used by `core.mountView(...)` and constraint enforcement (it MAY be empty).
- Each view registration MUST contain a view factory and MAY contain a view constraint.
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
- Callers MUST treat Core read results as snapshots, not mutable shared state.

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
- The fallback item MUST use `content.type === "issue"`.
- The fallback item MUST use `mode.type === "readonly"`.

## Item content

```ts
type Content =
  | { type: "value"; value: Value | null }
  | { type: "group"; children: readonly ItemId[] }
  | { type: "issue"; message: string };
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
  | { type: "readonly" }
  | { type: "plain" }
  | { type: "connected"; conn: Connected };
```

Editability rule:

```ts
item.mode.type !== "readonly";
```

Rules:

- An item MUST be editable if and only if the editability rule evaluates true.
- Core MUST NOT pre-filter edits by mode.
- Transactions MAY still fail if the model rejects them.

Meaning:

- `readonly`: item is not directly editable; this includes formula-derived sub-items and fallback `issue` items.
- `plain`: item stores direct content.
- `connected`: item content is generated from a connected definition.

Notes:

- `plain` and `connected` describe current content semantics and UI intent.
- Except for `readonly`, modes do not add extra edit restrictions beyond model invariants.

## Connected definitions

```ts
type Connected =
  | { type: "formula"; expr: string }
  | { type: "query"; from: string; where: string; orderBy: string };
```

Connected definitions describe how item content is generated.

Rules:

- `formula` MUST generate content from `expr`.
- `query` MUST generate content from `from`/`where`/`orderBy`.
- The generated result MUST determine whether visible content is `value` or `group`.

## Editing and transactions

All edits are performed in transactions.

```ts
core.commit((tx) => {
  // operations
}): ApplyResult
```

Commit rules:

- All state changes MUST flow through `core.commit(...)`.
- Transaction operations MUST apply atomically.
- If any operation in a transaction fails validation or execution, the commit MUST throw and Core state MUST remain unchanged.
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

All transaction operations:

- MUST throw if an input item ID is invalid, missing, or resolves to a readonly/derived item.

`setLabel`:

- Sets or replaces the item label.
- Within one parent group, non-blank labels MUST be unique after trimming whitespace.
- If a label change would create a duplicate, the commit MUST throw.

`setView`:

- Sets the preferred view for the item.
- Accepts `ViewName | null` (`null` clears stored preference).

`setValue`:

- Replaces content with a value or blank.
- MUST follow the group conversion rule.

`setConnected`:

- Replaces content with a connected definition.
- MUST follow the group conversion rule.

`setGroup`:

- If current content is non-group, converts content to an empty group.
- If current content is already `group`, `setGroup` MUST be a no-op.
- MUST follow the group conversion rule.

`insertChild`:

- Signature option: `opts?: { at?: number }`.
- Creates a new child under `parentId`.
- New children MUST start as blank value items.
- If `at` is omitted, child insertion MUST append.
- MUST throw if `parentId` does not resolve to an existing editable group item.
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
  | { type: "idle" }
  | { type: "focused"; focus: Focus; target: string; caret?: Caret };

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

- Selection MUST be the single source of truth for focus state.
- A focused selection MUST reference existing items, and `focus.item` MUST be within `focus.container`.
- `core.focus` MUST default `target` to `DEFAULT_TARGET` and MUST apply no caret unless `opts.caret` is provided.
- After any apply, if selection is invalid, Core MUST repair it.
- For local apply (`commit`, `undo`, `redo`, and in-pipeline rule ops), Core MUST first attempt structural repair using a pre-apply ancestor anchor, choosing the original sibling slot index at the nearest surviving anchored parent level, otherwise the previous sibling.
- Local structural repair MUST set selection to `DEFAULT_TARGET` with no caret.
- If local structural repair cannot produce a valid focus, Core MUST fall back to runtime repair.
- For remote apply, invalid selection MUST become `idle`.

## Target binding

```ts
core.attachTarget({
  focus,
  target,
  getEl,
  caret?
})
```

Registers a target binding for a `(focus, target)` pair.

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
- If the stored view has a constraint and the item's resolved content does not satisfy it, Core MUST return `"outline"`. The stored view preference MUST be preserved on the item.

`core.mountView(...)` behavior:

- MUST mount non-readonly existing items only.
- MUST throw for readonly or missing `id`.
- MUST use the requested view when available, otherwise fall back to `"outline"`.
- MUST throw if neither the requested view nor `"outline"` is registered.
- `dispose()` MUST release mounted-view resources.

### Active view and keyboard routing

When `core.focus(...)` updates selection, Core sets active view from focused DOM ownership.

Rules:

- Active view MUST be derived from element focused via target binding (`getEl()`), not pointer event targets.
- Active view MUST resolve to the closest mounted view root containing that element.
- Global keyboard input MUST be parsed and routed by Core to the active view intent handler.
- Core receives editor key events only when editors/controls allow those events to bubble (yield).
- Native text editors (`input`, `textarea`, `contenteditable`) SHOULD process local text edits first.
- Core MAY still handle explicit global commands while focus is in native text editors.
- Core MUST handle root bootstrap navigation globally: when selection is root container focus, `NAV right` focuses the root's first child if one exists.
- View behavior MUST remain intent-driven (semantic), not raw-key driven.

### View constraints

Views MAY declare structural constraints as part of their registration.

```ts
type ViewConstraint = {
  content: "group" | "value" | "any";
  nonEmpty?: true;
  children?: {
    content: "group" | "value" | "any";
    viewLocked?: true;
  };
  shapeSync?: true;
};
```

```ts
type ViewRegistration = {
  factory: ViewFactory;
  constraint?: ViewConstraint;
};
```

Constraint meanings:

- `content`: required content shape for the item. `"value"` means non-group.
- `nonEmpty`: constrained group MUST have at least one direct child.
- `children.content`: required content shape for direct children of a constrained group.
- `children.viewLocked`: children MUST have their stored view cleared to `null`.
- `shapeSync`: direct children MUST share the same labeled column set and order.

Enforcement rules:

- Constraint enforcement MUST run after every transaction (`commit`, `undo`, `redo`, remote apply).
- Enforcement MUST only coerce plain items (blank, scalar, group). Connected items (formula, query) MUST NOT be coerced; mismatches are handled at view resolution time (see `core.view(id)`).
- Content coercion MUST run before non-empty enforcement. Non-empty enforcement MUST run before children coercion. Children coercion MUST run before shape sync.
- If a content constraint cannot be satisfied without destroying children (non-empty group requiring `"value"`), Core MUST clear the item's stored view to `null` instead.
- If `nonEmpty` is set and the constrained group is empty, enforcement MUST create one direct child.
- Shape sync MUST elect a leader row, then create missing columns, reorder mismatched columns, and detach excess columns in other rows.
- Coercion ops MUST be captured for undo/redo.

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
- Core MUST detach all target bindings.
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
- `core.dispatch`
- `core.attachTarget`
- `core.mountView`
- `core.dispose`

Type exports:

- `ItemId`
- `Value`
- `ValueOrBlank`
- `Content`
- `Connected`
- `ApplyResult`
- `Core`
- `Intent`
- `ViewIntent`
- `Selection`
- `Focus`
- `Caret`
- `Component`
- `DomView`
- `Transaction`
- `ViewFactory`
- `ViewName`
- `ViewConstraint`
- `ViewRegistration`

Constant exports:

- `DEFAULT_TARGET`
- `LABEL_TARGET`
- `VALUE_TARGET`
- `connTarget`

Helper exports:

- `parseValue(text): ValueOrBlank`
- `defaultTextCaret(...)`
