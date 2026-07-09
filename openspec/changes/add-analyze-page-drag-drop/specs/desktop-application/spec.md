## MODIFIED Requirements

### Requirement: Replay input selection
The system SHALL let users select one or more `.rep` files or directories and SHALL recursively discover, canonicalize, de-duplicate, and display the replay files that will be analyzed, including when those files or directories are dropped onto the Analyze page.

#### Scenario: Directory import
- **WHEN** a user selects a directory containing replay files in nested folders
- **THEN** every nested `.rep` file appears once in the pending import list

#### Scenario: Invalid selection
- **WHEN** a selected path is missing, unreadable, or contains no replay files
- **THEN** the application preserves valid selections and displays a clear warning for the invalid selection

#### Scenario: Drag and drop replays
- **WHEN** a user drops replay files or folders onto the Analyze page
- **THEN** the application discovers valid replay files from those dropped filesystem paths and adds them to the pending import list using the same deduplication and warning rules as picker-based selection
