# Roadmap

This roadmap organizes development by capability domains rather than features or timelines.

`CONTRIBUTING.md` defines how to change the code.
This section defines how the system should mature.

## Principles

### Protect the substrate

Preserve transaction integrity, undo safety, selection invariants, deterministic behavior, and reproducible state.
No feature may weaken these guarantees.

### Extend by composition

Build new capability by reusing structural operations, history semantics, and selection rules.
Avoid parallel mutation paths.
All movement paths must converge to the same structural result.

### Separate structure from view

There is one underlying structure.
Views are lenses over it.
View behavior must not silently redefine structural semantics.

### Strengthen before expanding

Simplify and unify behavior before adding power.
Persistence, performance, and failure visibility precede new expressiveness.

### Layer automation above integrity

LLM and automation operate through transactions, are fully undoable, and never bypass invariants.

## Platform scope

The focus is a robust foundation across major desktop browsers.

Work prioritizes standards compliance, cross-browser correctness, stable persistence, and predictable behavior in mainstream desktop environments.
Platform-specific adaptations are deferred until the core foundation is mature.

## Capability map

Each item below represents a coherent engineering capability that can be meaningfully implemented and validated.

## Substrate integrity

Purpose: Maintain a deterministic, reversible, invariant-safe core state model under all change.

- Define explicit failure types and recovery contracts for invariant violations
- Guarantee invariant preservation under remote transaction application
- Define and implement a clear coalescing and undo-boundary policy for mixed edit flows
- Eliminate history ambiguity across cross-surface structural operations
- Formalize removed-item and orphan-handling guarantees
- Guarantee deterministic root normalization and post-mutation selection repair

## Structural operation semantics

Purpose: Define canonical structural operations that produce the same valid result regardless of entry path.

- Complete and validate all primitive structural operations and edge cases
- Formalize contracts for value/group/connected transitions
- Guarantee predictable placeholder and boundary conversion behavior
- Unify cleanup and prune semantics across all operation entry points
- Enforce consistent prune stop conditions (root, readonly, non-group, first non-empty)
- Guarantee convergence of keyboard, drag-and-drop, and paste for equivalent intents
- Standardize post-operation focus, caret, and canonical target resolution

## Interaction model

Purpose: Define a deterministic interaction grammar for selection, editing, and navigation across all views.

- Specify and validate all state machine transitions between idle, editing, and item selection states
- Guarantee selection validity across delete, move, switch, and undo flows
- Write and validate behavioral contracts for anchor/head selection in edge cases
- Ensure item-selection and editing states remain explicit and non-ambiguous
- Guarantee interaction stability across nested views and mixed-mode transitions
- Eliminate ambiguous focus outcomes in edge-case navigation scenarios

## Input & intent pipeline

Purpose: Translate platform input events into unambiguous, deterministic core intents and operations.

- Stabilize contenteditable reconciliation under complex editing flows
- Harden cross-browser IME and input-event handling
- Align textfield and contenteditable yielding and commit semantics
- Standardize navigation and delete-boundary edge-case behavior
- Enforce strict runtime/core/view ownership separation for intent handling
- Eliminate duplicated or ambiguous intent interpretation paths
- Maintain clearly isolated platform deferrals (Android path, EditContext future)

## Views

Purpose: Render multiple views over one shared structure without altering core semantics or integrity.

- Add `when` guards to view eligibility
- Guarantee transaction safety and identity preservation across view switching
- Harden view switching under nested selection and mixed-mode transitions
- Preserve selection validity and rendering continuity across views
- Refine outline traversal and range-edit behavior in deeply nested structures
- Eliminate selection-driven layout instability and unnecessary remount churn
- Add result groups with one output child and local scope sibling items
- Harden table editing under row and column operations
- Formalize extension contracts for advanced table semantics (totals, aggregation, derived rows)
- Add further view types (tabs, rich text, and beyond) with appropriate contracts as the substrate and interaction model mature
- Ensure visual coherence for items across views, expanding a consistent indicator family as needed

## Data interchange

Purpose: Safely move data across clipboard, drag/drop, import/export, and external adapters without semantic loss.

- Harden drag-and-drop resolution, validation, and failure handling
- Guarantee deterministic post-drop focus and selection outcomes
- Define and implement a canonical internal structural clipboard format
- Guarantee safe clone insertion with validated payloads and regenerated IDs
- Define deterministic multi-line and multi-item paste semantics
- Guarantee atomic import with no partial state on failure
- Define CSV import/export contracts and isolate external adapters from model semantics

## Durability & performance

Purpose: Preserve correctness and responsiveness over time, scale, and high-frequency change.

- Implement a robust autosave and restore policy
- Introduce backend-neutral storage abstraction
- Guarantee explicit surfacing of save, parse, and restore failures
- Ensure boot-time restore precedes interactive rendering
- Define snapshot versioning and validated migration strategy
- Preserve rendering stability under high-churn structural edits
- Establish performance budgets and regression detection for critical paths
- Define representative scale benchmarks
- Apply targeted optimization strategies (virtualization, indexing)

## Observability & diagnostics

Purpose: Make system behavior and failures explicit, inspectable, and actionable.

- Eliminate silent failure paths across interaction and persistence flows
- Define consistent issue surfacing for structural and runtime failures
- Provide actionable failure states for edit, move, delete, paste, save, and restore workflows
- Provide transaction inspection and runtime diagnostics tooling
- Implement replay and trace support with equivalence validation
- Detect and surface structural inconsistencies early in execution
- Extend invariant monitoring to support production diagnostics where appropriate

## Computation & derivation

Purpose: Define deterministic derived computation and type-aware semantics beyond raw structure.

- Guarantee safe, deterministic formula evaluation semantics
- Use ID-backed connection references with reactive human-readable paths
- Improve formula ergonomics and reduce repetitive expression patterns
- Expand structured error surfacing through the issue system
- Formalize query semantics for item traversal, filtering, sorting, and aggregation
- Add deep query field-shape matching with per-field ancestor-chain value paths
- Guarantee consistency of derived items across views
- Implement dependency tracing for computed outputs
- Strengthen numeric precision guarantees
- Introduce date value semantics as a first additional scalar type
- Define validation contracts and schema evolution strategy for typed data

## LLM augmentation

Purpose: Add LLM-assisted workflows through explicit, bounded, fully undoable transactions.

- Provide read-only LLM suggestion flows
- Implement propose-and-approve pathways for LLM-originated edits
- Enforce one approved proposal per transaction boundary
- Guarantee bounded LLM scope per approval
- Preserve full undoability of LLM-applied changes
- Define least-privilege automation execution boundaries
- Prevent automation from bypassing invariants

## Collaboration

Purpose: Enable concurrent multi-user editing with deterministic convergence and transparent conflict handling.

- Adopt a CRDT-based synchronization strategy and transport layer (evaluate established candidate libraries against the tree model before committing)
- Implement end-to-end real-time sync: broadcast, receive, apply, and verify convergence of concurrent edits
- Extend to shared presence and remote selection display
- Define undo and redo semantics under concurrent edits
- Support offline editing with deterministic merge on reconnect
- Provide conflict explanation and reconciliation transparency

## Accessibility & platform

Purpose: Ensure accessible, standards-aligned behavior across current platform targets and future expansion paths.

- Define target accessibility baseline and compliance scope
- Establish semantic and ARIA contracts for interaction surfaces
- Guarantee consistent keyboard and assistive-technology behavior across views
- Introduce accessibility validation and regression workflows
- Continue desktop-browser hardening within current scope
- Define staged exploration path for Android/mobile editing
- Evaluate future platform APIs without weakening core guarantees
