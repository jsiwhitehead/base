# Style System

This document defines the shared styling language for the UI system. It is the normative reference for cross-view primitives, universal state styling, and focus and issue visual grammar.

## Scope

This document defines:

- Design tokens and token usage rules.
- CSS layering responsibilities.
- Shared primitives (`frame`, `body`, `header`, `rail`, `wash`).
- Universal state styling (`.is-focused`, `.is-issue`, and derived variables).
- Focus language (item vs target, container vs edit, control vs editor).
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
- Coherent in focus: container focus and edit focus are distinct and visually legible.

### Visual grammar

The system uses a small set of stable primitives that remain consistent across views.

- Frame/body separation: structure is expressed in the frame; content is expressed in the body.
- Rails: structural markers and continuity cues.
- Header: a compact, contained identity surface for each item.
- Wash: the primary indicator of container focus.
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

Every item is styled as two visual layers:

- Frame layer (system layer): owns rail, header, and optional wash; communicates system state.
- Body layer (content layer): owns view-specific content and local target affordances.

Rules:

- Frame styling MUST communicate item-level state (`focused`, `issue`) without relying on body semantics.
- Body styling MUST communicate target-level state without redefining frame language.

### Cross-view invariants

Rules:

- The rail and header MUST be interpretable without body context.
- The body MUST treat rail, header, and wash as frame-owned primitives.
- The body MUST NOT redefine or restyle rail and header language.
- Selection-driven state changes SHOULD use class toggles and derived variables, not structural DOM changes.
- Views SHOULD consume shared tokens and derived variables instead of hardcoded visual values.
- Nested items MUST remain visually coherent, with frame state scoped locally per item.

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
  - Base/surface (for example `--ui-color-bg`, `--ui-color-surface`).
  - Semantic state (for example `--ui-color-focus`, `--ui-color-issue`).

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
- Views MUST NOT redefine `.is-focused`, `.is-issue`, or frame-derived variables.
- Views MUST NOT alter rail segmentation/geometry language.
- Views MUST NOT replace the shared header language with a view-specific header system.
- Views MUST NOT add container-level focus rings; item-level focus belongs to rail and optional wash.

## Shared primitives

### Frame

The frame is the root visual container for an item.

Rules:

- State classes MUST be applied on the frame root.
- Derived variables MUST be computed on the frame root.
- Frame-level state MUST be scoped locally and MUST NOT bleed across siblings.

### Body

The body is the view-specific content area.

Rules:

- The body MUST remain visually neutral relative to frame-level state language.
- The body MUST NOT restyle rail or header primitives.
- The body MUST NOT add container-level wash/ring language.
- The body MAY host active targets, but local affordance styling SHOULD come from shared base primitives.

### Header

The header is the stable, system-owned identity marker for an item.

Rules:

- The header MUST remain visually stable across views.
- The header MUST read as a single, contained identity surface.
- The header MUST use subtle fill and legible contrast.
- The header MUST NOT look like a view-specific widget.
- The header MUST remain legible independently of body styling.

Header content model:

- `Label`: communicates what the item is.
- `Conn`: communicates how the item is derived/wired/configured.

Layout rules:

- Header placement SHOULD communicate structure (item-level or set-level alignment).
- The header MUST support `stacked` and `inline` label/conn arrangements.
- Layout mode MAY switch based on available width.

### Textfield

Textfields are shared primitives used in headers and bodies.

Rules:

- Autosize textfields MAY be implemented using a hidden mirror element.
- Styling MAY use `:has(.ui-textfield-mirror)` to detect autosize mode if no explicit class is provided.

### Rail

The rail is the primary structural marker for boundaries and item focus. Each item renders one rail segment. Views that render groups MUST align sibling segments so they read as a continuous rail for the group, separated by small gaps.

Rules:

- Each item MUST render a rail segment and it MUST NOT behave as a generic card border.
- Focus and issue styling MUST be local to the item's own rail segment.
- Rail segments MUST NOT merge across siblings (the gap must remain visible).
- Rail segments SHOULD be square-ended at internal joins (between siblings).
- Rail segments SHOULD be rounded only at the outer ends of a contiguous group (first and last segment).
- Implementations SHOULD use structural selectors (`:first-*`, `:last-*`) on the items, not helper classes (for example `is-first`/`is-last`).

Notes:

- Rail segments may be rendered as pseudo-elements (for example `::before`) or real elements. Both follow the same rounding rules.
- Rail overlays (for example a thicker focus overlay) MAY be used if overlays stay local, preserve sibling geometry, and keep the inter-item gap visible.
- Hit targets MAY exceed visible rail width when usability requires it.

### Wash

The wash is a subtle background tint for container-level focus.

Rules:

- Wash MUST be subtle and frame-local.
- Wash MUST NOT appear by default for edit focus.
- Wash SHOULD appear only for container focus (`DEFAULT_TARGET`).

## State model

### Required state classes

All frames MUST support and apply these classes on the frame root:

- `.is-focused`.
- `.is-issue`.

### Precedence and derived variables

Rules:

- `.is-issue` MUST override `.is-focused` for derived color decisions.
- The frame MUST derive canonical variables consumed by primitives.
- Frame-derived variables SHOULD be defined on `.ui-frame` so nested controls can consume them.
- Views MUST NOT set frame-derived state colors ad hoc.

Required derived variables:

- `--rail-tint`.
- `--header-fill`.
- `--frame-wash`.

### Selection-driven focus styling

Rules:

- Item focus MUST be driven by `.is-focused`, not DOM `:focus`/`:focus-within`.
- Rail/header/wash MUST use frame-derived variables.
- DOM focus MAY be used only for container vs edit mode (`:focus` vs `:focus-within:not(:focus)`) and local control affordances (`:focus`).

## Focus language

### Item focus vs target focus

Item focus answers "Which item is active?" and target focus answers "Where will input go?"

Rules:

- Item focus MUST be communicated by rail tint and optional wash.
- Item focus MUST NOT encode which field is active.
- Target focus MUST be communicated locally at the active control/editor.
- Target focus MUST NOT be expressed as a container-level ring.

### Container focus vs edit focus

Container focus (`DEFAULT_TARGET`) represents active item, not active field.

Rules:

- Container focus: rail tint active, wash MAY be active, local rings SHOULD be absent.
- Edit focus (non-default target): rail tint remains active, wash SHOULD be off, local affordance MUST appear on active target.

### How DOM focus is used

DOM focus is a modifier for the focused item. It MUST NOT determine item focus.

Signals:

- `.ui-frame.is-focused`: authoritative item focus.
- `.ui-frame:focus`: container itself has DOM focus.
- `.ui-frame:focus-within`: DOM focus is inside the item (including container focus).
- `input/textarea/select/button:focus`: the active control/editor.

Model:

- Container focus: `.ui-frame.is-focused:focus` (wash MAY be on).
- Edit focus: `.ui-frame.is-focused:focus-within:not(:focus)` (wash SHOULD be off; local affordance on `:focus`).
- Target affordances SHOULD use `:focus`, not `:focus-visible`.

### Root focus indicator

Rules:

- Root container focus MAY use a thin edge rail on `.ui-main`.
- Root rail color SHOULD use frame-derived `--rail-tint` in both base and focused states.
- Root container focus MAY use the same wash behavior as focused item frames.
- Root focus styling MUST stay lightweight and MUST NOT imply item header/card framing.

### Control focus vs editor focus

Rules:

- Widget-like targets (`label`, `conn:*`, buttons, toggles, sliders) SHOULD use a local ring/halo.
- Control rings MUST remain local and compatible with issue palette overrides.
- Editor targets (for example `value`) SHOULD rely on caret/selection, not heavy rings.
- Editors MUST NOT receive block-level wash/highlight when active.
- In the default DOM structure, header-owned targets (`label`, `conn:*`) are treated as controls, and body-owned targets (`value`) are treated as editors.

### Cursor semantics

Rules:

- `.ui-frame` SHOULD use `cursor: pointer` to communicate item interactivity.
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
- Focus affordances SHOULD remain usable without hiding issue state.

### Recommended visual grammar

Issue-only (not focused):

- Rail: gentle issue tint.
- Header: gentle issue fill.
- Wash: off.

Issue + container focus:

- Rail: stronger issue tint.
- Header: stronger issue fill.
- Wash: subtle issue wash.

Issue + edit focus:

- Rail: stronger issue tint.
- Header: stronger issue fill.
- Wash: off.
- Local control ring: issue-tinted where applicable.

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

- `.is-focused`: active item.
- `.is-issue`: broken/invalid connection.

Precedence:

- `.is-issue` overrides `.is-focused` for frame-derived palette.

Frame-derived variables:

- `--rail-tint`: rail segment tint.
- `--header-fill`: header fill.
- `--frame-wash`: container wash.

Focus grammar:

- Item focus = rail tint (+ optional wash).
- Target focus = local affordance only.
- Container focus = wash on, no local rings.
- Edit focus = wash off, local ring/caret on active target.

Rail rules

- Each item renders one rail segment.
- Group layouts align sibling segments into a continuous rail with small gaps.
- Segments never merge across siblings.
- Segments are square at internal joins and rounded only at the outer ends of the group.

CSS layering:

1. Reset.
2. Tokens.
3. Base primitives.
4. Views (layout/composition only).
