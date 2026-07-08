import test from "node:test";
import assert from "node:assert/strict";
import { buildReadonlySqlExecutionPlan, getReadonlySqlDefaults, validateReadonlySql } from "../src/sql/readonlySql.js";

test("validateReadonlySql accepts safe SELECT", () => {
  const result = validateReadonlySql("SELECT name, race FROM players LIMIT 50;");
  assert.equal(result.allowed, true);
  assert.equal(result.statementKind, "select");
  assert.equal(result.normalizedSql, "SELECT name, race FROM players LIMIT 50");
  assert.deepEqual(result.blockedReasons, []);
});

test("validateReadonlySql accepts WITH SELECT", () => {
  const result = validateReadonlySql(`
    WITH spires AS (
      SELECT replay_id, owner, time_seconds
      FROM build_order_events
      WHERE item = 'Spire'
    )
    SELECT * FROM spires LIMIT 10;
  `);
  assert.equal(result.allowed, true);
  assert.equal(result.statementKind, "with");
});

test("validateReadonlySql rejects unsafe keywords and multiple statements", () => {
  for (const sql of [
    "DROP TABLE players;",
    "DELETE FROM players;",
    "UPDATE players SET name = 'x';",
    "INSERT INTO players VALUES ('a');",
    "CREATE TABLE x(a);",
    "ATTACH DATABASE 'other.sqlite' AS other;",
    "PRAGMA writable_schema = 1;",
    "VACUUM;",
    "SELECT 1; SELECT 2;"
  ]) {
    const result = validateReadonlySql(sql);
    assert.equal(result.allowed, false, sql);
    assert.ok(result.blockedReasons.length > 0, sql);
  }
});

test("validateReadonlySql rejects recursive CTEs", () => {
  const result = validateReadonlySql(`
    WITH RECURSIVE cnt(x) AS (
      SELECT 1
      UNION ALL
      SELECT x + 1 FROM cnt
    )
    SELECT * FROM cnt;
  `);
  assert.equal(result.allowed, false);
  assert.match(result.blockedReasons.join(" "), /RECURSIVE/i);
});

test("validateReadonlySql clamps maxRows and warns when limit is absent", () => {
  const defaults = getReadonlySqlDefaults();
  const result = validateReadonlySql("SELECT name FROM players", 9999);
  assert.equal(result.allowed, true);
  assert.equal(result.effectiveMaxRows, defaults.hardMaxRows);
  assert.ok(result.warnings.some((warning) => warning.includes("No LIMIT detected")));
});

test("buildReadonlySqlExecutionPlan returns normalized query for safe SQL", () => {
  const plan = buildReadonlySqlExecutionPlan("SELECT 1;", 25);
  assert.equal(plan.normalizedSql, "SELECT 1");
  assert.equal(plan.effectiveMaxRows, 25);
});
