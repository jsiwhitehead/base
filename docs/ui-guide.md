# UI Guide

This guide describes the DOM/UI system layered on Core: how UI is structured, how it mounts and disposes safely, how it stays reactive and stable, and how user interaction is routed consistently across views.

**This guide does not duplicate the Core contract.** The Core API and selection model are defined in `core-api.md`. This guide documents the UI layer conventions and responsibilities.

---

## 0. Scope and principles

The UI layer is intentionally small. It is not a general UI framework. It is a small set of primitives and conventions designed for an editor-like application where:

- selection drives focus and interaction
- nested views compose cleanly
- DOM identity remains stable across navigation
- keyboard behavior is predictable and consistent

Core principles:

1. **Core is the source of truth.**
   UI renders Core state and commits changes through Core.

2. **Selection is the single focus truth.**
   UI does not track focus manually; it attaches targets and Core selection determines the active DOM element.

3. **Shell is stable; body is swappable.**
   Selection changes should be cheap and styling-only.

4. **Interaction is semantic.**
   Views interpret high-level intents (`NAV`, `TAB`, etc.) rather than raw DOM key events.

5. **Tab is always an app command.**
   The UI does not use browser tab-order navigation.

---

# 1) UI Architecture

This chapter describes how the DOM is structured, how components are mounted/disposed, and how reactivity is kept stable.

---

## 1.0 App frame / shell DOM

Canonical app frame (debug panel omitted):

```text
#root
  .ui-shell
    .ui-shell-main                              (tabIndex=0; only tabbable element)
      .ui-app.ui-item                           (root item shell; target: DEFAULT_TARGET)
        .ui-body.ui-<view>                      (mounted root view body)
```

Tab invariant:

- `.ui-shell-main` is the only tabbable element in the app.
- All other focus movement is programmatic via Core targets.

---

## 1.1 Two layers everywhere: Shell vs Body

Every presented item is represented using two conceptual layers:

### Shell (owned by the parent/context)

The shell is the stable wrapper element for an item.

A shell is responsible for:

- representing exactly one Core item presentation
- adding the `.ui-item` class
- setting a stable `data-id` (recommended)
- being programmatically focusable (`tabIndex = -1` if not already set)
- attaching `DEFAULT_TARGET`
- handling pointer selection on the item
- applying selection-driven state classes (e.g. `.is-focused`)
- optionally rendering **meta chrome** (label + connected fields)

Shell logic is shared and implemented by:

- `bindUiItemShell(ctx, { core, focus }, shellEl)`

Shells must remain structurally stable across selection changes.

---

### Meta (part of shell ownership)

Meta is item chrome rendered by the parent/context.

Meta includes:

- label editor (`target = "label"`)
- connected field editors (`target = "conn:*"`)

Meta is not view-specific. It is item-specific.

Meta rendering policy:

- parent/context controls meta visibility by mounting/unmounting it.
- remounting meta starts editors from committed state.

Canonical meta structure:

```text
.ui-meta
  .ui-meta-label
    [.ui-textfield structure]                   (target: label)
  .ui-meta-conn
    .ui-meta-conn-row                           (repeated)
      .ui-meta-conn-key
      .ui-meta-conn-val
        [.ui-textfield structure]               (target: conn:<fieldKey>)
```

---

### Body (owned by the mounted view)

The body is the view-specific UI subtree.

A body is responsible for:

- rendering `.ui-body` (or an element stamped as body)
- rendering view-specific structure
- rendering children (via shell/body composition)
- attaching **body-owned targets**
- rendering view-owned controls (text editors, sliders, etc.)

Bodies are mounted via:

- `core.mountView({ id, focus, view: core.view(id) })`

In composed contexts (for example, table header meta and row shells), a context view may render elements that act as shell + body surface for items that are not mounted as standalone roots. Target ownership rules still apply.

---

### Target ownership contract (hard rule)

This is a core UI invariant.

**Shell/meta owns these targets:**

- `DEFAULT_TARGET`
- `label`
- `conn:<fieldKey>`

**Body owns these targets:**

- `value`
- any future body-specific targets

Bodies must not attach `label` or `conn:*`.
Shell/meta must not attach `value`.

This keeps:

- item chrome consistent across contexts
- view bodies simpler
- target behavior uniform regardless of which view is mounted

---

### Editability and mode

Editability is mode-driven:

- `readonly` is a hard stop for editing
- `plain` vs `connected` determines which edit targets exist (`value` vs `conn:*`)

The UI may convert modes (`plain` <-> `connected`), but conversion must be explicit.

---

## 1.2 Component model and lifecycle

The UI uses a minimal component model.

A component is:

```ts
type Component = { el: HTMLElement; dispose(): void };
```

The only correct way to create a component is:

- `createComponent(core, (ctx) => HTMLElement)`

`createComponent` provides:

- automatic disposal of:
  - event listeners
  - reactive effects
  - mounted child components
  - target bindings

- predictable teardown:
  - all cleanups run
  - the component root is emptied

This is the primary mechanism preventing:

- memory leaks
- stale DOM
- stale focus targets
- duplicate effects

---

## 1.3 `Ctx`: the UI’s “micro-framework”

`createComponent` supplies a `Ctx` that provides safe building blocks.

### `ctx.cleanup(fn)`

Registers a cleanup function.

Use this whenever you mount another component or register any external disposer.

---

### `ctx.on(el, type, handler, opts?)`

Registers an event listener and automatically removes it on dispose.

Views should not call `addEventListener` directly.

---

### `ctx.effect(run)`

Registers a reactive effect using signals.

`run()` may return a cleanup function which is called:

- before the effect re-runs
- when the component is disposed

Effects should be written as idempotent updates to DOM state.

---

### `ctx.slot(host)`

Manages a single mounted child component inside a host element.

Used when a subtree must swap based on a discriminator (view kind, content kind).

---

### `ctx.list(host, create)`

Manages a keyed list of child components.

Provides:

- stable reuse of children by id
- deterministic disposal of removed children
- DOM reconciliation without destroying stable nodes

This is the standard way to render item children.

---

### `ctx.target(focus, target, getEl, opts?)`

Attaches a Core focus target binding.

This registers a DOM element as the focus destination for a given `{ focus, target }`.

This is the only correct way to integrate DOM focus with Core selection.

---

## 1.4 DOM helpers and conventions

The UI layer provides small helpers that encode conventions:

- `el(tag, className?, text?)`
- `reconcileChildren(parent, desired)`
- `setData(el, key, value)`
- `caretFromTarget(eventTarget)`

These helpers exist to:

- keep DOM code terse and consistent
- avoid ad-hoc reconciliation patterns
- make debugging easier via stable datasets

---

## 1.5 Reactivity & stability rules

Selection changes are frequent and must be cheap.

### Rule: selection-driven updates must be styling-only

Selection-driven effects should only:

- toggle classes
- update datasets
- update caret ranges / editor state

Selection-driven effects must not:

- rebuild shells
- remount bodies
- restructure lists

---

### Rule: `.ui-item` identity must be stable across navigation

A `.ui-item` element represents a specific item presentation.

When selection moves, the `.ui-item` DOM nodes must not be replaced; only their styling should change.

This is foundational to predictable focus and pointer behavior.

---

### Rule: structural swaps must be gated by stable discriminators

When using `slot.set(...)`, swaps must be gated by discriminators such as:

- item content kind (`group` vs `scalar`)
- item view name

Reactive re-runs should not remount unchanged structure.

---

### Rule: prefer small computed selectors

When a component needs selection state, it should prefer local computed signals like:

- `isFocused = computed(() => ...)`

Rather than broad effects that read selection repeatedly.

This keeps selection reads cheap and local.

---

# 2) Interaction & Editing

This chapter defines how keyboard and pointer input is routed and how editors behave.

---

## 2.1 Focus, targets, and caret (UI-level model)

Core selection is always either:

- idle (blurred)
- focused: `{ focus, target, caret? }`

The UI treats targets as named focus surfaces:

- `DEFAULT_TARGET` — item container focus (shell)
- `label` — label editor (shell/meta)
- `conn:*` — connected editors (shell/meta)
- `value` — primary content editor (body)

Universal item edit targets are:

- `conn:*` fields (in connected mode)
- `value` (in plain scalar mode)

`label` is a valid target but is not part of standard keyboard edit-entry flow.

Universal label editing policy (current):

- label editing is pointer-accessible only
- keyboard navigation does not enter label
- label targets do not yield navigation while editing
- label is not part of edit-stop traversal

Caret values are meaningful only for caret-supporting targets (typically text editors).

---

## 2.2 Hard focus and tab invariants

These are intentional design choices.

### Exactly one tabbable element

The app uses exactly one tabbable element total:

- `.ui-shell-main` (`tabIndex=0`)

No other element participates in browser tab-order navigation (App frame / shell DOM).

---

### Tab / Shift+Tab are always app commands

Tab is never used for browser focus traversal.

Even inside text editors:

- Tab is intercepted and translated into an app intent
- the view defines what Tab means

This makes keyboard behavior consistent and view-controlled.

---

### Tab is delivered to the current view

`TAB` / `Shift+TAB` is always interpreted by exactly one current view based on focused ownership.

- focus on an outer container/target routes `TAB` to the parent/context view
- focus on an inner container/target routes `TAB` to the child view that owns that target

This keeps behavior local to the focused item context regardless of target type.

---

### Programmatic focus only

Targets are focused programmatically based on Core selection.

Inputs may still be focusable (for selection/caret), but they are not part of tab-order.

---

## 2.3 Intent model (semantic keyboard)

The UI defines a shared intent vocabulary:

- `NAV { dir, mode }`
- `TAB { shift }`
- `CONFIRM { caret? }`
- `CANCEL`
- `TYPE { char }`
- `DELETE { dir }`
- `DELETE_BOUNDARY { dir }`

Views interpret intents. Controls emit intents.

This separation is what keeps:

- view logic simple
- editor logic reusable
- behavior consistent across views

---

## 2.4 Keyboard routing

Keyboard routing happens at two levels.

### Global routing

Core owns the global `keydown` listener (attached once for the app).

Core:

- parses the event into an intent
- consumes the DOM event when it routes an intent
- handles global commands (for example, Escape ladder)
- routes view intents to the active view intent handler

---

### Editor yielding

Editors implement “yielding” via:

- `bindTextEditorYield(inp, onIntent)`

Yielding is semantic, not bubbling.
It applies to text edit targets (`conn:*`, `value`), not to `label`.
This is local editor behavior and is independent of Core global keydown routing.

Instead of letting arrow keys bubble, editors detect boundary conditions and emit intents like:

- `NAV`
- `TAB`
- `CONFIRM`
- `CANCEL`
- `DELETE_BOUNDARY`

This is what enables:

- outline-style editing
- grid-style editing
- predictable navigation at text boundaries

---

## 2.5 Pointer routing

Pointer behavior is intentionally simple and consistent.

### Shell pointerdown

`.ui-item` shells handle pointerdown by:

- focusing the item at `DEFAULT_TARGET`
- capturing a caret (if the pointer was on a text editor)
- stopping propagation

This is owned by `bindUiItemShell`.

---

### Editor pointerdown

Editors handle pointerdown by:

- focusing their specific target
- using `caretFromTarget(e.target)` for caret placement
- stopping propagation

---

## 2.6 Text editing controls

The UI provides one text control:

- `textField` (configured with options, including `autosize: true`)

`textField` supports:

- `multiline` (`input` vs `textarea`)
- `autosize` (mirror-driven sizing)
- `editModel: "live" | "draft"`
- yielding on/off (`yieldNav`; labels typically disable yielding)

Canonical DOM:

```text
.ui-textfield
  .ui-textfield-mirror                          (optional; aria-hidden="true")
  input.ui-textfield-input | textarea.ui-textfield-input
```

Autosize semantics (`autosize: true`):

- mirror is hidden but drives autosize layout.
- input/textarea overlays the mirror in the same slot.

Padding note:

- for autosize fields, apply padding to both `.ui-textfield-input` and `.ui-textfield-mirror` (not `.ui-textfield`).

`textField` instances:

- attach their target via `ctx.target(...)`
- participate in yielding via `bindTextEditorYield(...)`
- respect readonly state
- rely on shell-level issue state via `.ui-item.is-issue`

---

### 2.6.1 Editor commit models

Editors support two commit models:

#### Live

- commits on every `input`
- no local draft state
- cancel does not revert

Use when:

- updates are cheap
- “what you see is what Core has” is desired

---

#### Draft

- maintains local draft state while focused
- commits on:
  - `CONFIRM`
  - `TAB`
  - yielded `NAV`
  - `blur`

- cancels on `CANCEL`
- resets to committed state when focus leaves

Draft mode exists to provide:

- explicit commit points
- cancellation
- stable editing across reactive reruns

---

### 2.6.2 Multiline Enter rules

In multiline editors:

- `Enter` is interpreted as `CONFIRM` (commit/exit) by default.
- `Ctrl+Enter` or `Meta+Enter` inserts a newline.

This preserves:

- fast commit behavior
- the ability to enter multiline content intentionally

---

## 2.7 Universal interaction rules

These are shared across views.

### Escape ladder

Escape behaves as:

- if focused on a non-default target → focus `DEFAULT_TARGET`
- else → blur

---

### Typing from `DEFAULT_TARGET`

When focused on `DEFAULT_TARGET`:

- `TYPE` enters the first item edit target (if any)
- selects all
- inserts the typed character

---

### Enter from `DEFAULT_TARGET`

When focused on `DEFAULT_TARGET`:

- `CONFIRM` enters the first item edit target (if any)
- caret is placed at end (not select-all)
- if there is no item edit target, `CONFIRM` performs the view structural default

---

### Navigation does not implicitly enter edit

When navigation moves focus to a different item:

- the destination is focused at `DEFAULT_TARGET`
- navigation never auto-enters editing

---

# 3) View Specs

This chapter describes each view and its intent interpretation.

All views should be documented using the same template:

1. Purpose / mental model
2. DOM shape
3. Focus surfaces + targets
4. Navigation rules
5. Editing rules
6. Structural commands
7. Notable edge cases

---

## 3.1 Outline view

### Purpose

Outline is a hierarchical editor optimized for:

- structural navigation
- fast text editing
- nesting / splitting / joining

Outline presents items in a depth-first visible order.

---

### DOM shape

Outline renders:

- a body stamped as `.ui-body.ui-outline`
- for each presented item:
  - a `.ui-outline-node` shell (`.ui-item`)
  - optional `[.ui-meta structure]` in the shell
  - the mounted body for that item’s view

Group items render children recursively.

Scalar items render a body editor (`value`) and do not necessarily wrap themselves in an additional shell when mounted as the body root.

Canonical structure:

```text
.ui-body.ui-outline
  .ui-outline-node.ui-item                       (target: DEFAULT_TARGET)
    [.ui-meta structure]                         (optional shell/meta chrome; targets: label, conn:*)
    .ui-body...                                  (mounted child view body)
  .ui-outline-node.ui-item
    ...
```

Scalar item body (plain scalar):

```text
.ui-body.ui-outline
  [.ui-textfield structure]                      (target: value)
```

### Meta visibility (outline)

- meta is shown when label has content, connected fields exist, or the `label` target is focused.

---

### Focus surfaces and targets

Outline uses:

Shell/meta targets:

- `DEFAULT_TARGET`
- `label`
- `conn:*`

Body targets:

- `value`

---

### Navigation rules

#### Container focus (`DEFAULT_TARGET`)

Arrow navigation is structural:

- up/down: previous/next visible item
- left: parent item (if any)
- right: first child (if any)

---

#### Edit focus (non-default targets)

When focused on an edit target (`value` or `conn:*`):

- arrow keys traverse the edit-flow space
- traversal moves between edit stops (not structural shells)

Edit stops include:

- `conn:*` fields for connected-mode leaf items
- `value` for plain scalar leaf items

Label is excluded for now.

Caret policy:

- forward traversal places caret at start
- backward traversal places caret at end

---

### Editing rules

#### Primary edit target

Outline follows the universal first-edit-target rule (`conn:*` then `value`).

---

#### `=` shortcut

If the user types `=` on an empty plain scalar:

- the item is converted to formula connected mode
- focus moves to `conn:expr`

---

### Confirm rules

Enter behavior (outline-specific cases):

- If editing `value`:
  - split the scalar at caret selection into two sibling items
  - focus the new right item’s `value`

- If editing a `conn:*` field:
  - exit to `DEFAULT_TARGET`

---

### Tab rules

Tab performs nesting:

- Tab: indent (nest in)
- Shift+Tab: outdent (nest out)

When tabbing while editing:

- the view attempts to preserve the same target
- caret is clamped into the new text

---

### Delete rules

Outline interprets boundary delete as:

- removing empty items
- joining adjacent scalar items when appropriate
- removing non-scalar items structurally

After deletion:

- focus moves to a neighboring item or blurs if none remain

---

## 3.2 Table view

### Purpose

Table presents a group item as a grid:

- children of the table are rows
- children of each row are cells
- the first row defines the schema (column count)

Table is optimized for:

- spatial navigation
- fast data entry
- nested cell views

---

### DOM shape

Table mounts:

- `.ui-body.ui-table`
  - `.ui-table-header`
  - `.ui-table-body`

Rows are rendered as `.ui-table-row.ui-item` shells.

Each row contains:

- a meta-column cell (`.ui-table-meta-col`) for row item meta
- a set of cell shells for each cell item

The header renders schema cell meta by mounting `mountItemMeta(...)` for schema-row cells.

Canonical structure:

```text
.ui-body.ui-table
  .ui-table-header
    .ui-table-col.ui-table-meta-col
    .ui-table-col
      [.ui-meta structure]                       (schema cell meta; targets: label, conn:*)
    ...
  .ui-table-body
    .ui-table-row.ui-item                        (row target: DEFAULT_TARGET)
      .ui-table-cell.ui-table-meta-col
        [.ui-meta structure]                     (row meta; targets: label, conn:*)
      .ui-table-cell.ui-item                     (cell target: DEFAULT_TARGET)
        .ui-body...                              (mounted cell view body)
          [.ui-textfield structure]              (when mounted cell view is scalar `value`)
      ...
    ...
```

---

### Focus surfaces and targets

Row shells:

- `DEFAULT_TARGET` is attached to the row shell

Row meta targets:

- `label`
- `conn:*`

Cell shells:

- `DEFAULT_TARGET` attached to each cell shell

Cell body targets:

- `value` for editable scalar cells

---

### Traversal stops

- row container focus
- cell container focus
- cell edit targets (`value`)
- connected edit stops where applicable

---

### Navigation rules

#### Row container focus (`DEFAULT_TARGET`)

- up/down: move between rows
- right: enter first cell container (column 0)
- left: no-op (table does not currently escape left)

---

#### Cell container focus (`DEFAULT_TARGET`)

- left/right: move between cells
- up/down: move between rows in same column
- left from column 0: returns to row container focus

---

#### Cell edit focus (`value`)

Editors yield at boundaries:

- arrow keys yield at start/end to move to neighbor cell

---

### Tab traversal rules

Tab provides a linear traversal order:

- row container → first cell → next cells → next row container → …

Shift+Tab moves backward.

---

### Confirm rules (Enter)

Enter behavior is intentionally spreadsheet-like:

- From row container focus:
  - insert a new row after current row
  - focus new row container

- From cell editing (`value`):
  - commit and exit edit
  - move focus down one row in the same column (if possible)
  - otherwise exit to the same cell container

---

### Type-to-edit

Type-to-edit exception:

- typing while row container-focused does nothing (row container is structural)

---

### Structural commands

Table supports:

- add row after current row (Enter from row container)
- remove row (command-driven; not bound to Delete by default)

---

## 3.3 Slider view

### Purpose

Slider is a scalar editor optimized for numeric adjustment.

It provides:

- pointer dragging
- keyboard nudging
- formatted numeric display

---

### DOM shape

Slider mounts:

- `.ui-body.ui-slider`
  - `<input type="range">`
  - `.ui-slider-value`

Canonical structure:

```text
.ui-body.ui-slider
  input[type="range"]                            (body control; not a separate Core target)
  .ui-slider-value
```

---

### Focus surfaces and targets

Slider does not introduce extra targets beyond `DEFAULT_TARGET`.

The slider input is not a separate focus target; it is a body control.

---

### Navigation rules

Arrow keys nudge the value:

- left/down: decrement
- right/up: increment

Jump vs step:

- jump nudges by 10 steps
- step nudges by 1 step

---

### Editing rules

Slider commits only when:

- the item is a plain scalar
- the value is numeric/coercible

Value display formatting depends on step precision.

---

# 4) Styling & Visual Language

This chapter defines the styling contract for the UI. It describes the minimal visual system (chrome + body), the universal state classes, and layout-specific rail rules. It is intentionally small: the purpose is to keep CSS consistent and composable across views.

---

## 4.1 Two layers visually: Item chrome vs Item content

Styling assumes a two-layer presentation everywhere.

### Chrome (context-owned)

Chrome is rendered by the parent/context and includes:

- item rails (the signature marker)
- optional meta header (`.ui-meta`)

Chrome is responsible for reflecting universal state:

- focused
- issue

Chrome must not depend on the mounted body's internal DOM structure.

---

### Content (view-owned)

Content is rendered by the mounted view body:

- `.ui-body` subtree
- view-specific layout and controls

Content is styled neutrally by default. View-specific styling should not redefine universal chrome language.

---

## 4.2 Universal state classes (hard contract)

The UI uses a minimal, shared set of state classes:

- `.is-focused`
- `.is-issue`

These classes are applied to `.ui-item` shells (and optionally on child shells where relevant).

Styling rules:

- default: neutral rails and neutral meta (transparent)
- focused: rails + meta header use accent styling
- issue: rails + meta header use issue styling

Bodies should remain readable and neutral; state is expressed primarily through chrome.

---

## 4.3 Rails: signature + grouping language

Rails are the primary structural marker.

Principles:

1. Every item has a representative rail (directly or via its chrome context).
2. Groups are expressed as continuous rails composed of child rails, separated by gaps.
3. Rail direction matches layout direction:
   - vertical stacks -> vertical rail at left edge
   - horizontal stacks -> horizontal rail at top edge
4. Gaps are the separator language:
   - rails do not require divider lines
   - spacing between rail segments is the main grouping cue

Rails are drawn using pseudo-elements on the chrome elements that own layout geometry (not inside mounted body content).

---

## 4.4 Meta header styling rules

Meta is chrome, not content.

- `.ui-meta` is a header block, not a pill.
- It should visually connect to the rail for the item (no floating-chip treatment).
- Meta tinting follows state classes on the owning `.ui-item`:
  - focused -> accent-soft background
  - issue -> issue-soft background

Meta text styling is intentionally restrained:

- label: small, slightly stronger weight
- connection keys: small and muted
- connection values: monospaced (optional but recommended)

---

## 4.5 Layout-specific chrome rules

### Outline

Outline items are vertically stacked.

Chrome rules:

- `.ui-outline-node` renders the vertical rail segment at its left edge.
- Meta (if present) sits at the top of the node, above the mounted body.
- The outline group effect is created by stacked segments with small vertical gaps.

Canonical styling targets:

- `.ui-body.ui-outline`
- `.ui-outline-node` (rail owner)
- `.ui-outline-node > .ui-meta` (meta header)

---

### Table

Table is a grid. Layout uses CSS table formatting to preserve column alignment.

Structural rules:

- `.ui-body.ui-table` acts as the table.
- `.ui-table-header` is a table header group.
- `.ui-table-body` is a row group.
- `.ui-table-row` is a table row.
- `.ui-table-col` and `.ui-table-cell` are table cells.
- Spacing is implemented using:
  - `border-collapse: separate`
  - `border-spacing: <col-gap> <row-gap>`

Rails:

- Each data cell (`.ui-table-cell.ui-item`) renders a horizontal top rail.
- The row meta column cell (`.ui-table-cell.ui-table-meta-col`) renders a vertical left rail segment for the row.
- Rails are segmented naturally by `border-spacing`.

Header:

- Header styling is a separate component language.
- Header uses neutral strip styling and does not use rails.
- Header may contain schema meta UI for columns (`.ui-meta` mounted for schema cells).

Canonical styling targets:

- `.ui-body.ui-table`
- `.ui-table-col` (header cells)
- `.ui-table-cell` (body cells)
- `.ui-table-cell.ui-table-meta-col` (row rail owner)

---

### Slider

Slider has no nested chrome composition.

- `.ui-body.ui-slider` is styled as a single neutral control surface.
- State is reflected by the owning `.ui-item` chrome, not by slider internals.

---

## 4.6 Styling boundaries and invariants

To keep styling predictable:

- Chrome styling must not rely on body DOM internals.
- Body styling must not restyle chrome primitives (`.ui-meta`, rails).
- Selection-driven changes should be class toggles only (`.is-focused`, `.is-issue`).
- Avoid view-specific state classes unless a new view introduces a new semantic concept.

---

## 4.7 Recommended CSS structure

To keep CSS minimal and maintainable, organize stylesheets as:

1. Tokens (`:root`)
2. App frame (`#root`, `.ui-shell`, `.ui-shell-main`, `.ui-app`)
3. Universal primitives (`.ui-item`, `.ui-body`, `.ui-meta`, `.is-focused`, `.is-issue`, typography)
4. View chrome/layout blocks:
   - outline
   - table
   - slider
5. Text field primitive (`.ui-textfield`, `.ui-textfield-input`, `.ui-textfield-mirror`)

---

# Summary of invariants

- One item presentation → exactly one `.ui-item` shell.
- Shell owns: `DEFAULT_TARGET`, label, and conn targets.
- Body owns: value targets.
- Shell identity is stable across selection changes.
- Selection-driven updates must be styling-only.
- One tabbable element total (`.ui-shell-main`).
- Tab/Shift+Tab are always app commands.
- Tab is routed by Core and delivered to the active view intent handler (outer -> parent/context view; inner -> child view).
- Interaction is routed via intents.
- Editors yield semantically (they emit intents rather than bubbling raw events).
- Label editing is pointer-only and does not yield navigation.
- `CONFIRM` from `DEFAULT_TARGET` enters first item edit target, or runs the view structural default when no edit target exists.
- Table Enter in cell edit commits and moves down when possible.
- Mod+Enter inserts newline in multiline editors.
