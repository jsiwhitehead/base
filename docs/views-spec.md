# UI Views

This document defines **view-specific behavior**.

For each view, it specifies:

- What the view's **body subtree** looks like.
- What **focus surfaces** exist inside the body.
- Which **targets** the view introduces (if any).
- How the view interprets **intents** into Core operations and focus transitions.

## Scope

This document covers:

- Per-view purpose and mental model.
- Per-view body DOM shape.
- Per-view focus surfaces and targets.
- Per-view intent handling.
- Per-view commands, invariants, and styling notes.

## Shared assumptions

All views inherit the universal controls model defined in `docs/architecture.md`, including target classification, edit target lists, container-focus behaviors, traversable-target yielding, and the escape ladder. Shared DOM runtime contracts (`docs/dom-runtime.md`) and visual language (`docs/style-system.md`) also apply.

## View specification template

Each view section SHOULD follow this structure:

- Purpose and mental model
- Body DOM shape
- Focus surfaces and targets
- View-specific behaviors
- Commands and state transitions
- Edge cases and invariants
- Styling notes

View-specific behaviors SHOULD define:

- **Navigation geometry**: how NAV moves at container focus.
- **Tab action**: what Tab does structurally.
- **Edit traversal scope**: how far the edit target traversal extends across items.
- **Inter-item edge behavior**: what happens when Enter or boundary NAV overflows an item's edit target list.
- **DELETE policy**: remove, clear, or no-op, plus any edit-focus refinements.
- **View-specific exceptions**: split, join, or other behaviors not covered by the universal model.

## Outline view (`outline`)

### Purpose and mental model

Outline is the primary hierarchical editor view.

Rules:

- Outline is a lines-of-text editor: scalars are lines, and groups define indentation levels.
- Items are either `group` containers or scalar leaves (plain `value` or connected `conn:*`).
- Empty groups are valid Core state, but Outline should not normally show indentation with no lines.
- Outline uses a placeholder for empty groups.
- Navigation is hierarchical and depth-first over visible items.
- Editing remains inline in the outline context.
- Outline defines an edit traversal space across leaf edit targets.

### Body DOM shape

Outline group body:

```text
.ui-body.ui-outline
  .ui-frame.ui-outline-child                   (target: DEFAULT_TARGET)
    [.ui-header subtree]                       (optional; targets: label, conn:*)
    [.ui-body.<child-view> subtree]            (mounted child view body)
  .ui-frame.ui-outline-child
    ...
```

Outline scalar body:

```text
.ui-body.ui-outline
  [.ui-textfield subtree]                      (target: value)
```

Structural rules:

- `.ui-frame.ui-outline-child` instances MUST stay stable per visible child item.
- `.ui-header` subtree in `.ui-frame.ui-outline-child` MAY mount/unmount by header visibility policy.
- Mounted child body subtree MAY swap by child view name, but `.ui-frame.ui-outline-child` MUST NOT.
- When a group has zero children, Outline MUST render a body-only empty state.
- Empty-state UI for an empty group MUST NOT be a focus surface and MUST NOT add edit targets.

Notes:

- For the current outline item, `.ui-frame` and `.ui-header` are outside `.ui-body.ui-outline` and are outer-view-owned.
- For each visible child item, outline renders a `.ui-frame.ui-outline-child` that hosts the child's optional `.ui-header` subtree and mounted child body subtree.

### Focus surfaces and targets

Outline focus surfaces:

- **Frame container focus**: `DEFAULT_TARGET` on the item's `.ui-frame` (outer view).
- **Inline edit focus**:
  - `value` (body-owned)
  - `conn:*` (header-owned)
  - `label` (header-owned)

Edit targets by item type:

- Plain scalar leaf:
  - `value`

- Connected leaf:
  - `conn:*` in `fieldsFromConn` order (see `docs/dom-runtime.md`)
  - (optionally) `value` if the view supports showing it (usually no)

- Label editing:
  - `label`

Notes:

- Outline defines a traversal space for `NAV` while editing.
- Groups participate in navigation but not in edit traversal.
- Even when child header/body are hosted inside `.ui-outline-child`, target ownership stays per `docs/dom-runtime.md`.

### Header visibility policy

Inside `.ui-outline-child`, outline mounts the child header subtree when at least one condition is true:

- Item has a non-empty label.
- Item has connected fields.
- The `label` target is focused.

### View-specific behaviors

#### View-specific exceptions

When a group is empty and container focus is on that group (`DEFAULT_TARGET`):

- `TYPE "="` MUST convert the group to formula and focus `conn:expr` at caret start.
- `TYPE` with any other character MUST convert the group to blank `value`, focus `value`, and type that character (replace behavior).
- `CONFIRM` MUST convert the group to blank `value` and focus `value`.

#### Navigation geometry

Hierarchical, depth-first over visible items. At the edges of the tree (root parent, childless leaf, first or last visible item), NAV is a no-op.

| NAV   | From container focus  |
| ----- | --------------------- |
| Up    | Previous visible item |
| Down  | Next visible item     |
| Left  | Parent item           |
| Right | First child           |

#### Tab action

Nest in (Tab) or nest out (Shift+Tab). Moves the item in the tree hierarchy. Preserves current target and clamps caret to destination text length. No-op when nesting is not possible.

#### Edit traversal scope

Unified across all visible leaf items in depth-first order. Each leaf contributes its edit target list (per `docs/architecture.md`). Groups do not participate. These are concatenated into one continuous sequence of edit stops.

#### Inter-item edge behavior

Continue to the adjacent leaf's edit target in the unified traversal. Backward moves to the previous leaf's last target with caret at end. Forward moves to the next leaf's first target with caret at start. At the very first or last edit stop in the entire traversal, no-op.

Enter from a plain scalar `value` target performs a split at caret before advancing — the text after the caret becomes a new sibling item, and its `value` becomes the next edit stop with caret at start. Split only applies to `value` targets on plain scalar items, never to `conn:*` fields.

Delete at boundary from a `conn:*` target is a no-op.

Delete at boundary from a `value` target is target-specific:

- If the current text is non-empty, boundary delete joins adjacent plain scalar items at the boundary point. Backspace at start joins with the previous item. Delete at end joins with the next item. The caret is placed at the join boundary in the surviving item. Join only applies when both items are plain scalars.
- If the current text is empty, boundary delete removes the item and moves to the adjacent edit stop in the unified traversal when one exists. Backward moves to the previous stop with caret at end; forward moves to the next stop with caret at start.

#### DELETE policy

All outline items use remove.

Container delete removes the subtree and does not explicitly resolve focus in the view; Outline relies on Core anchor-based healing.

Structural deletes (container delete, empty-`value` delete, and join removal of the absorbed neighbor) must prune newly-empty ancestor groups in the same commit, stopping at `rootId`, readonly ancestors, non-group ancestors, or when an ancestor remains non-empty.

### Commands and state transitions

Outline-local commands:

- `setLabel(id, text)`
- `setText(id, text)`
- `commitConnField(id, key, text)`
- `convertEmptyGroupToValue(id)`
- `insertSibling(sel, side)`
- `splitAt(sel, caretStart, caretEnd)`
- `joinBoundary(sel, dir)`
- `removeAndPruneAncestors(rootId, id)`
- `changeNesting(sel, dir)`

`changeNesting(sel, dir)` rules:

- `in`: wraps item in a new group and moves it inside.
- `out`: moves item to the wrapper's parent.
- `out`: unwraps and removes the wrapper only when the wrapper has exactly one child (the moved item).

### Edge cases and invariants

- Prune invariant: After any Outline structural edit, Outline MUST NOT leave any newly-empty groups in the edited ancestry; newly-empty groups MUST be removed immediately.
- Outline MAY still encounter pre-existing empty groups (for example, from other views); these are handled by the placeholder rule.

### Styling notes

Outline-local styling:

- One left rail segment per item depth.
- Indentation based on `(rail + pad)` per depth level.
- Header capsule aligns to item rail start.
- Nodes stack with vertical gap.

## Table view (`table`)

### Purpose and mental model

Table is a grid-oriented view over tree data.

Rules:

- Table item children represent rows.
- Row item children represent cells.
- Tables MUST always have at least one row.
- Navigation follows spreadsheet-like row/column movement.
- Table distinguishes **container focus** from **cell edit focus**.

### Body DOM shape

Table body:

```text
.ui-body.ui-table
  .ui-table-header
    .ui-table-col.ui-table-header-col
    .ui-table-col
      [.ui-header subtree]                     (schema cell header; targets: label, conn:*)
    ...
  .ui-table-body
    .ui-frame.ui-table-row                     (row target: DEFAULT_TARGET)
      .ui-table-cell.ui-table-header-col
        [.ui-header subtree]                   (row header; targets: label, conn:*)
      .ui-frame.ui-table-cell                  (cell target: DEFAULT_TARGET)
        [.ui-body.<cell-view> subtree]         (mounted cell view body)
      ...
    ...
```

Structural rules:

- `.ui-frame.ui-table-row` and `.ui-frame.ui-table-cell` wrappers MUST stay stable for visible rows/cells.
- Cell bodies MAY swap by view name.

Notes:

- For the table item itself, `DEFAULT_TARGET` is on the table's `.ui-frame` outside `.ui-body.ui-table`.
- Row/cell container focus in table body MUST be implemented as Core focus surfaces on `.ui-frame.ui-table-row` / `.ui-frame.ui-table-cell`, not raw DOM focus.

### Focus surfaces and targets

Table focus modes:

- **Table frame container focus**:
  - `DEFAULT_TARGET` on the table's `.ui-frame`

- **Row container focus**:
  - focus refers to a row item
  - `DEFAULT_TARGET`

- **Cell container focus**:
  - focus refers to a cell item
  - `DEFAULT_TARGET`

- **Cell edit focus**:
  - focus refers to a cell item
  - `value`

Rules:

- Table MUST distinguish container focus from `value` edit focus.
- Table MUST NOT implement outline-style multi-target edit traversal.
- `NAV` and `TAB` are container-focus operations in table mode.
- Row/cell container focus MUST be implemented as Core focus surfaces backed by stable `.ui-table-row` and `.ui-table-cell` wrappers, not raw DOM focus.

### Schema row behavior

Rules:

- Schema row SHOULD resolve as `rows[0] ?? null`.
- `colCount` SHOULD follow `schemaRow.children.length` when schema row exists.
- Header rendering for schema cells SHOULD use the same header DOM contract as the outer view (`.ui-header`), but mounted in a table header cell context.
- Schema header cells SHOULD use `buildItemHeader` to preserve shared header target semantics (see `docs/dom-runtime.md`).

### View-specific behaviors

#### Navigation geometry

Grid over rows and cells. Row headers occupy column 0. Column headers occupy row 0. At the edges of the grid (first row, last row, first cell, last cell), NAV is a no-op.

| NAV   | From row container | From cell container                             |
| ----- | ------------------ | ----------------------------------------------- |
| Up    | Previous row       | Same column, previous row                       |
| Down  | Next row           | Same column, next row                           |
| Left  | No-op              | Previous cell (column 0 exits to row container) |
| Right | First cell         | Next cell                                       |

#### Tab action

Move right (Tab) or left (Shift+Tab) across cells, wrapping across rows. From row container, Tab enters the first cell and Shift+Tab is a no-op. Tab from edit focus commits and performs the same cell-to-cell movement, landing at container focus on the destination.

#### Edit traversal scope

Scoped to a single item. The traversal moves through that item's edit targets only.

#### Inter-item edge behavior

Enter commits and moves to the same-column cell in the next row at container focus. If there is no next row, no-op. Boundary NAV at the edge of an item's edit targets is a no-op.

All table operations that cross items — NAV, Tab, and Enter — land at container focus on the destination. Edit is always entered explicitly via CONFIRM or TYPE.

#### DELETE policy

Rows use remove with a last-row special case:

- If the table has more than one row, remove the row. After removing a row, focus the next row at row container, then previous row, then table container.
- If the row is the last remaining row, remove the whole table item.

Cells use clear — reset the cell to blank and stay on the same cell at container focus.

### Commands and state transitions

Table-local commands:

- `addRowAfter(tableId, afterRowId)`
- `removeRow(tableId, rowId)`
- `clearCell(cellId)` — reset cell value to blank.

Notes:

- `removeRow` MAY exist but is not necessarily bound to intents.

### Edge cases and invariants

Rules:

- When there are no rows, navigation operations SHOULD no-op.
- Schema row MUST resolve from first row when present.
- Missing cells relative to `colCount` SHOULD render as empty placeholders.

### Styling notes

Table-local styling:

- Uses CSS table display grouping primitives.
- Header column and data columns are distinct layout roles.
- Data cells present top rail segments.
- Header column presents a left block rail region.

## Slider view (`slider`)

### Purpose and mental model

Slider is a scalar control view for numeric-like adjustments.

Rules:

- Presents a range input and formatted numeric readout.
- Arrow-key nudging is handled natively by the range input, not by view intents.
- The range input stops propagation for native keys so the runtime never sees them.

### Body DOM shape

Slider body:

```text
.ui-body.ui-slider
  input[type="range"]                            (target: value)
  .ui-slider-value
```

### Focus surfaces and targets

Rules:

- Slider uses:
  - `DEFAULT_TARGET` on the slider frame.
  - `value` (`VALUE_TARGET`) on the `<input type="range">`.
- Keyboard semantics are interpreted at view level.

### View-specific behaviors

Slider is only ever used as an item view, never as an outer view. Its body is a range input rather than a text field.

Arrow keys, Home, End, PageUp, and PageDown are owned by the native range input. The input's `keydown` listener calls `stopPropagation()` for these keys so they never reach the runtime's global handler. The view does not interpret NAV intents.

Enter, Tab, and Escape are not consumed by the slider and bubble to the outer view, which handles them through its normal rules. TYPE and DELETE are no-ops.

Pointerdown on the range input SHOULD focus `value` (`VALUE_TARGET`) before native slider interaction.

### Commands and state transitions

Slider-local commands:

- `setValue(id, value)`

Rules:

- `setValue` SHOULD commit only when item is an editable plain scalar and value is finite.

### Edge cases and invariants

Rules:

- Slider MUST only edit plain scalar value items.
- Non-numeric current values SHOULD fall back to `min`.
- Boolean-like current values MAY map to numeric fallback behavior.
- Display formatting SHOULD derive from `step` precision.
- Pointer input SHOULD stop propagation and MUST NOT change selection.
- Slider input MUST be disabled when item is not editable.

### Styling notes

Slider-local styling:

- Horizontal row layout.
- Flexible range control.
- Compact muted value readout.

## Adding a new view

Rules:

- New view sections SHOULD follow the template in this file.
- New sections MUST reference `docs/dom-runtime.md` for shared interaction/runtime semantics and `docs/style-system.md` for shared visual language, instead of duplicating them.

A new view specification MUST define:

- Body DOM shape (`.ui-body.<view>`) and stable wrappers.
- Meaning of `DEFAULT_TARGET` in that view context.
- Edit-target behavior from container focus.
- Type-to-edit behavior.
- Yielding behavior from editors (per `docs/dom-runtime.md`).
- `DELETE` handling (or explicit no-op).
- Styling notes describing view-local rail composition (shared rail geometry in `docs/style-system.md`).
