import * as ohm from "ohm-js";

import {
  type DataNode,
  type DataSignal,
  isBlank,
  isLiteral,
  isFunction,
  isBlock,
  createSignal,
  sliceText,
  sliceBlockItems,
  createRangeBlock,
  getByKey,
  getByKeyOrIndex,
} from "./data";
import {
  blank,
  lit,
  bool,
  fn,
  asJsBool,
  primExpect,
  numExpect,
  numOpt,
  textOpt,
  mapNums,
} from "./library";

/* Grammar */

const grammar = ohm.grammar(String.raw`
Script {
  Start           = Expr<"">

  Expr<Dot>       = Lambda<Dot>

  Lambda<Dot>     = "(" IdentList? ")" "->" Lambda<"">    -- paren
                  | &"." Pipe<".">                        -- implicit
                  | Pipe<Dot>                             -- pipe

  Pipe<Dot>       = Eq<Dot> (PipeOp Eq<Dot>)*
  PipeOp          = "->"

  Eq<Dot>         = Rel<Dot> (EqOp Rel<Dot>)*
  EqOp            = "!=" | "="

  Rel<Dot>        = Range<Dot> (RelOp Range<Dot>)*
  RelOp           = "<=" | "<" | ">=" | ">"

  Range<Dot>      = Slice<Dot>
                  | Add<Dot>

  Add<Dot>        = Mul<Dot> (AddOp Mul<Dot>)*
  AddOp           = "+" | "-"

  Mul<Dot>        = Unary<Dot> (MulOp Unary<Dot>)*
  MulOp           = "*" | "/"

  Unary<Dot>      = (("!" | "-" | "+" | "#")*) Path<Dot>

  Path<Dot>       = Prim<Dot> PathPart<Dot>*
  PathPart<Dot>   = Call<Dot>
                  | Index<Dot>
                  | Member

  Call<Dot>       = "(" ListOf<Expr<Dot>, ","> ")"

  Index<Dot>      = "[" Slice<Dot> "]"
                  | "[" Expr<Dot> "]"

  Member          = "." ident

  Slice<Dot>      = Add<Dot>? ".." Add<Dot>? (":" Add<Dot>?)?

  Prim<Dot>       = Literal                              -- lit
                  | ident                                -- ident
                  | "(" Expr<Dot> ")"                    -- paren
                  | &"." Dot ident                       -- dot
                  | &"." Dot "[" Expr<Dot> "]"           -- dotindex

  Literal         = "blank"                              -- blank
                  | "true"                               -- true
                  | number                               -- number
                  | text                                 -- text
                  | template                             -- tpl

  number          = sciNumber
                  | decimal
                  | integer

  sciNumber       = (integer | decimal) exponent
  exponent        = ("e" | "E") ("+" | "-")? digit+

  decimal         = integer "." digit+ exponent?         -- intdot
                  | "0" "." digit+ exponent?             -- zerodot
                  | "." digit+ exponent?                 -- dot

  integer         = "1".."9" digit*                      -- nonzero
                  | "0"                                  -- zero

  text            = textLit<"\""> 
                  | textLit<"'">
  template        = tplLit<"\"">  
                  | tplLit<"'">

  textLit<q>      = q textChar<q>* q
  tplLit<q>       = "&" q tplChunk<q>* q

  textChar<q>     = escape | ~(q | "\\" | "\n" | "\r") any

  tplChunk<q>     = "{{"                                 -- lbrace
                  | "{" applySyntactic<Expr<"">> "}"     -- expr
                  | tplRun<q>                            -- text
  tplRun<q>       = tplChar<q>+
  tplChar<q>      = escape | ~(q | "\\" | "\n" | "\r" | "{") any

  escape          = "\\" escSimple | "\\u" hex4
  escSimple       = "\"" | "'" | "\\" | "n" | "r" | "t" | "b" | "f"
  hex4            = hexDigit hexDigit hexDigit hexDigit

  ident           = identStart identRest*
  identStart      = "_" | letter
  identRest       = identStart | digit

  IdentList       = NonemptyListOf<ident, ",">
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
  | Slice
  | Lit
  | Template
  | Blank
  | Ident;

export interface Lambda {
  type: "Lambda";
  params: Ident[];
  body: Expr;
}

export interface Binary {
  type: "Binary";
  op: "!=" | "=" | "<=" | "<" | ">=" | ">" | "+" | "-" | "*" | "/";
  left: Expr;
  right: Expr;
}

export interface Unary {
  type: "Unary";
  op: "!" | "-" | "+" | "#";
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

export interface Slice {
  type: "Slice";
  start?: Expr;
  end?: Expr;
  step?: Expr;
}

export interface Lit {
  type: "Lit";
  value: true | number | string;
}

export interface Template {
  type: "Template";
  parts: (string | Expr)[];
}

export interface Blank {
  type: "Blank";
}

export interface Ident {
  type: "Ident";
  name: string;
}

/* Semantics */

const IMPLICIT_PARAM = "_";

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

function decodeEscapes(unquoted: string): string {
  const s = unquoted
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .replace(/"/g, '\\"');
  return JSON.parse(`"${s}"`);
}

const semantics = grammar.createSemantics().addAttribute("ast", {
  Lambda_paren(_open, maybeList, _close, _arrow, body) {
    return {
      type: "Lambda",
      params: (maybeList.children[0]?.ast ?? []) as Ident[],
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

  Pipe(first, _ops, rights) {
    return rights.children.reduce<Expr>((acc, node) => {
      const step = node.ast as Expr;
      if (step.type === "Call") {
        return { type: "Call", callee: step.callee, args: [acc, ...step.args] };
      }
      return { type: "Call", callee: step, args: [acc] };
    }, first.ast as Expr);
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

  Slice(start, _dots, end, _colon, step) {
    return {
      type: "Slice",
      start: start.children[0]?.ast as Expr | undefined,
      end: end.children[0]?.ast as Expr | undefined,
      step: step.children[0]?.ast as Expr | undefined,
    } as Slice;
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
  Prim_dotindex(_guard, _dot, _open, expr, _close) {
    return {
      type: "Index",
      block: { type: "Ident", name: IMPLICIT_PARAM },
      index: expr.ast,
    } as Index;
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
    return {
      type: "Lit",
      value: decodeEscapes(t.sourceString.slice(1, -1)),
    } as Lit;
  },

  tplLit(_amp, _open, chunks, _close) {
    return {
      type: "Template",
      parts: chunks.asIteration().children.map((c) => c.ast),
    } as Template;
  },

  tplChunk_lbrace(_lb) {
    return "{";
  },
  tplChunk_expr(_open, expr, _close) {
    return expr.ast as Expr;
  },
  tplChunk_text(run) {
    return decodeEscapes(run.sourceString);
  },

  IdentList(list) {
    return list
      .asIteration()
      .children.map((n) => ({ type: "Ident", name: n.sourceString }));
  },
});

/* Operators */

const BINARY_OPS: Partial<
  Record<Binary["op"], (a: DataSignal, b: DataSignal) => DataSignal>
> = {
  "!=": (a, b) => bool(primExpect(a) !== primExpect(b)),
  "=": (a, b) => bool(primExpect(a) === primExpect(b)),

  "<=": (a, b) => bool(numExpect(a) <= numExpect(b)),
  "<": (a, b) => bool(numExpect(a) < numExpect(b)),
  ">=": (a, b) => bool(numExpect(a) >= numExpect(b)),
  ">": (a, b) => bool(numExpect(a) > numExpect(b)),

  "+": mapNums((a, b) => a + b),
  "-": mapNums((a, b) => a - b),
  "*": mapNums((a, b) => a * b),
  "/": mapNums((a, b) => a / b),
};

const UNARY_OPS: Record<Unary["op"], (v: DataSignal) => DataSignal> = {
  "!": (v) => bool(!asJsBool(v)),

  "-": mapNums((x) => -x),
  "+": mapNums((x) => +x),

  "#": (v) => {
    const n = v.get();
    if (isBlank(n)) {
      return blank();
    }
    if (isBlock(n)) {
      return lit(n.values.length + n.items.length);
    }
    if (isLiteral(n) && typeof n.value === "string") {
      return lit(n.value.length);
    }
    throw new TypeError("Expected text or block");
  },
};

/* Evaluate */

function evalNumberOpt(
  e: Expr | undefined,
  scope: (name: string) => DataSignal
): number | null {
  if (!e) return null;
  const sig = evalExpr(e, scope);
  return numOpt(sig);
}

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
      const f = BINARY_OPS[op];
      if (f) return f(evalExpr(left, scope), evalExpr(right, scope));
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

    case "Index": {
      if ((e.index as any).type === "Slice") {
        const targetSig = evalExpr(e.block, scope);
        const target = targetSig.get();

        const slice = e.index as Slice;
        const startN = evalNumberOpt(slice.start, scope);
        const endN = evalNumberOpt(slice.end, scope);
        const stepN = evalNumberOpt(slice.step, scope);

        if (isLiteral(target) && typeof target.value === "string") {
          return lit(sliceText(target.value, startN, endN, stepN));
        }

        if (isBlock(target)) {
          return createSignal(sliceBlockItems(target, startN, endN, stepN));
        }

        throw new TypeError("Cannot slice a non-text or non-block value");
      }

      return getByKeyOrIndex(
        evalExpr(e.block, scope),
        evalExpr(e.index, scope)
      );
    }

    case "Member": {
      return getByKey(evalExpr(e.block, scope), e.key.name);
    }

    case "Slice": {
      const startN = evalNumberOpt(e.start, scope);
      const endN = evalNumberOpt(e.end, scope);
      const stepN = evalNumberOpt(e.step, scope);
      return createSignal(createRangeBlock(startN, endN, stepN));
    }

    case "Lit":
      return lit(e.value);

    case "Template": {
      let out = "";
      for (const p of e.parts) {
        if (typeof p === "string") {
          out += p;
        } else {
          const v = evalExpr(p, scope);
          out += textOpt(v) ?? "";
        }
      }
      return lit(out);
    }

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
