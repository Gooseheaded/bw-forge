import { replayEventCatalog, type ReplayEventCatalogEntry } from "../domain/eventCatalog.js";
import type { EventKey, EventRef, ParsedEventRef, ParsedRuleDocument, Predicate, RuleDocument } from "./ast.js";
import type { RuleDiagnostic } from "./diagnostics.js";
import { parseBuildRules } from "./parser.js";

export interface ValidateBuildRulesResult {
  valid: boolean;
  ruleCount?: number;
  document?: RuleDocument;
  diagnostics: RuleDiagnostic[];
}

const catalogByKey = new Map(replayEventCatalog.map((entry) => [entry.key, entry] as const));

export function validateParsedBuildRules(document: ParsedRuleDocument): ValidateBuildRulesResult {
  const diagnostics: RuleDiagnostic[] = [];
  const sourceName = document.sourceName;
  const names = new Map<string, { span: ParsedRuleDocument["rules"][number]["nameSpan"] }>();

  for (const rule of document.rules) {
    if (names.has(rule.name)) {
      diagnostics.push(error("DUPLICATE_RULE_NAME", `duplicate rule name ${JSON.stringify(rule.name)}`, rule.nameSpan, sourceName));
    } else {
      names.set(rule.name, { span: rule.nameSpan });
    }
    for (const predicate of rule.predicates) {
      validateEventRef(predicate.event, diagnostics, sourceName);
      if (predicate.kind === "order") validateEventRef(predicate.right, diagnostics, sourceName);
      if (predicate.kind === "time") {
        const seconds = Number(predicate.targetText.slice(predicate.targetText.indexOf(":") + 1));
        if (seconds > 59) {
          diagnostics.push(error("INVALID_TIME", "seconds must be between 00 and 59", predicate.targetSpan, sourceName));
        } else if (!Number.isSafeInteger(predicate.targetSeconds)) {
          diagnostics.push(error("INVALID_TIME", "time must fit in a safe integer number of seconds", predicate.targetSpan, sourceName));
        }
      }
      if (predicate.kind === "supply" && predicate.targetSupply > 200) {
        diagnostics.push(error("INVALID_SUPPLY", "supply must be between 0 and 200", predicate.targetSpan, sourceName));
      }
    }
  }

  diagnostics.sort((left, right) => left.span.start.offset - right.span.start.offset || compareAscii(left.code, right.code));
  if (diagnostics.length > 0) return { valid: false, ruleCount: document.rules.length, diagnostics };
  return {
    valid: true,
    ruleCount: document.rules.length,
    document: {
      rules: document.rules.map((rule) => ({
        ...rule,
        predicates: rule.predicates.map(toValidatedPredicate)
      })),
      ...(sourceName ? { sourceName } : {})
    },
    diagnostics
  };
}

export function validateBuildRules(source: string, sourceName?: string): ValidateBuildRulesResult {
  const parsed = parseBuildRules(source, sourceName);
  if (parsed.diagnostics.length > 0) {
    return { valid: false, ruleCount: parsed.document.rules.length, diagnostics: parsed.diagnostics };
  }
  return validateParsedBuildRules(parsed.document);
}

function validateEventRef(ref: ParsedEventRef, diagnostics: RuleDiagnostic[], sourceName?: string): void {
  if (!Number.isSafeInteger(ref.occurrence) || ref.occurrence < 1) {
    diagnostics.push(error("INVALID_OCCURRENCE", "event occurrence must be at least 1", ref.occurrenceSpan, sourceName));
  }
  if (!catalogByKey.has(ref.key)) {
    const suggestion = closestEventKey(ref.key);
    diagnostics.push({
      ...error("UNKNOWN_EVENT_KEY", `unknown event key '${ref.key}'`, ref.keySpan, sourceName),
      ...(suggestion ? { suggestion } : {})
    });
  }
}

function toValidatedEventRef(ref: ParsedEventRef): EventRef {
  return { ...ref, key: ref.key as EventKey, event: catalogByKey.get(ref.key)! };
}

function toValidatedPredicate(predicate: Predicate<ParsedEventRef>): Predicate<EventRef> {
  if (predicate.kind === "order") {
    return { ...predicate, event: toValidatedEventRef(predicate.event), right: toValidatedEventRef(predicate.right) };
  }
  return { ...predicate, event: toValidatedEventRef(predicate.event) };
}

function closestEventKey(input: string): string | undefined {
  let best: { key: string; distance: number } | undefined;
  for (const entry of replayEventCatalog) {
    const distance = levenshtein(input, entry.key);
    if (!best || distance < best.distance || (distance === best.distance && compareAscii(entry.key, best.key) < 0)) {
      best = { key: entry.key, distance };
    }
  }
  const threshold = Math.max(2, Math.floor(input.length / 3));
  return best && best.distance <= threshold ? best.key : undefined;
}

function levenshtein(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1]! + 1,
        previous[rightIndex]! + 1,
        previous[rightIndex - 1]! + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1)
      );
    }
    previous = current;
  }
  return previous[right.length]!;
}

function error(
  code: RuleDiagnostic["code"],
  message: string,
  span: RuleDiagnostic["span"],
  sourceName?: string
): RuleDiagnostic {
  return { severity: "error", phase: "semantic", code, message, span, ...(sourceName ? { sourceName } : {}) };
}

function compareAscii(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
