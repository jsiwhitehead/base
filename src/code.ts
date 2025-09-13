import * as ohm from "ohm-js";

import { makeLiteral, resolve, type Value, type Resolved } from "./data";

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

function toNum(v: Value): number {
  const r = resolve(v);
  const n = typeof r === "number" ? r : Number(r);
  if (Number.isNaN(n)) {
    throw new TypeError(`Expected a number, got ${String(r)}`);
  }
  return n;
}

const semantics = grammar
  .createSemantics()
  .addOperation<number | string>("eval(scope)", {
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
      return this.args.scope(id.sourceString);
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

export function evalExpr(
  src: string,
  scope: (name: string) => Value
): Resolved {
  const m = grammar.match(src, "Exp");
  if (m.failed()) {
    throw new SyntaxError(m.message);
  }
  return makeLiteral(semantics(m).eval(scope));
}
