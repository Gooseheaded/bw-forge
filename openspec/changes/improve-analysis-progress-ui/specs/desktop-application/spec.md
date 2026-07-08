## MODIFIED Requirements

### Requirement: Observable analysis jobs
The system SHALL show structured analysis progress with user-friendly stage labels, visible queued/running/succeeded/failed/cancelled status for each replay, secondary batch progress across the selected replay set, and raw timestamped stdout/stderr logs available as troubleshooting details.

#### Scenario: Long replay export remains visibly active
- **WHEN** replay analysis is in the replay-export stage and no replay has finished yet
- **THEN** the analysis screen shows a primary progress bar for the current replay with a stage label that indicates replay playback is still underway

#### Scenario: Exact reducer progress is available
- **WHEN** the timeline-analysis stage emits percentage progress lines
- **THEN** the current replay progress bar advances from parsed progress rather than only waiting for replay completion

#### Scenario: Ingest reports processed replay counts
- **WHEN** corpus ingestion emits processed and discovered replay counts
- **THEN** the analysis screen shows an exact ingest progress percentage for the library update stage

#### Scenario: Only heartbeat progress is available
- **WHEN** replay export emits elapsed-time heartbeat output without an exact percentage
- **THEN** the analysis screen shows a clearly labeled estimated progress bar rather than appearing stalled

#### Scenario: User opens troubleshooting details
- **WHEN** a user expands the details section during or after a run
- **THEN** the raw process logs remain available without replacing the structured progress view
