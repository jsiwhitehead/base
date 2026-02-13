# UI Guide

This guide describes the DOM/UI system layered on Core: how UI is structured, how it mounts and disposes safely, how it stays reactive and stable, and how user interaction is routed consistently across views.

**This guide does not duplicate the Core contract.** The Core API and selection model are defined in `core-api.md`. This guide documents the UI layer conventions and responsibilities.

---

## 0. Scope and principles

The UI layer is intentionally small. It is not a general UI framework. It is a small set of primitives and conventions designed for an editor-like application where:

- Selection drives focus and interaction.
- Nested views compose cleanly.
- DOM identity remains stable across navigation.
- Keyboard behavior is predictable and consistent.

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
        [.ui-body.<root-view> subtree]        (mounted root view body)
```

Tab invariant:

- `.ui-shell-main` is the only tabbable element in the app.
- All other focus movement is programmatic via Core targets.

---

## 1.1 Two layers everywhere: Shell vs Body

Every item presentation uses two conceptual layers:

### Shell (owned by the parent/context)

The shell is the stable wrapper element for an item.

A shell is responsible for:

- Representing exactly one Core item presentation.
- Adding the `.ui-item` class.
- Setting a stable `data-id` (recommended).
- Being programmatically focusable (`tabIndex = -1` if not already set).
- Attaching `DEFAULT_TARGET`.
- Handling pointer selection on the item.
- Applying selection-driven state classes (e.g. `.is-focused`, `.is-issue`).
- Rendering item chrome (rails + optional meta).

Shell logic is shared and implemented by:

- `bindUiItemShell(ctx, { core, focus }, shellEl)`

Shells must remain structurally stable across selection changes.

---

### Meta (part of shell ownership)

Meta is item chrome rendered by the parent/context.

Meta includes:

- Label editor (`target = "label"`).
- Connected field editors (`target = "conn:*"`).

Meta is not view-specific. It is item-specific.

Meta rendering policy:

- Parent/context controls meta visibility by mounting/unmounting it.
- Remounting meta starts editors from committed state.

Canonical meta structure:

```text
.ui-meta
  .ui-meta-label
    [.ui-textfield subtree]                   (target: label)
  .ui-meta-conn
    .ui-meta-conn-row                           (repeated)
      .ui-meta-conn-key
      .ui-meta-conn-val
        [.ui-textfield subtree]               (target: conn:<fieldKey>)
```

---

### Body (owned by the mounted view)

The body is the view-specific UI subtree.

A body is responsible for:

- Rendering `.ui-body` (or an element stamped as body).
- Rendering view-specific structure.
- Rendering children (via shell/body composition).
- Attaching **body-owned targets**.
- Rendering view-owned controls (text editors, sliders, etc.).

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

- The `value` target.
- Any future body-specific targets.

Bodies must not attach `label` or `conn:*`.
Shell/meta must not attach `value`.

This keeps:

- Item chrome consistent across contexts.
- View bodies simpler.
- Target behavior uniform regardless of which view is mounted.

---

### Editability and mode

Editability is mode-driven:

- `readonly` is a hard stop for editing.
- `plain` vs `connected` determines which edit targets exist (`value` vs `conn:*`).

The UI may convert modes (`plain` and `connected`), but conversion must be explicit.

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

- Automatic teardown of:
  - Event listeners registered through `ctx.on`.
  - Reactive effects registered through `ctx.effect`.
  - Target bindings registered through `ctx.target`.
  - Mounted static child components registered through `ctx.mount`.
  - Mounted child subtrees managed through `ctx.slot` / `ctx.list`.
- Predictable disposal:
  - All cleanups run.
  - The component root is emptied.

This is the primary mechanism preventing:

- Memory leaks.
- Stale DOM.
- Stale focus targets.
- Duplicate effects.
- Forgotten disposal of mounted views/components.

---

## 1.3 `Ctx`: the UI’s minimal mounting API

`createComponent` supplies a `Ctx` that provides safe building blocks.

Quick chooser:

- `ctx.on`: attach DOM listeners with automatic cleanup.
- `ctx.effect`: run reactive effects with automatic cleanup.
- `ctx.target`: bind Core focus targets to DOM elements.
- `ctx.mount`: append a static child component once.
- `ctx.slot`: mount one reactive child subtree.
- `ctx.list`: mount a keyed reactive child list.

---

### `ctx.on(el, type, handler, opts?)`

Registers an event listener and automatically removes it on dispose.

Views should not call `addEventListener` directly.

---

### `ctx.effect(run)`

Registers a reactive effect using signals.

`run()` may return a cleanup function which is called:

- Before the effect re-runs.
- When the component is disposed.

Effects should be written as idempotent updates to DOM state.

---

### `ctx.target(focus, target, getEl, opts?)`

Attaches a Core focus target binding.

This registers a DOM element as the focus destination for a given `{ focus, target }`.

This is the only correct way to integrate DOM focus with Core selection.

---

### `ctx.mount(host, child)`

Mounts a static child component into `host`.

- Appends `child.el` to `host`.
- Automatically disposes `child` when the parent component is disposed.
- Use this for child components created once during build.

---

## 1.3.1 Regions: stable insertion points

`ctx.slot` and `ctx.list` are region-based reactive mounting primitives.

A **region** is a stable insertion point inside a host element where dynamic children live. Regions:

- Preserve DOM order (relative to static siblings and other regions).
- Allow updates without wrapper elements.
- Ensure removals dispose correctly.

Regions are created implicitly when `ctx.slot` / `ctx.list` are called, and stay fixed for the component lifetime.

**Hard rule:** once a region exists in a host, do not clear or replace the host's children manually (`replaceChildren`, `innerHTML = ""`, etc.). Doing so destroys the region anchors.

---

### `ctx.slot(host, getComponent)`

Mounts **zero or one** component into a stable region inside `host`.

- Creates a region at the call site.
- Installs an effect which re-runs when reactive dependencies read by `getComponent()` change.
- On each run:
  - Disposes the previously mounted component (if any).
  - Mounts the next component (or clears the region if `null`).
- Disposal is automatic; callers do not track the current child manually.

Used for:

- Conditional chrome (meta on/off).
- Switching between view bodies (group vs scalar).
- Mounting `core.mountView(...)` where the view kind can change.

---

### `ctx.list(host, getIds, mountById)`

Mounts a **keyed list** of components into a stable region inside `host`.

- Creates a region at the call site.
- Installs an effect which re-runs when reactive dependencies read by `getIds()` change.
- Reconciles children by key:
  - Reuses existing components for ids that remain.
  - Disposes components for ids that are removed.
  - Orders DOM to match `getIds()` exactly.

Used for:

- Outline child nodes.
- Table rows.
- Table columns / schema-driven subtrees.

---

## 1.4 Reactivity & stability rules

Selection changes are frequent and must be cheap.

### Rule: selection-driven updates must be styling-only

Selection-driven effects should only:

- Toggle classes.
- Update datasets.
- Update caret/editor state.

Selection-driven effects must not:

- Rebuild shells.
- Remount bodies.
- Restructure lists.

---

### Rule: `.ui-item` identity must be stable across navigation

A `.ui-item` element represents a specific item presentation.

When selection moves, the `.ui-item` DOM nodes must not be replaced; only their styling should change.

This is foundational to predictable focus and pointer behavior.

---

### Rule: structural swaps must be gated by stable discriminators

When a subtree genuinely changes shape, `ctx.slot` should be fed by a stable discriminator (for example, a computed `"group" | "value"` or a view name).

This ensures:

- Edits and selection changes don't remount structure.
- Swaps happen only when structure truly changes.

---

### Rule: one region per responsibility

Prefer:

- One `slot` for one conditional/switchable subtree.
- One `list` for one repeated sequence.

Avoid building manual reconciliation inside effects; the region primitives exist to own lifecycle and ordering safely.

---

## 1.5 DOM helpers and conventions

The UI layer provides small helpers that encode conventions:

- `el(tag, className?, text?)`
- `setData(el, key, value)`
- `caretFromTarget(eventTarget)`

Helpers exist to keep DOM code terse and consistent. Structural mounting/reconciliation should be done via `ctx.slot` / `ctx.list` (regions), not ad-hoc child management.

---

# 2) Interaction & Editing

This chapter defines how keyboard and pointer input is routed and how editors behave.

---

## 2.1 Focus, targets, and caret (UI-level model)

Core selection is always either:

- Idle (blurred).
- Focused: `{ focus, target, caret? }`.

The UI treats targets as named focus surfaces:

- `DEFAULT_TARGET` — item container focus (shell).
- `label` — label editor (shell/meta).
- `conn:*` — connected editors (shell/meta).
- `value` — primary content editor (body).

Universal item edit targets are:

- `conn:*` fields (in connected mode).
- `value` (in plain scalar mode).

`label` is a valid target but is not part of standard keyboard edit-entry flow.

Universal label editing policy (current):

- Label editing is pointer-accessible only.
- Keyboard navigation does not enter label.
- Label targets do not yield navigation while editing.
- Label is not part of edit-stop traversal.

Caret values are meaningful only for caret-supporting targets (typically text editors).

---

## 2.2 Hard focus and tab invariants

These are intentional design choices.

### Exactly one tabbable element

The app uses exactly one tabbable element total:

- `.ui-shell-main` (`tabIndex=0`)

No other element participates in browser tab-order navigation.

---

### Tab / Shift+Tab are always app commands

Tab is never used for browser focus traversal.

Even inside text editors:

- Tab is intercepted and translated into an app intent.
- The view defines what Tab means.

This makes keyboard behavior consistent and view-controlled.

---

### Tab is delivered to the current view

`TAB` / `Shift+TAB` is always interpreted by exactly one current view based on focused ownership.

- Focus on an outer container/target routes `TAB` to the parent/context view.
- Focus on an inner container/target routes `TAB` to the child view that owns that target.

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

- View logic simple.
- Editor logic reusable.
- Behavior consistent across views.

---

## 2.4 Keyboard routing

Keyboard routing happens at two levels.

### Global routing

Core owns the global `keydown` listener (attached once for the app).

Core:

- Parses the event into an intent.
- Consumes the DOM event when it routes an intent.
- Handles global commands (for example, Escape ladder).
- Routes view intents to the active view intent handler.
- Lets native text editors handle local text input first; explicit global commands may still be handled by Core.

---

### Editor yielding

Editors implement yielding inside `buildTextField` when `yieldNav` and `onIntent` are enabled.

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

- Outline-style editing.
- Grid-style editing.
- Predictable navigation at text boundaries.

---

## 2.5 Pointer routing

Pointer behavior is intentionally simple and consistent.

### Shell pointerdown

`.ui-item` shells handle pointerdown by:

- Focusing the item at `DEFAULT_TARGET`.
- Capturing a caret (if the pointer was on a text editor).
- Stopping propagation.

This is owned by `bindUiItemShell`.

---

### Editor pointerdown

Editors handle pointerdown by:

- Focusing their specific target.
- Using `caretFromTarget(e.target)` for caret placement.
- Stopping propagation.

---

## 2.6 Text editing controls

The UI provides one text control:

- `buildTextField` (configured with options, including `autosize: true`)

`buildTextField` supports:

- Multiline mode (`input` vs `textarea`).
- Autosize mode (mirror-driven sizing).
- Edit model: `live` or `draft`.
- Yielding on/off (`yieldNav`; labels typically disable yielding).

Canonical DOM:

```text
.ui-textfield
  .ui-textfield-mirror                          (optional; aria-hidden="true")
  input.ui-textfield-input | textarea.ui-textfield-input
```

Autosize semantics (`autosize: true`):

- Mirror is hidden but drives autosize layout.
- Input/textarea overlays the mirror in the same slot.

Padding note:

- For autosize fields, apply padding to both `.ui-textfield-input` and `.ui-textfield-mirror` (not `.ui-textfield`).
- Autosize textfields must opt out of global `width: 100%` defaults (for example: wrapper uses `fit-content` and input uses auto width).

`buildTextField` instances:

- Attach their target via `ctx.target(...)`.
- Participate in yielding when `yieldNav` and `onIntent` are enabled.
- Respect readonly state.
- Rely on shell-level issue state via `.ui-item.is-issue`.

---

### 2.6.1 Editor commit models

Editors support two commit models:

#### Live

- Commits on every `input`.
- No local draft state.
- Cancel does not revert.

Use when:

- Updates are cheap.
- “what you see is what Core has” is desired.

---

#### Draft

- Maintains local draft state while focused.
- Commits on:
  - `CONFIRM`
  - `TAB`
  - `NAV` (yielded)
  - `blur`
- Cancels on `CANCEL`.
- Resets to committed state when focus leaves.

Draft mode exists to provide:

- Explicit commit points.
- Cancellation.
- Stable editing across reactive reruns.

---

### 2.6.2 Multiline Enter rules

In multiline editors:

- `Enter` is interpreted as `CONFIRM` (commit/exit) by default.
- `Ctrl+Enter` or `Meta+Enter` inserts a newline.

This preserves:

- Fast commit behavior.
- The ability to enter multiline content intentionally.

---

## 2.7 Universal interaction rules

These are shared across views.

### Escape ladder

Escape behaves as:

- If focused on a non-default target -> focus `DEFAULT_TARGET`.
- Else -> blur.

---

### Typing from `DEFAULT_TARGET`

When focused on `DEFAULT_TARGET`:

- `TYPE` enters the first item edit target (if any).
- Selects all.
- Inserts the typed character.

---

### Enter from `DEFAULT_TARGET`

When focused on `DEFAULT_TARGET`:

- `CONFIRM` enters the first item edit target (if any).
- Caret is placed at end (not select-all).
- If there is no item edit target, `CONFIRM` performs the view structural default.

---

### Navigation does not implicitly enter edit

When navigation moves focus to a different item:

- The destination is focused at `DEFAULT_TARGET`.
- Navigation never auto-enters editing.

---

# 3) View Specs

This chapter describes each view and its intent interpretation.

All views should be documented using the same template:

1. Purpose / mental model.
2. DOM shape.
3. Focus surfaces + targets.
4. Navigation rules.
5. Editing rules.
6. Structural commands.
7. Notable edge cases.

---

## 3.1 Outline view

### Purpose

Outline is a hierarchical editor optimized for:

- Structural navigation.
- Fast text editing.
- Nesting / splitting / joining.

Outline presents items in a depth-first visible order.

---

### DOM shape

Outline renders:

- A body stamped as `.ui-body.ui-outline`.
- For each presented item:
  - A `.ui-outline-node` shell (`.ui-item`).
  - Optional `[.ui-meta subtree]` in the shell.
  - Nested `[.ui-body.<child-view> subtree]` for that item’s mounted view body.

Group items render children recursively.

Scalar items render a body editor (`value`) and do not necessarily wrap themselves in an additional shell when mounted as the body root.

Canonical structure:

```text
.ui-body.ui-outline
  .ui-outline-node.ui-item                       (target: DEFAULT_TARGET)
    [.ui-meta subtree]                         (optional shell/meta chrome; targets: label, conn:*)
    [.ui-body.<child-view> subtree]            (mounted child view body)
  .ui-outline-node.ui-item
    ...
```

Scalar item body (plain scalar):

```text
.ui-body.ui-outline
  [.ui-textfield subtree]                      (target: value)
```

### Meta visibility (outline)

- Meta is shown when label has content, connected fields exist, or the `label` target is focused.

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

- Up/down: previous/next visible item.
- Left: parent item (if any).
- Right: first child (if any).

---

#### Edit focus (non-default targets)

When focused on an edit target (`value` or `conn:*`):

- Arrow keys traverse the edit-flow space.
- Traversal moves between edit stops (not structural shells).

Edit stops include:

- `conn:*` fields for connected-mode leaf items.
- `value` for plain scalar leaf items.

Label is excluded for now.

Caret policy:

- Forward traversal places caret at start.
- Backward traversal places caret at end.

---

### Editing rules

#### Primary edit target

Outline follows the universal first-edit-target rule (`conn:*` then `value`).

---

#### `=` shortcut

If the user types `=` on an empty plain scalar:

- The item is converted to formula connected mode.
- Focus moves to `conn:expr`.

---

### Confirm rules

Enter behavior (outline-specific cases):

- If editing `value`:
  - Split the scalar at caret selection into two sibling items.
  - Focus the new right item’s `value`.
- If editing a `conn:*` field:
  - Exit to `DEFAULT_TARGET`.

---

### Tab rules

Tab performs nesting:

- Tab: indent (nest in).
- Shift+Tab: outdent (nest out).

When tabbing while editing:

- The view attempts to preserve the same target.
- Caret is clamped into the new text.

---

### Delete rules

Outline interprets boundary delete as:

- Removing empty items.
- Joining adjacent scalar items when appropriate.
- Removing non-scalar items structurally.

After deletion:

- Focus moves to a neighboring item or blurs if none remain.

---

## 3.2 Table view

### Purpose

Table presents a group item as a grid:

- Children of the table are rows.
- Children of each row are cells.
- Core maintains a shared labeled column set and order across rows.

Table is optimized for:

- Spatial navigation.
- Fast data entry.
- Nested cell views.

---

### DOM shape

Table mounts:

- `.ui-body.ui-table`:
  - `.ui-table-header`
  - `.ui-table-body`

Rows are rendered as `.ui-table-row.ui-item` shells.

Each row contains:

- A meta-column cell (`.ui-table-meta-col`) for row item meta.
- A set of cell shells for each cell item, each nesting `[.ui-body.<cell-view> subtree]`.

The header renders schema cell meta by mounting `buildItemMeta(...)` for schema-derived cells.

Canonical structure:

```text
.ui-body.ui-table
  .ui-table-header
    .ui-table-col.ui-table-meta-col
    .ui-table-col
      [.ui-meta subtree]                       (schema cell meta; targets: label, conn:*)
    ...
  .ui-table-body
    .ui-table-row.ui-item                        (row target: DEFAULT_TARGET)
      .ui-table-cell.ui-table-meta-col
        [.ui-meta subtree]                     (row meta; targets: label, conn:*)
      .ui-table-cell.ui-item                     (cell target: DEFAULT_TARGET)
        [.ui-body.<cell-view> subtree]         (mounted cell view body)
      ...
    ...
```

---

### Focus surfaces and targets

Row shells:

- `DEFAULT_TARGET` is attached to the row shell.

Row meta targets:

- `label`
- `conn:*`

Cell shells:

- `DEFAULT_TARGET` attached to each cell shell.

Cell body targets:

- `value` for editable scalar cells.

---

### Traversal stops

- Row container focus.
- Cell container focus.
- Cell edit targets (`value`).
- Connected edit stops where applicable.

---

### Navigation rules

#### Row container focus (`DEFAULT_TARGET`)

- Up/down: move between rows.
- Right: enter first cell container (column 0).
- Left: no-op (table does not currently escape left).

---

#### Cell container focus (`DEFAULT_TARGET`)

- Left/right: move between cells.
- Up/down: move between rows in same column.
- Left from column 0: returns to row container focus.

---

#### Cell edit focus (`value`)

Editors yield at boundaries:

- Arrow keys yield at start/end to move to neighbor cell.

---

### Tab traversal rules

Tab provides a linear traversal order:

- Row container -> first cell -> next cells -> next row container, then repeat.

Shift+Tab moves backward.

---

### Confirm rules (Enter)

Enter behavior is intentionally spreadsheet-like:

- From row container focus:
  - Insert a new row after current row.
  - Focus new row container.
- From cell editing (`value`):
  - Commit and exit edit.
  - Move focus down one row in the same column (if possible).
  - Otherwise exit to the same cell container.

---

### Type-to-edit

Type-to-edit exception:

- Typing while row container-focused does nothing (row container is structural).

---

### Structural commands

Table supports:

- Add row after current row (Enter from row container).
- Remove row (command-driven; not bound to Delete by default).

---

## 3.3 Slider view

### Purpose

Slider is a scalar editor optimized for numeric adjustment.

It provides:

- Pointer dragging.
- Keyboard nudging.
- Formatted numeric display.

---

### DOM shape

Slider mounts:

- `.ui-body.ui-slider`:
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

- Left/down: decrement.
- Right/up: increment.

Jump vs step:

- Jump nudges by 10 steps.
- Step nudges by 1 step.

---

### Editing rules

Slider commits only when:

- The item is a plain scalar.
- The value is numeric/coercible.

Value display formatting depends on step precision.

---

# 4) Styling & Visual Language

This chapter defines the styling contract for the UI. It describes the minimal visual system (chrome + body), the universal state classes, and layout-specific rail rules.

It is intentionally small: the purpose is to keep CSS consistent and composable across all views, and to preserve one recognizable visual language throughout.

---

## 4.1 Visual foundations (tokens)

The UI is driven by a small set of global tokens. These tokens define the visual identity and should be treated as the canonical defaults.

Token categories:

- Typography (fonts, sizes, weights, line-height).
- Geometry (gap, padding, inset, rail thickness, radius).
- Colors (text, muted text, background, chrome fill, focus, issue).

Tokens should be defined at `:root` and referenced everywhere else. View styles should not hardcode raw values unless unavoidable.

---

## 4.2 Two layers visually: Item chrome vs Item content

Styling assumes a two-layer presentation everywhere.

### Chrome (context-owned)

Chrome is rendered by the parent/context and includes:

- Item rails (the signature marker).
- Optional meta header (`.ui-meta`).

Chrome is responsible for reflecting universal state:

- Focused.
- Issue.

Chrome must not depend on the mounted body's internal DOM structure.

---

### Content (view-owned)

Content is rendered by the mounted view body:

- `.ui-body` subtree.
- View-specific layout and controls.

Content is styled neutrally by default. View-specific styling should not redefine universal chrome language.

---

## 4.3 Universal state classes (hard contract)

The UI uses a minimal, shared set of state classes:

- `.is-focused`
- `.is-issue`

These classes are applied to `.ui-item` shells (and optionally on child shells where relevant).

State styling rules:

- Rails and meta always share one chrome fill.
- Default: neutral fill.
- Focused: focus fill.
- Issue: issue fill.
- Priority: `issue` overrides `focus`.
- Focus is shown by chrome fill only (no focus ring).
- Selection is local: only the selected item is loud; selected issue uses an issue-colored pill overlay.
- Path context is subtle and local:
  - Selected path (ancestors): gentle emphasis on each ancestor's own segment.
  - Issue path (ancestors): lighter issue tint on each ancestor's own segment.
- Siblings are never tinted by another item's state.

Bodies should remain readable and neutral; state is expressed primarily through chrome.

---

## 4.4 Chrome fill derivation

Chrome styling is driven through a single derived value on `.ui-item`:

- `.ui-item` defines one derived chrome fill: `--chrome-color`.
- `.is-focused` and `.is-issue` override that derived fill according to the state priority stack.
- Rails and meta use the derived fill, not raw state tokens.

This keeps:

- Rails and meta always match.
- State styling is centralized.
- Chrome does not depend on body structure.

---

## 4.5 Rails: signature + grouping language

Rails are the primary structural marker.

They communicate:

1. Hierarchy map (nested containment).
2. Item segmentation (sibling boundaries).
3. State (selection and issues).

Rails are structural guides, not borders or cards.

### One rail design everywhere

Rails use one design everywhere.
Each item has one rail segment at its depth.

Principles:

1. Grouping is shown by segmented rails and spacing, not divider lines.
2. Rail direction follows layout:
   - Vertical stacks -> vertical rail at the leading edge.
   - Horizontal/table layouts -> horizontal rail at the top edge.
3. State is item-local:
   - Primary selection/issue styling applies to that item's own segment.
   - Ancestor path context may add subtle emphasis/tint on ancestors' own segments.
   - State does not spill to unrelated siblings.

### Continuity and rounding

- Default segments use square ends.
- Only the leading and trailing ends of a contiguous run are rounded.
- The selected item draws a louder pill overlay with rounded ends on its own segment.

### Interaction

- Rail segments remain visible and clickable.
- Each segment should provide a wider hit target with a narrower visible rail mark inside it.

Rails are drawn on chrome elements that own layout geometry (never inside mounted body content).

---

### Prominence hierarchy (quiet -> loud)

1. Default item rail segment.
2. Context segment (selected-path emphasis or issue tint).
3. Selected item segment (loud pill overlay; issue-colored when selected item has issue).

---

### What does not happen

- No multi-item selection glow.
- No sibling or unrelated-item spillover from selection/issue state.
- No per-depth or per-type rail shape or thickness changes.

---

### Rail implementation contract

- Start by choosing a rail owner: the chrome/layout element that defines the rail segment.
- Rail owners live in chrome/layout (`.ui-outline-node`, `.ui-table-cell`, `.ui-table-cell.ui-table-meta-col`), never inside mounted body content.
- Render rails either as an owner `::before` (absolute in a `position: relative` owner) or as the owner surface fill.
- Rails always use `--chrome-color` and never read raw state tokens directly.
- Rails must not change layout sizing (no rail via `border-left`/`border-top` substitutions).
- Rail grouping/segmentation comes from layout gaps (`gap`/`border-spacing`), not divider lines.

---

### Rail geometry (identity-defining)

Rails should be driven by tokens:

- Rail thickness (`--rail`).
- Rail end radius.
- Rail inset rules.

Default segment endcaps are square; rounded caps are reserved for run boundaries and selected overlays.

These values are part of the UI's visual identity and should not vary between views except where explicitly called out.

---

## 4.6 Meta styling rules

Meta is chrome, not content.

- `.ui-meta` is chrome, not a separate control surface.
- When present, meta and rail must read as one continuous block (shared fill, no seam).
- Meta fill uses the same derived chrome fill as rails.
- Meta is full-width by default. Views may override meta sizing when needed.
- Body value editors may remain full-width.

Meta typography is intentionally restrained:

- Label: smaller size, slightly stronger weight.
- Connection keys: smallest size, muted.
- Connection values: monospaced.

### Textfield styling rules

Textfields are base primitives. Add styles on the base `.ui-textfield` element using scoped CSS.

- Padding is the exception. Set it through `--tf-pad-x` and `--tf-pad-y` on the wrapper.

---

## 4.7 Layout-specific chrome rules

### Outline

Outline items are vertically stacked.

Chrome rules:

- `.ui-outline-node` renders the vertical rail segment at its left edge.
- Rails are depth-aligned in nested vertical columns.
- Deeper columns are horizontally indented.
- Small vertical gaps segment siblings and outline the nested tree shape.
- Meta (if present) sits at the top of the node, above the mounted body.
- Outline overrides meta sizing to shrink-wrap for compact chrome.
- Meta and rail should visually merge into a single block.

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
- The row meta column cell (`.ui-table-cell.ui-table-meta-col`) uses the cell surface itself as the row's vertical left rail segment.
- Rails are segmented naturally by `border-spacing`.

Header:

- Header containers do not use rails.
- Header cells use a neutral "header surface" styling (separate from chrome rails).
- Header may contain schema meta UI for columns.
- Schema meta in headers is rendered using the same meta DOM, but is visually "unstyled" (transparent background, no chrome padding). The header cell provides the container styling.

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

## 4.8 Styling boundaries and invariants

To keep styling predictable:

- Chrome styling must not rely on body DOM internals.
- Body styling must not restyle chrome primitives (`.ui-meta`, rails).
- Selection-driven changes should be class toggles only (`.is-focused`, `.is-issue`).
- Avoid view-specific state classes unless a new view introduces a new semantic concept.
- Prefer token-driven values over hardcoded per-view numbers.
- In flex/grid layouts, apply `min-width: 0` to shrinkable items; apply overflow/truncation rules on the text element itself.

---

## 4.9 Recommended CSS structure

Use a fixed layer order to keep CSS predictable:

1. Reset: baseline normalization only.
2. Tokens (`:root`): define tokens only here; all other layers consume them.
3. Base primitives (`.ui-item`, `.ui-body`, `.ui-textfield`): shared defaults and primitive behavior.
4. Components (`.ui-meta`): reusable chrome primitives.
5. Views (outline, table, slider): layout/composition only; do not redefine shared chrome/state language.

---

# Summary of invariants

Structure and ownership:

- One item presentation -> exactly one `.ui-item` shell.
- Shell/meta owns `DEFAULT_TARGET`, `label`, and `conn:*`.
- Body owns `value`.
- `.ui-item` identity stays stable across selection changes.
- Selection-driven updates are styling-only.

Focus and interaction:

- The app has one tabbable element: `.ui-shell-main`.
- Tab/Shift+Tab are app commands, not browser focus traversal.
- Tab is routed by Core to the active view intent handler (outer -> parent/context, inner -> child).
- Interaction is intent-driven; editors yield semantically.
- Label editing is pointer-only and does not yield navigation.

Editing behavior:

- `CONFIRM` from `DEFAULT_TARGET` enters the first item edit target, or runs the view structural default if none exists.
- Table Enter in cell edit commits and moves focus down when possible.
- In multiline editors, Mod+Enter inserts a newline.

Mounting and reactivity:

- Dynamic subtrees are mounted through regions (`ctx.slot`, `ctx.list`) to preserve DOM order and lifecycle.
- Once a host has a region, do not manually clear/replace host children; update through `slot`/`list`.

Rails and state:

- Rail system has one primitive: each item has one rail segment at its depth.
- Rail state is item-local; path context is subtle and siblings are unaffected.
