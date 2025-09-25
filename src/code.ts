import * as ohm from "ohm-js";
import type { Node as OhmNode } from "ohm-js";

import {
  type Primitive,
  type DataNode,
  type Signal,
  isLiteral,
  isBlock,
  isFunction,
  isData,
  isSignal,
  createLiteral,
  createFunction,
  createSignal,
  resolveShallow,
} from "./data";

/* Types */

type ScopeLookup = (name: string) => Signal;
type EvalValue = Signal | DataNode | Primitive;

type NodeLike = OhmNode & {
  eval(scope: ScopeLookup): EvalValue;
};

type EvalActionDict = {
  [key: string]: (
    this: { args: { scope: ScopeLookup } },
    ...children: NodeLike[]
  ) => EvalValue;
};

/* Grammar */

const grammar = ohm.grammar(String.raw`Script {
  Expr       = Lambda

  Lambda     = ident "=>" Lambda                  -- ident
             | "(" IdentList? ")" "=>" Lambda     -- list
             | Or

  Or         = Or "|" And                         -- or
             | And

  And        = And "&" Eq                         -- and
             | Eq

  Eq         = Eq "=" Rel                         -- eq
             | Eq "!=" Rel                        -- ne
             | Rel

  Rel        = Rel "<=" Add                       -- le
             | Rel "<"  Add                       -- lt
             | Rel ">=" Add                       -- ge
             | Rel ">"  Add                       -- gt
             | Add

  Add        = Add "+" Mul                        -- plus
             | Add "-" Mul                        -- minus
             | Mul

  Mul        = Mul "*" Unary                      -- times
             | Mul "/" Unary                      -- div
             | Unary

  Unary      = "!" Unary                          -- not
             | "-" Unary                          -- neg
             | Call
             | Prim

  Call       = Func "(" ExprList? ")"             -- normal
             | Expr ":" Func "(" ExprList? ")"    -- method

  Prim       = boolean                            -- bool
             | number                             -- num
             | string                             -- str
             | IdentPath                          -- path
             | "(" Expr ")"                       -- paren

  Func       = IdentPath                          -- path
             | "(" Expr ")"                       -- paren

  ExprList   = ListOf<Expr, ",">
  IdentList  = NonemptyListOf<ident, ",">

  IdentPath  = NonemptyListOf<ident, ".">

  ident      = letter (alnum | "_")*

  boolean    = "true" | "false"
  number     = digit+ ("." digit+)? 

  string     = d_string | s_string
  d_string   = "\"" (~"\"" any)* "\""
  s_string   = "'"  (~"'"  any)* "'"

  space     += " " | "\t" | "\n" | "\r"
}`);

/* Coercion */

function toPrimitive(x: EvalValue): Primitive {
  const resolved = isSignal(x) ? resolveShallow(x) : x;
  if (isLiteral(resolved)) return resolved.value;
  if (isBlock(resolved))
    throw new TypeError("Expected a primitive, got a block");
  if (isFunction(resolved))
    throw new TypeError("Expected a primitive, got a function");
  return resolved;
}

function toBoolean(x: EvalValue): boolean {
  return Boolean(toPrimitive(x));
}

function toNumber(x: EvalValue): number {
  const n = Number(toPrimitive(x));
  if (Number.isNaN(n)) {
    throw new TypeError(`Expected a number, got ${String(toPrimitive(x))}`);
  }
  return n;
}

function toString(x: EvalValue): string {
  return String(toPrimitive(x));
}

function isEqual(left: EvalValue, right: EvalValue): boolean {
  return toPrimitive(left) === toPrimitive(right);
}

function compareNumbers(
  left: EvalValue,
  right: EvalValue,
  op: "<" | "<=" | ">" | ">="
): boolean {
  const ln = toNumber(left);
  const rn = toNumber(right);
  switch (op) {
    case "<":
      return ln < rn;
    case "<=":
      return ln <= rn;
    case ">":
      return ln > rn;
    case ">=":
      return ln >= rn;
  }
}

/* Helpers */

function toSignal(value: EvalValue): Signal {
  if (isSignal(value)) return value;
  return createSignal(isData(value) ? value : createLiteral(value));
}

function makeLambda(names: string[], body: NodeLike, outerScope: ScopeLookup) {
  return createFunction((...args: Signal[]) => {
    const extendedScope: ScopeLookup = (name: string) => {
      const i = names.indexOf(name);
      if (i !== -1) {
        return args[i] ?? createSignal(createLiteral(""));
      }
      return outerScope(name);
    };
    return toSignal(body.eval(extendedScope));
  });
}

function optChildren(optNode: OhmNode): OhmNode[] {
  const child = optNode.child(0);
  return child ? child.asIteration().children : [];
}

function performCall(
  callee: NodeLike,
  argsOpt: NodeLike,
  scope: ScopeLookup,
  receiver?: NodeLike
): Signal {
  const calleeVal = callee.eval(scope);
  const fnNode = isSignal(calleeVal) ? resolveShallow(calleeVal) : calleeVal;
  if (!isFunction(fnNode)) throw new TypeError("Callee is not a function");

  const args = optChildren(argsOpt).map((n) => toSignal(n.eval(scope)));
  const allArgs = receiver ? [toSignal(receiver.eval(scope)), ...args] : args;

  return fnNode.fn(...allArgs);
}

function resolveIdentPath(idents: string[], scope: ScopeLookup): Signal {
  let current: Signal = scope(idents[0]!);

  for (let i = 1; i < idents.length; i++) {
    const key = idents[i]!;
    const resolved = resolveShallow(current);

    if (!isBlock(resolved)) {
      throw new TypeError(`Cannot access property '${key}' of non-block value`);
    }

    const pair = resolved.values.find(([k]) => k === key);
    if (!pair) {
      throw new ReferenceError(`Unknown property '${key}'`);
    }

    const [, next] = pair;
    current = next;
  }

  return current;
}

/* Semantics */

const evalActions: EvalActionDict = {
  Expr(expr) {
    return expr.eval(this.args.scope);
  },

  Lambda_ident(ident, _arrow, body) {
    return makeLambda([ident.sourceString], body, this.args.scope);
  },
  Lambda_list(_open, identListOpt, _close, _arrow, body) {
    return makeLambda(
      optChildren(identListOpt).map((n) => n.sourceString),
      body,
      this.args.scope
    );
  },

  Or_or(left, _op, right) {
    const leftValue = left.eval(this.args.scope);
    return toBoolean(leftValue) ? leftValue : right.eval(this.args.scope);
  },

  And_and(left, _op, right) {
    const leftValue = left.eval(this.args.scope);
    return toBoolean(leftValue) ? right.eval(this.args.scope) : leftValue;
  },

  Eq_eq(left, _op, right) {
    return isEqual(left.eval(this.args.scope), right.eval(this.args.scope));
  },
  Eq_ne(left, _op, right) {
    return !isEqual(left.eval(this.args.scope), right.eval(this.args.scope));
  },

  Rel_le(left, _op, right) {
    return compareNumbers(
      left.eval(this.args.scope),
      right.eval(this.args.scope),
      "<="
    );
  },
  Rel_lt(left, _op, right) {
    return compareNumbers(
      left.eval(this.args.scope),
      right.eval(this.args.scope),
      "<"
    );
  },
  Rel_ge(left, _op, right) {
    return compareNumbers(
      left.eval(this.args.scope),
      right.eval(this.args.scope),
      ">="
    );
  },
  Rel_gt(left, _op, right) {
    return compareNumbers(
      left.eval(this.args.scope),
      right.eval(this.args.scope),
      ">"
    );
  },

  Add_plus(left, _op, right) {
    return (
      toNumber(left.eval(this.args.scope)) +
      toNumber(right.eval(this.args.scope))
    );
  },
  Add_minus(left, _op, right) {
    return (
      toNumber(left.eval(this.args.scope)) -
      toNumber(right.eval(this.args.scope))
    );
  },

  Mul_times(left, _op, right) {
    return (
      toNumber(left.eval(this.args.scope)) *
      toNumber(right.eval(this.args.scope))
    );
  },
  Mul_div(left, _op, right) {
    return (
      toNumber(left.eval(this.args.scope)) /
      toNumber(right.eval(this.args.scope))
    );
  },

  Unary_not(_op, expr) {
    return !toBoolean(expr.eval(this.args.scope));
  },
  Unary_neg(_op, expr) {
    return -toNumber(expr.eval(this.args.scope));
  },

  Call_normal(callee, _open, argsOpt, _close) {
    return performCall(callee, argsOpt, this.args.scope);
  },
  Call_method(receiver, _colon, callee, _open, argsOpt, _close) {
    return performCall(callee, argsOpt, this.args.scope, receiver);
  },

  Prim_bool(tok) {
    return tok.sourceString === "true";
  },
  Prim_num(tok) {
    return parseFloat(tok.sourceString);
  },
  Prim_str(tok) {
    const raw = tok.sourceString;
    return raw.slice(1, -1);
  },

  Func_path(path) {
    return path.eval(this.args.scope);
  },
  Func_paren(_open, expr, _close) {
    return expr.eval(this.args.scope);
  },

  IdentPath(parts) {
    const idents = parts.asIteration().children.map((n) => n.sourceString);
    return resolveIdentPath(idents, this.args.scope);
  },
};

const semantics = grammar
  .createSemantics()
  .addOperation<EvalValue>(
    "eval(scope)",
    evalActions as unknown as ohm.ActionDict<EvalValue>
  );

/* Evaluate */

export function evalCode(code: string, scope: ScopeLookup): DataNode {
  const match = grammar.match(code, "Expr");
  if (match.failed()) throw new SyntaxError(match.message);

  const result = semantics(match).eval(scope);

  if (isSignal(result)) return resolveShallow(result);
  if (isData(result)) return result;

  return createLiteral(result as Primitive);
}
