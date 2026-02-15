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

## Shared assumptions (from `docs/dom-runtime.md` and `docs/style-system.md`)

All views in this file inherit these rules:

### Outer view vs item view

- The **outer view** owns the stable `.ui-frame`, rail, header, and mounts the item view body.
- The **item view** owns the `.ui-body.<view>` subtree and all behavior inside it.

### Target ownership

- `.ui-frame` owns `DEFAULT_TARGET`.
- `.ui-header` owns:
  - `label`
  - `conn:*`

- `.ui-body.<view>` owns:
  - `value` (when applicable)

### Selection and updates

- Selection-driven updates MUST be styling-only.
- Frames and mounted bodies MUST NOT be remounted due to selection changes.

### Intent handling

- Views interpret `ViewIntent` (non-`CANCEL`) only when their item is the focused selection.
- `NAV` MUST NOT implicitly enter edit mode (unless explicitly stated by the view).

## View specification template

Each view section SHOULD follow this structure:

- Purpose and mental model
- Body DOM shape
- Focus surfaces and targets
- Intent handling
- Commands and state transitions
- Edge cases and invariants
- Styling notes

Intent handling SHOULD describe these intents where applicable:

- `NAV`
- `TAB`
- `CONFIRM`
- `TYPE`
- `DELETE`
- `DELETE_BOUNDARY`

## Outline view (`outline`)

### Purpose and mental model

Outline is the primary hierarchical editor view.

Rules:

- Items are treated as either:
  - `group` containers, or
  - scalar leaves (plain `value` or connected `conn:*`).

- Navigation is hierarchical and depth-first over visible items.
- Editing remains inline in the outline context.
- Outline defines an **edit traversal space** across leaf edit targets.

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

### Edit traversal space

Leaf participation:

- Connected items MUST participate as leaf edit nodes.
- Plain scalar items MUST participate as leaf edit nodes.
- Groups MUST NOT participate as edit traversal nodes.

Edit stops per leaf:

- Connected leaf: `conn:*` in `fieldsFromConn` order (see `docs/dom-runtime.md`).
- Plain scalar leaf: `value`.
- Other kinds: no edit stops.

Traversal order:

- Traversal MUST be depth-first over collected leaf edit stops.

Caret placement policy:

- Backward traversal (`NAV up` / `NAV left`) SHOULD place caret at destination end.
- Forward traversal (`NAV down` / `NAV right`) SHOULD place caret at destination start.

### Header visibility policy

Inside `.ui-outline-child`, outline mounts the child header subtree when at least one condition is true:

- Item has a non-empty label.
- Item has connected fields.
- The `label` target is focused.

### Intent handling

Precondition shorthand:

- Focused selection: `core.selection().type === "focused"`.
- Editing: `sel.target !== DEFAULT_TARGET`.
- Container focus: `sel.target === DEFAULT_TARGET`.

#### `NAV` from container focus

| Intent      | Preconditions            | Action                        | Focus result                     |
| ----------- | ------------------------ | ----------------------------- | -------------------------------- |
| `NAV left`  | Focused, container focus | Move to parent item           | Focus parent at `DEFAULT_TARGET` |
| `NAV right` | Focused, container focus | Move to first child           | Focus child at `DEFAULT_TARGET`  |
| `NAV up`    | Focused, container focus | Move to previous visible item | Focus item at `DEFAULT_TARGET`   |
| `NAV down`  | Focused, container focus | Move to next visible item     | Focus item at `DEFAULT_TARGET`   |

#### `NAV` while editing

| Intent | Preconditions    | Action                   | Focus result                                         |
| ------ | ---------------- | ------------------------ | ---------------------------------------------------- |
| `NAV`  | Focused, editing | Move between edit points | Focus destination target with traversal caret policy |

#### `TYPE`

| Intent        | Preconditions                                                       | Action                                   | Focus result                     |
| ------------- | ------------------------------------------------------------------- | ---------------------------------------- | -------------------------------- |
| `TYPE "="`    | Focused; container focus or `value`; item is plain scalar and blank | Convert item to formula-connected        | Focus `conn:expr` caret at start |
| `TYPE <char>` | Focused, container focus                                            | Enter primary edit target and select all | Insert char in microtask         |

Primary edit target order:

- First `conn:*` if connected.
- Otherwise `value` if plain scalar.
- Otherwise none.

#### `CONFIRM` while editing

| Intent    | Preconditions                            | Action                             | Focus result                        |
| --------- | ---------------------------------------- | ---------------------------------- | ----------------------------------- |
| `CONFIRM` | Focused, editing `value`, caret provided | Split scalar at caret into sibling | Focus new sibling `value` at start  |
| `CONFIRM` | Focused, editing non-`value` target      | Exit edit                          | Focus same item at `DEFAULT_TARGET` |

#### `CONFIRM` from container focus

| Intent    | Preconditions                                | Action               | Focus result                       |
| --------- | -------------------------------------------- | -------------------- | ---------------------------------- |
| `CONFIRM` | Focused, container focus, edit target exists | Enter edit           | Focus primary target; caret at end |
| `CONFIRM` | Focused, container focus, no edit target     | Insert sibling after | Focus new sibling `value`          |

#### `TAB` nesting behavior

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

#### `DELETE` and `DELETE_BOUNDARY`

| Intent                             | Preconditions                              | Action                                                | Focus result                            |
| ---------------------------------- | ------------------------------------------ | ----------------------------------------------------- | --------------------------------------- |
| `DELETE`                           | Focused, container focus                   | Equivalent to `DELETE_BOUNDARY` in the same direction | View-local result                       |
| `DELETE_BOUNDARY backward/forward` | Focused, non-plain-scalar item             | Remove item                                           | Focus neighbor `DEFAULT_TARGET` or blur |
| `DELETE_BOUNDARY backward/forward` | Focused, plain scalar with empty value     | Remove item                                           | Focus neighbor `DEFAULT_TARGET` or blur |
| `DELETE_BOUNDARY backward/forward` | Focused, plain scalar with non-empty value | Join neighbor when both are plain scalars             | Focus joined item `value` at boundary   |

### Commands and state transitions

Outline-local commands:

- `setLabel(id, text)`
- `setText(id, text)`
- `setFormula(id)`
- `commitConnField(id, key, text)`
- `insertSibling(sel, side)`
- `splitAt(sel, caretStart, caretEnd)`
- `joinBoundary(sel, dir)`
- `removeItem(sel, prefer)`
- `changeNesting(sel, dir)`

`changeNesting(sel, dir)` rules:

- `in`: wraps item in a new group and moves it inside.
- `out`: moves item to the wrapper's parent.
- `out`: unwraps and removes the wrapper only when the wrapper has exactly one child (the moved item).

### Edge cases and invariants

Rules:

- `NAV left` from root MUST no-op.
- `NAV up/down` MUST use visible depth-first order.
- `CONFIRM` split MUST apply only to plain scalar values.
- Join MUST apply only when both items are plain scalars.
- Removing the last item SHOULD blur selection.
- Tab indentation SHOULD repair focus by preserving target when possible and clamping caret.

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

### Intent handling

Precondition shorthand:

- `tableId`: focused table item id.
- `rowId`: focused row item id (child of `tableId`).
- `cellId`: focused cell item id (child of `rowId`).
- Row container selection:
  - `sel.focus.container === tableId`
  - `sel.focus.item === rowId`
  - `sel.target === DEFAULT_TARGET`
  - `rowId` is a child of `tableId`

- Cell selection:
  - `sel.focus.container === rowId`
  - `sel.focus.item === cellId`
  - `cellId` is a child of `rowId`
  - container focus: `sel.target === DEFAULT_TARGET`
  - edit focus: `sel.target === "value"`

#### `NAV` from row container focus

| Intent      | Preconditions | Action           | Focus result         |
| ----------- | ------------- | ---------------- | -------------------- |
| `NAV up`    | Row container | Previous row     | Focus row container  |
| `NAV down`  | Row container | Next row         | Focus row container  |
| `NAV right` | Row container | Enter first cell | Focus cell container |
| `NAV left`  | Row container | No-op            | Unchanged            |

#### `NAV` from cell container focus

| Intent      | Preconditions  | Action                                      | Focus result      |
| ----------- | -------------- | ------------------------------------------- | ----------------- |
| `NAV left`  | Cell container | If col=0: row container; else previous cell | Focus destination |
| `NAV right` | Cell container | Next cell when present                      | Focus destination |
| `NAV up`    | Cell container | Same column, previous row                   | Focus destination |
| `NAV down`  | Cell container | Same column, next row                       | Focus destination |

Rule:

- `NAV` MUST NOT enter edit mode.

#### `TAB`

| Intent      | Preconditions  | Action                              | Focus result                         |
| ----------- | -------------- | ----------------------------------- | ------------------------------------ |
| `TAB`       | Row container  | Enter first cell                    | Focus first cell container           |
| `TAB shift` | Row container  | No-op                               | Unchanged                            |
| `TAB`       | Cell container | Next cell; wrap to next row         | Focus next cell or row container     |
| `TAB shift` | Cell container | Previous cell; wrap to previous row | Focus previous cell or row container |

Rule:

- Table tab traversal is positional and MUST NOT enter edit mode.

#### `CONFIRM`

| Intent    | Preconditions           | Action                  | Focus result                                                     |
| --------- | ----------------------- | ----------------------- | ---------------------------------------------------------------- |
| `CONFIRM` | Row container           | Insert row after        | Focus new row container                                          |
| `CONFIRM` | Cell container          | Enter edit              | Focus `value`; caret at end (`caretEnd()`)                       |
| `CONFIRM` | Cell `value` edit focus | Exit edit and move down | Focus next-row same-col cell container; else same cell container |

#### `TYPE`

| Intent        | Preconditions  | Action                    | Focus result             |
| ------------- | -------------- | ------------------------- | ------------------------ |
| `TYPE`        | Row container  | No-op                     | Unchanged                |
| `TYPE <char>` | Cell container | Enter edit and select all | Insert char in microtask |

#### `DELETE` and `DELETE_BOUNDARY`

- Table currently ignores both intents at the table level.
- Mounted child views MAY still interpret delete locally.

### Commands and state transitions

Table-local commands:

- `addRowAfter(tableId, afterRowId)`
- `removeRow(tableId, rowId)`

Notes:

- `removeRow` MAY exist but is not necessarily bound to intents.

### Edge cases and invariants

Rules:

- When there are no rows, navigation operations SHOULD no-op.
- Schema row MUST resolve from first row when present.
- Missing cells relative to `colCount` SHOULD render as empty placeholders.
- `NAV` and `TAB` MUST remain container-focus operations.
- `TYPE` SHOULD only enter edit from cell container focus.

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
- Supports arrow-key nudging with step and jump modes.
- Slider interprets navigation intents as nudging, not focus movement.

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

### Intent handling

#### `CONFIRM`

| Intent    | Preconditions                      | Action                   | Focus result                     |
| --------- | ---------------------------------- | ------------------------ | -------------------------------- |
| `CONFIRM` | Focused on slider `DEFAULT_TARGET` | Enter slider value focus | Focus same item `value`          |
| `CONFIRM` | Focused on slider `value`          | Exit slider value focus  | Focus same item `DEFAULT_TARGET` |

#### `NAV` nudging

| Intent      | Preconditions | Action     | Focus result        |
| ----------- | ------------- | ---------- | ------------------- |
| `NAV left`  | Always        | Nudge down | Selection unchanged |
| `NAV down`  | Always        | Nudge down | Selection unchanged |
| `NAV right` | Always        | Nudge up   | Selection unchanged |
| `NAV up`    | Always        | Nudge up   | Selection unchanged |

Mode mapping:

- `step` mode SHOULD nudge by `+-1` step.
- `jump` mode SHOULD nudge by `+-10` steps.

- Pointerdown on the range input SHOULD focus `value` (`VALUE_TARGET`) before native slider interaction.

Ignored intents:

- `TAB`
- `TYPE`
- `DELETE`
- `DELETE_BOUNDARY`

### Commands and state transitions

Slider-local commands:

- `setValue(id, value)`
- `nudgeValue(id, deltaSteps, opts)`

Rules:

- `setValue` SHOULD commit only when item is an editable plain scalar and value is finite.
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
- Edit-entry behavior from container focus.
- Type-to-edit behavior.
- Yielding behavior from editors (per `docs/dom-runtime.md`).
- `DELETE`/`DELETE_BOUNDARY` handling (or explicit no-op).
- Styling notes describing view-local rail composition (shared rail geometry in `docs/style-system.md`).
