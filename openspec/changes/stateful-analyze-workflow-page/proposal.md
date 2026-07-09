## Why

The Analyze page currently exposes internal pieces of the workflow all at once, which creates dead or duplicated UI in most states. Users need one state-owned page that matches what they are trying to do right now: add replays, review the queue, watch the run, or understand the result.

## What Changes

- Redesign the Analyze page around a single derived workflow state: empty, queue-review, running, or complete.
- Replace simultaneous rendering of the add, queue, and progress cards with one state-owned body per workflow state.
- Make the running experience a full-width progress monitor rather than a secondary side card.
- Add a completion summary with follow-up actions such as viewing the library, analyzing more replays, retrying failed items, and resuming remaining items after cancellation.
- Update the Analyze sidebar summary to reflect workflow state rather than only the current queue count.
- Preserve the current desktop shell, visual language, and underlying analysis pipeline behavior.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `desktop-application`: the Analyze page workflow, progress presentation, completion summary, and Analyze navigation status now follow a single stateful workflow model.

## Impact

- Affects the desktop renderer, especially Analyze-page state derivation and component structure.
- Reuses existing analysis state and queue data instead of changing CLI or main-process pipeline behavior.
- Extends renderer and workflow-state tests for the new state-owned page behavior.
