import * as ohm from "ohm-js";
import type { Node } from "ohm-js";

import {
  type Primitive,
  type DataNode,
  type Signal,
  isLiteral,
  isBlock,
  isFunction,
  isSignal,
  createLiteral,
  createSignal,
  resolveShallow,
} from "./data";

/* Types */

type ScopeFn = (name: string) => Signal;
type EvalResult = Signal | Primitive;

type NodeLike = Node & {
  eval(scope: ScopeFn): EvalResult;
};

type EvalActionDict = {
  [key: string]: (
    this: { args: { scope: ScopeFn } },
    ...children: NodeLike[]
  ) => EvalResult;
};

/* Grammar */

const grammar = ohm.grammar(String.raw`Script {
  Exp       = OrExp

  OrExp     = OrExp "||" AndExp   -- or
            | AndExp

  AndExp    = AndExp "&&" EqExp   -- and
            | EqExp

  EqExp     = EqExp "=" RelExp    -- eq
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
            | Call                -- call
            | Atom                -- atom

  Atom      = Path                -- path
            | boolean             -- bool
            | number              -- num
            | string              -- str
            | "(" Exp ")"         -- paren

  Call      = Path "(" Args? ")"              -- normal
            | Atom ":" ident "(" Args? ")"    -- method

  Args      = Exp ("," Exp)*

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

function asPrimitive(x: EvalResult): Primitive {
  const r = isSignal(x) ? resolveShallow(x) : x;
  if (isLiteral(r)) return r.value;
  if (isBlock(r)) throw new TypeError("Expected a primitive, got a block");
  if (isFunction(r))
    throw new TypeError("Expected a primitive, got a function");
  return r;
}

function toBool(x: EvalResult): boolean {
  return Boolean(asPrimitive(x));
}

function toNum(x: EvalResult): number {
  const n = Number(asPrimitive(x));
  if (Number.isNaN(n))
    throw new TypeError(`Expected a number, got ${String(asPrimitive(x))}`);
  return n;
}

function toStr(x: EvalResult): string {
  return String(asPrimitive(x));
}

function eq(a: EvalResult, b: EvalResult): boolean {
  return asPrimitive(a) === asPrimitive(b);
}

function cmp(
  a: EvalResult,
  b: EvalResult,
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

/* Call Helpers */

const toSig = (v: Signal | Primitive): Signal =>
  isSignal(v) ? v : createSignal(createLiteral(v));

function resolveFunctionFrom(anyVal: EvalResult) {
  const node = isSignal(anyVal) ? resolveShallow(anyVal) : anyVal;
  if (isFunction(node)) return node;
  throw new TypeError("Value is not a function");
}

function collectArgSignals(argsOpt: NodeLike, scope: ScopeFn): Signal[] {
  if (argsOpt.children.length === 0) return [];

  const argsNode = argsOpt.child(0);
  const expNodes: NodeLike[] = [
    argsNode.child(0) as NodeLike,
    ...argsNode.child(1).children.map((c) => c.child(1) as NodeLike),
  ];

  return expNodes.map((n) => toSig(n.eval(scope)));
}

/* Semantics */

const evalActions: EvalActionDict = {
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

  /* calls */
  Call_normal(path, _l, argsOpt, _r) {
    const targetSig = path.eval(this.args.scope);
    const funcNode = resolveFunctionFrom(targetSig);
    const args = collectArgSignals(argsOpt, this.args.scope);
    return funcNode.fn(...args);
  },

  Call_method(receiverAtom, _colon, funcId, _l, argsOpt, _r) {
    const funcSig = this.args.scope(funcId.sourceString);
    const funcNode = resolveFunctionFrom(funcSig);

    const recvVal = receiverAtom.eval(this.args.scope);
    const recvSig = toSig(recvVal);

    const args = [recvSig, ...collectArgSignals(argsOpt, this.args.scope)];
    return funcNode.fn(...args);
  },

  /* atoms */
  Atom_path(p) {
    return p.eval(this.args.scope);
  },
  Atom_bool(b) {
    return b.sourceString === "true";
  },
  Atom_num(n) {
    return parseFloat(n.sourceString);
  },
  Atom_str(s) {
    const raw = s.sourceString;
    return raw.slice(1, -1);
  },
  Atom_paren(_l, e, _r) {
    return e.eval(this.args.scope);
  },

  /* variable access */
  Path(id, _d, dots) {
    let cur: Signal = this.args.scope(id.sourceString);

    for (const seg of dots.children) {
      const key = seg.child(1).sourceString;
      const r = resolveShallow(cur);

      if (isBlock(r)) {
        const pair = r.values.find(([k]) => k === key);
        if (!pair) throw new ReferenceError(`Unknown property '${key}'`);
        const [, next] = pair;
        cur = next;
      } else {
        throw new TypeError(
          `Cannot access property '${key}' of non-block value`
        );
      }
    }

    return cur;
  },
};

const semantics = grammar
  .createSemantics()
  .addOperation<EvalResult>(
    "eval(scope)",
    evalActions as unknown as ohm.ActionDict<EvalResult>
  );

/* Evaluate */

export function evalCode(src: string, scope: ScopeFn): DataNode {
  const m = grammar.match(src, "Exp");
  if (m.failed()) {
    throw new SyntaxError(m.message);
  }
  const result = semantics(m).eval(scope);
  if (isSignal(result)) {
    return resolveShallow(result);
  }
  return createLiteral(result as Primitive);
}
