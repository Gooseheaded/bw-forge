## 1. Structured progress model

- [x] 1.1 Add shared desktop progress types for stage, mode, primary progress, queue progress, and per-replay progress snapshots
- [x] 1.2 Add a main-process progress parser/helper for replay-export, timeline-analysis, and ingest log lines

## 2. Analysis state orchestration

- [x] 2.1 Update the analysis manager to track current replay progress, queue progress, and ingest progress from parsed child-process output
- [x] 2.2 Add or update tests for progress parsing and analysis-manager state transitions, including estimated replay-export fallback

## 3. Analysis screen refresh

- [ ] 3.1 Replace the current count-only analysis bar with primary per-replay progress and secondary queue progress UI
- [ ] 3.2 Collapse raw analysis logs behind a details section and add renderer coverage for the new progress presentation

## 4. Finish and verify

- [ ] 4.1 Run the desktop test suite and any targeted build/type checks needed for the progress changes
- [ ] 4.2 Update task checkboxes and change artifacts to reflect completed implementation state
