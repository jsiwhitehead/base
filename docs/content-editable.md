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
    ├─ recognized op? -> e.preventDefault() + model commit + DOM reconcile
    │
    └─ browser-owned text mutation path (composition and some autocorrect paths)
                       -> let browser mutate DOM; observer syncs to model
                            │
                            ▼
                     MutationObserver  ← sync text back to model
```

`beforeinput` is the contract boundary: recognized edit intents are model-owned and browser DOM writes are blocked. Browser-native mutation paths (notably composition and some autocorrect paths) are reconciled through the observer.

### `beforeinput`

Fires before DOM mutation; `e.preventDefault()` suppresses the browser's action. Provides semantic `inputType` covering all input sources — keyboard, paste, drag-drop, voice, IME commit.

| `inputType`                                                                                | Handling                                                                                                                               |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `insertText`                                                                               | Prevent; apply via model text insertion. Guard: non-empty groups reject text insertion                                                 |
| `insertReplacementText`                                                                    | Prevent; apply replacement via model using target range when available; fallback to model insert (autocorrect replacement-intent path) |
| `insertParagraph`, `insertLineBreak`                                                       | Prevent; split item at cursor                                                                                                          |
| `deleteContentBackward`, `deleteContentForward`, `deleteWordBackward`, `deleteWordForward` | Handle in model; if not handleable (for example unsupported cross-parent range), still prevent native DOM mutation                     |
| `insertFromPaste`                                                                          | Prevent (browser DOM mutation only; insertion is handled in the `paste` event)                                                         |
| `insertFromDrop`                                                                           | Prevent (browser DOM mutation only; insertion is handled in the `drop` event)                                                          |
| `deleteByDrag`                                                                             | Prevent; source-side native deletion is blocked (drop path owns the model move/insert)                                                 |
| `insertCompositionText`                                                                    | **Always allow through** — browser manages IME candidate display                                                                       |
| `historyUndo`, `historyRedo`                                                               | Prevent; dispatch to application undo/redo — Safari fires these via `beforeinput` before `keydown`, bypassing the `keydown` intercept  |
| Everything else                                                                            | Prevent by default (closed-world contract between browser events and model handlers)                                                   |

**Paste** uses `text/plain`, not `text/html`. HTML from external sources carries formatting with no schema mapping; sanitising it reliably is complex. `text/plain` is the safe, consistent default. Structure-preserving internal paste is cleanest as a separate custom clipboard format.

**Copy and cut** are intercepted via the `copy` and `cut` events: read the current selection, serialize to `text/plain` in `clipboardEvent.dataTransfer`, call `preventDefault()`. This ensures clean model text on the clipboard rather than a browser-serialized DOM fragment. If model serialization is unavailable (for example unsupported cross-parent ranges), handlers still call `preventDefault()` and no-op to block native HTML fallback.

**Drag.** `dragstart` is intercepted to serialize the current DOM selection as `text/plain` in `e.dataTransfer`; guard so that only events originating inside the value surface are serialized. Serialization MUST be skipped when selection origin is outside a value surface. `drop` is intercepted to read `text/plain` and apply the insertion as a model update.

**Paste and drop pipeline.** The `paste` and `drop` event handlers own the model update and call `preventDefault()`. Their `beforeinput` counterparts (`insertFromPaste`, `insertFromDrop`) only call `preventDefault()` to block the browser's direct DOM write. Chrome fires `insertFromDrop` regardless of whether `drop` was already prevented; the `beforeinput` case is necessary to suppress this stale mutation.

### `keydown`

For operations that never produce `beforeinput`: Tab (nesting), Escape (NAV/out), `Cmd/Ctrl+Z` (undo), `Cmd/Ctrl+Shift+Z` / `Ctrl+Y` (redo). All structural `keydown` handlers must be guarded with `e.isComposing` — structural operations must not fire mid-composition.

### IME and composition

IME is a multi-step process: `compositionstart` -> repeated `insertCompositionText` -> `compositionend`. The in-progress candidate text is managed entirely by the browser.

- **Never call `e.preventDefault()` on `insertCompositionText`** — doing so breaks CJK input for all users. The standard implementation is a single `if (e.isComposing) return;` guard at the top of the `beforeinput` handler, allowing all composition-phase events through without per-case handling.
- **Guard the MutationObserver and `selectionchange`** with an `isComposing` flag — do not commit model updates or update model selection while composition is active. The committed text arrives via a final `characterData` mutation after `compositionend`.
- **Create an undo boundary at both `compositionstart` and `compositionend`**:
  - `compositionstart` flushes accumulated pre-composition edits into their own undo group.
  - `compositionend` seals the committed composition text as its own undo group.
- **Guard post-composition Enter**: suppress `keydown` Enter events arriving within ~100ms of `compositionend`. Some IMEs emit Enter as part of commit; without this guard it is misread as a paragraph split. Track composition end time and ignore Enter in that brief window.

### Undo/redo

Native contenteditable undo (`Cmd+Z`) reverts DOM changes without touching the model — a silent data-corruption bug present in all naive implementations.

- `Cmd/Ctrl+Z` -> prevent native undo, dispatch application undo.
- `Cmd/Ctrl+Shift+Z` / `Ctrl+Y` -> prevent native redo, dispatch application redo.

Application undo/redo replays recorded transactions; reactive effects reconcile the DOM. The browser's undo stack is never involved.

**History coalescing.** Consecutive character edits on the same item merge into a single undo entry rather than one per keystroke. The grouping key is item ID + target; merging stops when a non-character operation occurs or after a time window.

**Flushing/sealing.** The active coalescing group MUST be flushed at `compositionstart` and sealed at `compositionend` (see IME section above).

### Ownership boundary

| Pipeline                                    | Owns                                                            | Guard                                                                                                                                                                                                      |
| ------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contenteditable` `beforeinput` + `keydown` | Text-edit target — all text and structural ops                  | Global keydown routing returns early when the event target is contenteditable                                                                                                                              |
| Command/intent routing pipeline             | Item-level commands — navigation, selection, structural intents | Returns early unless current focus is in item command mode                                                                                                                                                 |
| MutationObserver                            | Browser-authored character sync in `value` surface              | Skips if model already has this text; ignored during structural reconciliation                                                                                                                             |
| `selectionchange`                           | Location tracking                                               | Skips if model already reflects this cursor position — guards against the infinite loop where programmatic cursor placement fires `selectionchange`, which would re-focus, which would re-place the cursor |

These boundaries are strict. Neither pipeline reaches into the other's domain.
For maintainability, model -> DOM rendering is the primary write path; imperative DOM writes should be reserved for explicit cursor/selection repair only.

### Platform caveat: Android

On Android, the virtual keyboard communicates with the browser via the native `InputConnection` API — a platform-level protocol that mutates the DOM directly before any JS event fires. By the time `beforeinput` arrives in JS, the mutation has already happened; `e.preventDefault()` has no effect. The `beforeinput`-first interception model does not apply on Android.

This is explicitly off-spec (W3C Input Events Level 2 requires all non-IME `beforeinput` to be cancelable) but is a deliberate architectural constraint of Android's IME subsystem, not a bug. Both ProseMirror and Lexical implement a separate Android code path: MutationObserver becomes the primary input mechanism, with `beforeinput` used only as an intent signal, not for prevention. The [EditContext API](https://developer.chrome.com/blog/introducing-editcontext-api) (Chrome/Edge 121+) resolves this at the architectural level but has no Firefox/Safari implementation.

**Android is not a supported platform for this editor.** This note exists so the constraint is understood if support is added later.

---

## Text sync — MutationObserver

### Why the observer is necessary

A pure model->DOM approach — preventing all `beforeinput` — would break:

- **IME** (CJK, Arabic, Hindi) — manages candidate text natively across multiple events
- **Dead keys** (e.g. `option+e` -> `é` on Mac) — unfold across multiple events
- **OS autocorrect and spell-check** — corrections may arrive without a clean `beforeinput` signal
- **Voice dictation** — inserts natively

`insertText` events from regular typing are intercepted via `beforeinput`, prevented, and applied directly to the model. The MutationObserver is necessary for the cases above, which either bypass `beforeinput` entirely or cannot have it cancelled.

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
- `childList` — **the first character in an empty item** creates a new text node rather than modifying one. Without `childList: true` this character is silently lost — a well-known gotcha. Also filter bare `<br>` insertions: browsers add one to maintain editability in an empty surface; treat it as structural noise, not a text edit, or the model briefly sees `"\n"` as content.

The observer is a **text-sync channel**, not a general source of truth for every DOM mutation. App-authored structural and reconciliation DOM churn must not be misclassified as user text edits. With `subtree: true` the observer fires for mutations anywhere in the editing root; each `MutationRecord.target` must be traced up the DOM to identify which item's value surface was affected. Mutations outside any value surface are skipped.

Read the full value surface with the plain-text parser, not the mutated node. IME and autocorrect can produce multiple adjacent text nodes and `<br>`/block wrappers; only full-surface parsing is reliable.

### Canonical newline contract

For plain-text `contenteditable` value surfaces:

- Model text MUST use LF-only newlines (`\n`). Normalize `\r\n` and `\r` to `\n`.
- DOM -> model parsing MUST treat line-break DOM structures (`<br>`, block wrappers such as `<div>` / `<p>`) as newline boundaries.
- Parsing MUST preserve blank lines and trailing newline (for example `"a\n\nb\n"`).
- Model -> DOM writes MUST preserve the exact model string and MUST NOT rely on browser-default Enter/Shift+Enter DOM shape.
- Model -> DOM rendering MAY add a visual-only `<br>` sentinel for empty/trailing-newline visibility. DOM -> model parsing MUST ignore this sentinel.

This contract is shared across all views that implement plain-text `contenteditable` surfaces.

### Timing, suppression, and idempotency

The MutationObserver callback fires as a **microtask** — after all synchronous code in the current task. Reactive effects run synchronously. This means: a structural model update runs -> effects run -> DOM updates -> _then_ the observer microtask fires. By that point the DOM already reflects the model; an idempotency check silently discards the mutations. An explicit suppression window is belt-and-suspenders for complex reconciliation edge cases.

**Flush pending observer records before programmatic DOM writes.** Before any programmatic DOM write, flush pending mutation records synchronously. Without this, a stale pending mutation may arrive after the write and incorrectly overwrite the updated content.

**Idempotency.** Both sides use equality checks to prevent feedback loops: the observer commits only if parsed DOM text differs from model text; the render side writes only when model text/sentinel state differs from current DOM state.
Renderer idempotency MUST consider sentinel presence, not only parsed text equality.

**Signal safety guard.** Before running model-driven render into a value surface, check whether the browser cursor is currently inside that element. If so, skip the update — the browser is mid-edit and the observer is already syncing live. Once the cursor leaves, the effect reconciles if needed.

**Direct DOM writes in `beforeinput` handlers.** If a `beforeinput` handler commits a model change and must place the caret immediately (for example after delete or insert), it writes the new content directly to the value element first. This is intentional: while the caret is inside the element, the signal safety guard blocks effect-driven writes. The MutationObserver then ignores the later microtask mutation because the DOM already matches the model.

---

## DOM structure

A view built on `contenteditable` has a single editing root with recursively rendered item rows. Each row contains:

- **Gutter/handle** — structural chrome; `contenteditable="false"`
- **Value surface** — the text editing surface; uniquely identifiable; the only zone without editing suppression
- **Non-text metadata/control zone** — optional; `contenteditable="false"`
- **Embedded interactive subtree zone** — optional; `contenteditable="false"`
- **Child item list** — optional; holds nested item rows for group items

**`contenteditable="false"` on all non-text zones** is mandatory. Without it the browser treats structural and control content as editable, producing corrupt mutations and broken selection behaviour.

Plain-text value surfaces SHOULD always contain at least one caret-host node (for example a visual-only sentinel `<br>`).

**`preventDefault()` on structural chrome `pointerdown`.** All `contenteditable="false"` structural chrome inside the editing root — gutter, drag handle, collapse toggle — must call `e.preventDefault()` on `pointerdown`. Without it, the browser silently relocates the text cursor to the nearest text position at the click coordinates before any handler runs. Applies only to interactive chrome inside the editing root; elements outside follow normal focus rules.

**Location/blur lifecycle with embedded controls.** Embedded controls within `contenteditable="false"` zones steal DOM focus when clicked — the item is still logically focused. The runtime must distinguish focus leaving the editor host entirely from focus moving to an embedded control within it. Save the last known selection on `blur` and restore it on `focus`; browsers do not reliably restore cursor position, and without this the cursor resets to position 0.

**Decorations and overlays.** Visual adornments must not be interleaved with the editing root DOM. Two approaches, both driven reactively from model signals:

- **Node decorations** — CSS classes or attributes on existing item elements driven by reactive state updates. Correct for per-item state: selected, focused, collapsed, error.
- **Overlay layer** — a separate element positioned above the editing root with absolutely-positioned children computed from item bounding boxes. Correct for multi-item highlights, annotations, or anything spanning item boundaries.

**Durable requirements:**

- Value surface is uniquely identifiable (for observer target identification and position mapping)
- Item identity is available on row hosts (for DOM↔model mapping)
- Mounted non-text metadata/control roots and embedded interactive subtree roots are explicitly marked `contenteditable="false"`
- `spellcheck="false"` `autocorrect="off"` `autocapitalize="off"` on the editing root — suppresses browser input transforms, particularly on mobile
- Observer text sync is scoped to the value surface; structural DOM churn is distinguishable and ignorable

---

## Position and cursor

A deterministic bridge between browser cursor positions and model positions is required:

- **DOM position -> `{ itemId, offset }`** — to determine which item and offset the cursor is at
- **Model position -> DOM point/offset** — to programmatically place the cursor

**Cursor restoration after structural ops.** After any structural commit (split, join, paste-expand, item removal with join), the browser cursor is left pointing at DOM nodes that may no longer exist or have been repositioned by reconciliation. The cursor must be programmatically restored:

```ts
const { node, offset } = mapModelPositionToDom(targetItemId, targetOffset);
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
ArrowLeft  + caretOffset === 0                   -> preventDefault + jump to end of previous item
ArrowRight + caretOffset === modelText.length    -> preventDefault + jump to start of next item
otherwise                                         -> let browser handle
```

"Previous/next item" is pre-order tree traversal — leaf items in document order, skipping container items without a value surface.

### Up/Down — hybrid approach

Up/Down movement is purely visual. The browser computes "one line height up/down" — correct for wrapped text, must be preserved. The editor intercepts only when the cursor is on the first or last visual line, detected from text line rects:

```
cursorRect = collapsed caret rect
lineRects  = text line rectangles for the value surface

firstTop   = min(lineRects.top)
lastBottom = max(lineRects.bottom)
tol = 1px

isFirstLine = cursorRect.top <= firstTop + tol
isLastLine  = cursorRect.bottom >= lastBottom - tol

ArrowUp   + isFirstLine -> preventDefault + jump to previous item's last line
ArrowDown + isLastLine  -> preventDefault + jump to next item's first line
otherwise               -> let browser handle
```

Single-line items: both flags are always true. For multi-line items, the implementation also checks logical line index from newline-separated model text; boundary is signalled only when the caret is on the first (`up`) or last (`down`) logical line, not merely at a visual edge.

### Sticky column

When jumping to an adjacent item vertically, the cursor should land at the nearest horizontal position — not at offset 0 or end. The **sticky column** pattern used by all mature text editors:

- Record the cursor's X coordinate when Up/Down is first pressed.
- Use `document.caretRangeFromPoint(stickyX, targetY)` (Chrome/Safari) / `document.caretPositionFromPoint(x, y)` (Firefox) to find the nearest text position in the target item at that X.
- Reset when the user types, presses Left/Right, or takes any non-vertical action.

`caretRangeFromPoint` is the key API: given screen coordinates it returns the nearest text position without requiring any font metric knowledge.

### What not to do

- **Don't intercept all arrow keys** and navigate by model position — this loses wrapped-line awareness, bidirectional text, and OS text services.
- **Don't correct cursor position after `selectionchange`** — by then the cursor is already wrong; `keydown` interception before the browser acts is the correct point.
- **Don't use character offset alone to detect first/last line** — `anchorOffset === 0` indicates the text start but not which visual line for wrapped items; rect comparison is the reliable approach.

---

## Selection

### Model during drag

During text drag selection, application selection should remain in text-edit mode and should not be cleared just because the DOM range is expanding.
The app should keep tracking the active item and text-edit target, while DOM `Selection` remains the source of live range endpoints during the drag.

```
mousedown   -> text edit focus on item A, DOM range collapsed
drag moves  -> text edit focus remains on item A, DOM range extended
settles     -> text edit focus may move to item X, DOM range collapsed
```

Operations triggered mid-range (type to replace, copy, cut) use the live DOM range directly — no awkward save-and-restore logic needed.

The browser exposes `anchorNode/anchorOffset` (fixed — where the selection started) and `focusNode/focusOffset` (the moving end). The `selectionchange` handler maps the **focus** side to the active editing position and caret, so backward drags and extended selections keep item identity aligned to the moving endpoint.

### Focused-item indicator

The focused-item indicator (`is-focused`) is a **caret indicator**, not a selection indicator. It answers "where is my cursor?" — which only has meaning when the selection is collapsed. During a text range, the selection highlight is the sole indicator; a simultaneous per-item focus highlight is redundant.

```
Show is-focused when:
  this item is the active text-edit item
  AND (
    target is non-text
    OR (target is text-edit and DOM selection is collapsed)
  )
  OR this item is the active item-selection target
```

For text-edit targets, the collapsed check suppresses `is-focused` during text ranges. For non-text editing targets and item selection, focus styling follows model selection directly.

### Selection visuals in embedded zones

The single editing root means browser sweep-selection can include non-editable metadata/control and embedded-interactive zones. Correct implementation needs two distinct tools:

- `user-select: none`: excludes an element from selection range and clipboard content.
- `::selection` suppression: visual-only; the element remains in range/clipboard but does not show selection highlight.

Use `user-select: none` for structural chrome that must not be selected. Use `::selection` suppression for non-text interactive zones that should remain part of selection semantics.

For `::selection` suppression, both background and foreground color should be set, and descendants should be covered:

```css
.zone::selection,
.zone *::selection {
  background: transparent;
  color: inherit;
}
```

`background` alone is insufficient in some browsers because selected text color may still be inverted.

Inputs and textareas inside embedded zones manage their own selection independently (`selectionStart`/`selectionEnd`), so parent `::selection` suppression does not control input-internal highlight.

For inline atomic non-editable nodes inside the editable flow, range-inclusion should be represented explicitly by selection state (for example via a model-driven class), rather than relying on browser text-selection paint.

Recommended defaults:

| Zone                                                                                   | Approach                                                     |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Structural chrome (for example gutter, drag handle)                                    | `user-select: none`                                          |
| Non-text embedded zones (for example metadata/control host, embedded interactive host) | `::selection` suppression (background + color + descendants) |
| Value surface                                                                          | No suppression                                               |
| Inline atomic non-editable node                                                        | `::selection` suppression + separate inclusion state styling |
