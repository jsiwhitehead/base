# Roadmap

This roadmap organizes development by capability domains rather than features or timelines. `CONTRIBUTING.md` defines how to change the code, while this document defines how the system should mature. Engineering maturity is organized along two independent axes: how changes happen (change mechanics) and what the model can represent (semantic scope).

The focus is a robust foundation across major desktop browsers. Work prioritizes standards compliance, cross-browser correctness, stable persistence, and predictable behavior in mainstream desktop environments. Platform-specific adaptations are deferred until the core foundation is mature.

## Principles

### Protect the substrate

Preserve transaction integrity, undo safety, selection invariants, deterministic behavior, and reproducible state.
No feature may weaken these guarantees.

### Extend by composition

Build new capability by reusing structural operations, history semantics, and selection rules.
Avoid parallel mutation paths.
All mutation paths must converge to the same structural result.

### Separate structure from view

There is one underlying structure.
Views are lenses over it.
View behavior must not silently redefine structural semantics.

### Strengthen before expanding

Simplify and unify behavior before adding power.
Persistence, performance, and failure visibility precede new expressiveness.

### Layer automation above integrity

LLM assistance operates through transactions, is fully undoable, and never bypasses invariants.

## Axis A: how changes happen

This axis covers change mechanics: how edits are initiated (user, automation, collaborator), interpreted, applied, persisted, synchronized, replayed, and audited while preserving deterministic correctness.

### Bounded automation

Purpose: Allow LLM assistance without displacing human authority or weakening structural guarantees.

- Provide read-only suggestion and analysis flows
- Implement propose-and-approve mutation pathways
- Support a staged human-LLM workflow with exact structural diffs presented at each stage
- Define approval granularity relative to transaction boundaries
- Restrict automation execution to the structural scope shown in the approval diff
- Define the minimum read/write scope granted to each automation operation
- Define the data format, grammar, and addressing model exposed to automation for reliable LLM use
- Define the user-facing surface for automation proposals and staged diffs

### Deterministic collaboration

Purpose: Enable concurrent multi-user revision with guaranteed convergence and transparent conflict handling.

- Adopt and validate a CRDT strategy appropriate to the tree model
- Implement broadcast, receive, apply, and convergence verification
- Guarantee invariant preservation under remote transaction application
- Define undo and redo semantics under concurrent edits
- Support offline editing with deterministic merge on reconnect
- Preserve stable identity across replicas
- Provide shared presence and remote selection display
- Provide conflict explanation and reconciliation transparency
- Guarantee consistency of derived computation across replicas

### Access control and audit

Purpose: Ensure authority is explicitly scoped and all structural changes are attributable and inspectable.

- Define authentication and session contracts
- Define authorization primitives for access control over subtrees and structural regions
- Enforce permission checks at transaction entry points
- Define consistent behavior for rejected and unauthorized transactions
- Provide comprehensive audit logs with actor attribution

### Automation under concurrency

Purpose: Ensure automation remains bounded, attributable, and deterministic within collaborative contexts.

- Define approval semantics when automation intersects concurrent edits
- Guarantee deterministic merge of automation-originated transactions
- Prevent automation from bypassing coordination rules
- Preserve attribution of automation-applied changes
- Validate convergence when automation operates across replicas

### Durability and performance

Purpose: Ensure structural continuity, responsiveness, and diagnosability under scale, time, and failure.

- Define and implement snapshot migration across format versions
- Define user-facing checkpoint and named version semantics
- Define user-facing document control affordances for save, restore, and version selection flows
- Introduce backend-neutral storage abstraction
- Guarantee atomic persistence with no partial state on failure
- Explicitly surface save, parse, and restore failures to the user
- Add debounced autosave behavior to reduce write churn during rapid edits
- Stress-test and harden outline traversal and range-edit behavior under deep nesting and large trees
- Establish performance budgets, representative scale benchmarks, and regression detection
- Provide deterministic structural hashing for state equivalence validation
- Provide transaction inspection, replay, and trace tooling
- Define an edit script format and implement fuzz testing to surface structural invariant violations under arbitrary operation sequences
- Expose dependency graphs for computed outputs to support debugging and error attribution
- Detect and surface structural inconsistencies at startup and during editing operations
- Provide reproducible export bundles for debugging

### Accessibility and platform

Purpose: Ensure accessible, standards-aligned behavior across supported platforms without weakening core guarantees.

- Define accessibility baseline and compliance scope
- Establish semantic and ARIA contracts for interaction surfaces
- Guarantee consistent keyboard and assistive-technology behavior across views
- Introduce accessibility validation and regression workflows

## Axis B: what the model can represent

This axis covers representational scope: the structures, relationships, types, views, and interchange forms the model can express while preserving one coherent substrate.

### Base views

Purpose: Harden and extend the foundational views that allow structure to be inhabited and revised without altering the data model.

- Define and implement table and slider delete-focus landing rules consistent with node-boundary navigation contracts
- Harden slider value coercion, snapping, and undo semantics
- Provide deterministic column totals in table contexts
- Harden row and column operations under deletion and undo
- Add `.is-stale` textfield styling consistently across views

### Structural relationships

Purpose: Allow the data model to express explicit relationships beyond containment through formal connection types.

- Introduce shorthand forms and reusable expression patterns to reduce formula verbosity
- Provide structured error surfacing for invalid expressions
- Provide formula and query authoring assistance with inline feedback and expression hints
- Add field selection to queries, returning only nodes that match a specified field shape
- Extend queries to traverse all descendants with ancestor-chain field values from root to each result
- Guarantee stable identity and consistency of derived nodes across views
- Define result items as a structural primitive: nodes with a designated output child and local context children, with explicit visibility, addressing, undo, and export semantics
- Introduce first-class link connections independent of derivation
- Define referential integrity for link targets and surface broken references explicitly

### Typed semantics

Purpose: Allow regions of structure to become formally dependable where reliability is required.

- Clarify numeric precision semantics and evaluate decimal support for financial values
- Introduce date value semantics
- Define type validation contracts
- Define schema evolution strategy for typed nodes
- Guarantee deterministic type coercion
- Surface type mismatches explicitly

### Advanced views

Purpose: Extend how structure can be rendered and interacted with in the UI without redefining underlying semantics.

- Define `when` predicate contract and view eligibility resolution rules
- Implement `when` guards on view assignment
- Define user-facing view management flows for assigning and switching eligible views
- Define collapse and expand interaction contracts for hierarchical views
- Define the interface a view type must implement to integrate with the view system
- Define a shared indicator system that allows views to choose appropriate structural markers while maintaining visual consistency
- Add column aggregate display to table view as a view-level feature independent of structural entries

### Data interchange

Purpose: Ensure structure and meaning survive crossing boundaries and external adapters without semantic loss.

- Harden drag-and-drop including validation, failure handling, and deterministic post-drop focus outcomes
- Define and implement a structural clipboard format for node subtrees
- Define paste semantics for structural clipboard content, including identifier regeneration and multi-node ordering
- Guarantee atomic import with no partial state on failure
- Define CSV import and export contracts
- Verify that export/import round-trips preserve structural equivalence
