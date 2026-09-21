import type { ReplayEventCatalogEntry } from "../domain/eventCatalog.js";

export interface SourcePosition {
  offset: number;
  line: number;
  column: number;
}

export interface SourceSpan {
  start: SourcePosition;
  end: SourcePosition;
}

export type EventKey = string & { readonly __eventKey: unique symbol };

export interface ParsedEventRef {
  key: string;
  occurrence: number;
  span: SourceSpan;
  keySpan: SourceSpan;
  occurrenceSpan: SourceSpan;
}

export interface EventRef extends Omit<ParsedEventRef, "key"> {
  key: EventKey;
  /** The immutable canonical catalog entry resolved during validation. */
  event: ReplayEventCatalogEntry;
}

interface PredicateBase<E> {
  event: E;
  span: SourceSpan;
}

export interface TimePredicate<E = EventRef> extends PredicateBase<E> {
  kind: "time";
  operator: "around" | "before" | "after";
  targetSeconds: number;
  targetText: string;
  targetSpan: SourceSpan;
  calibration: "required";
}

export type SupplyPredicate<E = EventRef> = PredicateBase<E> & (
  | {
      kind: "supply";
      operator: "around" | "before" | "after";
      targetSupply: number;
      targetSpan: SourceSpan;
      calibration: "required";
    }
  | {
      kind: "supply";
      operator: "at";
      targetSupply: number;
      targetSpan: SourceSpan;
      calibration: "none";
    }
);

export interface OrderPredicate<E = EventRef> extends PredicateBase<E> {
  kind: "order";
  operator: "before";
  right: E;
  calibration: "none";
}

export type Predicate<E = EventRef> = TimePredicate<E> | SupplyPredicate<E> | OrderPredicate<E>;

export interface RuleDefinition<E = EventRef> {
  name: string;
  nameSpan: SourceSpan;
  predicates: Predicate<E>[];
  span: SourceSpan;
}

export interface RuleDocument<E = EventRef> {
  rules: RuleDefinition<E>[];
  sourceName?: string;
}

export type ParsedRuleDocument = RuleDocument<ParsedEventRef>;

