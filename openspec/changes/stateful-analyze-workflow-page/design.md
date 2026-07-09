## Context

The current Analyze page still renders three conceptual cards together: add replays, selected replays, and current progress. That leaks implementation structure into the UI. After the recent progress-bar work, the progress card became better, but the page still shows too much irrelevant surface area in each workflow phase.

The user-provided interaction model is explicit: the page should act like a single workflow with four derived states:

- `empty`
- `queue-review`
- `running`
- `complete`

This change is primarily a renderer information-architecture change. The main-process queue and analysis pipeline can remain unchanged if the renderer derives workflow state correctly and retains a way to dismiss the last completed run when the user starts a fresh queue.

## Goals / Non-Goals

**Goals:**
- Make the Analyze page show only one state-owned view at a time.
- Keep queue editing available only before a run starts.
- Make the running view full-width and dominant.
- Add a strong completion summary with context-sensitive next actions.
- Avoid getting stuck in `complete` after the user starts preparing the next analysis run.

**Non-Goals:**
- Change the underlying analysis pipeline, queue execution order, or cancellation semantics.
- Redesign the Library or MCP pages.
- Add advanced queue features such as reordering, pausing, or parallel execution.

## Decisions

### Decision: Derive a UI workflow state from existing renderer state

The page will derive workflow state from the current analysis run plus the pending replay queue. No backend or shared-contract workflow enum is required for this feature.

To support “Analyze more replays” without permanently showing the last finished run, the renderer will keep a local dismissed-completion marker keyed by `analysis.runId`. Once dismissed, terminal runs stop forcing the `complete` view.

Alternative considered:
- Add a workflow-state field to shared contracts. Rejected because the workflow is a presentation concern built from existing data.

### Decision: Split Analyze into dedicated subviews

The Analyze page will render separate components for:

- empty
- queue review
- running
- complete

This keeps each state focused and prevents condition-heavy JSX from accumulating in one monolithic card layout.

Alternative considered:
- Keep one `AnalyzeView` with nested conditionals. Rejected because the new UX is intentionally state-owned rather than card-owned.

### Decision: Completion actions reuse the pending queue as the next input queue

Follow-up actions such as retrying failed items, analyzing remaining items after cancellation, or analyzing more replays will be implemented by repopulating or clearing `pendingReplays` in the renderer. The next run then uses the same existing start-analysis flow.

Alternative considered:
- Start retries immediately from the completion screen. Rejected because queue review remains valuable and matches the requested design.

### Decision: Sidebar Analyze status should reflect workflow, not only selection count

The Analyze nav label will be driven by the derived workflow state plus terminal outcome details. This gives a compact summary without keeping redundant cards visible on the page.

## Risks / Trade-offs

- [Terminal run state persists in the app model] → Track a dismissed run ID locally so users can intentionally leave the completion view.
- [More component splitting could duplicate queue rendering logic] → Extract small reusable queue/run list helpers where it reduces repeated markup.
- [Completion action rules could become inconsistent] → Base button visibility directly on replay-job status groups from the existing analysis state.
