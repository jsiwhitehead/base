# UI Views

This document defines **view-specific behavior**.

For each view, it specifies:

- What the view's **body subtree** looks like.
- What **location surfaces** exist inside the body.
- Which **targets** the view introduces (if any).
- How the view interprets **intents** into Core operations and selection transitions.

## Scope

This document covers:

- Per-view purpose and mental model.
- Per-view body DOM shape.
- Per-view location surfaces and targets.
- Per-view intent handling.
- Per-view commands, invariants, and styling notes.

## Shared assumptions

All views inherit the shared controls model in `docs/architecture.md`, plus the DOM runtime contracts in `docs/dom-runtime.md` and the visual language in `docs/style-system.md`.

## View section shape

Each view section SHOULD cover:

- Purpose and mental model
- Body DOM shape
- Targets and surfaces
- View-specific behaviors
- Commands and invariants

## Outline view (`outline`)

### Purpose and mental model

Outline is the primary hierarchical editor view.

Rules:

- Outline is a hierarchical lines-of-text editor: value items are lines, and groups define indentation levels.
- Items are either `group` items or value items (plain `value` or connected `conn:*`).
- Navigation is hierarchical and depth-first across visible items.
- Editing stays inline in the outline.
- Traversal follows visible item stops.
- `Enter` on item selection goes inward; structural insertion uses modified Enter shortcuts.

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
  span.ui-outline-value                        (target: content:text)
```

Structural rules:

- `.ui-frame.ui-outline-child` instances MUST stay stable per visible child item.
- `.ui-header` subtree in `.ui-frame.ui-outline-child` MAY mount/unmount by header visibility policy.
- Mounted child body subtree MAY swap by child view name, but `.ui-frame.ui-outline-child` MUST NOT.
- When a group has zero children, Outline MUST render a body-only empty state.
- Empty-state UI for an empty group MUST NOT be a location surface and MUST NOT add edit targets.

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

Outline surfaces:

- `ITEM_TARGET` on the item's `.ui-frame`
- `content:text` for plain value editing
- `conn:*` for connected fields, in canonical shared-header field order
- `label` for label editing

Notes:

- Traversal follows visible item stops.
- Groups participate in navigation but do not contribute a stop directly.
- Only `content:text` participates in linear Outline edit traversal.
- `label` and `conn:*` are explicit-entry header controls outside Outline edit traversal.
- Connected Outline items are atomic traversal stops at `ITEM_TARGET`.
- Non-outline child views are atomic traversal stops at `ITEM_TARGET`.
- Target ownership still follows `docs/dom-runtime.md`, even when child header/body are hosted inside `.ui-outline-child`.

### Header visibility policy

Inside `.ui-outline-child`, outline mounts the child header subtree when at least one condition is true:

- Item has a non-empty label.
- Item has connected fields.
- The `label` target is focused.

### View-specific behaviors

#### View-specific exceptions

Pointer hit routing inside `.ui-outline-child`:

- Gutter/rail region (left of `--outline-indent`) keeps frame `ITEM_TARGET` behavior. `span.ui-outline-gutter` MUST call `e.preventDefault()` on `pointerdown` (structural chrome requirement for `contenteditable` views; see `docs/content-editable.md`).
- For the non-gutter content area, the value surface SHOULD span under the header area while its text starts below the header via padding.
- For clicks in the value surface's top padding area (above first text line), Outline SHOULD place caret at end of text.
- Header interactive controls retain native behavior and MUST win hit-testing over body text-editing surfaces.
- Outline gutter is the reorder drag surface and MUST set `data-drag="reorder"`.

When a group is empty and item selection is on that group (`ITEM_TARGET`):

- `TYPE` with any other character MUST convert the group to `value` with `""`, focus `content:text`, and type that character (replace behavior).
- `ENTER` MUST convert the group to `value` with `""` and focus `content:text`.

#### Undo boundary policy

Outline MUST call `core.undoBoundary()` at semantic breaks:

- `compositionstart` and `compositionend` (IME session boundaries).
- before and after `onPaste` (paste is its own undo step).
- before and after `onDrop` (drop is its own undo step).

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

- **Tab (indent)**: the focused item remains in place and keeps its **label** and **view**. Outline inserts a single child item and copies the focused item's **body content** into that child. The focused item's label remains on the parent item. If the focused item is `connected`, indent is a no-op.
- **Shift+Tab (outdent)**: the focused item's parent remains in place and keeps its **label** and **view**. Outline replaces the parent's **body content** with the focused child's body content, then removes the focused child and all its siblings under that parent. The focused child's label, if any, is discarded. If the parent is `connected`, outdent is a no-op.
- Preserve the current target and caret when possible. Otherwise, no-op.

#### Edit traversal scope

Traversal is unified across visible Outline items in depth-first order, with at most one stop per item.

- Plain value items contribute one `content:text` stop.
- Connected Outline items and non-outline child views contribute one atomic `ITEM_TARGET` stop.
- Header controls do not participate.
- Outline groups do not contribute a stop directly; they contribute the stops of their visible descendants.

#### Inter-item edge behavior

Continue to the adjacent stop in the unified traversal. Backward lands at the previous stop's end when it is editable; forward lands at the next stop's start when it is editable. At the first or last stop, no-op.

When the adjacent stop is a connected Outline item or a non-outline embedded child view, traversal lands on that row's `ITEM_TARGET`. Subsequent arrow navigation from that stop uses ordinary Outline item-selection geometry until the user explicitly goes inward.

For `ArrowUp` / `ArrowDown`, native text movement remains in effect while the caret can still move within the current `content:text` block. At the first or last visual line boundary, vertical movement follows the same stop model: plain-value stops re-enter `content:text`, while connected and embedded stops land on `ITEM_TARGET`.
Sticky column is preserved only within the same continuous vertical `content:text` session.

Header text-editing keys stay local/native. `Enter` commits and exits to same-item item selection. `Escape` cancels and exits to same-item item selection. For `conn:*`, `Tab` / `Shift+Tab` move within canonical shared-header field order when another field exists; otherwise they commit and no-op.

#### Enter behavior

- `Enter` from a plain value `content:text` target splits at caret and focuses the new sibling item's `content:text` target at caret `0`. This applies only to plain value `content:text` targets, never to `conn:*`.
- `Shift+Enter` from a plain value `content:text` target inserts a newline in place and keeps edit focus on the same item.
- `Mod+Enter` inserts a new plain sibling after the focused item and focuses its `content:text` target at caret `0`.
- `Mod+Shift+Enter` inserts a new plain item after the parent only when the focused item is the last child of a non-root group; otherwise it is a no-op. Focus moves to the new item's `content:text` target at caret `0`.

These structural intents are always handled by Outline, even when focus is on an embedded child view's `content:*` target.

#### Item-selection Enter behavior

`Enter` from item selection goes inward:

- Plain value or embedded leaf item: focus the primary edit target if present.
- Non-empty group: focus the first child at `ITEM_TARGET`.
- Empty group: create the first child and focus its `content:text` target with caret at start.

#### DELETE policy

- Outline handles DELETE with remove semantics (not clear-in-place).
- `ITEM_TARGET` DELETE MUST remove the selected subtree.
- Delete at boundary from a `conn:*` target is a no-op.
- Delete at boundary from a `content:text` target is target-specific:
  If the current text is non-empty, boundary delete checks the adjacent edit stop in the delete direction. If that stop is a plain value item, Outline joins the two values at the boundary point and places the caret at the join boundary in the surviving item. Otherwise, no-op.
  If the current text is empty, that DELETE intent removes the item and moves to the adjacent edit stop in the unified traversal when one exists. Backward moves to the previous stop with caret at end; forward moves to the next stop with caret at start.
- When the contenteditable selection spans multiple plain value items within the same parent, delete/backspace merges the start item's text up to the selection start with the end item's text from the selection end, removing all spanned items between them. The caret lands at the merge point in the surviving start item. Constrained to same-parent siblings; cross-parent ranges are a no-op.
- After remove, focus lands on: next sibling, then previous sibling, then parent.
- Parent fallback is valid only if that parent survives the same commit.
- If no live destination exists, Core repair MUST apply.
- Structural removals triggered by DELETE (`ITEM_TARGET`, block selection, empty-`content:text`, and join removal of the absorbed neighbor) MUST prune newly-empty ancestor groups in the same commit.
- Pruning stops at `rootId`, readonly ancestors, non-group ancestors, or when an ancestor remains non-empty.

### Commands and state transitions

Outline-local commands:

- `setLabel(id, text)`
- `setText(id, text)`
- `commitConnField(id, key, text)`
- `createFirstChild(location, initialText?)`
- `insertForScope(rootId, location, scope)`
- `splitAt(sel, caretStart, caretEnd)`
- `joinValues(leftId, rightId)`
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
- Root normalization: if a structural removal leaves the current Outline `rootId` as an empty group, Outline MUST clear that `rootId` to blank.
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
- Slot-capable cell frames MUST set `data-drag="slot"` for shared drag slot resolution.

Notes:

- For the table item itself, `ITEM_TARGET` is on the table's `.ui-frame` outside `.ui-body.ui-table`.
- Row/cell item selection in table body MUST be implemented as Core location surfaces on `.ui-frame.ui-table-row` / `.ui-frame.ui-table-cell`, not raw DOM focus.

### Location surfaces and targets

Table location and target modes:

- **Table frame item selection**:
  - `ITEM_TARGET` on the table's `.ui-frame`

- **Row item selection**:
  - location refers to a row item
  - `ITEM_TARGET`

- **Cell item selection**:
  - location refers to a cell item
  - `ITEM_TARGET`

- **Cell edit focus**:
  - location refers to a cell item
  - `content:text`

Rules:

- Table MUST distinguish item selection from `content:text` edit focus.
- Table MUST keep embedded outline editing local unless the embedded editor explicitly yields structural behavior.
- Directional `NAV` and `DELETE` are local item-selection operations in table mode. `Tab` is handled locally by the table view.
- Row/cell item selection MUST be implemented as Core location surfaces backed by stable `.ui-table-row` and `.ui-table-cell` wrappers, not raw DOM focus.

### Schema row behavior

Rules:

- Schema row SHOULD resolve as `rows[0] ?? null`.
- When schema row exists, `colCount` SHOULD follow `schemaRow.children.length`.
- Row alignment comes from Core `alignChildren`: rows converge to one ordered slot sequence, with slots that may be labeled or unlabeled.
- Schema header cells SHOULD mount the shared `.ui-header` contract via `mountHeader` in table-header context so label and `conn:*` target behavior stays consistent with other views (see `docs/dom-runtime.md`).

### View-specific behaviors

#### Navigation geometry

Grid over rows and cells. Row headers occupy column 0. Column headers occupy row 0. At the edges of the grid (first row, last row, first cell, last cell), NAV is a no-op.

| NAV   | From row `ITEM_TARGET` | From cell `ITEM_TARGET`                             |
| ----- | ---------------------- | --------------------------------------------------- |
| Up    | Previous row           | Same column, previous row                           |
| Down  | Next row               | Same column, next row                               |
| Left  | Exit to table item     | Previous cell (column 0 exits to row `ITEM_TARGET`) |
| Right | First cell             | Next cell                                           |

#### Tab action

Move right (Tab) or left (Shift+Tab) across cells, wrapping across rows, from table-owned item selection. From row `ITEM_TARGET`, Tab enters the first cell and Shift+Tab is a no-op. Tab from embedded edit focus remains local to the embedded editor unless that editor explicitly yields structural behavior.

#### Edit traversal scope

Scoped to a single item. The traversal moves through that item's edit targets only.

#### Inter-item edge behavior

Plain `Enter` inside the embedded cell outline stays local to the embedded outline view by default. The containing table only acts on explicit structural intents yielded from the embedded editor. Boundary `NAV` and boundary `DELETE` MAY be yielded to the containing table, but are not part of the default global boundary path.

Table-owned cross-item operations (item-selection `NAV`, item-selection `DELETE`, and local item-level `Tab`) land at item selection on the destination. Edit is entered explicitly via `ENTER` or `TYPE`, or remains inside the embedded cell view when that view keeps local ownership.

#### DELETE policy

Rows use remove with a last-row special case:

- If the table has more than one row, remove the row. After removing a row, focus the next row at row `ITEM_TARGET`, then previous row `ITEM_TARGET`, then table `ITEM_TARGET`.
- If the row is the last remaining row, remove the whole table item.

Cells use clear — clear the cell to blank and stay on the same cell at item selection.

### Commands and state transitions

Table-local commands:

- `addRowAfter(tableId, afterRowId)`
- `removeRow(tableId, rowId)`
- `clearCell(cellId)` — clear the cell value to blank.

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
- Native range keys are not exported by the default global key boundary.

### Body DOM shape

Slider body:

```text
.ui-body.ui-slider
  input[type="range"]                            (target: content:slider)
  .ui-slider-value
```

### Location surfaces and targets

Rules:

- Slider uses:
  - `ITEM_TARGET` on the slider frame.
  - `content:slider` on the `<input type="range">`.
- Keyboard behavior is primarily native to the range input.

### View-specific behaviors

Slider is only ever used as an item view, never as an outer view. Its body is a range input rather than a text field.

Arrow keys, Home, End, PageUp, and PageDown are owned by the native range input.

`Enter` and `Shift+Enter` are local no-ops while editing `content:slider`. `Tab` is local.

Pointerdown on the range input SHOULD focus `content:slider` before native slider interaction.

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
