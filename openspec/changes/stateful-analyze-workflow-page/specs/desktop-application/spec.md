## MODIFIED Requirements

### Requirement: Observable analysis jobs
The system SHALL present the Analyze page as a single stateful workflow that shows only the UI relevant to one of four user-facing states: adding replays, reviewing the queue, monitoring a run, or reviewing the completed outcome.

#### Scenario: Empty analyze page
- **WHEN** no replay queue exists, no analysis run is active, and the most recent terminal run has been dismissed or does not exist
- **THEN** the Analyze page shows only the replay-add experience and does not show an empty queue table or idle progress card

#### Scenario: Queue review before analysis
- **WHEN** one or more replays are selected and no analysis run is active
- **THEN** the Analyze page shows an editable replay queue with add, remove, clear, and start-analysis actions and does not show the running progress view

#### Scenario: Active analysis run
- **WHEN** replay analysis is running, ingesting, or cancelling
- **THEN** the Analyze page shows a full-width run monitor with current progress, queue progress, live replay statuses, and cancellation controls without showing queue-edit actions

#### Scenario: Completed analysis run
- **WHEN** replay analysis succeeds, partially succeeds, fails, or is cancelled and the completion view has not been dismissed
- **THEN** the Analyze page shows a completion summary with outcome-specific next actions instead of the empty or queue-review views

#### Scenario: Analyze more after completion
- **WHEN** a user chooses to analyze more replays from the completion view
- **THEN** the completion view is dismissed and the Analyze page returns to the empty replay-add state until a new queue is created
