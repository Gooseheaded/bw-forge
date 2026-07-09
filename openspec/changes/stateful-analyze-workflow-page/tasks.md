## 1. OpenSpec and workflow-state foundation

- [x] 1.1 Add the OpenSpec proposal, design, spec delta, and task list for the stateful Analyze workflow page
- [x] 1.2 Add renderer helpers for deriving Analyze workflow state and Analyze sidebar status from the existing queue and analysis model

## 2. Stateful Analyze page views

- [ ] 2.1 Replace the current multi-card Analyze layout with state-owned empty, queue-review, running, and complete views
- [ ] 2.2 Add completion actions for view library, analyze more, retry failed, and analyze remaining when applicable

## 3. Verification

- [ ] 3.1 Add or update renderer-focused tests for workflow derivation, completion behavior, and Analyze nav status
- [ ] 3.2 Run desktop tests and typecheck, then update task checkboxes to reflect the completed implementation
