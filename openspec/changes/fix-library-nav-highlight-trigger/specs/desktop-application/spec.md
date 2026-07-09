## MODIFIED Requirements

### Requirement: Replay library
The system SHALL signal that the Library has been refreshed by a completed analysis run in the Library navigation item until the user opens the Library page.

#### Scenario: Analysis completes while viewing another page
- **WHEN** a completed analysis run triggers a successful library refresh and the current page is not Library
- **THEN** the Library navigation item shows a temporary and visually obvious highlight indicating new items are available

#### Scenario: User opens the Library page
- **WHEN** the user navigates to the Library page while the Library navigation item is highlighted
- **THEN** the highlight is dismissed immediately
