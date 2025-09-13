import * as ohm from "ohm-js";

import type { Node, Value } from "./data";

const grammar = ohm.grammar(String.raw`Script {

  Exp       = AddExp
  AddExp    = AddExp "+" MulExp  -- plus
            | AddExp "-" MulExp  -- minus
            | MulExp
  MulExp    = MulExp "*" PriExp  -- times
            | MulExp "/" PriExp  -- divide
            | PriExp
  PriExp    = "-" PriExp         -- neg
            | ident              -- var
            | number             -- num
            | "(" Exp ")"        -- paren

  ident (lex)  = letter alnum*
  number (lex) = digit+ ("." digit+)?

  space += " " | "\t" | "\n" | "\r"

}`);

type Scope = Record<string, Node>;

function getScopeValue(scope: Scope, name: string): Node {
  if (!(name in scope)) {
    throw new ReferenceError(`Unknown variable: ${name}`);
  }
  const v = (scope as any)[name];
  return v && typeof v === "object" && "value" in v ? (v as any).value : v;
}

function toNum(x: unknown, hint?: string): number {
  const n = typeof x === "number" ? x : Number(x);
  if (Number.isNaN(n)) {
    throw new TypeError(
      `Expected a number${hint ? ` for ${hint}` : ""}, got ${String(x)}`
    );
  }
  return n;
}

const semantics = grammar
  .createSemantics()
  .addOperation<Node | Value>("eval(scope)", {
    Exp(e) {
      return e.eval(this.args.scope);
    },
    AddExp_plus(a, _op, b) {
      return toNum(a.eval(this.args.scope)) + toNum(b.eval(this.args.scope));
    },
    AddExp_minus(a, _op, b) {
      return toNum(a.eval(this.args.scope)) - toNum(b.eval(this.args.scope));
    },
    MulExp_times(a, _op, b) {
      return toNum(a.eval(this.args.scope)) * toNum(b.eval(this.args.scope));
    },
    MulExp_divide(a, _op, b) {
      return toNum(a.eval(this.args.scope)) / toNum(b.eval(this.args.scope));
    },
    PriExp_neg(_minus, e) {
      return -toNum(e.eval(this.args.scope));
    },
    PriExp_var(id) {
      const name = id.sourceString;
      return getScopeValue(this.args.scope, name);
    },
    PriExp_num(n) {
      return parseFloat(n.sourceString);
    },
    PriExp_paren(_l, e, _r) {
      return e.eval(this.args.scope);
    },
    ident(_a, _b) {
      return this.sourceString;
    },
    number(_a, _d, _b) {
      return this.sourceString;
    },
  });

export function evalExpr(src: string, scope: Scope): number {
  const m = grammar.match(src, "Exp");
  if (m.failed()) {
    throw new SyntaxError(m.message);
  }
  const result = semantics(m).eval(scope);
  return toNum(result);
}
