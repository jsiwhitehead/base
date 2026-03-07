# Core API Overview

This document defines the supported Core API contract and the behavior that callers can rely on. It is the authoritative reference for Core types, commands, and invariants.

## Scope

This document covers:

- Public Core types and constants.
- Core commands and reactive reads.
- Structural, selection, and intent-routing invariants.

## Creating Core

```ts
createCore(opts): { core: Core; rootId: ItemId }
```

Creates a new Core instance.

Rules:

- `rootId` MUST reference the root item.
- The root item MUST always exist.
- Removing `rootId` MUST completely clear the root to blank rather than deleting it.
- Core MUST be the single source of truth for model state.
- `createCore` MAY receive a collaboration adapter for sending committed local transactions and applying remote transactions.
- Collaboration transport MUST use exported `Transaction` values (model/entry-level ops); normal editing remains item-based (`core.commit(...)` and `tx.*`).
- For locally emitted collaboration metadata, `txn.meta.seq` MUST be assigned only after successful local apply (failed local commits MUST NOT consume sequence numbers).
- Malformed remote transactions MUST be rejected atomically and MUST NOT mutate Core state.
- `createCore` MAY receive a view-shape registry (`ViewShape` by `ViewName`) used by `core.view(...)` resolution and post-transaction shape enforcement.
- `createCore` MAY receive platform callbacks (`CorePlatformHooks`) for runtime-owned behavior while preserving Core semantics.
- A Core instance owns all state and MUST be explicitly disposed.

## Reactivity model

Core exposes reactive reads and imperative commands.

The following methods are reactive when called inside a reactive context:

- `core.item(id)`.
- `core.selection()`.
- `core.locate(id)`.
- `core.view(id)`.
- `core.canUndo()`.
- `core.canRedo()`.

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
- Outside Core internals, callers SHOULD treat `ItemId` as opaque and MUST rely on Core APIs rather than parsing item IDs.

## Error taxonomy

Core throws typed errors with stable `code` discriminants. Callers SHOULD branch on error class + `code`, not message text. Messages are diagnostic and are not part of the public contract.

| Class                | Code                            | When thrown                                                      | Recovery contract                 |
| -------------------- | ------------------------------- | ---------------------------------------------------------------- | --------------------------------- |
| `CoreInvariantError` | `INVARIANT_VIOLATION`           | Internal invariant violation                                     | Unrecoverable; treat as bug.      |
| `CoreOpError`        | `ROOT_NOT_SET`                  | Root access before root is configured                            | Mutation failed; state unchanged. |
| `CoreOpError`        | `UNKNOWN_ENTRY`                 | Op references missing entry id                                   | Mutation failed; state unchanged. |
| `CoreOpError`        | `DUPLICATE_ENTRY_ID`            | Create op reuses an existing entry id                            | Mutation failed; state unchanged. |
| `CoreOpError`        | `DUPLICATE_CHILD_LABEL`         | Sibling label uniqueness violated                                | Mutation failed; state unchanged. |
| `CoreOpError`        | `CANNOT_MOVE_ROOT`              | Move attempts to move root                                       | Mutation failed; state unchanged. |
| `CoreOpError`        | `CANNOT_MOVE_INTO_SELF`         | Move attempts parent = child                                     | Mutation failed; state unchanged. |
| `CoreOpError`        | `CANNOT_MOVE_INTO_DESCENDANT`   | Move introduces parent cycle                                     | Mutation failed; state unchanged. |
| `CoreOpError`        | `PARENT_NOT_GROUP`              | Op requires group parent but parent is non-group                 | Mutation failed; state unchanged. |
| `CoreOpError`        | `GROUP_MEMBERSHIP_VIA_MOVE`     | Patch tries to set group children directly                       | Mutation failed; state unchanged. |
| `CoreOpError`        | `CANNOT_CONVERT_NONEMPTY_GROUP` | Patch converts non-empty group to non-group                      | Mutation failed; state unchanged. |
| `CoreApiError`       | `INVALID_ITEM_ID`               | Mutation API receives malformed `ItemId`                         | Mutation failed; state unchanged. |
| `CoreApiError`       | `DERIVED_ITEM_ID`               | Mutation API receives readonly/derived `ItemId`                  | Mutation failed; state unchanged. |
| `CoreApiError`       | `UNKNOWN_ITEM_ID`               | Mutation API receives missing item `ItemId`                      | Mutation failed; state unchanged. |
| `CoreApiError`       | `SNAPSHOT_ROOT_MISMATCH`        | `core.importSnapshot(...)` root id differs from instance root id | Mutation failed; state unchanged. |
| `CoreApiError`       | `SNAPSHOT_PARSE_ERROR`          | Snapshot structure/content fails validation                      | Mutation failed; state unchanged. |
| `CoreReadError`      | `INVALID_ITEM_ID`               | Read API receives malformed `ItemId`                             | Read failed; state unchanged.     |
| `CoreReadError`      | `UNKNOWN_ITEM_ID`               | Read API references missing entry                                | Read failed; state unchanged.     |
| `CoreReadError`      | `INVALID_ITEM_PATH`             | Derived path cannot be resolved                                  | Read failed; state unchanged.     |
| `CoreReadError`      | `CONTENT_MISMATCH`              | Shape reader expected different content type                     | Read failed; state unchanged.     |
| `CoreReadError`      | `SHAPE_CHILD_NOT_FOUND`         | Shape reader child lookup misses in group                        | Read failed; state unchanged.     |

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

Rules:

- `core.item(id)` MUST throw if `id` is malformed, missing, or resolves to an invalid derived path.
- `core.item(id)` MUST support valid derived IDs.

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
}): void
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
- If removed item content is `group`, `remove` MUST delete the full subtree rooted at that item.
- After removal, a surviving item's `parentId` or group `children` MUST NOT reference the removed ID or any removed descendant ID.
- Connected items whose expressions reference a removed item MUST yield `issue` content on next evaluation and recover automatically if the name is restored.

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
  | { type: "editing"; location: Location; target: string }
  | { type: "item"; anchor: Location; head: Location };

type Location = { item: ItemId; portals: readonly ItemId[] };
```

Variants:

- `idle`: no focus.
- `editing`: cursor active in a named target such as `CONTENT_TEXT_TARGET`, `LABEL_TARGET`, `conn:*`, or another `content:*`.
- `item`: item-level keyboard cursor or structural multi-item selection; no text target.

Read selection:

```ts
core.selection();
```

Update selection:

```ts
core.focus({ type: "editing", location, target }, opts?)
core.focus({ type: "item", location })
core.focus({ type: "item", anchor, head })
core.focus({ type: "idle" })
```

Rules:

- Selection MUST be the single source of truth for focus state.
- `core.focus` is the canonical selection write API.
- Editing focus requires an explicit `target`.
- `opts.caret` is valid only with editing focus, is forwarded ephemerally to `onSelectionChange`, and MUST NOT be stored in `Selection`.
- Location validity is model-only: `location.item` MUST exist, and every `location.portals` entry MUST exist and be connected.
- Item focus supports both explicit ranges (`anchor` + `head`) and collapsed shorthand (`location`, equivalent to `anchor=head=location`).
- Item ranges remain valid while both endpoints are valid.
- For item ranges, `anchor` is fixed origin and `head` is active endpoint.
- Shift-extend behavior (for example Shift+arrow and Shift+click in view adapters) MUST keep `anchor` fixed and move `head`.
- Item-range navigation is head-driven, including `NAV out`; non-Shift directional navigation first collapses to `head`, then moves.
- `core.focus(...)` validates only item existence and portal validity; it MUST NOT normalize to any tree-derived parent shape.
- After any apply, invalid selection MUST be repaired.
- For local apply (`commit`, `undo`, `redo`, and in-pipeline rule ops), Core MUST first attempt structural repair from a pre-apply ancestor anchor.
- Local structural repair chooses the original sibling slot at the nearest surviving anchored parent; if missing, it chooses the last surviving sibling at that level.
- Local structural repair always lands on item selection at the repaired location.
- If local structural repair cannot produce valid focus, Core MUST fall back to a Core-owned valid selection (`root` item selection or `idle`).
- For remote apply, invalid selection MUST become `idle`.

## Core/platform boundary (`CorePlatformHooks`)

`createCore(opts)` MAY receive optional platform callbacks:

```ts
type CorePlatformHooks = {
  primaryContentTarget?: (location: Location) => string | null;
  onSelectionChange?: (selection: Selection, caret?: number) => void;
  readCurrentCaret?: () => number | undefined;
  resolveIntentHandler?: (
    selection: Selection,
  ) => ((intent: Intent) => void) | null;
};
```

Rules:

- Core MUST remain headless and MUST NOT depend on DOM APIs directly.
- Platform callbacks MUST be optional so Core can run headless in tests/non-DOM contexts.
- `primaryContentTarget` lets runtime/view registration expose the current primary body target for an item location.
- `onSelectionChange` synchronizes platform focus from Core selection. For `core.focus(...)` with editing selection, it receives `opts.caret` as the second argument when provided. For non-editing selection, no caret is forwarded.
- `readCurrentCaret` allows runtime-owned surfaces to provide the current caret offset during local repair-anchor capture (`commit`, `undo`, `redo`, and in-pipeline local apply). This is mainly for live surfaces such as `contenteditable`. The value is optional and MUST NOT be stored in `Selection`.
- `resolveIntentHandler` allows Core to delegate non-global intents to runtime-resolved mounted views.
- Selection validity in Core MUST remain model-only and MUST NOT depend on runtime view/binding state.

## Views and shapes

```ts
core.reader(id, shape): ReaderForShape<typeof shape>
```

Returns a typed shape reader for `id` using the provided `ViewShape`.

Rules:

- `core.reader(id, shape)` MUST throw if `id` is malformed, missing, or resolves to an invalid derived path.
- `core.reader(id, shape)` MUST support valid derived IDs.
- Callers MUST provide a shape compatible with the access pattern they intend to use; incompatible reads MAY throw when reader methods are called.

```ts
core.view(id): ViewName
```

`core.view(id)` behavior:

- Returns the current resolved view name for the item (stored preference or `"outline"`).
- `core.view(id)` MUST throw if `id` is malformed, missing, or resolves to an invalid derived path.
- `core.view(id)` MUST support valid derived IDs.
- `core.view(id)` MUST resolve shaped-view eligibility against the current resolved item data and return `"outline"` when the preferred shaped view is currently incompatible.
- DOM factory availability and mounting fallback are runtime concerns (`docs/dom-runtime.md`).

### Active view and keyboard routing

Rules:

- Core owns semantic intent parsing (`parseKeyIntent`) and dispatch.
- DOM/runtime owns DOM `keydown` listener installation and `KeyboardEvent` capture (`docs/dom-runtime.md`).
- Global history intents (`Cmd/Ctrl+Z`, `Cmd/Ctrl+Shift+Z`, `Ctrl+Y`) MUST be handled by Core before view delegation. Global keydown paths SHOULD route them through `parseKeyIntent`; contenteditable surfaces MAY handle them in their editing pipeline (`docs/content-editable.md`).
- Global edit shortcuts parsed by Core include `Cmd/Ctrl+.` -> focus `LABEL_TARGET`.
- Core handles `NAV/out` before any active-view delegation.
- Core routes other non-global intents through `resolveIntentHandler(selection)` when provided.
- Editors and controls decide which key events bubble to Core.
- Native text editors (`input`, `textarea`, `contenteditable`) SHOULD handle local text edits first.
- Core MAY still handle explicit global commands while focus is in a native text editor.
- View behavior MUST remain intent-driven (semantic), not raw-key driven.

### View shapes

Views MAY declare structural shapes as part of application/view registration, but Core receives only the shape registry.

```ts
type ViewShape =
  | { type: "any" }
  | { type: "value" }
  | {
      type: "group";
      children: ViewShape;
      nonEmpty?: true;
    }
  | {
      type: "group";
      children: Extract<ViewShape, { type: "group" }>;
      nonEmpty?: true;
      alignChildren?: true;
    };
```

Shape meanings:

- `type`: required node shape for the item. `"value"` means value-content (blank/scalar) and excludes issue/group results.
- `children`: required shape for direct children of a constrained group (group shapes only).
- `nonEmpty`: constrained group MUST have at least one direct child (group shapes only).
- `alignChildren`: direct child groups MUST share the same labeled child set and order by label (group shapes only, and only valid when `children` is a group shape).
- Child view locking is inferred from `children`: if `children.type !== "any"`, direct children MUST have their stored view cleared to `null`.
- Nested shapes MUST be enforced recursively by applying `children` at each matching group node.

Enforcement rules:

- Shape enforcement MUST run after every transaction (`commit`, `undo`, `redo`, remote apply).
- Enforcement MUST iterate to a stable fixpoint within the same apply.
- Enforcement MUST only coerce plain items (blank, value, group). Connected items (formula, query) MUST NOT be coerced; incompatibility for non-plain items MUST NOT clear stored view (render fallback is handled by `core.view(id)`).
- Rule order per pass MUST be: content coercion -> non-empty enforcement -> children coercion -> child alignment (`alignChildren`).
- If a shape requirement cannot be satisfied without destroying children (non-empty group requiring `"value"`), Core MUST clear the item's stored view to `null` instead.
- If `nonEmpty` is set and the constrained group is empty, enforcement MUST create one direct child.
- Label alignment MUST elect a leader child group, then create missing labeled children, reorder mismatched labeled children, and remove excess labeled children in other child groups.
- Coercion ops MUST be captured for undo/redo.
- Failure to converge within the implementation pass bound MUST be treated as an invariant failure.

## Undo and redo

```ts
core.undo(): void
core.redo(): void
core.canUndo(): boolean
core.canRedo(): boolean
core.undoBoundary(): void
```

Rules:

- Undo/redo MUST restore item content and structure.
- Selection MUST be repaired to valid state.
- Undo MUST restore the pre-commit selection/caret when that snapshot remains valid after apply; otherwise keep repaired selection.
- Redo MUST restore the selection/caret snapshot captured at undo-time when that snapshot remains valid after apply; otherwise keep repaired selection.
- If undo/redo applies a `view` patch on the restored editing item, Core MUST preserve view-change coercion (snap to item selection) instead of restoring editing selection.
- Undo history MUST be linear.
- Core MUST coalesce text edits only for consecutive single-op text commits on the same item and target within 500ms.
- Core MUST NOT coalesce structural commits (create, move, or remove), multi-op transactions, or commits made outside editing selection mode.
- A new edit MUST clear the redo stack.
- `core.canUndo()` and `core.canRedo()` MUST reflect current undo/redo availability.
- `core.undoBoundary()` closes the active coalescing group and MUST be a no-op if no group is active.
- Views MUST call `core.undoBoundary()` at semantic breaks that Core cannot observe.

## Snapshot import/export

```ts
core.exportSnapshot(): SnapshotData
core.importSnapshot(snapshot: SnapshotData): void
```

Rules:

- `core.exportSnapshot()` MUST return the full stored tree state (IDs, labels, views, content, structure, root ID, next ID).
- `core.importSnapshot(...)` MUST replace Core state atomically or throw.
- Invalid snapshots MUST throw and MUST NOT mutate existing Core state.
- `snapshot.rootId` MUST match the existing Core root ID.
- Successful import MUST clear undo/redo history.
- After successful import, `core.canUndo()` and `core.canRedo()` MUST both return `false`.
- Successful import MUST reset selection to root item selection.
- `SnapshotData` MUST NOT include selection/caret, history, caches, or debug state.

## Helper functions

### `fieldsFromConn(conn)`

```ts
fieldsFromConn(conn: Connected): { key: string; label: string; multiline: boolean; text: string }[]
```

Returns the ordered list of editable fields for a connected item.

Rules:

- For `formula`: returns one field with key `"expr"`.
- For `query`: returns fields `"from"`, `"where"`, `"orderBy"` in that order.
- Field order MUST be canonical and stable.

### `patchConn(conn, key, text)`

```ts
patchConn(conn: Connected, key: string, text: string): Connected
```

Returns a connected object with one field updated when `key` is recognized.

Rules:

- For `formula`, only `key === "expr"` updates the object.
- For `query`, recognized keys are `"from"`, `"where"`, and `"orderBy"`.
- For unknown keys, returns the original object unchanged.

### `getTextForTarget(core, id, target)`

```ts
getTextForTarget(core: Core, id: ItemId, target: string): string
```

Returns the current text for a given item and target.

Rules:

- For `CONTENT_TEXT_TARGET`: returns the item's value as a string, or `""` if blank or non-value.
- For `LABEL_TARGET`: returns the item's label, or `""` if absent.
- For `conn:*` targets: returns the matching connected field text, or `""` if not found.
- Other `content:*` targets are opaque to this helper and return `""`.

### `isNumericLikeValue(value)`

```ts
isNumericLikeValue(value: ValueOrBlank): boolean
```

Presentational helper that returns `true` if the value is a finite number or a string parseable as one. Determines whether `.is-numeric` is applied to a frame; has no effect on storage, evaluation, or sorting.

Rules:

- `number`: `true` if and only if `Number.isFinite(value)`.
- `string`: trims whitespace, returns `true` if the result is a finite number.
- All other values (`null`, `true`): `false`.

## Lifecycle

```ts
core.dispose();
```

Disposes Core resources.

Rules:

- Core MUST release all reactive resources.
- After disposal, Core methods MUST NOT be used.

## Public Core API surface

Core exports:

- `createCore`
- `core.item`
- `core.selection`
- `core.locate`
- `core.view`
- `core.reader`
- `core.exportSnapshot`
- `core.importSnapshot`
- `core.commit`
- `core.undo`
- `core.redo`
- `core.undoBoundary`
- `core.focus`
- `core.dispatch`
- `core.dispose`

Type exports:

- `ItemId`
- `Value`
- `ValueOrBlank`
- `Content`
- `Connected`
- `Tx`
- `Core`
- `CorePlatformHooks`
- `Intent`
- `KeyIntentInput`
- `NavDirection`
- `Selection`
- `Location`
- `SnapshotData`
- `Transaction`
- `ViewName`
- `ViewShape`
- `ReaderForShape`

Constant exports:

- `contentTarget`
- `LABEL_TARGET`
- `CONTENT_TEXT_TARGET`
- `connTarget`

Function exports:

- `parseKeyIntent`
- `defineShape`
- `fieldsFromConn`
- `getTextForTarget`
- `isNumericLikeValue`
