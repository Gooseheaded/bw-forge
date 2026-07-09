## MODIFIED Requirements

### Requirement: Replay library
The system SHALL signal newly added replay entries in the Library navigation item until the user opens the Library page.

#### Scenario: New entries arrive while viewing another page
- **WHEN** the loaded library gains one or more entries and the current page is not Library
- **THEN** the Library navigation item shows a temporary visual highlight indicating new items are available

#### Scenario: User opens the Library page
- **WHEN** the user navigates to the Library page while the Library navigation item is highlighted
- **THEN** the highlight is dismissed immediately
