# Contenteditable View Layer

A view built on `contenteditable` uses a single editing root. This document covers the design and implementation of that layer — the event pipeline, text sync, DOM structure, position mapping, navigation, and selection.

## Why contenteditable

The established approach (ProseMirror, Lexical) uses a single `contenteditable` root. The alternatives fail structurally:

- **One input/textarea per item** — no cross-item selection, no cross-item paste, IME breaks at item boundaries, poor accessibility.
- **Fully custom rendering** — must re-implement all browser text input behaviour; IME (CJK, Arabic, etc.) is notoriously hard to get right; accessibility requires `contenteditable`; spell-check, autocorrect, and OS text services are lost.

`contenteditable` gives: native cursor and caret, IME, spell-check, autocorrect, accessibility, system copy/paste. The architecture's job is to intercept browser behaviour at the right points and keep the model as the single source of truth.

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

### Event ownership and precedence

`contenteditable` implementations are reliable only when event ownership is explicit and centralized.

Use a single coordinator with strict precedence:

1. **Ownership gate**: ignore events whose target is outside the active editing root or is captured by an embedded control subtree.
2. **Editor-local handlers**: contenteditable pipeline (`beforeinput`, `selectionchange`, contenteditable-specific key handling).
3. **Shared platform handlers**: generic frame/target/runtime handlers.
4. **Global intent routing**: keyboard-intent pipeline for non-contenteditable surfaces.

Rules:

- Ownership must be resolved before any model selection write.
- Non-owning handlers must return immediately and must not "repair" selection.
- Global key routing must early-return when the target is `contenteditable`.
- Embedded interactive subtrees should be able to block contenteditable ownership explicitly.

Without this ordering, multiple pipelines race and produce transient focus/selection flips.

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
| `deleteByDrag`                                                                             | Prevent; source-side native deletion is blocked for copy-only text drag/drop                                                           |
| `insertCompositionText`                                                                    | **Always allow through** — browser manages IME candidate display                                                                       |
| `historyUndo`, `historyRedo`                                                               | Prevent; dispatch to application undo/redo — Safari fires these via `beforeinput` before `keydown`, bypassing the `keydown` intercept  |
| Everything else                                                                            | Prevent by default (closed-world contract between browser events and model handlers)                                                   |

**Paste** uses `text/plain`, not `text/html`. HTML from external sources carries formatting with no schema mapping; sanitising it reliably is complex. `text/plain` is the safe, consistent default. Structure-preserving internal paste is cleanest as a separate custom clipboard format.

**Copy and cut** are intercepted via the `copy` and `cut` events: read the current selection, serialize to `text/plain` in `clipboardEvent.dataTransfer`, call `preventDefault()`. This ensures clean model text on the clipboard rather than a browser-serialized DOM fragment. If model serialization is unavailable (for example unsupported cross-parent ranges), handlers still call `preventDefault()` and no-op to block native HTML fallback.

**Drag and drop.** Outline HTML5 drag/drop is a plain-text, copy-only path for owned value surfaces. `dragstart` serializes the current selection as `text/plain` only when the event starts inside a value surface. `dragover` only admits the drop and advertises copy semantics. `drop` reads `text/plain` and applies the insertion as a model update. The app does not delete the source selection.

**Paste and drop pipeline.** The `paste` and `drop` event handlers own the model update and call `preventDefault()`. Their `beforeinput` counterparts (`insertFromPaste`, `insertFromDrop`) only call `preventDefault()` to block the browser's direct DOM write. Chrome fires `insertFromDrop` regardless of whether `drop` was already prevented; the `beforeinput` case is necessary to suppress this stale mutation.

### `keydown`

For operations that never produce `beforeinput`: Tab (nesting), Escape (NAV/out), `Cmd/Ctrl+Z` (undo), `Cmd/Ctrl+Shift+Z` / `Ctrl+Y` (redo). All structural `keydown` handlers must be guarded with `e.isComposing` — structural operations must not fire mid-composition.

### Pointer lifecycle and click semantics

Do not treat pointer input as isolated `click` events. Handle the full lifecycle:

```
pointerdown -> optional pointermove sequence -> pointerup / pointercancel
```

Keep explicit pointer state. Minimum required:

- `isPointerSelecting`: primary-button text selection is in progress.

Optional richer state (useful in more complex editors):

- `pointerDownInValue`: pointer started in a value surface.
- `pointerDownInChrome`: pointer started in structural chrome.
- `lastPointerType`: mouse/touch/pen (selection logic may differ by type).

Rules:

- `pointerdown` in value surface: keep browser-native caret/selection behavior.
- `pointerdown` in structural chrome inside the contenteditable root: call `preventDefault()` to block browser caret relocation.
- Do not collapse or rewrite model selection during drag-select (`pointerdown` to `pointerup`) unless ownership changes.
- `pointercancel` must clear pointer state exactly like `pointerup`.
- Pointer lifecycle state must also be cleared on editor blur, root switch, and editor disposal to avoid stale cross-interaction state.

Single/double/triple click handling should be explicit when behavior differs (for example line/paragraph select semantics), but must still route through the same ownership gate and suppression policy.

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

| Pipeline                                    | Owns                                                                    | Guard                                                                          |
| ------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `contenteditable` `beforeinput` + `keydown` | Text-edit target: text and structural edits                             | Return early from global key routing when event target is `contenteditable`.   |
| Command/intent routing pipeline             | Non-contenteditable command handling: navigation and structural intents | Return early unless editor is in command-routing mode.                         |
| MutationObserver                            | Browser-authored character sync in `value` surface                      | Skip when model text already matches; ignore during structural reconciliation. |
| `selectionchange`                           | Editing location/range tracking                                         | Skip when model already matches current selection to avoid sync loops.         |

These boundaries are strict: pipelines should not cross responsibilities.
Model -> DOM rendering is the default write path; imperative DOM writes are for explicit cursor/selection repair only.

### Selection origin tags (recommended pattern)

Mature editors often model selection origin metadata for policy decisions:

- `pointer` — pointerdown/drag/click lifecycle
- `keyboard` — key navigation/edit operations
- `composition` — IME phase
- `programmatic` — model-driven focus repair/reveal

Origins are ephemeral pipeline metadata and do not need to be persisted in canonical selection state.

Why this matters:

- Pointer-origin selection changes should tolerate temporary expanded DOM ranges.
- Programmatic updates should enable stronger suppression of echo `selectionchange`.
- Composition-origin updates should avoid structural behavior.

### Platform caveat: Android

On Android, the virtual keyboard communicates with the browser via the native `InputConnection` API — a platform-level protocol that mutates the DOM directly before any JS event fires. By the time `beforeinput` arrives in JS, the mutation has already happened; `e.preventDefault()` has no effect. The `beforeinput`-first interception model does not apply on Android.

This is explicitly off-spec (W3C Input Events Level 2 requires all non-IME `beforeinput` to be cancelable) but is a deliberate architectural constraint of Android's IME subsystem, not a bug. Both ProseMirror and Lexical implement a separate Android code path: MutationObserver becomes the primary input mechanism, with `beforeinput` used only as an intent signal, not for prevention. The [EditContext API](https://developer.chrome.com/blog/introducing-editcontext-api) (Chrome/Edge 121+) resolves this at the architectural level but has no Firefox/Safari implementation.

**Android is not a supported platform for this editor.** This note exists so the constraint is understood if support is added later.

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
observer.observe(contenteditableRoot, {
  characterData: true,
  characterDataOldValue: true,
  childList: true,
  subtree: true,
});
```

Two mutation types matter:

- `characterData` — normal typing; modifies an existing text node.
- `childList` — **the first character in an empty item** creates a new text node rather than modifying one. Without `childList: true` this character is silently lost — a well-known gotcha. Also filter bare `<br>` insertions: browsers add one to maintain editability in an empty surface; treat it as structural noise, not a text edit, or the model briefly sees `"\n"` as content.

`characterDataOldValue: true` provides each `characterData` record's previous text. If `record.target.data === record.oldValue`, treat it as a no-op re-normalization and skip the full-surface read. Keep the full-surface idempotency check as fallback for `childList` mutations and any case without usable `oldValue`.

The observer is a **text-sync channel**, not a general source of truth for every DOM mutation. App-authored structural and reconciliation DOM churn must not be misclassified as user text edits. With `subtree: true` the observer fires for mutations anywhere in the editing root; each `MutationRecord.target` must be traced up the DOM to identify which item's value surface was affected. Mutations outside any value surface are skipped.

Read the full value surface with the plain-text parser, not the mutated node. IME and autocorrect can produce multiple adjacent text nodes and `<br>`/block wrappers; only full-surface parsing is reliable.

### Canonical newline contract

For plain-text `contenteditable` value surfaces:

- Model text MUST use LF-only newlines (`\n`) (`\r\n`/`\r` normalize to `\n`).
- Model -> DOM rendering is canonical plain-text structure: `Text` nodes plus `<br>` (including optional sentinel `<br>` for empty/trailing newline visibility), not block wrappers.
- DOM -> model parsing MUST be tolerant: treat `<br>` and block wrappers (for example `<div>` / `<p>`) as line breaks, preserve blank lines and trailing newline (for example `"a\n\nb\n"`), and ignore sentinel `<br>`.
- Model -> DOM writes MUST preserve the exact model string and MUST NOT rely on browser-default Enter/Shift+Enter DOM shape.
- Tolerant parsing is a safety fallback for non-canonical browser/native mutations (for example paste/autocorrect/IME).

This contract is shared across all views that implement plain-text `contenteditable` surfaces.

### Timing, suppression, and idempotency

The MutationObserver callback runs as a **microtask** after synchronous work in the current task. In practice: model update -> reactive effects -> DOM update -> observer callback. By callback time, DOM usually already matches model, so idempotency checks discard no-op records; suppression is a defensive extra guard.

**Flush pending observer records before programmatic DOM writes.** Before any programmatic DOM write, flush pending mutation records synchronously. Without this, a stale pending mutation may arrive after the write and incorrectly overwrite the updated content.

**Idempotency.** Both sides use equality checks to prevent feedback loops. The observer commits only when parsed DOM text differs from model text; the renderer writes only when model text or sentinel state differs from DOM. Renderer idempotency MUST include sentinel presence, not just parsed text equality.

**Signal safety guard.** Before running model-driven render into a value surface, check whether the browser cursor is currently inside that element. If so, skip the update — the browser is mid-edit and the observer is already syncing live. Once the cursor leaves, the effect reconciles if needed.

**Direct DOM writes in `beforeinput` handlers.** When a `beforeinput` handler commits and must place the caret immediately (for example after delete or insert), it writes content directly to the value element first. This is intentional: the signal safety guard blocks effect-driven writes while the caret is inside the element, and the observer later ignores the matching mutation as a no-op.

**Suppression flag reset timing — `setTimeout(0)`, not `queueMicrotask`.** Reset suppression in the next macrotask so synchronous `selectionchange` handlers still see it as active. `queueMicrotask` resets too early. Because resets are async, use token-based suppression instead of a plain boolean so overlapping suppressions do not clear each other incorrectly.
Any deferred pointer-finalize reconcile should use compatible timing (typically next macrotask) so it does not race suppression resets.

### Suppression channels

Use separate suppression channels for separate causes; do not multiplex into one boolean:

- Programmatic caret/selection set is in progress.
- Structural-chrome pointer interaction should not be remapped to editing.
- Model-authored reconciliation is in progress.
- `beforeinput` history event already consumed undo/redo.

Rules:

- Suppression must be token-based and one-turn scoped.
- Suppression channels must be independent; one channel ending must not clear another.
- Suppression exists to prevent self-echo loops, not to hide real user input.

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

**Exiting `contenteditable` requires explicit selection clear.** Moving DOM focus away from a `contenteditable` surface does not reliably clear the browser's document selection. When text editing exits to structural/item selection, clear the DOM document selection before or while focusing the structural owner, or a stale caret/range may remain visible in the old surface.

**Decorations and overlays.** Visual adornments must not be interleaved with the editing root DOM. Two approaches, both driven reactively from model signals:

- **Node decorations** — CSS classes or attributes on existing item elements driven by reactive state updates. Correct for per-item state: selected, focused, collapsed, error.
- **Overlay layer** — a separate element positioned above the editing root with absolutely-positioned children computed from item bounding boxes. Correct for multi-item highlights, annotations, or anything spanning item boundaries.

**Durable requirements:**

- Value surface is uniquely identifiable (for observer target identification and position mapping)
- Item identity is available on row hosts (for DOM↔model mapping)
- Mounted non-text metadata/control roots and embedded interactive subtree roots are explicitly marked `contenteditable="false"`
- `spellcheck="false"` `autocorrect="off"` `autocapitalize="off"` on the editing root — suppresses browser input transforms, particularly on mobile
- Observer text sync is scoped to the value surface; structural DOM churn is distinguishable and ignorable

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

**Cursor placement timing in a reactive system.** After a model selection write, place the cursor in the next microtask so focus effects and DOM reconciliation settle first. For structural edits inside live `beforeinput`, place it immediately (`defer: false`) because the surface is already focused and DOM was updated synchronously.

Position mapping must remain stable under text-node fragmentation — IME, autocorrect, and browser-internal optimisations can produce multiple adjacent text nodes within a single value surface.

For plain-text surfaces, mapping MUST treat semantic `<br>` as one logical newline character. Visual-only terminal sentinel `<br>` nodes MUST contribute zero logical characters.

Shared DOM helpers SHOULD expose mapped selection/range primitives (DOM point -> caller-mapped model point) so views can reuse contenteditable mapping without embedding view semantics in the DOM layer.
Shared DOM helpers MAY also expose collapsed-caret rect and mapped selection snapshot primitives for view-agnostic cursor/selection plumbing.

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

### `selectionchange` reconciliation algorithm

`selectionchange` is a reconciliation signal, not an unconditional command.

Recommended order:

1. Exit if composing.
2. Exit if any relevant suppression channel is active.
3. Read DOM `Selection`; if absent, clear range visuals and exit.
4. Exit if either selection endpoint is outside the active editor root.
5. Map DOM endpoints into model positions; if unmappable, clear range visuals and exit.
   During active pointer selection, a temporary unmappable state may be tolerated to avoid range-visual flicker/churn.
6. Update range-visual state (collapsed vs expanded; start/end items).
7. Derive focus-side model location from DOM focus endpoint.
8. If model selection is already on the same editing location+target, exit.
9. Otherwise write editing selection, with caret only when collapsed.

Rules:

- Never "correct" intra-item cursor movement after the fact.
- Reconcile only when mapping is valid inside owned contenteditable surfaces.
- Prefer focus endpoint identity for active editing location.
- Expanded ranges should preserve editing mode rather than dropping to item mode.

This keeps pointer drag selection stable and avoids item/editing thrash.

### Default-prevention matrix for pointer-related paths

| Event/zone                                                   | Default action                                           |
| ------------------------------------------------------------ | -------------------------------------------------------- |
| `pointerdown` in value surface                               | Allow default                                            |
| `pointerdown` on structural chrome in contenteditable root   | `preventDefault()`                                       |
| `pointerdown` in input/textarea controls                     | Allow default caret/selection behavior                   |
| `dragstart` in contenteditable value surface                 | Allow default drag start, but override payload as needed |
| `drop` in contenteditable value surface (model-owned insert) | `preventDefault()`                                       |

This matrix should be treated as normative unless a view has an explicit exception.

### Select-all

Handle `Mod+A`/`Cmd+A` as a model-first command, then sync DOM selection.
Do not infer full-range selection from container-boundary DOM ranges.

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
