## MODIFIED Requirements

### Requirement: Replay library
The system SHALL signal newly added replay entries in the Library navigation item until the user opens the Library page, based on whether newly loaded replay IDs were not present in the prior loaded library.

#### Scenario: New replay IDs arrive while viewing another page
- **WHEN** the loaded library contains one or more replay IDs that were not present in the previously loaded library and the current page is not Library
- **THEN** the Library navigation item shows a temporary and visually obvious highlight indicating new items are available

#### Scenario: User opens the Library page
- **WHEN** the user navigates to the Library page while the Library navigation item is highlighted
- **THEN** the highlight is dismissed immediately
