import * as ohm from "ohm-js";
import type { Node as OhmNode } from "ohm-js";

import {
  type DataNode,
  type ChildSignal,
  isBlock,
  isFunction,
  createLiteral,
  createFunction,
  createSignal,
  childToData,
} from "./data";

import {
  type EvalValue,
  toBoolean,
  toNumber,
  toData,
  toSignal,
  equals,
} from "./library";

/* Types */

type ScopeLookup = (name: string) => ChildSignal;

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
  Expr       = Lambda | Or

  Lambda     = ident "=>" Lambda                  -- ident
             | "(" IdentList? ")" "=>" Lambda     -- list
             | &"." Expr                          -- implicit

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
             | Path                               -- path
             | "(" Expr ")"                       -- paren

  Func       = Path                               -- path
             | "(" Expr ")"                       -- paren

  Path       = IdentPath                           -- plain
             | "." IdentPath                       -- dotted

  IdentPath  = NonemptyListOf<ident, ".">

  ExprList   = ListOf<Expr, ",">
  IdentList  = NonemptyListOf<ident, ",">

  ident      = letter (alnum | "_")*

  boolean    = "true" | "false"
  number     = digit+ ("." digit+)? 

  string     = d_string | s_string
  d_string   = "\"" (~"\"" any)* "\""
  s_string   = "'"  (~"'"  any)* "'"

  space     += " " | "\t" | "\n" | "\r"
}`);

/* Helpers */

function makeLambda(names: string[], body: NodeLike, outerScope: ScopeLookup) {
  return createFunction((...args) => {
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
) {
  const calleeVal = toData(callee.eval(scope));
  if (!calleeVal || !isFunction(calleeVal)) {
    throw new TypeError("Callee is not a function");
  }

  const args = optChildren(argsOpt).map((n) => toSignal(n.eval(scope)));
  const allArgs = receiver ? [toSignal(receiver.eval(scope)), ...args] : args;

  return calleeVal.fn(...allArgs);
}

function resolveIdentPath(idents: string[], scope: ScopeLookup): ChildSignal {
  let current: ChildSignal = scope(idents[0]!);

  for (const key of idents.slice(1)) {
    const resolved = childToData(current);
    if (!resolved || !isBlock(resolved)) {
      throw new TypeError(`Cannot access property '${key}' of non-block value`);
    }
    const pair = resolved.values.find(([k]) => k === key);
    if (!pair) throw new ReferenceError(`Unknown property '${key}'`);
    current = pair[1];
  }

  return current;
}

function numericOp<T>(
  scope: ScopeLookup,
  left: NodeLike,
  right: NodeLike,
  op: (a: number, b: number) => T
): T {
  const a = toNumber(left.eval(scope));
  const b = toNumber(right.eval(scope));
  return op(a, b);
}

/* Semantics */

const IMPLICIT = "__";

const evalActions: EvalActionDict = {
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
  Lambda_implicit(_guard, body) {
    return makeLambda([IMPLICIT], body, this.args.scope);
  },

  Or_or(left, _op, right) {
    const l = left.eval(this.args.scope);
    return toBoolean(l) ? l : right.eval(this.args.scope);
  },

  And_and(left, _op, right) {
    const l = left.eval(this.args.scope);
    return toBoolean(l) ? right.eval(this.args.scope) : l;
  },

  Eq_eq(left, _op, right) {
    return equals(left.eval(this.args.scope), right.eval(this.args.scope));
  },
  Eq_ne(left, _op, right) {
    return !equals(left.eval(this.args.scope), right.eval(this.args.scope));
  },

  Rel_le(left, _op, right) {
    return numericOp(this.args.scope, left, right, (a, b) => a <= b);
  },
  Rel_lt(left, _op, right) {
    return numericOp(this.args.scope, left, right, (a, b) => a < b);
  },
  Rel_ge(left, _op, right) {
    return numericOp(this.args.scope, left, right, (a, b) => a >= b);
  },
  Rel_gt(left, _op, right) {
    return numericOp(this.args.scope, left, right, (a, b) => a > b);
  },

  Add_plus(left, _op, right) {
    return numericOp(this.args.scope, left, right, (a, b) => a + b);
  },
  Add_minus(left, _op, right) {
    return numericOp(this.args.scope, left, right, (a, b) => a - b);
  },

  Mul_times(left, _op, right) {
    return numericOp(this.args.scope, left, right, (a, b) => a * b);
  },
  Mul_div(left, _op, right) {
    return numericOp(this.args.scope, left, right, (a, b) => a / b);
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

  Prim_bool(boolToken) {
    return boolToken.sourceString === "true";
  },
  Prim_num(numToken) {
    return parseFloat(numToken.sourceString);
  },
  Prim_str(strToken) {
    const raw = strToken.sourceString;
    return raw.slice(1, -1);
  },
  Prim_path(path) {
    return path.eval(this.args.scope);
  },
  Prim_paren(_open, expr, _close) {
    return expr.eval(this.args.scope);
  },

  Func_path(path) {
    return path.eval(this.args.scope);
  },
  Func_paren(_open, expr, _close) {
    return expr.eval(this.args.scope);
  },

  Path_plain(list) {
    const names = list.asIteration().children.map((c) => c.sourceString);
    return resolveIdentPath(names, this.args.scope);
  },
  Path_dotted(_dot, list) {
    const names = list.asIteration().children.map((c) => c.sourceString);
    return resolveIdentPath([IMPLICIT, ...names], this.args.scope);
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

  const result = semantics(match).eval(scope) as EvalValue;
  return toData(result) ?? createLiteral("");
}
