# Style System

This document defines the shared styling language for the UI system. It is the normative reference for cross-view primitives, universal state styling, and focus and issue visual grammar.

## Scope

This document defines:

- Design tokens and token usage rules.
- CSS layering responsibilities.
- Shared primitives (`frame`, `body`, `header`, `rail`, `wash`).
- Universal state styling (`.is-selected`, `.is-node-selected`, `.is-issue`, and derived variables).
- Location language (node vs target, node-target vs edit-target, control vs editor).
- Issue language and issue/focus interaction.

## Deep feel and visual language

This section defines the intended deep feel and visual language for the system. These foundations are normative and SHOULD guide all view design and styling decisions.

### Ethos

The system is oriented towards cumulative learning.

- Understanding is treated as revisable, incomplete, and worth preserving.
- The system aims to strengthen human judgment with care, continuity, and restraint.
- The system supports thoughtful engagement rather than speed for its own sake.

### Temperament

The system should feel like quiet confidence.

- Calm, patient, trustworthy, steady.
- Balanced warmth, expressed through craft and restraint (neither cosy nor clinical).
- The atmosphere of a good notebook, a good workshop bench, a good library desk.

### Cognitive feel

The system is designed to support understanding that can evolve without losing coherence.

- Meaning develops through local context and relationships.
- Uncertainty and incompleteness are first-class and safe.
- Revision is expected and supported as normal.
- Continuity is protected across change and reorganisation.
- Connections are treated as threads of meaning: closer to citations and cross-references than diagrams, mostly implicit by default and explicitly revealable when needed.

### Interaction feel

The system should feel stable in the hands.

- Predictable: behaviour is consistent across contexts.
- Steady: navigation and editing feel deliberate rather than reactive.
- Reversible: change feels safe and recoverable.
- Coherent in focus: node selection and edit focus are distinct and visually legible.

### Visual grammar

The system uses a small set of stable primitives that remain consistent across views.

- Frame/body separation: structure is expressed in the frame; content is expressed in the body.
- Rails: structural markers and continuity cues.
- Header: a compact, contained identity surface for each node.
- Wash: the primary indicator of node selection.
- State language: a consistent vocabulary for focus, selection, editability, and issues.
- Quiet persistence: structure is legible without being loud.

### Material system

The system's surface character is balanced, durable, and readable.

- Surface tone is balanced (neither overly warm nor overly cool).
- Typography voice is calm and highly readable (neither overly literary nor overly technical).
- Density sits between airy and compact, with breathing room at structural levels.
- Warmth comes through craft: rhythm, proportion, restraint, and careful hierarchy.

## Mental model

### Frame layer and body layer

Every node is styled as two visual layers:

- Frame layer (system layer): owns rail, header, and optional wash; communicates system state.
- Body layer (content layer): owns view-specific content and local target affordances.

Rules:

- Frame styling MUST communicate node-level state (`focused`, `issue`) without relying on body semantics.
- Body styling MUST communicate target-level state without redefining frame language.

### Cross-view invariants

Rules:

- The rail and header MUST be interpretable without body context.
- The body MUST treat rail, header, and wash as frame-owned primitives.
- The body MUST NOT redefine or restyle rail and header language.
- Selection-driven state changes SHOULD use class toggles and derived variables, not structural DOM changes.
- Views SHOULD consume shared tokens and derived variables instead of hardcoded visual values.
- Nested nodes MUST remain visually coherent, with frame state scoped locally per node.

## Foundations

### Design tokens

Tokens are global and shared across primitives and views.

Rules:

- Tokens MUST be defined globally (typically on `:root`).
- Views SHOULD NOT use raw hex values, arbitrary radii, or ad hoc spacing values.
- Token names SHOULD reflect semantic role (for example `--ui-size-meta`, `--ui-space-pad`) rather than numeric scales, unless a numeric scale is genuinely needed.

Token categories:

- Typography:
  - Families (for example `--ui-font-sans`, `--ui-font-mono`).
  - Sizes/leading (for example `--ui-size-body`, `--ui-leading-meta`).
  - Weights (for example `--ui-weight-regular`, `--ui-weight-strong`).
- Geometry:
  - Spacing (for example `--ui-space-gap`, `--ui-space-pad`).
  - Shape/measure (for example `--ui-radius`, `--ui-ring`).
- Colors:
  - Base/surface and frame neutrals (for example `--ui-color-bg`, `--ui-color-surface`, `--ui-color-rail`, `--ui-color-header`).
  - Semantic state (for example `--ui-color-focus`, `--ui-color-issue`, `--ui-color-numeric`).

### CSS layering order

Rules:

- CSS SHOULD be structured in a stable layer order.
- Base layer SHOULD contain shared primitives (including header) when they are stable and minimal.
- Views SHOULD limit their layer to composition/layout only.
- Local affordances SHOULD be defined in base primitives; views SHOULD supply structure/classes only.

Recommended order:

1. Reset/normalization.
2. Tokens (`:root`).
3. Base primitives (`.ui-frame`, `.ui-body`, `.ui-header`, `.ui-textfield`).
4. Views (layout/composition only).

### View styling boundaries

Rules:

- Views MAY add view-specific state classes for view-specific semantics.
- Views MUST NOT redefine `.is-selected`, `.is-node-selected`, `.is-issue`, or frame-derived variables.
- Views MUST NOT alter rail segmentation/geometry language.
- Views MUST NOT replace the shared header language with a view-specific header system.
- Views MUST NOT add node-level focus rings; node-level focus belongs to rail and optional wash.

## Shared primitives

### Frame

The frame is the root visual shell for a node.

Rules:

- State classes MUST be applied on the frame root.
- Derived variables MUST be computed on the frame root.
- Frame-level state MUST be scoped locally and MUST NOT bleed across siblings.

### Body

The body is the view-specific content area.

Rules:

- The body MUST remain visually neutral relative to frame-level state language.
- The body MUST NOT restyle rail or header primitives.
- The body MUST NOT add node-level wash/ring language.
- The body MAY host active targets, but local affordance styling SHOULD come from shared base primitives.

### Header

The header is the stable, system-owned identity marker for a node.

Rules:

- The header MUST remain visually stable across views.
- The header MUST read as a single, contained identity surface.
- The header MUST use subtle fill and legible contrast.
- The header MUST NOT look like a view-specific widget.
- The header MUST remain legible independently of body styling.

Header content model:

- `Label`: communicates what the node is.
- `Conn`: communicates how the node is derived/wired/configured.

Layout rules:

- Header placement SHOULD communicate structure (node-level or set-level alignment).
- The header MUST support `stacked` and `inline` label/conn arrangements.
- Layout mode MAY switch based on available width.

### Textfield

Textfields are shared primitives used in headers and bodies.

Rules:

- Autosize textfields MAY be implemented using a hidden mirror element.
- `:has(.ui-textfield-mirror)` MAY be used to detect autosize mode when no explicit class is present.
- `.ui-textfield.is-stale` marks draft-vs-committed divergence and SHOULD include non-color cues when styled.

### Rail

The rail is the primary structural marker for boundaries and node focus. Each node renders one rail segment. Views that render items MUST align sibling segments so they read as a continuous rail for the item, separated by small gaps.

Rules:

- Each node MUST render a rail segment and it MUST NOT behave as a generic card border.
- Location and issue styling MUST be local to the node's own rail segment.
- Rail segments MUST NOT merge across siblings (the gap must remain visible).
- Rail segments SHOULD be square-ended at internal joins (between siblings).
- Rail segments SHOULD be rounded only at the outer ends of a contiguous item (first and last segment).
- Implementations SHOULD use structural selectors (`:first-*`, `:last-*`) on the nodes, not helper classes (for example `is-first`/`is-last`).

Notes:

- Rail segments may be rendered as pseudo-elements (for example `::before`) or real elements. Both follow the same rounding rules.
- Rail overlays (for example a thicker focus overlay) MAY be used if overlays stay local, preserve sibling geometry, and keep the inter-node gap visible.
- Hit targets MAY exceed visible rail width when usability requires it.

### Wash

The wash is a subtle background tint for node-level focus.

Rules:

- Wash MUST be subtle and frame-local.
- Wash MUST NOT appear by default for edit focus.
- Wash SHOULD appear only for node selection (`NODE_TARGET`).

## State model

### Required state classes

All frames MUST support these classes on the frame root:

- `.is-selected`.
- `.is-node-selected`.
- `.is-issue`.
- `.is-numeric`.

Application rules:

- Implementations SHOULD apply `.is-numeric` when the resolved value is numeric-like.

### Precedence and derived variables

Rules:

- `.is-issue` MUST override `.is-selected` for derived color decisions.
- The frame MUST derive canonical variables consumed by primitives.
- Frame-derived variables SHOULD be defined on `.ui-frame` so nested controls can consume them.
- Views MUST NOT set frame-derived state colors ad hoc.

Required derived variables:

- `--rail-tint`.
- `--header-fill`.
- `--frame-wash`.
- `--value-ink`.

### Selection-driven focus styling

Rules:

- Node-level selected state MUST be driven by `.is-selected`/`.is-node-selected`, not DOM `:focus`/`:focus-within`.
- Rail/header/wash MUST use frame-derived variables.
- DOM focus MAY be used only for node-target vs edit-target mode (`:focus` vs `:focus-within:not(:focus)`) and local control affordances (`:focus`).

## Location language

### Node focus vs target focus

Node focus answers "Which node is active?" and target focus answers "Where will input go?"

Rules:

- Node focus MUST be communicated by rail tint and optional wash.
- Node focus MUST NOT encode which field is active.
- Target focus MUST be communicated locally at the active control/editor.
- Target focus MUST NOT be expressed as a node-level ring.

### Node selection vs edit focus

Node selection (`NODE_TARGET`) represents active node, not active field.

Rules:

- Node selection: rail tint active, wash MAY be active, local rings SHOULD be absent.
- Edit focus (non-default target): rail tint remains active, wash SHOULD be off, local affordance MUST appear on active target.

### How DOM focus is used

Node state is model-driven by frame classes. DOM focus is only for local target affordances.

Signals:

- `.ui-frame.is-selected`: node is active in selection/editing context.
- `.ui-frame.is-node-selected`: node is part of node-selection range.
- `.ui-frame:focus`: frame outline reset only (no node-state meaning).
- `input/textarea/select/button:focus` and `.ui-textfield:focus-within`: active local control/editor.

Model:

- Node visuals (rail/wash) come from `.is-selected` / `.is-node-selected`.
- Target visuals (halo/ring/caret) come from local DOM focus.
- Use `:focus`/`:focus-within` for target affordances only; never for node state.

### Root focus indicator

Rules:

- Root node selection MAY use a thin edge rail on `.ui-main`.
- Root rail color SHOULD use frame-derived `--rail-tint` in both base and focused states.
- Root node selection MAY use the same wash behavior as focused node frames.
- Root focus styling MUST stay lightweight and MUST NOT imply node header/card framing.

### Control focus vs editor focus

Rules:

- Widget-like targets (`label`, `conn:*`, buttons, toggles, sliders) SHOULD use a local ring/halo.
- Control rings MUST remain local and compatible with issue palette overrides.
- Text-edit targets such as `content:text` SHOULD rely on caret/selection, not heavy rings or block-level wash.
- In the default DOM structure, header-owned targets (`label`, `conn:*`) are controls and body-owned text-edit targets (`content:text`) are editors.

### Cursor semantics

Rules:

- `.ui-frame` SHOULD use `cursor: pointer` to communicate node interactivity.
- Text targets MUST use `cursor: text`.
- Other controls SHOULD use `cursor: pointer`.

## Issue language

Issue state means a connection is broken or invalid and is persistent, not transient.

### Meaning and persistence

Rules:

- `.is-issue` MUST remain visible while focused or edited.
- `.is-issue` MUST NOT be replaced by focus styling.

### Interaction with focus

Rules:

- Issue state MUST remain dominant for frame-derived palette decisions.
- Location affordances SHOULD remain usable without hiding issue state.

### Recommended visual grammar

Issue-only (not focused):

- Rail: gentle issue tint.
- Header: gentle issue fill.
- Wash: off.

Issue + node selection:

- Rail: stronger issue tint.
- Header: stronger issue fill.
- Wash: subtle issue wash.

Issue + edit focus:

- Rail: stronger issue tint.
- Header: stronger issue fill.
- Wash: off.
- Local control ring: issue-tinted where applicable.

## Numeric language

### Meaning

- `.is-numeric` marks nodes whose resolved value is numeric (`number`) or a string parseable as a finite number.

### Scope

- `.is-numeric` is purely presentational metadata.
- `.is-numeric` MUST NOT affect evaluation, sorting, coercion, or storage semantics.

### Interaction with other states

- `.is-issue` takes precedence for frame palette decisions.
- `.is-numeric` MUST NOT alter rail or header primitives by default.
- `.is-numeric` MAY alter body value styling via `--value-ink`.

### Styling contract

- `.ui-frame` defines `--value-ink` defaulting to `--ui-color-fg`.
- `.ui-frame.is-numeric` overrides `--value-ink` to `--ui-color-numeric`.
- Views MAY opt into `--value-ink` for value text.
- Views MUST NOT hardcode numeric colors.

## Implementation guidance

### Selection-driven updates

Rules:

- Selection-driven visual updates SHOULD be class toggles and variable changes on the frame root.
- Selection-driven updates SHOULD NOT remount subtrees, restructure DOM, or swap primitives.

### Token-driven values

Rules:

- Primitives SHOULD use tokens for geometry/typography.
- Primitives SHOULD use derived variables for state color.
- Views SHOULD avoid hardcoded visual constants.

### Shrinkable layouts and overflow

Rules:

- Containers that need to shrink SHOULD use `min-width: 0`.
- Text that may overflow SHOULD use explicit overflow handling.
- Header mode SHOULD adapt (`stacked`/`inline`) to available width.

### Common pitfalls

- Styling rails/headers from DOM `:focus`, which causes selection/routing mismatch and double-focus effects.
- Treating the rail as a generic border (card outlines), which collapses the rail language into stacked boxes.
- Inventing per-view header language, which breaks system-owned identity cues.

## Quick reference

Universal state classes:

- `.is-selected`: node participates in active selection/editing context.
- `.is-node-selected`: node is part of node-selection range.
- `.is-issue`: broken/invalid connection.
- `.is-numeric`: numeric-like resolved value.

Precedence:

- `.is-issue` overrides `.is-selected` for frame-derived palette.

Frame-derived variables:

- `--rail-tint`: rail segment tint.
- `--header-fill`: header fill.
- `--frame-wash`: node wash.
- `--value-ink`: value text ink.
- Default neutral bases: `--ui-color-rail` for rail tint, `--ui-color-header` for header fill; `--ui-color-surface` remains the generic panel/surface neutral.

Location grammar:

- Node focus = rail tint (+ optional wash).
- Target focus = local affordance only.
- Node selection = wash on, no local rings.
- Edit focus = wash off, local ring/caret on active target.

Rail rules

- Each node renders one rail segment.
- Item layouts align sibling segments into a continuous rail with small gaps.
- Segments never merge across siblings.
- Segments are square at internal joins and rounded only at the outer ends of the item.

CSS layering:

1. Reset.
2. Tokens.
3. Base primitives.
4. Views (layout/composition only).
