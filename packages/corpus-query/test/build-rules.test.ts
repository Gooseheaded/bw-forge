import test from "node:test";
import assert from "node:assert/strict";
import { formatRuleDiagnostic, parseBuildRules, validateBuildRules } from "../src/rules/index.js";

function valid(source: string) {
  const result = validateBuildRules(source, "test.bwbuild");
  assert.equal(result.valid, true, JSON.stringify(result.diagnostics));
  assert.ok(result.document);
  return result.document;
}

function invalid(source: string, code: string) {
  const result = validateBuildRules(source, "test.bwbuild");
  assert.equal(result.valid, false);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === code), JSON.stringify(result.diagnostics));
  return result;
}

test("parses an empty document", () => assert.equal(valid("").rules.length, 0));
test("parses one rule", () => assert.equal(valid('rule "One" { hatchery[1] around 2:30 }').rules.length, 1));
test("parses multiple rules", () => assert.equal(valid('rule "One" {} rule "Two" {}').rules.length, 2));
test("ignores whole-line and inline comments", () => {
  const document = valid('# heading\nrule "One" {\n hatchery[1] around 2:30 # note\n}\n');
  assert.equal(document.rules[0]?.predicates.length, 1);
});
test("accepts arbitrary quoted rule names", () => assert.equal(valid('rule "2 Hatch Lurker (fast gas)" {}').rules[0]?.name, "2 Hatch Lurker (fast gas)"));

for (const operator of ["around", "before", "after"] as const) {
  test(`parses time operator ${operator}`, () => {
    const predicate = valid(`rule "T" { hatchery[1] ${operator} 2:30 }`).rules[0]?.predicates[0];
    assert.deepEqual([predicate?.kind, predicate?.operator, predicate?.calibration], ["time", operator, "required"]);
  });
}

for (const operator of ["around", "before", "after", "at"] as const) {
  test(`parses supply operator ${operator}`, () => {
    const predicate = valid(`rule "S" { hatchery[1] ${operator} 12 supply }`).rules[0]?.predicates[0];
    assert.equal(predicate?.kind, "supply");
    assert.equal(predicate?.operator, operator);
    assert.equal(predicate?.calibration, operator === "at" ? "none" : "required");
  });
}

test("parses event-before-event as a crisp order predicate", () => {
  const predicate = valid('rule "O" { metabolic_boost[1] before lair[1] }').rules[0]?.predicates[0];
  assert.equal(predicate?.kind, "order");
  assert.equal(predicate?.calibration, "none");
  assert.equal(predicate?.kind === "order" ? predicate.right.key : undefined, "lair");
});
test("accepts whitespace variations", () => assert.equal(valid(' rule\t"W"\n{ hatchery [ 2 ] around 2 : 30 } ').rules.length, 1));
test("accepts canonical unit and building keys", () => {
  const document = valid('rule "C" { marine[1] before hatchery[1] }');
  assert.equal(document.rules[0]?.predicates[0]?.event.event.kind, "unit");
});
test("accepts a canonical upgrade key", () => assert.equal(valid('rule "U" { metabolic_boost[1] before 3:00 }').rules[0]?.predicates[0]?.event.event.kind, "upgrade"));
test("accepts a canonical tech key", () => assert.equal(valid('rule "T" { siege_mode[1] before 4:00 }').rules[0]?.predicates[0]?.event.event.kind, "tech"));
test("accepts occurrence one", () => assert.equal(valid('rule "N" { hatchery[1] before 2:00 }').rules[0]?.predicates[0]?.event.occurrence, 1));
test("accepts occurrences greater than one", () => assert.equal(valid('rule "N" { hatchery[12] before 9:00 }').rules[0]?.predicates[0]?.event.occurrence, 12));
test("rejects occurrence zero", () => invalid('rule "N" { hatchery[0] before 2:00 }', "INVALID_OCCURRENCE"));
test("normalizes valid m:ss to seconds", () => {
  const predicate = valid('rule "T" { hatchery[1] around 14:19 }').rules[0]?.predicates[0];
  assert.equal(predicate?.kind === "time" ? predicate.targetSeconds : undefined, 859);
});
test("rejects time seconds at least 60", () => invalid('rule "T" { hatchery[1] around 2:60 }', "INVALID_TIME"));
test("rejects malformed time", () => invalid('rule "T" { hatchery[1] around 2:3 }', "EXPECTED_TWO_DIGIT_SECONDS"));
test("rejects a decimal in place of m:ss", () => invalid('rule "T" { hatchery[1] around 2.5 }', "UNEXPECTED_CHARACTER"));
test("accepts supply zero", () => assert.equal(valid('rule "S" { hatchery[1] at 0 supply }').rules[0]?.predicates[0]?.kind, "supply"));
test("accepts supply 200", () => assert.equal(valid('rule "S" { hatchery[1] at 200 supply }').rules[0]?.predicates[0]?.kind, "supply"));
test("rejects supply above 200", () => invalid('rule "S" { hatchery[1] at 201 supply }', "INVALID_SUPPLY"));
test("rejects unknown event keys", () => invalid('rule "E" { hatcheryy[1] before 2:00 }', "UNKNOWN_EVENT_KEY"));
test("suggests a deterministic canonical key for a typo", () => {
  const result = invalid('rule "E" { metabolic_boosts[1] before 2:00 }', "UNKNOWN_EVENT_KEY");
  assert.equal(result.diagnostics[0]?.suggestion, "metabolic_boost");
});
test("rejects duplicate rule names", () => invalid('rule "Same" {} rule "Same" {}', "DUPLICATE_RULE_NAME"));
test("validated AST contains canonical event key and metadata", () => {
  const ref = valid('rule "E" { hatchery[1] before 2:00 }').rules[0]?.predicates[0]?.event;
  assert.deepEqual([ref?.key, ref?.event.displayName, ref?.event.kind], ["hatchery", "Hatchery", "building"]);
});
test("before time disambiguates to a time predicate", () => assert.equal(valid('rule "D" { spire[1] before 5:30 }').rules[0]?.predicates[0]?.kind, "time"));
test("before supply disambiguates to a supply predicate", () => assert.equal(valid('rule "D" { spire[1] before 13 supply }').rules[0]?.predicates[0]?.kind, "supply"));
test("before event disambiguates to an order predicate", () => assert.equal(valid('rule "D" { spire[1] before lair[1] }').rules[0]?.predicates[0]?.kind, "order"));
test("diagnostics preserve source name, line, column, and exact span", () => {
  const result = invalid('# comment\nrule "E" {\n  hatcheryy[1] before 2:00\n}', "UNKNOWN_EVENT_KEY");
  const diagnostic = result.diagnostics[0]!;
  assert.deepEqual([diagnostic.sourceName, diagnostic.span.start.line, diagnostic.span.start.column], ["test.bwbuild", 3, 3]);
  assert.equal(diagnostic.span.end.offset - diagnostic.span.start.offset, "hatcheryy".length);
  assert.match(formatRuleDiagnostic(diagnostic, '# comment\nrule "E" {\n  hatcheryy[1] before 2:00\n}'), /\^\^\^\^\^\^\^\^\^/u);
});
test("diagnostics expose stable syntax error codes", () => {
  const result = parseBuildRules('rule "E" { hatchery[1] around potato }');
  assert.equal(result.diagnostics[0]?.code, "EXPECTED_TARGET");
  assert.equal(result.diagnostics[0]?.phase, "syntax");
});
test("semantic validation collects multiple independent errors", () => {
  const result = validateBuildRules('rule "E" { hatcheryy[0] before 2:75 spiree[1] at 201 supply }');
  assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code), [
    "UNKNOWN_EVENT_KEY", "INVALID_OCCURRENCE", "INVALID_TIME", "UNKNOWN_EVENT_KEY", "INVALID_SUPPLY"
  ]);
});
test("display names are not accepted as event references", () => invalid('rule "E" { Metabolic Boost[1] before 2:00 }', "EXPECTED_OPEN_BRACKET"));
test("unsupported event-after-event is rejected", () => invalid('rule "E" { hatchery[1] after lair[1] }', "EXPECTED_TARGET"));
