import * as ohm from "ohm-js";

import {
  type Box,
  type Primitive,
  type Resolved,
  isLiteral,
  isBlock,
  isBox,
  makeLiteral,
  resolveShallow,
} from "./data";

/* Grammar */

const grammar = ohm.grammar(String.raw`Script {
  Exp       = OrExp

  OrExp     = OrExp "||" AndExp   -- or
            | AndExp

  AndExp    = AndExp "&&" EqExp   -- and
            | EqExp

  EqExp     = EqExp "=" RelExp   -- eq
            | EqExp "!=" RelExp   -- ne
            | RelExp

  RelExp    = RelExp "<=" AddExp  -- le
            | RelExp "<"  AddExp  -- lt
            | RelExp ">=" AddExp  -- ge
            | RelExp ">"  AddExp  -- gt
            | AddExp

  AddExp    = AddExp "+" MulExp   -- plus
            | AddExp "-" MulExp   -- minus
            | MulExp

  MulExp    = MulExp "*" PriExp   -- times
            | MulExp "/" PriExp   -- divide
            | PriExp

  PriExp    = "!" PriExp          -- not
            | "-" PriExp          -- neg
            | "+" PriExp          -- pos
            | Path                -- path
            | boolean             -- bool
            | number              -- num
            | string              -- str
            | "(" Exp ")"         -- paren

  Path      = ident ("." ident)*

  boolean   = "true" | "false"
  ident     = letter alnum*
  number    = digit+ ("." digit+)?

  string    = dqString | sqString
  dqString  = "\"" (~"\"" any)* "\""
  sqString  = "'"  (~"'"  any)* "'"

  space     += " " | "\t" | "\n" | "\r"
}`);

/* Coercion */

function asPrimitive(x: Box | Resolved | Primitive): Primitive {
  const r = isBox(x) ? resolveShallow(x) : x;
  if (isLiteral(r)) return r.value;
  if (isBlock(r)) throw new TypeError("Expected a primitive, got a block");
  return r;
}

function toBool(x: Box | Resolved | Primitive): boolean {
  return Boolean(asPrimitive(x));
}

function toNum(x: Box | Resolved | Primitive): number {
  const v = asPrimitive(x);
  const n = typeof v === "number" ? v : Number(v);
  if (Number.isNaN(n)) {
    throw new TypeError(`Expected a number, got ${String(v)}`);
  }
  return n;
}

function toStr(x: Box | Resolved | Primitive): string {
  const v = asPrimitive(x);
  return typeof v === "string" ? v : String(v);
}

function eq(
  a: Box | Resolved | Primitive,
  b: Box | Resolved | Primitive
): boolean {
  return asPrimitive(a) === asPrimitive(b);
}

function cmp(
  a: Box | Resolved | Primitive,
  b: Box | Resolved | Primitive,
  op: "<" | "<=" | ">" | ">="
): boolean {
  const na = toNum(a);
  const nb = toNum(b);
  switch (op) {
    case "<":
      return na < nb;
    case "<=":
      return na <= nb;
    case ">":
      return na > nb;
    case ">=":
      return na >= nb;
  }
}

/* Semantics */

const semantics = grammar
  .createSemantics()
  .addOperation<Primitive | Box>("eval(scope)", {
    Exp(e) {
      return e.eval(this.args.scope);
    },

    /* logical */
    OrExp_or(a, _op, b) {
      const va = a.eval(this.args.scope);
      return toBool(va) ? va : b.eval(this.args.scope);
    },
    AndExp_and(a, _op, b) {
      const va = a.eval(this.args.scope);
      return toBool(va) ? b.eval(this.args.scope) : va;
    },

    /* equality */
    EqExp_eq(a, _op, b) {
      return eq(a.eval(this.args.scope), b.eval(this.args.scope));
    },
    EqExp_ne(a, _op, b) {
      return !eq(a.eval(this.args.scope), b.eval(this.args.scope));
    },

    /* relational */
    RelExp_lt(a, _op, b) {
      return cmp(a.eval(this.args.scope), b.eval(this.args.scope), "<");
    },
    RelExp_le(a, _op, b) {
      return cmp(a.eval(this.args.scope), b.eval(this.args.scope), "<=");
    },
    RelExp_gt(a, _op, b) {
      return cmp(a.eval(this.args.scope), b.eval(this.args.scope), ">");
    },
    RelExp_ge(a, _op, b) {
      return cmp(a.eval(this.args.scope), b.eval(this.args.scope), ">=");
    },

    /* arithmetic */
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

    /* unary */
    PriExp_not(_bang, e) {
      return !toBool(e.eval(this.args.scope));
    },
    PriExp_neg(_minus, e) {
      return -toNum(e.eval(this.args.scope));
    },
    PriExp_pos(_plus, e) {
      return +toNum(e.eval(this.args.scope));
    },

    /* literals */
    PriExp_num(n) {
      return parseFloat(n.sourceString);
    },
    PriExp_str(s) {
      const raw = s.sourceString;
      return raw.slice(1, -1);
    },
    PriExp_bool(b) {
      return b.sourceString === "true";
    },
    PriExp_paren(_l, e, _r) {
      return e.eval(this.args.scope);
    },

    /* variable access */
    Path(id, _d, dots) {
      let cur: Box = this.args.scope(id.sourceString);

      for (const seg of dots.children) {
        const key = seg.child(1).sourceString;
        const r = isBox(cur) ? resolveShallow(cur) : cur;

        if (isBlock(r)) {
          const next = r.values[key];
          if (!next) throw new ReferenceError(`Unknown property '${key}'`);
          cur = next;
        } else {
          throw new TypeError(
            `Cannot access property '${key}' of non-block value`
          );
        }
      }

      return cur;
    },

    ident(_a, _b) {
      return this.sourceString;
    },
    number(_a, _d, _b) {
      return this.sourceString;
    },
  });

/* Evaluate */

export function evalCode(src: string, scope: (name: string) => Box): Resolved {
  const m = grammar.match(src, "Exp");
  if (m.failed()) {
    throw new SyntaxError(m.message);
  }
  const result = semantics(m).eval(scope);

  if (isBox(result)) {
    return resolveShallow(result);
  }
  return makeLiteral(result as Primitive);
}
