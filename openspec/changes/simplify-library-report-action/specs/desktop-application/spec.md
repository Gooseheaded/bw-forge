## MODIFIED Requirements

### Requirement: Safe report opening
The system SHALL let users open a manifest-declared standalone replay report from the Library in the system browser.

#### Scenario: Open available report
- **WHEN** the user chooses the report action for an available report in the Library
- **THEN** the application validates the report path under the configured output root and opens it in the system browser

#### Scenario: Reject untrusted report path
- **WHEN** the renderer requests a path that is not declared by the selected replay manifest or escapes the output root
- **THEN** the main process rejects the request and does not open the file
