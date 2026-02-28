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

All views inherit the universal controls model defined in `docs/architecture.md`, including target classification, edit target lists, item-selection behaviors, traversable-target yielding, and the escape ladder. Shared DOM runtime contracts (`docs/dom-runtime.md`) and visual language (`docs/style-system.md`) also apply.

## View specification template

Each view section SHOULD follow this structure:

- Purpose and mental model
- Body DOM shape
- Location surfaces and targets
- View-specific behaviors
- Commands and state transitions
- Edge cases and invariants
- Styling notes

View-specific behaviors SHOULD define:

- **Navigation geometry**: how NAV moves at item selection.
- **Tab action**: what Tab does structurally.
- **Edit traversal scope**: how far the edit target traversal extends across items.
- **Inter-item edge behavior**: what happens when Enter or boundary NAV overflows an item's edit target list.
- **DELETE policy**: remove, clear, or no-op, plus any edit-focus refinements.
- **View-specific exceptions**: split, join, or other behaviors not covered by the universal model.

## Outline view (`outline`)

### Purpose and mental model

Outline is the primary hierarchical editor view.

Rules:

- Outline is a lines-of-text editor: value items are lines, and groups define indentation levels.
- Items are either `group` containers or value leaves (plain `value` or connected `conn:*`).
- Empty groups are valid Core state, but Outline should not normally show indentation with no lines.
- Outline uses a placeholder for empty groups.
- Navigation is hierarchical and depth-first over visible items.
- Editing remains inline in the outline context.
- Outline defines an edit traversal space across leaf edit targets.

### Body DOM shape

Outline group body:

```text
.ui-body.ui-outline
  .ui-frame.ui-outline-child                   (target: ITEM_TARGET)
    span.ui-outline-gutter
    [.ui-header subtree]                       (optional; targets: label, conn:*)
    [.ui-body.<child-view> subtree]            (mounted child view body)
  .ui-frame.ui-outline-child
    ...
```

Outline value body:

```text
.ui-body.ui-outline
  span.ui-outline-value                        (target: value)
```

Structural rules:

- `.ui-frame.ui-outline-child` instances MUST stay stable per visible child item.
- `.ui-header` subtree in `.ui-frame.ui-outline-child` MAY mount/unmount by header visibility policy.
- Mounted child body subtree MAY swap by child view name, but `.ui-frame.ui-outline-child` MUST NOT.
- When a group has zero children, Outline MUST render a body-only empty state.
- Empty-state UI for an empty group MUST NOT be a focus surface and MUST NOT add edit targets.

Content-editable rules:

- `.ui-body.ui-outline` MUST carry `contenteditable="true"`.
- Nested `.ui-body.ui-outline` elements MUST NOT redeclare `contenteditable`; they inherit from the root.
- `span.ui-outline-gutter` MUST carry `contenteditable="false"`.
- Outline MUST set `contenteditable="false"` on each mounted `.ui-header` element and on each mounted non-outline child view body root.
- `.ui-body.ui-outline` is the only outline node that carries `contenteditable="true"`.
- `span.ui-outline-value` MUST inherit editability from `.ui-body.ui-outline` when editable, and MUST carry `contenteditable="false"` when non-editable (for example readonly/connected/hidden cases).

Notes:

- For the current outline item, `.ui-frame` and `.ui-header` are outside `.ui-body.ui-outline` and are outer-view-owned.
- For each visible child item, outline renders a `.ui-frame.ui-outline-child` that hosts the child's optional `.ui-header` subtree and mounted child body subtree.

### Location surfaces and targets

Outline focus surfaces:

- **Frame item selection**: `ITEM_TARGET` on the item's `.ui-frame` (outer view).
- **Inline edit focus**:
  - `value` (body-owned)
  - `conn:*` (header-owned)
  - `label` (header-owned)

Edit targets by item type:

- Plain value leaf:
  - `value`

- Connected leaf:
  - `conn:*` in `fieldsFromConn` order (see `docs/dom-runtime.md`)
  - (optionally) `value` if the view supports showing it (usually no)

- Label editing:
  - `label`

Notes:

- Outline defines a traversal space for `NAV` while editing.
- Groups participate in navigation but not in edit traversal.
- Non-outline child views are treated as atomic traversal stops at `ITEM_TARGET` and are not traversed recursively.
- Even when child header/body are hosted inside `.ui-outline-child`, target ownership stays per `docs/dom-runtime.md`.

### Header visibility policy

Inside `.ui-outline-child`, outline mounts the child header subtree when at least one condition is true:

- Item has a non-empty label.
- Item has connected fields.
- The `label` target is focused.

### View-specific behaviors

#### View-specific exceptions

Pointer hit routing inside `.ui-outline-child`:

- Gutter/rail region (left of `--outline-indent`) keeps frame container behavior (`ITEM_TARGET`). `span.ui-outline-gutter` MUST call `e.preventDefault()` on `pointerdown` (structural chrome requirement for `contenteditable` views; see `docs/content-editable.md`).
- For the non-gutter content area, the value textarea SHOULD span under the header area while its text starts below the header via padding.
- For clicks in the value textarea's top padding area (above first text line), Outline SHOULD place caret at end of text.
- Header interactive controls retain native behavior and MUST win hit-testing over body text-editing surfaces.
- Outline MUST mark gutter, value, and header subtrees with `data-drag-start="block"` so shared drag runtime does not start drags from editing chrome.

When a group is empty and item selection is on that group (`ITEM_TARGET`):

- `TYPE "="` MUST convert the group to formula and focus `conn:expr` at caret start.
- `TYPE` with any other character MUST convert the group to `value` with `""`, focus `value`, and type that character (replace behavior).
- `CONFIRM` MUST convert the group to `value` with `""` and focus `value`.

#### Navigation geometry

Item selection uses sibling-only vertical navigation. At boundaries (no parent, no child, no previous/next sibling), NAV is a no-op.

| NAV   | From item selection            |
| ----- | ------------------------------ |
| Up    | Previous sibling               |
| Down  | Next sibling                   |
| Left  | Parent item                    |
| Right | First child, else next sibling |

#### Tab action

Tab changes structure via **in-place body transforms** (item identity stays in place).

- **Tab (indent)**: the focused item remains in place and keeps its **label** and **view**. Outline inserts a single child item and copies the focused item's **body content** into that child (the child is inserted "in the middle" rather than making the focused item a moved child). The focused item's label remains on the parent item. If the focused item is `connected`, indent is a no-op.
- **Shift+Tab (outdent)**: the focused item's parent remains in place and keeps its **label** and **view**. Outline replaces the parent's **body content** with the focused child's body content, then removes the focused child and all its siblings under that parent. The focused child's label (if any) is discarded. If the parent is `connected`, outdent is a no-op.
- Preserve the current target and caret when possible. Otherwise, no-op.

#### Edit traversal scope

Unified across all visible leaf items in depth-first order. Each leaf contributes its edit target list (per `docs/architecture.md`). Groups do not participate. These are concatenated into one continuous sequence of edit stops.

For contenteditable-based implementations, this section specifies the required **outcomes** (focus/target/caret transitions), even when the browser's contenteditable event pipeline is the implementation mechanism instead of `onIntent`.

#### Inter-item edge behavior

Continue to the adjacent leaf's edit target in the unified traversal. Backward moves to the previous leaf's last target with caret at end. Forward moves to the next leaf's first target with caret at start. At the very first or last edit stop in the entire traversal, no-op.

Enter from a plain value `value` target performs a split at caret before advancing — the text after the caret becomes a new sibling item, and its `value` becomes the next edit stop with caret at start. Split only applies to `value` targets on plain value items, never to `conn:*` fields.
Shift+Enter from a plain value `value` target inserts a newline in place within the same item and keeps edit focus on that item.

Delete at boundary from a `conn:*` target is a no-op.

Delete at boundary from a `value` target is target-specific:

- If the current text is non-empty, boundary delete joins adjacent plain value items at the boundary point. Backspace at start joins with the previous item. Delete at end joins with the next item. The caret is placed at the join boundary in the surviving item. Join only applies when both items are plain value items.
- If the current text is empty, boundary delete removes the item and moves to the adjacent edit stop in the unified traversal when one exists. Backward moves to the previous stop with caret at end; forward moves to the next stop with caret at start.

When the contenteditable selection spans multiple plain value items within the same parent, delete/backspace merges the start item's text up to the selection start with the end item's text from the selection end, removing all spanned items between them. The caret lands at the merge point in the surviving start item. Constrained to same-parent siblings; cross-parent ranges are a no-op.

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
- `promoteChildToRoot(rootId, childId)`

Outline value edit storage:

- Outline value editing MUST store raw text exactly as entered, including `""` (empty string).
- Outline value editing MUST NOT auto-coerce text to number, `true`, or `null`.

`changeNesting(sel, dir)` rules:

- `in` (Tab): wrap `X` as `G(X)` in place. `G.label` is empty. `X.label` is unchanged.
- `out` (Shift+Tab): unwrap the parent group by moving `G(children...)` into `G`'s parent at `G`'s original index. `G.label` is discarded.
- Root fallback for `out`: if `X` is a direct child of `rootId`, promote `X` into `rootId` (root id unchanged). Remove all other root children, then remove `X` after transfer.
- No-op: do nothing when the required structure is missing, when promotion preconditions fail, when content is not plain `value`/`group`, or when any required item is `connected` or `readonly`.

### Edge cases and invariants

- Prune invariant: After any Outline structural edit, Outline MUST NOT leave any newly-empty groups in the edited ancestry; newly-empty groups MUST be removed immediately.
- Root normalization: if a structural delete leaves the current Outline `rootId` as an empty group, Outline MUST convert that `rootId` to blank.
- Outline MAY still encounter pre-existing empty groups (for example, from other views); these are handled by the placeholder rule.

### Styling notes

Outline-local styling:

- One left rail segment per item depth.
- Indentation based on `(rail + pad)` per depth level.
- Header capsule aligns to item rail start.
- Nodes stack with vertical gap.
- Outline value text MAY consume frame-derived `--value-ink`.

## Table view (`table`)

### Purpose and mental model

Table is a grid-oriented view over tree data.

Rules:

- Table item children represent rows.
- Row item children represent cells.
- Tables MUST always have at least one row.
- Navigation follows spreadsheet-like row/column movement.
- Table distinguishes **item selection** from **cell edit focus**.

### Body DOM shape

Table body:

```text
.ui-body.ui-table
  .ui-table-inner
    .ui-table-header
      .ui-table-cell.ui-table-first
      .ui-table-cell
        [.ui-header subtree]                   (schema cell header; targets: label, conn:*)
      ...
    .ui-table-body
      .ui-frame.ui-table-row                   (row target: ITEM_TARGET)
        .ui-table-cell.ui-table-first
          [.ui-header subtree]                 (row header; targets: label, conn:*)
        .ui-frame.ui-table-cell                (cell target: ITEM_TARGET)
          [.ui-body.<cell-view> subtree]       (mounted cell view body)
      ...
    ...
```

Structural rules:

- `.ui-frame.ui-table-row` and `.ui-frame.ui-table-cell` wrappers MUST stay stable for visible rows/cells.
- Cell bodies MAY swap by view name.
- `.ui-body.ui-table` SHOULD set `data-drag-start="block"` to prevent drag-start from table editing/body surfaces while allowing frame-level drag interactions.
- Slot-capable cell frames MUST set `data-drag-slot="true"` for shared drag slot resolution.

Notes:

- For the table item itself, `ITEM_TARGET` is on the table's `.ui-frame` outside `.ui-body.ui-table`.
- Row/cell item selection in table body MUST be implemented as Core focus surfaces on `.ui-frame.ui-table-row` / `.ui-frame.ui-table-cell`, not raw DOM focus.

### Location surfaces and targets

Table focus modes:

- **Table frame item selection**:
  - `ITEM_TARGET` on the table's `.ui-frame`

- **Row item selection**:
  - focus refers to a row item
  - `ITEM_TARGET`

- **Cell item selection**:
  - focus refers to a cell item
  - `ITEM_TARGET`

- **Cell edit focus**:
  - focus refers to a cell item
  - `value`

Rules:

- Table MUST distinguish item selection from `value` edit focus.
- Table MUST NOT implement outline-style multi-target edit traversal.
- `NAV` and `TAB` are item-selection operations in table mode.
- Row/cell item selection MUST be implemented as Core focus surfaces backed by stable `.ui-table-row` and `.ui-table-cell` wrappers, not raw DOM focus.

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
| Left  | Exit to table item | Previous cell (column 0 exits to row container) |
| Right | First cell         | Next cell                                       |

#### Tab action

Move right (Tab) or left (Shift+Tab) across cells, wrapping across rows. From row container, Tab enters the first cell and Shift+Tab is a no-op. Tab from edit focus commits and performs the same cell-to-cell movement, landing at item selection on the destination.

#### Edit traversal scope

Scoped to a single item. The traversal moves through that item's edit targets only.

#### Inter-item edge behavior

Enter commits and moves to the same-column cell in the next row at item selection. If there is no next row, no-op. Boundary NAV at the edge of an item's edit targets is a no-op.

All table operations that cross items — NAV, Tab, and Enter — land at item selection on the destination. Edit is always entered explicitly via CONFIRM or TYPE.

#### DELETE policy

Rows use remove with a last-row special case:

- If the table has more than one row, remove the row. After removing a row, focus the next row at row container, then previous row, then table container.
- If the row is the last remaining row, remove the whole table item.

Cells use clear — reset the cell to blank and stay on the same cell at item selection.

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

- `.ui-body.ui-table` is the horizontal scroll container for table overflow.
- `.ui-table-inner` uses CSS table display grouping primitives with intrinsic width sizing.
- Header column and data columns are distinct layout roles.
- Data cells present top rail segments.
- Header column presents a left block rail region.

## Slider view (`slider`)

### Purpose and mental model

Slider is a value control view for numeric-like adjustments.

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

### Location surfaces and targets

Rules:

- Slider uses:
  - `ITEM_TARGET` on the slider frame.
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

- `setValue` SHOULD commit only when item is an editable plain value item and value is finite.

### Edge cases and invariants

Rules:

- Slider MUST only edit plain value items.
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
- Meaning of `ITEM_TARGET` in that view context.
- Edit-target behavior from item selection.
- Type-to-edit behavior.
- Yielding behavior from editors (per `docs/dom-runtime.md`).
- `DELETE` handling (or explicit no-op).
- Styling notes describing view-local rail composition (shared rail geometry in `docs/style-system.md`).
