# contenteditable View Layer

A view built on `contenteditable` uses a single editing root. This document covers the design and implementation of that layer — the event pipeline, text sync, DOM structure, position mapping, navigation, and selection.

---

## Why contenteditable

The established approach (ProseMirror, Lexical) uses a single `contenteditable` root. The alternatives fail structurally:

- **One input/textarea per item** — no cross-item selection, no cross-item paste, IME breaks at item boundaries, poor accessibility.
- **Fully custom rendering** — must re-implement all browser text input behaviour; IME (CJK, Arabic, etc.) is notoriously hard to get right; accessibility requires `contenteditable`; spell-check, autocorrect, and OS text services are lost.

`contenteditable` gives: native cursor and caret, IME, spell-check, autocorrect, accessibility, system copy/paste. The architecture's job is to intercept browser behaviour at the right points and keep the model as the single source of truth.

---

## The event pipeline

**Core tension.** The browser wants to modify the editing root DOM freely. The model is source of truth. These conflict.

**Resolution: two-way sync with explicit ownership.**

```
User input
    │
    ▼
beforeinput          ← intercept structural operations here
    │
    ├─ structural?   → e.preventDefault() + model commit + DOM reconcile
    │
    └─ text only?    → let browser mutate DOM freely
                            │
                            ▼
                     MutationObserver  ← sync text back to model
```

The browser owns character-level editing; the model owns structure. The dividing line is `beforeinput`. This is the architecture ProseMirror pioneered and Lexical refined.

### `beforeinput`

Fires before DOM mutation; `e.preventDefault()` suppresses the browser's action. Provides semantic `inputType` covering all input sources — keyboard, paste, drag-drop, voice, IME commit.

| `inputType`                                     | Handling                                                                                                                                      |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `insertText`                                    | Allow through; guard: prevent if item is a non-empty group                                                                                    |
| `insertParagraph`, `insertLineBreak`            | Prevent; split item at cursor                                                                                                                 |
| `deleteContentBackward`, `deleteContentForward` | At boundary: prevent + join adjacent items. Within item: allow                                                                                |
| `insertFromPaste`                               | Prevent; use `text/plain` from `dataTransfer`; split on `\n` for multiple items                                                               |
| `insertFromDrop`                                | Prevent; handle identically to `insertFromPaste`                                                                                              |
| `insertCompositionText`                         | **Always allow through** — browser manages IME candidate display                                                                              |
| `historyUndo`, `historyRedo`                    | Prevent; dispatch to `core.undo()` / `core.redo()` — Safari fires these via `beforeinput` before `keydown`, bypassing the `keydown` intercept |
| Everything else                                 | Allow through                                                                                                                                 |

**Paste** uses `text/plain`, not `text/html`. HTML from external sources carries formatting with no schema mapping; sanitising it reliably is complex. `text/plain` is the safe, consistent default. Structure-preserving internal paste is cleanest as a separate custom clipboard format.

**Copy and cut** are intercepted via the `copy` and `cut` events: read the current selection, write to `clipboardEvent.dataTransfer` as `text/plain`, call `preventDefault()`. This ensures the clipboard contains clean model text, not whatever the browser would serialise from the contenteditable DOM.

### `keydown`

For operations that never produce `beforeinput`: Tab (nesting), Escape (NAV/out), `Cmd/Ctrl+Z` (undo), `Cmd/Ctrl+Shift+Z` / `Ctrl+Y` (redo). All structural `keydown` handlers must be guarded with `e.isComposing` — structural operations must not fire mid-composition.

### IME and composition

IME is a multi-step process: `compositionstart` → repeated `insertCompositionText` → `compositionend`. The in-progress candidate text is managed entirely by the browser.

- **Never call `e.preventDefault()` on `insertCompositionText`** — doing so breaks CJK input for all users.
- **Guard the MutationObserver** with an `isComposing` flag — do not commit model updates while composition is active. The committed text arrives via a final `characterData` mutation after `compositionend`.
- **Call `core.undoBoundary()` at `compositionstart`** — prevents undo from landing mid-composition and producing garbled text.

### Undo/redo

Native contenteditable undo (`Cmd+Z`) reverts DOM changes without touching the model — a silent data-corruption bug present in all naive implementations.

- `Cmd/Ctrl+Z` → `e.preventDefault(); core.undo()`
- `Cmd/Ctrl+Shift+Z` / `Ctrl+Y` → `e.preventDefault(); core.redo()`

`core.undo()` / `core.redo()` replay recorded transactions; signal effects reconcile the DOM. The browser's undo stack is never involved.

**History coalescing.** Consecutive character edits on the same item merge into a single undo entry rather than one per keystroke. The grouping key is item ID + target; merging stops when a non-character operation occurs or after a time window.

**Flushing.** The active coalescing group MUST be flushed at two points:

- `compositionstart` — via `core.undoBoundary()` (see IME section above).
- Editing root blur — call `core.undoBoundary()` when the editing root loses focus, so that a user who returns to the same item within the coalescing window starts a new undo entry rather than merging with the prior typing run.

### Ownership boundary

| Pipeline                                    | Owns                                                 | Guard                                                                                                                                                                                                      |
| ------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contenteditable` `beforeinput` + `keydown` | `VALUE_TARGET` — all text and structural ops         | Global `dispatchKeyDown` returns early when `e.target.isContentEditable`                                                                                                                                   |
| `onIntent`                                  | `ITEM_TARGET` — navigation, selection, formula entry | Returns early if `sel.target !== ITEM_TARGET`                                                                                                                                                              |
| MutationObserver                            | Browser-authored character sync in `value` surface   | Skips if model already has this text; ignored during structural reconciliation                                                                                                                             |
| `selectionchange`                           | Location tracking                                    | Skips if model already reflects this cursor position — guards against the infinite loop where programmatic cursor placement fires `selectionchange`, which would re-focus, which would re-place the cursor |

These boundaries are strict. Neither pipeline reaches into the other's domain.
For maintainability, model -> DOM rendering is the primary write path; imperative DOM writes should be reserved for explicit cursor/selection repair only.

### Platform caveat: Android

On Android, the virtual keyboard communicates with the browser via the native `InputConnection` API — a platform-level protocol that mutates the DOM directly before any JS event fires. By the time `beforeinput` arrives in JS, the mutation has already happened; `e.preventDefault()` has no effect. The `beforeinput`-first interception model does not apply on Android.

This is explicitly off-spec (W3C Input Events Level 2 requires all non-IME `beforeinput` to be cancelable) but is a deliberate architectural constraint of Android's IME subsystem, not a bug. Both ProseMirror and Lexical implement a separate Android code path: MutationObserver becomes the primary input mechanism, with `beforeinput` used only as an intent signal, not for prevention. The [EditContext API](https://developer.chrome.com/blog/introducing-editcontext-api) (Chrome/Edge 121+) resolves this at the architectural level but has no Firefox/Safari implementation.

**Android is not a supported platform for this editor.** This note exists so the constraint is understood if support is added later.

---

## Text sync — MutationObserver

### Why the observer is necessary

A pure model→DOM approach — preventing all `beforeinput` — would break:

- **IME** (CJK, Arabic, Hindi) — manages candidate text natively across multiple events
- **Dead keys** (e.g. `option+e` → `é` on Mac) — unfold across multiple events
- **OS autocorrect and spell-check** — corrections may arrive without a clean `beforeinput` signal
- **Voice dictation** — inserts natively

Regular character insertion and within-item deletion are also intentionally allowed through, to preserve native typing feel and OS text services. The browser has its own text editing state machine that cannot be safely replicated.

### What to watch

```ts
observer.observe(ceRoot, {
  characterData: true,
  childList: true,
  subtree: true,
});
```

Two mutation types matter:

- `characterData` — normal typing; modifies an existing text node.
- `childList` — **the first character in an empty item** creates a new text node rather than modifying one. Without `childList: true` this character is silently lost — a well-known gotcha.
- **Filter `<br>` insertion** — when the editing root becomes empty, browsers insert a `<br>` to maintain editability. This arrives as a `childList` mutation and must be treated as structural noise, not a user text edit; without this guard the model briefly sees `"\n"` as content.

The observer is a **text-sync channel**, not a general source of truth for every DOM mutation. App-authored structural and reconciliation DOM churn must not be misclassified as user text edits. With `subtree: true` the observer fires for mutations anywhere in the editing root; each `MutationRecord.target` must be traced up the DOM to identify which item's value surface was affected. Mutations outside any value surface are skipped.

Read the full `valueEl.textContent`, not the mutated node. IME and autocorrect can produce multiple adjacent text nodes; only the full text content of the surface is reliable.

### Canonical newline contract

For plain-text `contenteditable` value surfaces:

- Model text MUST use LF-only newlines (`\n`). Normalize `\r\n` and `\r` to `\n`.
- DOM -> model parsing MUST treat line-break DOM structures (`<br>`, block wrappers such as `<div>` / `<p>`) as newline boundaries.
- Parsing MUST preserve blank lines and trailing newline (for example `"a\n\nb\n"`).
- Model -> DOM writes MUST preserve the exact model string and MUST NOT rely on browser-default Enter/Shift+Enter DOM shape.
- Model -> DOM rendering MAY add a visual-only `<br>` sentinel for empty/trailing-newline visibility. DOM -> model parsing MUST ignore this sentinel.

This contract is shared across all views that implement plain-text `contenteditable` surfaces.

### Timing, suppression, and idempotency

The MutationObserver callback fires as a **microtask** — after all synchronous code in the current task. Signal effects run synchronously. This means: a structural op calls `core.commit()` → effects run → DOM updates → _then_ the observer microtask fires. By that point the DOM already reflects the model; an idempotency check silently discards the mutations. An explicit suppression window is belt-and-suspenders for complex reconciliation edge cases.

**`takeRecords()` before programmatic DOM writes.** Before any programmatic DOM write, call `observer.takeRecords()` to flush pending mutations synchronously. Without this, a stale pending mutation may arrive after the write and incorrectly overwrite the updated content.

**Idempotency.** Both sides use equality checks to prevent feedback loops: the observer commits only if DOM text differs from model text; the render side writes `valueEl.textContent` only if model text differs from current DOM text.
Renderer idempotency MUST consider sentinel presence, not only parsed text equality.

**Signal safety guard.** Before overwriting `valueEl.textContent` from a model signal, check whether the browser cursor is currently inside that element. If so, skip the update — the browser is mid-edit and the observer is already syncing live. Once the cursor leaves, the effect reconciles if needed.

---

## DOM structure

A view built on `contenteditable` has a single editing root with recursively rendered item rows. Each row contains:

- **Gutter/handle** — structural chrome; `contenteditable="false"`
- **Value surface** — the text editing surface; uniquely identifiable; the only zone without editing suppression
- **Header zone** — optional; `contenteditable="false"`
- **Embedded view zone** — optional; `contenteditable="false"`
- **Child container** — optional; holds nested item rows for group items

**`contenteditable="false"` on all non-text zones** is mandatory. Without it the browser treats gutter and header content as editable, producing corrupt mutations and broken selection behaviour.

Plain-text value surfaces SHOULD always contain at least one caret-host node (for example a visual-only sentinel `<br>`).

**`preventDefault()` on structural chrome `pointerdown`.** All `contenteditable="false"` structural chrome inside the editing root — gutter, drag handle, collapse toggle — must call `e.preventDefault()` on `pointerdown`. Without it, the browser silently relocates the text cursor to the nearest text position at the click coordinates before any handler runs. Applies only to interactive chrome inside the editing root; elements outside follow normal focus rules.

**Location/blur lifecycle with embedded controls.** Embedded controls within `contenteditable="false"` zones steal DOM focus when clicked — the item is still logically focused. The runtime must distinguish focus leaving the outline entirely from focus moving to an embedded control within it. Save the last known selection on `blur` and restore it on `focus`; browsers do not reliably restore cursor position, and without this the cursor resets to position 0.

**Decorations and overlays.** Visual adornments must not be interleaved with the editing root DOM. Two approaches, both driven reactively from model signals:

- **Node decorations** — CSS classes or attributes on existing item elements via `ctx.effect`. Correct for per-item state: selected, focused, collapsed, error.
- **Overlay layer** — a separate element positioned above the editing root with absolutely-positioned children computed from item bounding boxes. Correct for multi-item highlights, annotations, or anything spanning item boundaries.

**Durable requirements:**

- Value surface is uniquely identifiable (for observer target identification and position mapping)
- Item identity is available on row hosts (for DOM↔model mapping)
- Mounted header roots and mounted embedded-view body roots are explicitly marked `contenteditable="false"`
- `spellcheck="false"` `autocorrect="off"` `autocapitalize="off"` on the editing root — suppresses browser input transforms, particularly on mobile
- Observer text sync is scoped to the value surface; structural DOM churn is distinguishable and ignorable

---

## Position and cursor

A deterministic bridge between browser cursor positions and model positions is required:

- **DOM position → `{ itemId, charOffset }`** — to determine which item and offset the cursor is at
- **Model position → DOM node/offset** — to programmatically place the cursor

**Cursor restoration after structural ops.** After any structural commit (split, join, paste-expand, item removal with join), the browser cursor is left pointing at DOM nodes that may no longer exist or have been repositioned by reconciliation. The cursor must be programmatically restored:

```ts
const { node, offset } = modelPositionToDOMPosition(targetItemId, targetOffset);
selection.setBaseAndExtent(node, offset, node, offset);
```

This is required after every structural op — omitting it leaves the cursor in an undefined or incorrect position. It is one of the most commonly broken aspects of naive contenteditable implementations.

**Scroll-to-cursor.** After programmatic cursor placement, ensure the cursor is scrolled into view. The browser does not do this automatically for programmatic placements.

Position mapping must remain stable under text-node fragmentation — IME, autocorrect, and browser-internal optimisations can produce multiple adjacent text nodes within a single value surface.

For plain-text surfaces, mapping MUST treat semantic `<br>` as one logical newline character. Visual-only terminal sentinel `<br>` nodes MUST contribute zero logical characters.

Shared DOM helpers SHOULD expose mapped selection/range primitives (DOM point -> caller-mapped model point) so views can reuse CE mapping without embedding view semantics in the DOM layer.
Shared DOM helpers MAY also expose collapsed-caret rect and mapped selection snapshot primitives for view-agnostic cursor/selection plumbing.

---

## Arrow key navigation

The browser gives correct natural caret movement within a single item — wrapped lines, bidirectional text, ligatures, OS text services. This must not be replaced with manual movement. The browser falls apart only at item boundaries and around `contenteditable="false"` zones. The approach: let the browser handle everything it can, intercept only at the points where it would go wrong.

### Left/Right — intercept at boundaries

Detected deterministically in `keydown`, before the browser acts:

```
ArrowLeft  + anchorOffset === 0                   → preventDefault + jump to end of previous item
ArrowRight + anchorOffset === textContent.length  → preventDefault + jump to start of next item
otherwise                                         → let browser handle
```

"Previous/next item" is pre-order tree traversal — leaf items in document order, skipping group items without a value surface.

### Up/Down — hybrid approach

Up/Down movement is purely visual. The browser computes "one line height up/down" — correct for wrapped text, must be preserved. The editor intercepts only when the cursor is on the first or last visual line, detected via rect comparison:

```
cursorRect  = selection.getRangeAt(0).getBoundingClientRect()
surfaceRect = valueEl.getBoundingClientRect()

isFirstLine = cursorRect.top < surfaceRect.top + threshold
isLastLine  = cursorRect.bottom > surfaceRect.bottom - threshold

ArrowUp   + isFirstLine → preventDefault + jump to previous item's last line
ArrowDown + isLastLine  → preventDefault + jump to next item's first line
otherwise               → let browser handle
```

Single-line items: both flags are always true. The threshold must account for visual spacing between items.

### Sticky column

When jumping to an adjacent item vertically, the cursor should land at the nearest horizontal position — not at offset 0 or end. The **sticky column** pattern used by all mature text editors:

- Record the cursor's X coordinate when Up/Down is first pressed.
- Use `document.caretRangeFromPoint(stickyX, targetY)` (Chrome/Safari) / `document.caretPositionFromPoint(x, y)` (Firefox) to find the nearest text position in the target item at that X.
- Reset when the user types, presses Left/Right, or takes any non-vertical action.

`caretRangeFromPoint` is the key API: given screen coordinates it returns the nearest text node and offset without requiring any font metric knowledge.

### What not to do

- **Don't intercept all arrow keys** and navigate by model position — this loses wrapped-line awareness, bidirectional text, and OS text services.
- **Don't correct cursor position after `selectionchange`** — by then the cursor is already wrong; `keydown` interception before the browser acts is the correct point.
- **Don't use character offset alone to detect first/last line** — `anchorOffset === 0` indicates the text start but not which visual line for wrapped items; rect comparison is the reliable approach.

---

## Selection

### Model during drag

During text drag selection, Core selection remains in `editing` mode and is never cleared to `idle`.
Core tracks the active item/target (`location` + `VALUE_TARGET`); DOM `Selection` remains the source
for live range endpoints during the drag.

```
mousedown   → editing(location=A, target=value), DOM range collapsed
drag moves  → editing(location=A, target=value), DOM range extended
settles     → editing(location=X, target=value), DOM range collapsed
```

Operations triggered mid-range (type to replace, copy, cut) use the live DOM range directly — no awkward save-and-restore logic needed.

The browser exposes `anchorNode/anchorOffset` (fixed — where the selection started) and `focusNode/focusOffset` (the moving end). The `selectionchange` handler maps the anchor side to Core `editing.location`, and may forward a caret side-channel for restore behavior.

### Focused-item indicator

The focused-item indicator (`is-focused`) is a **caret indicator**, not a selection indicator. It answers "where is my cursor?" — which only has meaning when the selection is collapsed. During a text range, the selection highlight is the sole indicator; a simultaneous per-item focus highlight is redundant.

```
Show is-focused when:
  selection is editing(location=this item)
  AND (
    target !== VALUE_TARGET
    OR (target === VALUE_TARGET AND DOM selection is collapsed)
  )
  OR selection is item(head=this item)
```

For `VALUE_TARGET`, the collapsed check suppresses `is-focused` during text ranges. For non-text editing targets and item selection, focus styling follows Core selection directly.

### Selection visuals in embedded zones

The single editing root means browser sweep-selection highlights everything between anchors — including `contenteditable="false"` header and embedded-view zones. Two tools address this, serving different purposes:

**`user-select: none`** — excludes an element from the selection range entirely; not selectable, not in clipboard copy. Correct for pure structural chrome: gutters, drag handles, decorative markers.

**`::selection` suppression** — visual only; the element still participates in the range and clipboard but renders with no visible highlight. Correct for interactive embedded zones containing inputs.

```css
.zone::selection,
.zone *::selection {
  background: transparent;
  color: inherit;
}
```

`background` alone is insufficient — browsers also flip text `color` to white during selection. Both properties are required, as is the `*` descendant rule to cover child elements.

**Inputs inside embedded zones.** `<input>` and `<textarea>` manage selection via `selectionStart`/`selectionEnd`, independently of the editing root's selection. Parent `::selection` rules have no effect on them — no special handling needed.

| Zone                                                      | Approach                                                     |
| --------------------------------------------------------- | ------------------------------------------------------------ |
| Gutter, drag handle                                       | `user-select: none`                                          |
| Header, embedded view host                                | `::selection` suppression (background + color + descendants) |
| Value surface                                             | No suppression                                               |
| Inline atomic node (`contenteditable="false"`, no inputs) | `::selection` suppression + reactive CSS class               |

**Inline atomic nodes.** For `contenteditable="false"` "pill" nodes logically within the selection: suppress `::selection` on the pill; apply a reactive CSS class (e.g. `is-within-selection`) driven by the selection model; style with a distinct ring or tint. This clearly communicates "this will be affected" without mimicking text-selection blue — and separates the selection affordance from the browser selection mechanism entirely.
