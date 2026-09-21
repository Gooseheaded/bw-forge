import type { SourceSpan } from "./ast.js";

export type RuleDiagnosticCode =
  | "UNEXPECTED_CHARACTER"
  | "UNTERMINATED_STRING"
  | "EXPECTED_RULE"
  | "EXPECTED_RULE_NAME"
  | "EXPECTED_OPEN_BRACE"
  | "EXPECTED_EVENT_KEY"
  | "EXPECTED_OPEN_BRACKET"
  | "EXPECTED_OCCURRENCE"
  | "EXPECTED_CLOSE_BRACKET"
  | "EXPECTED_OPERATOR"
  | "EXPECTED_TARGET"
  | "EXPECTED_TWO_DIGIT_SECONDS"
  | "EXPECTED_SUPPLY_KEYWORD"
  | "EXPECTED_CLOSE_BRACE"
  | "UNSUPPORTED_PREDICATE"
  | "UNKNOWN_EVENT_KEY"
  | "INVALID_OCCURRENCE"
  | "INVALID_TIME"
  | "INVALID_SUPPLY"
  | "DUPLICATE_RULE_NAME";

export interface RuleDiagnostic {
  severity: "error";
  phase: "syntax" | "semantic";
  code: RuleDiagnosticCode;
  message: string;
  sourceName?: string;
  span: SourceSpan;
  suggestion?: string;
}

export function formatRuleDiagnostic(diagnostic: RuleDiagnostic, source: string): string {
  const sourceName = diagnostic.sourceName ?? "<rules>";
  const { line, column } = diagnostic.span.start;
  const lines = source.split(/\r?\n/u);
  const sourceLine = lines[line - 1] ?? "";
  const width = Math.max(
    1,
    diagnostic.span.end.line === line
      ? diagnostic.span.end.column - column
      : sourceLine.length - column + 2
  );
  const pointer = `${" ".repeat(Math.max(0, column - 1))}${"^".repeat(width)}`;
  return [
    `${sourceName}:${line}:${column}: error ${diagnostic.code}:`,
    diagnostic.message,
    "",
    `    ${sourceLine}`,
    `    ${pointer}`,
    ...(diagnostic.suggestion ? ["", `Did you mean '${diagnostic.suggestion}'?`] : [])
  ].join("\n");
}

export function formatRuleDiagnostics(diagnostics: readonly RuleDiagnostic[], source: string): string {
  return diagnostics.map((diagnostic) => formatRuleDiagnostic(diagnostic, source)).join("\n\n");
}

