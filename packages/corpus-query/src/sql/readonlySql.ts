const DEFAULT_MAX_ROWS = 100;
const HARD_MAX_ROWS = 500;

const BLOCKED_KEYWORDS = [
  "INSERT",
  "UPDATE",
  "DELETE",
  "CREATE",
  "DROP",
  "ALTER",
  "REPLACE",
  "TRUNCATE",
  "VACUUM",
  "ATTACH",
  "DETACH",
  "PRAGMA",
  "REINDEX",
  "ANALYZE",
  "LOAD_EXTENSION"
] as const;

export type ReadonlySqlStatementKind = "select" | "with" | "unknown";

export type ReadonlySqlValidationResult = {
  allowed: boolean;
  statementKind: ReadonlySqlStatementKind;
  normalizedSql: string | null;
  effectiveMaxRows: number;
  warnings: string[];
  blockedReasons: string[];
};

export type ReadonlySqlExecutionPlan = {
  normalizedSql: string;
  effectiveMaxRows: number;
  warnings: string[];
};

export function validateReadonlySql(sql: string, requestedMaxRows?: number): ReadonlySqlValidationResult {
  const blockedReasons: string[] = [];
  const warnings: string[] = [];
  const effectiveMaxRows = clampMaxRows(requestedMaxRows);
  const trimmed = sql.trim();

  if (!trimmed) {
    return {
      allowed: false,
      statementKind: "unknown",
      normalizedSql: null,
      effectiveMaxRows,
      warnings,
      blockedReasons: ["SQL query is empty."]
    };
  }

  const masked = maskSqlLiteralsAndComments(trimmed);
  const statementCount = countStatements(masked);
  if (statementCount !== 1) {
    blockedReasons.push("Multiple SQL statements are not allowed.");
  }

  const normalizedSql = stripSingleTrailingSemicolon(trimmed, masked);
  const normalizedMasked = maskSqlLiteralsAndComments(normalizedSql);
  const statementKind = detectStatementKind(normalizedMasked);

  if (statementKind === "unknown") {
    blockedReasons.push("Only SELECT or WITH ... SELECT statements are allowed.");
  }

  if (/^\s*WITH\s+RECURSIVE\b/i.test(normalizedMasked)) {
    blockedReasons.push("WITH RECURSIVE queries are not allowed.");
  }

  const matchedBlockedKeywords = findBlockedKeywords(normalizedMasked);
  for (const keyword of matchedBlockedKeywords) {
    blockedReasons.push(`Blocked SQL keyword detected: ${keyword}.`);
  }

  if (!/\bLIMIT\b/i.test(normalizedMasked)) {
    warnings.push(`No LIMIT detected; server will enforce maxRows=${effectiveMaxRows}.`);
  }

  if (requestedMaxRows !== undefined && requestedMaxRows > HARD_MAX_ROWS) {
    warnings.push(`Requested maxRows ${requestedMaxRows} exceeds the hard cap; using ${effectiveMaxRows}.`);
  }

  return {
    allowed: blockedReasons.length === 0,
    statementKind,
    normalizedSql: blockedReasons.length === 0 ? normalizedSql : null,
    effectiveMaxRows,
    warnings,
    blockedReasons
  };
}

export function buildReadonlySqlExecutionPlan(sql: string, requestedMaxRows?: number): ReadonlySqlExecutionPlan {
  const validation = validateReadonlySql(sql, requestedMaxRows);
  if (!validation.allowed || !validation.normalizedSql) {
    throw new Error(validation.blockedReasons.join(" "));
  }

  return {
    normalizedSql: validation.normalizedSql,
    effectiveMaxRows: validation.effectiveMaxRows,
    warnings: validation.warnings
  };
}

export function clampMaxRows(value?: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_MAX_ROWS;
  }

  return Math.min(Math.trunc(value), HARD_MAX_ROWS);
}

export function getReadonlySqlDefaults(): { defaultMaxRows: number; hardMaxRows: number } {
  return {
    defaultMaxRows: DEFAULT_MAX_ROWS,
    hardMaxRows: HARD_MAX_ROWS
  };
}

function detectStatementKind(maskedSql: string): ReadonlySqlStatementKind {
  if (/^\s*SELECT\b/i.test(maskedSql)) {
    return "select";
  }
  if (/^\s*WITH\b/i.test(maskedSql)) {
    return "with";
  }
  return "unknown";
}

function findBlockedKeywords(maskedSql: string): string[] {
  const upperSql = maskedSql.toUpperCase();
  const matches = new Set<string>();

  for (const keyword of BLOCKED_KEYWORDS) {
    const pattern = new RegExp(`\\b${keyword}\\b`, "i");
    if (pattern.test(upperSql)) {
      matches.add(keyword);
    }
  }

  return [...matches];
}

function stripSingleTrailingSemicolon(sql: string, maskedSql: string): string {
  let index = sql.length - 1;
  while (index >= 0 && /\s/.test(sql[index] ?? "")) {
    index -= 1;
  }

  if (index >= 0 && sql[index] === ";") {
    const before = maskedSql.slice(0, index);
    if (!before.includes(";")) {
      return sql.slice(0, index).trimEnd();
    }
  }

  return sql;
}

function countStatements(maskedSql: string): number {
  const parts = maskedSql
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  return parts.length;
}

function maskSqlLiteralsAndComments(sql: string): string {
  let result = "";
  let index = 0;

  while (index < sql.length) {
    const current = sql[index] ?? "";
    const next = sql[index + 1] ?? "";

    if (current === "-" && next === "-") {
      result += "  ";
      index += 2;
      while (index < sql.length) {
        const char = sql[index] ?? "";
        result += char === "\n" ? "\n" : " ";
        index += 1;
        if (char === "\n") {
          break;
        }
      }
      continue;
    }

    if (current === "/" && next === "*") {
      result += "  ";
      index += 2;
      while (index < sql.length) {
        const char = sql[index] ?? "";
        const lookahead = sql[index + 1] ?? "";
        if (char === "*" && lookahead === "/") {
          result += "  ";
          index += 2;
          break;
        }
        result += char === "\n" ? "\n" : " ";
        index += 1;
      }
      continue;
    }

    if (current === "'" || current === "\"" || current === "`") {
      const quote = current;
      result += " ";
      index += 1;
      while (index < sql.length) {
        const char = sql[index] ?? "";
        const lookahead = sql[index + 1] ?? "";
        if (char === quote) {
          result += " ";
          if (lookahead === quote && quote !== "`") {
            result += " ";
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        result += char === "\n" ? "\n" : " ";
        index += 1;
      }
      continue;
    }

    if (current === "[") {
      result += " ";
      index += 1;
      while (index < sql.length) {
        const char = sql[index] ?? "";
        result += char === "]" ? " " : char === "\n" ? "\n" : " ";
        index += 1;
        if (char === "]") {
          break;
        }
      }
      continue;
    }

    result += current;
    index += 1;
  }

  return result;
}
