# Architecture

This document defines the system architecture, invariants, and layer boundaries for the editor. It is the authoritative source for technical MUST and MUST NOT contracts referenced by contributor workflow docs.

## System concept

This document is **normative**. The model, invariants, layering rules, and interaction semantics defined here are binding unless explicitly marked experimental.

A tree-structured document editor. The data model is a recursive tree of **items**, each with a content type and a mode.

**Content types:**

- `value` — leaf node; holds a text string
- `group` — branch item; holds an ordered array of child `ItemId`s
- `issue` — diagnostic node; holds a message string

**Modes:**

- `plain` — freely editable
- `readonly` — display only
- `connected` — value is externally managed; display is read-only

Items are identified by opaque `ItemId` strings. `ItemId` values are opaque and stable for the lifetime of the item, including across undo/redo and serialization.

The tree has no fixed depth limit. The outline view renders a subtree rooted at a given `rootId`, recursively.

## Layering model

Five layers with strict one-directional dependencies:

| Layer      | Owns                                                                                 | May depend on    |
| ---------- | ------------------------------------------------------------------------------------ | ---------------- |
| `core/`    | State, transactions, history, selection, intent parsing and routing                  | —                |
| `dom/`     | View mounting/lifecycle, reactive primitives, shared controls, global input handling | core             |
| `views/`   | View-specific body layout, intent interpretation, Core operation mapping             | core, dom        |
| `setup.ts` | Composition of Core, dom runtime, and registered views; platform hook wiring         | core, dom, views |
| `main.ts`  | Environment-specific bootstrap                                                       | setup            |

Dependencies MUST follow this direction. Cross-layer imports that violate this order are forbidden.

### Outer view vs item view

Each rendered item is composed of two layers of view responsibility:

- _Outer view_ — renders the stable frame; renders shared header surfaces; mounts the item view body; attaches outer-view-owned targets.
- _Item view_ — renders `.ui-body.<view>`; renders view-specific body structure and controls; attaches body-owned targets only.

Intent-handling follows the same split: the outer view handles item-selection intents and yielded keys from edit targets; item views define body field behavior and yield navigation at boundaries.

Ownership boundaries MUST remain stable under extension.

### Canonical Root DOM

```text
#root
  .ui-root
    .ui-shell
      .ui-toolbar
      .ui-main-scroll
        .ui-main.ui-frame
          .ui-body.<root-view>
```

`.ui-main` is the root `.ui-frame` and the only tabbable element (`tabIndex=0`).

### View resolution and routing

The active view resolves from the current selection binding, not from browser focus alone.
Routing is binding-based: outer-owned bindings route to outer handlers, and body-owned bindings route to body handlers.

Rules:

- Selection must resolve to a single view handler.
- Missing or cross-view selection bindings are invariant violations.

Core routes non-global intents to that active view handler.
Intent routing MUST be deterministic and MUST NOT depend on DOM traversal order.

### Model state vs view state

Model state — the item tree, selection, and history — is persisted, syncable, undoable, and deterministically reconstructible.

Policy for non-model view state is defined in `Sources of truth`.

Collapsed/expanded state is the canonical edge case — where it lives is a deliberate design decision with significant implications for sync and undo.

## Selection model

```text
Selection =
  | { type: "idle" }
  | { type: "editing", location: Location, target: string }
  | { type: "item", anchor: Location, head: Location }

Location = { item: ItemId, portals: readonly ItemId[] }
```

`item` is the focused item id. `portals` is the render-context portal path that produced this focus. `target` identifies which interaction mode is active.

Selection is structural state and is persisted and replayable.

**`idle`** — nothing focused.

**`editing`** — edit mode. The browser cursor is inside the focused target (`content:text`, another `content:*`, `label`, or `conn:*`). The global intent dispatcher is suppressed while editing.

**`item`** — item-level range selection. One or more whole items selected as structural units, no text cursor. Used for bulk operations: delete, move, duplicate.

**Anchor/head.** Any range selection is `{ anchor, head }` with both endpoints represented as `Location`. The anchor is fixed (where the selection started); the head moves as the user extends.

After any transaction, selection MUST reference existing items. If invalidated, repair MUST be deterministic and local.

## Reactive rendering

`createComponent` creates a reactive component with a lifecycle context (`ctx`). Three primitives drive all model-to-DOM updates:

- **`ctx.effect(fn)`** — runs `fn` immediately and re-runs whenever any signal read inside it changes. Syncs model state to specific DOM properties: text content, CSS classes, attributes.
- **`ctx.list(container, getIds, buildItem)`** — keyed list reconciliation. When the list changes, only the diff is applied — new items mounted, removed items disposed, reordered items moved. Stable keys (item IDs) ensure existing DOM nodes are reused across structural changes.
- **`ctx.slot(container, getComponent)`** — conditionally renders a single child component. Returns null to empty the slot, or a component to mount.

Signal flow: model signal changes -> effect re-runs -> targeted DOM update. Structural changes trigger computed children signals -> `ctx.list` reconciles the minimum diff.

DOM reconciliation MUST be a pure function of model state. DOM state MUST NOT author canonical model state.

## Universal controls model

This section defines the shared cross-view keyboard interaction contract.
View-specific geometry, traversal scope, and edge behaviors are defined in `docs/views-spec.md`.

### Target classification

| Kind              | Targets                           | `yieldNav` | Edit traversal | Role                                    |
| ----------------- | --------------------------------- | ---------- | -------------- | --------------------------------------- |
| Item              | `ITEM_TARGET`                     | n/a        | No             | Structural item selection               |
| Isolated text     | `label`                           | `false`    | No             | Local header text field                 |
| Traversable text  | `content:text`                    | `true`     | Yes            | Inline text editing with boundary yield |
| Structured header | `conn:*`                          | `false`    | No             | Local header fields with explicit Tab   |
| Opaque body       | `content:*` except `content:text` | View-owned | View-owned     | Non-text body controls                  |

`ITEM_TARGET` is the structural shell. Traversable targets edit in flow and yield at text boundaries. Header targets are explicit-entry local controls and stay out of linear edit traversal.

DOM focus follows selection mode:

- Editing selection focuses the active edit target.
- Item selection focuses the owning structural `ITEM_TARGET` surface.
- Idle clears DOM document selection and DOM focus.

### Primary target resolution

1. A body target marked `primary: true`.
2. Otherwise, the connected mode's primary header target (`conn:*`), as resolved by Core.

`label` is never primary. Printable-char handoff from item selection only applies to `content:text`.

### Intent handler ownership

| Target        | Owner  | Handler                                    |
| ------------- | ------ | ------------------------------------------ |
| `ITEM_TARGET` | Frame  | Outer view                                 |
| `label`       | Header | Local control                              |
| `conn:*`      | Header | Local control                              |
| `content:*`   | Body   | Body view; outer view handles yielded keys |

### Behaviors from item selection

| Intent      | Condition                        | Behavior                                                                |
| ----------- | -------------------------------- | ----------------------------------------------------------------------- |
| `CONFIRM`   | Primary target exists            | Enter edit on the primary target, caret at end                          |
| `CONFIRM`   | No primary target                | View-specific inward behavior                                           |
| `TYPE char` | Primary target is `content:text` | Enter edit and insert the character                                     |
| `TYPE char` | Otherwise                        | View-specific or no-op                                                  |
| `INSERT`    | `scope="sibling"`                | View-specific structural insert at the current level                    |
| `INSERT`    | `scope="after-parent"`           | View-specific structural insert after the parent, if valid              |
| `NAV`       | Always                           | Move by view geometry and stay in item selection. Escape -> `NAV/out`   |
| `TAB`       | Always                           | View-specific structural action                                         |
| `DELETE`    | View defines item deletion       | Remove or clear according to view rules; repair selection appropriately |

### Behaviors from traversable targets

Normal typing, cursor movement, and selection are handled natively. At a text boundary on a navigation or structural key, the field commits, calls `preventDefault`, and yields to the outer view.

**NAV at boundary** — collapses to backward (`left`/`up`) or forward (`right`/`down`). Multiline fields yield only on the first or last line.

1. Native text motion stays local while the browser can still move the caret within the current text surface.
2. At a boundary, navigation moves to the adjacent stop in the view's traversal model. In Outline, each visible item contributes at most one stop. Backward lands at the end of an edit stop; forward lands at the start; atomic stops land at item selection.

**Enter** — local/default behavior for the focused target. Traversable text targets MAY commit and yield to the outer view as part of that local behavior.

**Shift+Enter** — local alternate Enter behavior for the focused target.

### Behaviors from structured header targets

Structured header targets such as `conn:*` are explicit-entry local controls.

- Text-editing keys stay local/native.
- `Tab` / `Shift+Tab` commit and move within the canonical shared-header field order when another field exists; otherwise they commit and no-op.
- `Enter` commits and exits to same-item item selection.
- `Escape` cancels and exits to same-item item selection.

**Always-structural intents** — intents such as `INSERT` always route to the containing outer view, even from a body-owned `content:*` target. Embedded item views do not own these intents.

### Edit model

Shared input-based header/local fields use draft-only editing:

- They keep a local draft while focused.
- Core updates on commit boundaries such as blur, local Tab, or local Enter.
- Escape cancels the local draft first and MAY be handled locally by the focused field.

Contenteditable value surfaces use their own pipeline and apply edits model-side via their observer/event flow rather than the shared draft-field flow.

Intent handling and traversal semantics MUST converge to a single canonical structural result regardless of input source (keyboard, drag, paste, automation).

## Model operations

Structural edits are expressed as **Core commits** — atomic, synchronous transactions that update state and trigger reactive DOM reconciliation.
The same operations are callable from any interaction path (contenteditable pipeline or intent pipeline) with no DOM side effects in the operations themselves.

All structural mutations MUST occur inside a transaction. There are no partial structural writes.

Transactions MUST:

- Apply atomically.
- Preserve invariants.
- Be undoable.
- Be replayable.
- Produce deterministic results.

For a given initial state and ordered sequence of committed transactions, the resulting Core state MUST be identical.

### Post-commit normalization

After every transaction, the core pipeline runs shape enforcement on touched entries. View-tagged items that no longer conform to their registered shape are corrected in the same undo unit (type coercion, `nonEmpty` enforcement, ordered-slot `alignChildren` sync).

If a transaction patches `view` on the item currently in editing selection, selection is snapped to item selection at the same location before structural repair runs.

Post-commit normalization MUST be deterministic and MUST NOT depend on runtime view state or DOM state.

This is the only universal post-commit rule; all other cleanup is operation-specific.

**View-local editing conventions.** Typed views only receive shape-conforming data — core falls back to outline when compatibility fails. Within that, a view renders all conforming state including state it would not normally produce, but may bundle additional cleanup into its own commits for UX conventions that don't rise to a model constraint. The distinction is _can render_ vs _wants to produce_. See `docs/views-spec.md`.

## Invariants

The invariants defined in this section are stable contracts. Changes to these invariants constitute breaking changes and require explicit migration strategy.

### Sources of truth

- Core is the single source of truth for model state, and all model state is persistent.
- Whether any non-model view state is permitted is currently undecided.
- Selection is the single source of truth for focus.
- DOM and CSS are never treated as authoritative state or focus sources.
- DOM and runtime layers MUST NOT author canonical model state.

### Target-driven focus

- `Location` is `(itemId, portals)` — not DOM tab order.
- An editing address is `(location, target)`.
- `.ui-main` is the only tabbable element.
- Targets remain stable across selection changes.

### Ownership

- Frame owns `ITEM_TARGET`. Header owns `label` and `conn:*`. Body owns `content:*` and body-specific targets.
- Body MUST NOT own `label` or `conn:*`. Header MUST NOT own `content:*`.
- A target MUST NOT have multiple owners.

### Tree integrity

- Every non-root item MUST have a `parentId` that references an existing item.
- Every group item's `children` MUST contain each child exactly once.
- `parentId` and `children` MUST remain mutually consistent.
- Cycles MUST NOT exist in any `parentId` chain.
- Non-blank labels MUST be unique within each parent group.

### Structural stability under selection

- Each rendered item maps to exactly one stable `.ui-frame`.
- Selection changes are styling-only — no remounting frames, no rebuilding lists, no switching body subtrees.
- Conditional mounting uses `ctx.slot`. Repeated keyed mounting uses `ctx.list`.
- Region hosts are not manually cleared or replaced.

### Routing and interaction

- DOM runtime owns the global `keydown` listener (bubble phase).
- Intent parsing uses `parseKeyIntent` — not ad-hoc key parsing in views or runtime.
- Core handles global intents first; non-global view intents are routed to the active view handler.
- DOM runtime calls `preventDefault()` before dispatching a parsed intent.
- Native editors handle keydown locally and call `stopPropagation()`. Controls MAY yield keys by not calling `stopPropagation()`.

### Pointer and propagation

- When a frame owns `pointerdown`, it MUST stop propagation and either focus `ITEM_TARGET` or preserve the current editing selection. It captures caret only when the hit surface is text-editing content.
- Editors and controls focus their own target and stop propagation.

### Runtime boundary

- Core is headless — no DOM APIs, no `dom/` dependencies.
- Platform-specific behavior needed by Core is provided through injected callbacks wired in `setup.ts`.
- Manual reconciliation that bypasses runtime region ownership is forbidden.
- DOM-driven focus that diverges from Core selection is forbidden.

## Extension points

### Adding a new view

- Preserve outer view vs item view ownership split.
- Preserve target ownership and structural stability invariants.
- Implement behavior via intents, not ad-hoc raw key handling.

### Adding a new target

- Define exactly one owner (frame/header/body).
- Keep stable under selection changes.
- Do not introduce implicit edit target navigation.

### Adding a new control

- Participate in target-driven focus, not tab order.
- Follow pointer propagation rules.
- Follow Core routing and yielding behavior.

### Adding a new module

- Place in the correct layer; respect dependency direction.
- Use stable layer entrypoints — avoid deep cross-layer imports.
- Avoid cyclic dependencies.
- Introduce a new abstraction when it clarifies ownership or creates a stable shared contract. Reuse existing abstractions when behavior fits. Promote to a layer entrypoint only when it is a stable contract used across a layer boundary.

_See also: `docs/core-api.md`, `docs/dom-runtime.md`, `docs/views-spec.md`, `docs/style-system.md`, `docs/content-editable.md`_
