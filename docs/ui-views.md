# UI Views

This document defines view-specific behavior: for each view, how it structures its body, what focus surfaces it exposes, what targets exist, and how it interprets intents into Core operations and focus transitions. Shared architecture, interaction invariants, and visual language belong in `docs/ui-system.md`. Core API semantics belong in `docs/core-api.md`.

## Scope

This document covers:

- Per-view purpose and mental model.
- Per-view DOM shape and focus surfaces.
- Per-view intent handling.
- Per-view commands, invariants, and styling notes.

This document does not cover:

- Shared UI runtime and ownership contracts.
- Shared interaction semantics.
- Core API behavior.

## View specification template

Each view section SHOULD follow one structure.

Template sections:

- Purpose and mental model.
- DOM shape.
- Focus surfaces and targets.
- Intent handling.
- Commands and state transitions.
- Edge cases and invariants.
- Styling notes.

Intent handling SHOULD describe these intents where applicable:

- `NAV`
- `TAB`
- `CONFIRM`
- `TYPE`
- `DELETE`
- `DELETE_BOUNDARY`
- `CANCEL`

## Outline view (`outline`)

### Purpose and mental model

Outline is the primary hierarchical editor view.

Rules:

- Items are treated as either `group` containers or scalar `value` leaves.
- Navigation is depth-first and hierarchical.
- Editing remains inline within outline context.

### DOM shape

Outline body:

```text
.ui-body.ui-outline
  [.ui-outline-node.ui-item]*            (for each child item; repeated)
  [value editor]*                        (if focused item is a scalar)
```

Outline node shell:

```text
.ui-outline-node.ui-item
  [optional meta subtree]                (slot)
  [mounted child view body]              (slot: core.mountView)
```

Structural rule:

- Node shells MUST stay stable per visible child item.
- Mounted child body MAY swap by view kind.

### Focus surfaces and targets

Outline focus surfaces:

- Item container focus: `DEFAULT_TARGET` on item shell.
- Item edit focus: view-local edit targets.

Edit targets by item:

- Plain scalar leaves: `value`.
- Connected leaves: `conn:*` (meta-owned).
- Label edit: `label` (meta-owned).

Notes:

- Outline defines an edit traversal space for navigation while editing.

### Edit traversal space

Leaf participation rule:

- Connected items MUST participate as leaf edit nodes.
- Plain scalar items MUST participate as leaf edit nodes.
- Groups MUST NOT participate as edit traversal nodes.

Edit stops:

- Connected item: `conn:*` in `fieldsFromConn` order.
- Plain scalar item: `value`.
- Other item kinds: no edit stops.

Traversal rule:

- Traversal order MUST be depth-first over collected leaf edit stops.

Caret placement rule:

- Backward traversal (`up` or `left`) SHOULD place caret at destination end.
- Forward traversal (`down` or `right`) SHOULD place caret at destination start.

### Meta visibility policy

Outline shows meta when at least one condition is true:

- Item has non-empty label.
- Item has connected fields.
- `label` target is focused.

### Intent handling

Precondition shorthand:

- Focused selection: `core.selection().kind === "focused"`.
- Editing: `sel.target !== DEFAULT_TARGET`.
- Container focus: `sel.target === DEFAULT_TARGET`.

`CANCEL`:

| Intent   | Preconditions | Action               | Focus result                     |
| -------- | ------------- | -------------------- | -------------------------------- |
| `CANCEL` | Always        | `escapeLadder(core)` | Exit to `DEFAULT_TARGET` or blur |

`NAV` from container focus:

| Intent      | Preconditions            | Action                        | Focus result                     |
| ----------- | ------------------------ | ----------------------------- | -------------------------------- |
| `NAV left`  | Focused, container focus | Move to parent item           | Focus parent at `DEFAULT_TARGET` |
| `NAV right` | Focused, container focus | Move to first child           | Focus child at `DEFAULT_TARGET`  |
| `NAV up`    | Focused, container focus | Move to previous visible item | Focus item at `DEFAULT_TARGET`   |
| `NAV down`  | Focused, container focus | Move to next visible item     | Focus item at `DEFAULT_TARGET`   |

`NAV` while editing:

| Intent | Preconditions    | Action                   | Focus result                                         |
| ------ | ---------------- | ------------------------ | ---------------------------------------------------- |
| `NAV`  | Focused, editing | Move between edit points | Focus destination target with traversal caret policy |

`TYPE` behavior:

| Intent        | Preconditions                                                       | Action                                   | Focus result                     |
| ------------- | ------------------------------------------------------------------- | ---------------------------------------- | -------------------------------- |
| `TYPE "="`    | Focused, container focus or `value`; item is plain scalar and blank | Convert item to formula-connected        | Focus `conn:expr` caret at start |
| `TYPE <char>` | Focused, container focus                                            | Enter primary edit target and select all | Insert char in microtask         |

Primary edit target order:

- First `conn:*` if connected.
- Otherwise `value` if plain scalar.
- Otherwise none.

`CONFIRM` while editing:

| Intent    | Preconditions                            | Action                             | Focus result                        |
| --------- | ---------------------------------------- | ---------------------------------- | ----------------------------------- |
| `CONFIRM` | Focused, editing `value`, caret provided | Split scalar at caret into sibling | Focus new sibling `value` at start  |
| `CONFIRM` | Focused, editing non-`value` target      | Exit edit                          | Focus same item at `DEFAULT_TARGET` |

`CONFIRM` from container focus:

| Intent    | Preconditions                                | Action               | Focus result                           |
| --------- | -------------------------------------------- | -------------------- | -------------------------------------- |
| `CONFIRM` | Focused, container focus, edit target exists | Enter edit           | Focus primary target with caret at end |
| `CONFIRM` | Focused, container focus, no edit target     | Insert sibling after | Focus new sibling `value`              |

`TAB` nesting behavior:

| Intent      | Preconditions | Action   | Focus result                                         |
| ----------- | ------------- | -------- | ---------------------------------------------------- |
| `TAB`       | Focused       | Nest in  | Focus moved item; preserve edit target when possible |
| `TAB shift` | Focused       | Nest out | Focus moved item; preserve edit target when possible |

Tab focus rules:

- If not editing before tab: remain on `DEFAULT_TARGET`.
- If editing before tab:
  - Attempt to preserve same target when valid.
  - Otherwise exit to `DEFAULT_TARGET`.
  - Caret SHOULD be clamped to destination text length.

`DELETE` and `DELETE_BOUNDARY`:

| Intent                             | Preconditions                              | Action                                    | Focus result                            |
| ---------------------------------- | ------------------------------------------ | ----------------------------------------- | --------------------------------------- |
| `DELETE`                           | Focused, container focus                   | Equivalent to `DELETE_BOUNDARY`           | View-local result                       |
| `DELETE_BOUNDARY backward/forward` | Focused, non-plain-scalar item             | Remove item                               | Focus neighbor `DEFAULT_TARGET` or blur |
| `DELETE_BOUNDARY backward/forward` | Focused, plain scalar with empty value     | Remove item                               | Focus neighbor `DEFAULT_TARGET` or blur |
| `DELETE_BOUNDARY backward/forward` | Focused, plain scalar with non-empty value | Join neighbor when both are plain scalars | Focus joined item `value` at boundary   |

### Commands and state transitions

Outline-local commands:

- `setLabel(id, text)`.
- `setText(id, text)`.
- `setFormula(id)`.
- `commitConnField(id, key, text)`.
- `insertSibling(sel, side)`.
- `splitAt(sel, caretStart, caretEnd)`.
- `joinBoundary(sel, dir)`.
- `removeItem(sel, prefer)`.
- `changeNesting(sel, dir)`.

`changeNesting(sel, dir)` rules:

- `in`: wraps item in a new group and moves it inside.
- `out`: unwraps item from its parent wrapper.

### Edge cases and invariants

Rules:

- `NAV left` from root MUST no-op.
- `NAV up/down` MUST use visible depth-first order.
- `CONFIRM` split MUST apply only to plain scalar values.
- Join MUST apply only when both items are plain scalars.
- Removing last item SHOULD blur selection.
- Tab indentation SHOULD repair focus by preserving target when possible and clamping caret.

### Styling notes

Outline-local styling language:

- One left rail segment per item depth.
- Indentation based on `rail + pad` per depth level.
- Meta capsule aligned to item rail start.
- Node shells stacked with vertical gap.

## Table view (`table`)

### Purpose and mental model

Table is a grid-oriented view over tree data.

Rules:

- Table item children represent rows.
- Row item children represent cells.
- Navigation follows spreadsheet-like row/column movement.

### DOM shape

Table body:

```text
.ui-body.ui-table.ui-item                    (shell for table itself)
  .ui-table-header
    .ui-table-col.ui-table-meta-col
    [.ui-table-col]*                         (columns)
  .ui-table-body
    [.ui-table-row]*                         (rows)
```

Row:

```text
.ui-table-row.ui-item                        (row container focus)
  .ui-table-cell.ui-table-meta-col
    [meta subtree]
  [.ui-table-cell]*                          (data cells)
```

Cell:

```text
.ui-table-cell.ui-item                       (cell container focus)
  [mounted cell view body]                   (slot: core.mountView)
```

### Focus surfaces and targets

Table focus modes:

- Table container focus: table shell at `DEFAULT_TARGET`.
- Row container focus: `{ container: tableId, item: rowId }` at `DEFAULT_TARGET`.
- Cell container focus: `{ container: rowId, item: cellId }` at `DEFAULT_TARGET`.
- Cell edit focus: `{ container: rowId, item: cellId }` at `value`.

Rules:

- Table MUST distinguish container focus from `value` edit focus.
- Table MUST NOT implement outline-style multi-target edit traversal.

### Schema row behavior

Rules:

- Header schema row SHOULD resolve as `rows[0] ?? null`.
- `colCount` SHOULD follow `schemaRow.children.length` when schema row exists.
- Header SHOULD mount `buildItemMeta` for schema cells.

### Intent handling

Precondition shorthand:

- Row container selection:
  - `sel.focus.container === tableId`.
  - `sel.target === DEFAULT_TARGET`.
- Cell selection:
  - `sel.focus.container` is `rowId`.
  - `sel.focus.item` is a child of that row.

`CANCEL`:

| Intent   | Preconditions | Action               | Focus result                     |
| -------- | ------------- | -------------------- | -------------------------------- |
| `CANCEL` | Always        | `escapeLadder(core)` | Exit to `DEFAULT_TARGET` or blur |

`NAV` from row container focus:

| Intent      | Preconditions | Action           | Focus result         |
| ----------- | ------------- | ---------------- | -------------------- |
| `NAV up`    | Row container | Previous row     | Focus row container  |
| `NAV down`  | Row container | Next row         | Focus row container  |
| `NAV right` | Row container | Enter first cell | Focus cell container |
| `NAV left`  | Row container | No-op            | Unchanged            |

`NAV` from cell container focus:

| Intent      | Preconditions  | Action                                      | Focus result         |
| ----------- | -------------- | ------------------------------------------- | -------------------- |
| `NAV left`  | Cell container | If col=0: row container; else previous cell | Focus destination    |
| `NAV right` | Cell container | Next cell when present                      | Focus cell container |
| `NAV up`    | Cell container | Same column, previous row                   | Focus cell container |
| `NAV down`  | Cell container | Same column, next row                       | Focus cell container |

Rule:

- `NAV` MUST NOT enter edit mode.

`TAB` behavior:

| Intent      | Preconditions  | Action                              | Focus result                         |
| ----------- | -------------- | ----------------------------------- | ------------------------------------ |
| `TAB`       | Row container  | Enter first cell                    | Focus first cell container           |
| `TAB shift` | Row container  | No-op                               | Unchanged                            |
| `TAB`       | Cell container | Next cell; wrap to next row         | Focus next cell or row container     |
| `TAB shift` | Cell container | Previous cell; wrap to previous row | Focus previous cell or row container |

Rule:

- Table tab traversal is positional and MUST NOT enter edit mode.

`CONFIRM` behavior:

| Intent    | Preconditions           | Action                  | Focus result                                                     |
| --------- | ----------------------- | ----------------------- | ---------------------------------------------------------------- |
| `CONFIRM` | Row container           | Insert row after        | Focus new row container                                          |
| `CONFIRM` | Cell container          | Enter edit              | Focus `value` caret at end                                       |
| `CONFIRM` | Cell `value` edit focus | Exit edit and move down | Focus next-row same-col cell container; else same cell container |

`TYPE` behavior:

| Intent        | Preconditions  | Action                    | Focus result             |
| ------------- | -------------- | ------------------------- | ------------------------ |
| `TYPE`        | Row container  | No-op                     | Unchanged                |
| `TYPE <char>` | Cell container | Enter edit and select all | Insert char in microtask |

`DELETE` and `DELETE_BOUNDARY` behavior:

- Table view currently ignores both intents.
- Mounted child views MAY still interpret delete locally.

### Commands and state transitions

Table-local commands:

- `addRowAfter(tableId, afterRowId)`.
- `removeRow(tableId, rowId)`.

Notes:

- `removeRow` is implemented but not currently bound to intents.

### Edge cases and invariants

Rules:

- When there are no rows, navigation operations SHOULD no-op.
- Schema row MUST resolve from first row when present.
- Missing cells relative to `colCount` SHOULD render as empty placeholders.
- `NAV` and `TAB` MUST remain container-focus operations.
- `TYPE` SHOULD only enter edit from cell container focus.

### Styling notes

Table-local styling language:

- Uses CSS table display grouping primitives.
- Header columns use neutral chrome fill.
- Data cells present chrome as top rail segments.
- Meta column presents left block chrome without rail segment.

## Slider view (`slider`)

### Purpose and mental model

Slider is a scalar control view for numeric-like adjustments.

Rules:

- Presents a range input and formatted numeric readout.
- Supports arrow-key nudging with step and jump modes.

### DOM shape

Slider body:

```text
.ui-body.ui-slider
  input[type="range"]
  .ui-slider-value
```

### Focus surfaces and targets

Rules:

- Slider introduces no extra Core targets beyond shell `DEFAULT_TARGET`.
- `<input type="range">` is a local pointer control, not a Core target.
- Keyboard semantics are interpreted at view level.

### Intent handling

`CANCEL`:

| Intent   | Preconditions | Action               | Focus result                     |
| -------- | ------------- | -------------------- | -------------------------------- |
| `CANCEL` | Always        | `escapeLadder(core)` | Exit to `DEFAULT_TARGET` or blur |

`NAV` nudging:

| Intent      | Preconditions | Action     | Focus result        |
| ----------- | ------------- | ---------- | ------------------- |
| `NAV left`  | Always        | Nudge down | Selection unchanged |
| `NAV down`  | Always        | Nudge down | Selection unchanged |
| `NAV right` | Always        | Nudge up   | Selection unchanged |
| `NAV up`    | Always        | Nudge up   | Selection unchanged |

Mode mapping:

- `step` mode SHOULD nudge by `+-1` step.
- `jump` mode SHOULD nudge by `+-10` steps.

Ignored intents:

- `CONFIRM`
- `TAB`
- `TYPE`
- `DELETE`
- `DELETE_BOUNDARY`

### Commands and state transitions

Slider-local commands:

- `setValue(id, value)`.
- `nudgeValue(id, deltaSteps, opts)`.

Rules:

- `setValue` SHOULD commit only when item is editable plain scalar and value is finite.
- `nudgeValue` SHOULD read current value, clamp to bounds, and commit.

### Edge cases and invariants

Rules:

- Slider MUST only edit plain scalar value items.
- Non-numeric current values SHOULD fall back to `min`.
- Boolean-like current values MAY map to numeric fallback behavior.
- Display formatting SHOULD derive from `step` precision.
- Pointer input SHOULD stop propagation and MUST NOT change selection.
- Slider input MUST be disabled when item is not editable.

### Styling notes

Slider-local styling language:

- Horizontal row layout.
- Flexible range control.
- Compact muted value readout.

## Adding a new view

Rules:

- New view sections SHOULD follow the template in this file.
- New sections MUST reference `docs/ui-system.md` for shared semantics instead of duplicating them.

A new view specification MUST define:

- Meaning of `DEFAULT_TARGET` in that view context.
- Edit-entry behavior from container focus.
- Type-to-edit behavior.
- Yielding behavior from editors.
- `DELETE`/`DELETE_BOUNDARY` handling (or explicit no-op).
