import type {
  OrderPredicate,
  ParsedEventRef,
  ParsedRuleDocument,
  Predicate,
  RuleDefinition,
  SourcePosition,
  SourceSpan,
  SupplyPredicate,
  TimePredicate
} from "./ast.js";
import type { RuleDiagnostic, RuleDiagnosticCode } from "./diagnostics.js";

type TokenKind = "identifier" | "integer" | "string" | "{" | "}" | "[" | "]" | ":" | "eof";

interface Token {
  kind: TokenKind;
  text: string;
  value?: string;
  span: SourceSpan;
}

export interface ParseBuildRulesResult {
  /** Complete on success and best-effort/recovered when syntax diagnostics exist. */
  document: ParsedRuleDocument;
  diagnostics: RuleDiagnostic[];
}

export function parseBuildRules(source: string, sourceName?: string): ParseBuildRulesResult {
  const lexer = new Lexer(source, sourceName);
  const tokens = lexer.scan();
  const parser = new Parser(tokens, sourceName);
  const document = parser.parseDocument();
  const diagnostics = [...lexer.diagnostics, ...parser.diagnostics].sort(compareDiagnostics);
  return { document, diagnostics };
}

class Lexer {
  readonly diagnostics: RuleDiagnostic[] = [];
  private readonly tokens: Token[] = [];
  private offset = 0;
  private line = 1;
  private column = 1;

  constructor(private readonly source: string, private readonly sourceName?: string) {}

  scan(): Token[] {
    while (!this.atEnd()) {
      const character = this.peek();
      if (/\s/u.test(character)) {
        this.advance();
      } else if (character === "#") {
        while (!this.atEnd() && this.peek() !== "\n") this.advance();
      } else if (/[A-Za-z_]/u.test(character)) {
        this.scanWord();
      } else if (/\d/u.test(character)) {
        this.scanInteger();
      } else if (character === '"') {
        this.scanString();
      } else if (["{", "}", "[", "]", ":"].includes(character)) {
        const start = this.position();
        const text = this.advance();
        this.tokens.push({ kind: text as TokenKind, text, span: this.spanFrom(start) });
      } else {
        const start = this.position();
        const text = this.advance();
        this.error("UNEXPECTED_CHARACTER", `unexpected character ${JSON.stringify(text)}`, this.spanFrom(start));
      }
    }
    const at = this.position();
    this.tokens.push({ kind: "eof", text: "", span: { start: at, end: at } });
    return this.tokens;
  }

  private scanWord(): void {
    const start = this.position();
    const startOffset = this.offset;
    while (!this.atEnd() && /[A-Za-z0-9_]/u.test(this.peek())) this.advance();
    const text = this.source.slice(startOffset, this.offset);
    this.tokens.push({ kind: "identifier", text, span: this.spanFrom(start) });
  }

  private scanInteger(): void {
    const start = this.position();
    const startOffset = this.offset;
    while (!this.atEnd() && /\d/u.test(this.peek())) this.advance();
    const text = this.source.slice(startOffset, this.offset);
    this.tokens.push({ kind: "integer", text, span: this.spanFrom(start) });
  }

  private scanString(): void {
    const start = this.position();
    this.advance();
    const contentOffset = this.offset;
    while (!this.atEnd() && this.peek() !== '"' && this.peek() !== "\n" && this.peek() !== "\r") this.advance();
    if (this.atEnd() || this.peek() !== '"') {
      this.error("UNTERMINATED_STRING", "unterminated rule name string", this.spanFrom(start));
      return;
    }
    const value = this.source.slice(contentOffset, this.offset);
    this.advance();
    this.tokens.push({ kind: "string", text: this.source.slice(start.offset, this.offset), value, span: this.spanFrom(start) });
  }

  private error(code: RuleDiagnosticCode, message: string, span: SourceSpan): void {
    this.diagnostics.push({ severity: "error", phase: "syntax", code, message, span, ...(this.sourceName ? { sourceName: this.sourceName } : {}) });
  }

  private peek(): string { return this.source[this.offset] ?? ""; }
  private atEnd(): boolean { return this.offset >= this.source.length; }
  private position(): SourcePosition { return { offset: this.offset, line: this.line, column: this.column }; }
  private spanFrom(start: SourcePosition): SourceSpan { return { start, end: this.position() }; }
  private advance(): string {
    const character = this.source[this.offset++] ?? "";
    if (character === "\n") { this.line += 1; this.column = 1; } else { this.column += 1; }
    return character;
  }
}

class Parser {
  readonly diagnostics: RuleDiagnostic[] = [];
  private current = 0;

  constructor(private readonly tokens: readonly Token[], private readonly sourceName?: string) {}

  parseDocument(): ParsedRuleDocument {
    const rules: RuleDefinition<ParsedEventRef>[] = [];
    while (!this.check("eof")) {
      if (!this.isWord("rule")) {
        this.error(this.peek(), "EXPECTED_RULE", "expected 'rule' at the start of a rule definition");
        this.advance();
        continue;
      }
      const rule = this.parseRule();
      if (rule) rules.push(rule);
    }
    return { rules, ...(this.sourceName ? { sourceName: this.sourceName } : {}) };
  }

  private parseRule(): RuleDefinition<ParsedEventRef> | undefined {
    const start = this.advance().span.start;
    const name = this.consume("string", "EXPECTED_RULE_NAME", "expected a quoted rule name after 'rule'");
    const open = this.consume("{", "EXPECTED_OPEN_BRACE", "expected '{' after the rule name");
    if (!name || !open) { this.synchronizeToRule(); return undefined; }
    const predicates: Predicate<ParsedEventRef>[] = [];
    while (!this.check("}") && !this.check("eof") && !this.isWord("rule")) {
      const before = this.current;
      const predicate = this.parseStatement();
      if (predicate) predicates.push(predicate);
      if (this.current === before) this.advance();
    }
    const close = this.consume("}", "EXPECTED_CLOSE_BRACE", "expected '}' to close the rule");
    return {
      name: name.value ?? "",
      nameSpan: name.span,
      predicates,
      span: { start, end: (close ?? this.previous()).span.end }
    };
  }

  private parseStatement(): Predicate<ParsedEventRef> | undefined {
    const left = this.parseEventRef();
    if (!left) { this.synchronizeStatement(); return undefined; }
    const operatorToken = this.consume("identifier", "EXPECTED_OPERATOR", "expected predicate operator after event reference");
    if (!operatorToken) { this.synchronizeStatement(); return undefined; }
    const operator = operatorToken.text;
    if (!["around", "before", "after", "at"].includes(operator)) {
      this.error(operatorToken, "EXPECTED_OPERATOR", `unknown predicate operator '${operator}'`);
      this.synchronizeStatement();
      return undefined;
    }

    if (operator === "before" && this.check("identifier")) {
      const right = this.parseEventRef();
      if (!right) { this.synchronizeStatement(); return undefined; }
      return { kind: "order", event: left, operator: "before", right, calibration: "none", span: { start: left.span.start, end: right.span.end } } satisfies OrderPredicate<ParsedEventRef>;
    }
    if (this.check("integer")) {
      const numberToken = this.advance();
      if (this.match(":")) {
        if (operator === "at") {
          this.error(operatorToken, "UNSUPPORTED_PREDICATE", "'at' is only supported for supply predicates");
          this.synchronizeStatement();
          return undefined;
        }
        const seconds = this.consume("integer", "EXPECTED_TWO_DIGIT_SECONDS", "expected exactly two seconds digits after ':'");
        if (!seconds || seconds.text.length !== 2) {
          if (seconds && seconds.text.length !== 2) this.error(seconds, "EXPECTED_TWO_DIGIT_SECONDS", "seconds must contain exactly two decimal digits");
          this.synchronizeStatement();
          return undefined;
        }
        const end = seconds.span.end;
        return {
          kind: "time", event: left, operator: operator as TimePredicate["operator"],
          targetSeconds: Number(numberToken.text) * 60 + Number(seconds.text),
          targetText: `${numberToken.text}:${seconds.text}`,
          targetSpan: { start: numberToken.span.start, end }, calibration: "required",
          span: { start: left.span.start, end }
        } satisfies TimePredicate<ParsedEventRef>;
      }
      const supply = this.consumeWord("supply", "EXPECTED_SUPPLY_KEYWORD", "expected 'supply' after the supply value");
      if (!supply) { this.synchronizeStatement(); return undefined; }
      const calibration = operator === "at" ? "none" : "required";
      return {
        kind: "supply", event: left, operator: operator as SupplyPredicate["operator"],
        targetSupply: Number(numberToken.text), targetSpan: numberToken.span, calibration,
        span: { start: left.span.start, end: supply.span.end }
      } as SupplyPredicate<ParsedEventRef>;
    }
    this.error(this.peek(), "EXPECTED_TARGET", "expected a time, supply value, or event reference after the operator");
    this.synchronizeStatement();
    return undefined;
  }

  private parseEventRef(): ParsedEventRef | undefined {
    const key = this.consume("identifier", "EXPECTED_EVENT_KEY", "expected a canonical event key");
    if (!key) return undefined;
    if (!this.consume("[", "EXPECTED_OPEN_BRACKET", "expected '[' after the event key")) return undefined;
    const occurrence = this.consume("integer", "EXPECTED_OCCURRENCE", "expected an integer occurrence");
    if (!occurrence) return undefined;
    const close = this.consume("]", "EXPECTED_CLOSE_BRACKET", "expected ']' after the occurrence");
    if (!close) return undefined;
    return {
      key: key.text,
      occurrence: Number(occurrence.text),
      span: { start: key.span.start, end: close.span.end },
      keySpan: key.span,
      occurrenceSpan: occurrence.span
    };
  }

  private synchronizeStatement(): void {
    while (!this.check("eof") && !this.check("}")) {
      if (this.check("identifier") && this.tokens[this.current + 1]?.kind === "[") return;
      if (this.isWord("rule")) return;
      this.advance();
    }
  }
  private synchronizeToRule(): void { while (!this.check("eof") && !this.isWord("rule")) this.advance(); }
  private isWord(word: string): boolean { return this.check("identifier") && this.peek().text === word; }
  private consumeWord(word: string, code: RuleDiagnosticCode, message: string): Token | undefined {
    if (this.isWord(word)) return this.advance();
    this.error(this.peek(), code, message); return undefined;
  }
  private consume(kind: TokenKind, code: RuleDiagnosticCode, message: string): Token | undefined {
    if (this.check(kind)) return this.advance();
    this.error(this.peek(), code, message); return undefined;
  }
  private error(token: Token, code: RuleDiagnosticCode, message: string): void {
    this.diagnostics.push({ severity: "error", phase: "syntax", code, message, span: token.span, ...(this.sourceName ? { sourceName: this.sourceName } : {}) });
  }
  private match(kind: TokenKind): boolean { if (!this.check(kind)) return false; this.advance(); return true; }
  private check(kind: TokenKind): boolean { return this.peek().kind === kind; }
  private peek(): Token { return this.tokens[this.current]!; }
  private previous(): Token { return this.tokens[Math.max(0, this.current - 1)]!; }
  private advance(): Token { if (!this.check("eof")) this.current += 1; return this.previous(); }
}

function compareDiagnostics(left: RuleDiagnostic, right: RuleDiagnostic): number {
  return left.span.start.offset - right.span.start.offset || compareAscii(left.code, right.code);
}

function compareAscii(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
