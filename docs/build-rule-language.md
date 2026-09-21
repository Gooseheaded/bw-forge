# BW Build Rule Language v0

## Goals and non-goals

BW Build Rules are a small, human-authored language for describing expert reference points in a Brood War build. Version 0 defines syntax, a typed representation, and deterministic validation. It does not evaluate a replay or assign a score.

In particular, v0 does not define fuzzy scoring, timing or supply distributions, tolerances, archetypes, logical composition, weights, optional predicates, matchup/map/player scopes, inheritance, includes, variables, macros, or replay queries. It requires no schema migration or replay reanalysis. A future milestone will calibrate eligible predicates against replay corpora.

## Document grammar

The normative grammar is:

```text
document
  := rule*

rule
  := "rule" STRING "{" statement* "}"

statement
  := event_ref "around" time
   | event_ref "before" time
   | event_ref "after" time
   | event_ref "around" integer "supply"
   | event_ref "before" integer "supply"
   | event_ref "after" integer "supply"
   | event_ref "at" integer "supply"
   | event_ref "before" event_ref

event_ref
  := IDENT "[" positive_integer "]"

time
  := MINUTES ":" TWO_DIGIT_SECONDS
```

Whitespace and blank lines are insignificant outside quoted rule names. A `#` begins a comment that runs to the end of the line. Block comments are not supported. A rule name is a double-quoted, single-line human-readable string and may contain spaces and punctuation other than a double quote. Escape syntax is not part of v0. Rule names must be unique within a document.

An empty document is valid. Statements do not use terminators: the complete right-hand side determines where one statement ends.

## Canonical event references

An event reference has the form `event_key[occurrence]`, such as:

```text
hatchery[2]
marine[1]
metabolic_boost[1]
siege_mode[1]
```

The key must exist in the authoritative M11A.1 canonical event catalog. The same namespace covers units, buildings, upgrades, and tech. Keys are lowercase snake case, spaces become underscores, and apostrophes are omitted. Display names such as `Metabolic Boost` and `Command Center` are not accepted, and this specification does not define legacy-label aliases.

The occurrence is a positive decimal integer starting at 1. `[n]` always means the nth observed occurrence of that canonical event. For an upgrade, `[2]` means the second observed research start; it does not assert that the event represents upgrade level 2.

The validated AST contains the canonical key and its resolved catalog metadata. The catalog remains the sole vocabulary authority; the rule implementation does not copy its entries.

## Literals

Time uses `m:ss`. Minutes contain one or more decimal digits; seconds contain exactly two digits in the range `00` through `59`. The AST normalizes the literal to integer seconds while retaining its text and source span. `0:05`, `2:30`, and `14:19` are valid. `2:3`, `2:60`, `-1:30`, and `2.5` are invalid.

Supply is a non-negative decimal integer followed by the keyword `supply`. The accepted Brood War UI range is 0 through 200 inclusive. Fractional supply is not supported.

## Predicates

### Event versus time

```text
hatchery[2] around 2:30
spire[1] before 5:30
nexus[2] after 3:00
```

All three are calibratable predicates. Their time is an expert-authored canonical/reference value. `around`, `before`, and `after` do not yet define a tolerance, scoring curve, or pass/fail rule. The AST marks these predicates with `calibration: "required"`.

### Event versus supply

```text
hatchery[2] around 12 supply
refinery[1] before 13 supply
factory[1] after 20 supply
extractor[1] at 13 supply
```

The `around`, `before`, and `after` forms are calibratable reference predicates and do not yet define scoring curves. The `at` form is crisp: future evaluation will score exactly matching supply as 1 and every other supply as 0. The AST therefore marks the first three forms with `calibration: "required"` and `at` with `calibration: "none"`.

### Event ordering

```text
metabolic_boost[1] before lair[1]
hydralisk_den[1] before spire[1]
siege_mode[1] before factory[2]
```

Event ordering is crisp and maps to the M11A `before()` fact in a future evaluator. Only `before` is supported between events in v0. The parser distinguishes `before 5:30`, `before 13 supply`, and `before lair[1]` from the syntax of the right-hand side.

## Typed representation

The public model consists of `EventRef`, `TimePredicate`, `SupplyPredicate`, `OrderPredicate`, `Predicate`, `RuleDefinition`, and `RuleDocument`. Each node carries source spans. `EventRef` contains a canonical `EventKey`, occurrence, and immutable catalog entry. Predicate `kind`, `operator`, target fields, and `calibration` are discriminants, so clients do not infer semantics from source text.

The model is independent of SQLite, MCP payloads, replay fact results, and any future evaluator.

## Parsing and semantic validation

Parsing determines whether the token sequence conforms to the grammar. Semantic validation runs after successful parsing and checks:

- every event key resolves through the canonical event catalog;
- every occurrence is at least 1;
- time seconds are in `00..59`;
- supply is in `0..200`;
- rule names are unique within the document.

For example, `hatchery[2] around potato` is a syntax error, while `hatcheryy[2] around 2:30` is a semantic `UNKNOWN_EVENT_KEY` error. Unknown keys never become runtime “event missing” results.

Library callers use `parseBuildRules(source, sourceName?)` for syntax parsing, `validateParsedBuildRules(document)` for semantic validation of a parsed tree, or `validateBuildRules(source, sourceName?)` for the combined operation.

## Diagnostics

Diagnostics are deterministic structured values with severity, syntax/semantic phase, stable code, message, source name when supplied, and an offset/line/column span. Unknown-key diagnostics include a deterministic nearest-key suggestion when the typo is sufficiently close. The validator collects independent semantic errors rather than stopping after the first one.

Current codes are:

```text
UNEXPECTED_CHARACTER     UNTERMINATED_STRING
EXPECTED_RULE            EXPECTED_RULE_NAME
EXPECTED_OPEN_BRACE      EXPECTED_CLOSE_BRACE
EXPECTED_EVENT_KEY       EXPECTED_OPEN_BRACKET
EXPECTED_OCCURRENCE      EXPECTED_CLOSE_BRACKET
EXPECTED_OPERATOR        EXPECTED_TARGET
EXPECTED_TWO_DIGIT_SECONDS
EXPECTED_SUPPLY_KEYWORD  UNSUPPORTED_PREDICATE
UNKNOWN_EVENT_KEY        INVALID_OCCURRENCE
INVALID_TIME             INVALID_SUPPLY
DUPLICATE_RULE_NAME
```

The human formatter renders compiler-style context:

```text
rules/zvt.bwbuild:3:5: error UNKNOWN_EVENT_KEY:
unknown event key 'metabolic_boosts'

    metabolic_boosts[1] before lair[1]
    ^^^^^^^^^^^^^^^^^^

Did you mean 'metabolic_boost'?
```

## CLI and MCP validation

Validate a file without evaluating it:

```console
$ bw-forge rules test ./rules/zvt.bwbuild
bw-forge: rule file ./rules/zvt.bwbuild syntax is ok
bw-forge: rule file ./rules/zvt.bwbuild validation is successful
bw-forge: 4 rules validated
```

The command exits 0 for a valid document and nonzero after printing diagnostics for invalid input.

The MCP tool `validate_build_rules` accepts `{ "source": string, "source_name"?: string }`. It returns structured content shaped as `{ "valid": boolean, "rule_count"?: number, "diagnostics": RuleDiagnostic[] }`. It is a read-only wrapper over the same library validator and performs no corpus query or scoring.

## Complete example

```text
# Zerg opening landmarks.
rule "3 Hatch Example" {
    hatchery[2] around 2:30
    spire[1] before 5:30
    hatchery[2] around 12 supply
    extractor[1] at 13 supply
    metabolic_boost[1] before lair[1]
}
```

## Explicitly unsupported syntax

Event-to-event `after`, simultaneity, `within`, boolean operators, grouping, weights, optional predicates, custom tolerances, variables, macros, includes, inheritance, and scopes are invalid in v0. Implementations must not interpret them as aliases or extensions.
