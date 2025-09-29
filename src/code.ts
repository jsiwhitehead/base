import * as ohm from "ohm-js";

import {
  type DataNode,
  type DataSignal,
  isFunction,
  getByKey,
  getByKeyOrIndex,
} from "./data";
import {
  blank,
  lit,
  bool,
  fn,
  toBool,
  reqPrim,
  reqNum,
  mapNums,
} from "./library";

/* Grammar */

const grammar = ohm.grammar(String.raw`
Script {
  Start           = Expr<"">

  Expr<Dot>       = Lambda<Dot>

  Lambda<Dot>     = Pipe<Dot>                             -- pipe
                  | Params "=>" Lambda<"">                -- arrow
                  | &"." Pipe<".">                        -- implicit

  Params          = ident                                 -- ident
                  | "(" IdentList? ")"                    -- list

  IdentList       = NonemptyListOf<ident, ",">

  Pipe<Dot>       = Or<Dot> (PipeOp Or<Dot>)*
  PipeOp          = ":"

  Or<Dot>         = And<Dot> (OrOp And<Dot>)*
  OrOp            = "|"

  And<Dot>        = Eq<Dot> (AndOp Eq<Dot>)*
  AndOp           = "&"

  Eq<Dot>         = Rel<Dot> (EqOp Rel<Dot>)*
  EqOp            = "!=" | "="

  Rel<Dot>        = Add<Dot> (RelOp Add<Dot>)*
  RelOp           = "<=" | "<" | ">=" | ">"

  Add<Dot>        = Mul<Dot> (AddOp Mul<Dot>)*
  AddOp           = "+" | "-"

  Mul<Dot>        = Unary<Dot> (MulOp Unary<Dot>)*
  MulOp           = "*" | "/"

  Unary<Dot>      = (("!" | "-" | "+")*) Path<Dot>

  Path<Dot>       = Prim<Dot> PathPart<Dot>*
  PathPart<Dot>   = Call<Dot>
                  | Index<Dot>
                  | Member

  Call<Dot>       = "(" ListOf<Expr<Dot>, ","> ")"
  Index<Dot>      = "[" Expr<Dot> "]"
  Member          = "." ident

  Prim<Dot>       = Literal                              -- lit
                  | ident                                -- ident
                  | "(" Expr<Dot> ")"                    -- paren
                  | &"." Dot ident                       -- dot

  Literal         = "blank"                              -- blank
                  | "true"                               -- true
                  | number                               -- number
                  | text                                 -- text

  number          = integer
                  | decimal
                  | sciNumber

  integer         = "1".."9" digit*                      -- nonzero
                  | "0"                                  -- zero

  decimal         = integer "." digit+ exponent?         -- intdot
                  | "0" "." digit+ exponent?             -- zerodot
                  | "." digit+ exponent?                 -- dot

  sciNumber       = (integer | decimal) exponent
  exponent        = ("e" | "E") ("+" | "-")? digit+

  text            = dText
                  | sText

  dText           = "\"" dqChar* "\""
  sText           = "'"  sqChar* "'"

  dqChar          = escape | ~("\"" | "\\" | "\n" | "\r") any
  sqChar          = escape | ~("'"  | "\\" | "\n" | "\r") any

  escape          = "\\" escSimple | "\\u" hex4 | "\\x" hex2

  escSimple       = "\"" | "'" | "\\" | "n" | "r" | "t" | "b" | "f"
  hex2            = hexDigit hexDigit
  hex4            = hexDigit hexDigit hexDigit hexDigit

  ident           = identStart identRest*
  identStart      = "_" | letter
  identRest       = identStart | digit
}
`);

/* AST Types */

export type Expr =
  | Lambda
  | Binary
  | Unary
  | Call
  | Index
  | Member
  | Lit
  | Blank
  | Ident;

export interface Lambda {
  type: "Lambda";
  params: Ident[];
  body: Expr;
}

export interface Binary {
  type: "Binary";
  op: "|" | "&" | "!=" | "=" | "<=" | "<" | ">=" | ">" | "+" | "-" | "*" | "/";
  left: Expr;
  right: Expr;
}

export interface Unary {
  type: "Unary";
  op: "!" | "-" | "+";
  argument: Expr;
}

export interface Call {
  type: "Call";
  callee: Expr;
  args: Expr[];
}

export interface Index {
  type: "Index";
  block: Expr;
  index: Expr;
}

export interface Member {
  type: "Member";
  block: Expr;
  key: Ident;
}

export interface Lit {
  type: "Lit";
  value: true | number | string;
}

export interface Blank {
  type: "Blank";
}

export interface Ident {
  type: "Ident";
  name: string;
}

/* Semantics */

const IMPLICIT_PARAM = "__";

function buildBinaryChain(
  first: ohm.Node,
  ops: ohm.Node,
  rights: ohm.Node
): Expr {
  return ops.children.reduce<Expr>(
    (node, opNode, i) => ({
      type: "Binary",
      op: opNode.sourceString as Binary["op"],
      left: node,
      right: rights.children[i]!.ast as Expr,
    }),
    first.ast as Expr
  );
}

const semantics = grammar.createSemantics().addAttribute("ast", {
  Lambda_arrow(params, _arrow, body) {
    return {
      type: "Lambda",
      params: params.ast as Ident[],
      body: body.ast,
    } as Lambda;
  },
  Lambda_implicit(_guard, body) {
    return {
      type: "Lambda",
      params: [{ type: "Ident", name: IMPLICIT_PARAM }],
      body: body.ast,
    } as Lambda;
  },

  Params_ident(nameTok) {
    return [{ type: "Ident", name: nameTok.sourceString }];
  },
  Params_list(_open, maybeList, _close) {
    return (maybeList.children[0]?.ast ?? []) as Ident[];
  },
  IdentList(list) {
    return list
      .asIteration()
      .children.map((n) => ({ type: "Ident", name: n.sourceString }));
  },

  Pipe(first, _ops, rights) {
    return rights.children.reduce<Expr>((acc, node) => {
      const step = node.ast as Expr;
      if (step.type === "Call") {
        return { type: "Call", callee: step.callee, args: [acc, ...step.args] };
      }
      return { type: "Call", callee: step, args: [acc] };
    }, first.ast as Expr);
  },

  Or(first, ops, rights) {
    return buildBinaryChain(first, ops, rights);
  },
  And(first, ops, rights) {
    return buildBinaryChain(first, ops, rights);
  },
  Eq(first, ops, rights) {
    return buildBinaryChain(first, ops, rights);
  },
  Rel(first, ops, rights) {
    return buildBinaryChain(first, ops, rights);
  },
  Add(first, ops, rights) {
    return buildBinaryChain(first, ops, rights);
  },
  Mul(first, ops, rights) {
    return buildBinaryChain(first, ops, rights);
  },

  Unary(ops, operand) {
    return ops.children.reduceRight<Expr>(
      (node, tok) => ({
        type: "Unary",
        op: tok.sourceString as Unary["op"],
        argument: node,
      }),
      operand.ast as Expr
    );
  },

  Path(prim, parts) {
    return parts.children.reduce<Expr>((node, p) => {
      const apply = p.ast as (obj: Expr) => Expr;
      return apply(node);
    }, prim.ast as Expr);
  },
  Call(_open, list, _close) {
    return (callee: Expr): Call => ({
      type: "Call",
      callee,
      args: list.asIteration().children.map((n) => n.ast as Expr),
    });
  },
  Index(_open, expr, _close) {
    return (block: Expr): Index => ({
      type: "Index",
      block,
      index: expr.ast as Expr,
    });
  },
  Member(_dot, nameTok) {
    return (block: Expr): Member => ({
      type: "Member",
      block,
      key: { type: "Ident", name: nameTok.sourceString },
    });
  },

  Prim_ident(nameTok) {
    return { type: "Ident", name: nameTok.sourceString };
  },
  Prim_paren(_open, expr, _close) {
    return expr.ast;
  },
  Prim_dot(_guard, _dot, nameTok) {
    return {
      type: "Member",
      block: { type: "Ident", name: IMPLICIT_PARAM },
      key: { type: "Ident", name: nameTok.sourceString },
    } as Member;
  },

  Literal_blank(_) {
    return { type: "Blank" } as Blank;
  },
  Literal_true(_) {
    return { type: "Lit", value: true } as Lit;
  },
  Literal_number(n) {
    return { type: "Lit", value: Number(n.sourceString) } as Lit;
  },
  Literal_text(t) {
    const raw = t.sourceString;
    const value = JSON.parse(
      raw[0] === "'"
        ? `"${raw.slice(1, -1).replace(/\\'/g, "'").replace(/"/g, '\\"')}"`
        : raw
    );
    return { type: "Lit", value } as Lit;
  },
});

/* Operators */

const BINARY_OPS: Partial<
  Record<Binary["op"], (a: DataSignal, b: DataSignal) => DataSignal>
> = {
  "!=": (a, b) => bool(reqPrim(a) !== reqPrim(b)),
  "=": (a, b) => bool(reqPrim(a) === reqPrim(b)),

  "<=": (a, b) => bool(reqNum(a) <= reqNum(b)),
  "<": (a, b) => bool(reqNum(a) < reqNum(b)),
  ">=": (a, b) => bool(reqNum(a) >= reqNum(b)),
  ">": (a, b) => bool(reqNum(a) > reqNum(b)),

  "+": mapNums((a, b) => a + b),
  "-": mapNums((a, b) => a - b),
  "*": mapNums((a, b) => a * b),
  "/": mapNums((a, b) => a / b),
};

const UNARY_OPS: Record<Unary["op"], (v: DataSignal) => DataSignal> = {
  "!": (v) => bool(!toBool(v)),

  "-": mapNums((x) => -x),
  "+": mapNums((x) => +x),
};

/* Evaluate */

function evalExpr(e: Expr, scope: (name: string) => DataSignal): DataSignal {
  switch (e.type) {
    case "Lambda": {
      const params = e.params.map((p) => p.name);
      return fn((...args: DataSignal[]) =>
        evalExpr(e.body, (name: string) => {
          const i = params.indexOf(name);
          if (i !== -1) return args[i] ?? blank();
          return scope(name);
        })
      );
    }

    case "Binary": {
      const { op, left, right } = e;

      if (op === "|") {
        const lv = toBool(evalExpr(left, scope));
        return lv ? bool(true) : bool(toBool(evalExpr(right, scope)));
      }
      if (op === "&") {
        const lv = toBool(evalExpr(left, scope));
        return lv ? bool(toBool(evalExpr(right, scope))) : bool(false);
      }

      const f = BINARY_OPS[op];
      if (f) {
        return f(evalExpr(left, scope), evalExpr(right, scope));
      }

      throw new Error(`Unknown operator: ${op}`);
    }

    case "Unary": {
      const v = evalExpr(e.argument, scope);
      const f = UNARY_OPS[e.op];
      if (f) return f(v);
      throw new Error(`Unknown unary operator: ${e.op}`);
    }

    case "Call": {
      const callee = evalExpr(e.callee, scope).get();
      if (!isFunction(callee)) {
        throw new TypeError("Callee is not a function");
      }
      const args = e.args.map((a) => evalExpr(a, scope));
      return callee.fn(...args);
    }

    case "Member": {
      return getByKey(evalExpr(e.block, scope), e.key.name);
    }

    case "Index": {
      return getByKeyOrIndex(
        evalExpr(e.block, scope),
        evalExpr(e.index, scope)
      );
    }

    case "Lit":
      return lit(e.value);

    case "Blank":
      return blank();

    case "Ident":
      return scope(e.name);
  }
}

export function evalCode(
  code: string,
  scope: (name: string) => DataSignal
): DataNode {
  const match = grammar.match(code, "Start");
  if (match.failed()) throw new SyntaxError(match.message);
  return evalExpr(semantics(match).ast, scope).get();
}
