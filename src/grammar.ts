import * as ohm from "ohm-js";

import {
  ERR,
  type Content,
  type ContentSignal,
  isScalar,
  isGroup,
  isFunction,
  createBlank,
  createScalar,
  createFunction,
  createSignal,
  numOpt,
  textOpt,
  isTruthy,
  primExpect,
  numExpect,
  primitiveToContent,
  size,
  sliceText,
  sliceGroup,
  createRangeGroup,
  getByName,
  getByIndexOrName,
} from "./model";

/* Grammar */

const grammar = ohm.grammar(String.raw`
Script {
  Start         = Expr

  Expr          = Lambda

  Lambda        = "(" ListOf<ident, ","> ")" ("->" | "=>") Lambda  -- paren
                | ident ("->" | "=>") Lambda                       -- single
                | (&"." | &":") Eq                                 -- implicit
                | Eq                                               -- plain

  Eq            = Rel (("!=" | "=") Rel)*

  Rel           = Range (("<=" | "<" | ">=" | ">") Range)*

  Range         = Slice
                | Add

  Add           = Mul (("+" | "-") Mul)*

  Mul           = Unary (("*" | "/") Unary)*

  Unary         = ("!" | "-" | "+" | "#" | ":")* Path

  Path          = Prim PathPart*
  PathPart      = Call
                | Index
                | Member
                | Pipe

  Call          = "(" ListOf<Expr, ","> ")"

  Index         = "[" Slice "]"                                    -- slice
                | "[" Expr "]" "!"?                                -- expr

  Member        = "." ident "!"?

  Pipe          = ":" ident "(" ListOf<Expr, ","> ")"

  Slice         = Add? ".." Add? (":" Add?)?

  Prim          = Literal                                          -- lit
                | ident                                            -- ident
                | "(" Expr ")"                                     -- paren
                | "." "[" Expr "]" "!"?                            -- dotindex
                | "." ident "!"?                                   -- dot

  Literal       = "blank"                                          -- blank
                | "true"                                           -- true
                | number                                           -- number
                | text                                             -- text
                | template                                         -- tpl

  number        = digit+ ("." digit+)? exponent?                   -- intdec
                | "." digit+ exponent?                             -- dot
  exponent      = ("e" | "E") ("+" | "-")? digit+

  text          = textLit<"\"">
                | textLit<"'">
  template      = tplLit<"\"">
                | tplLit<"'">

  textLit<q>    = q textChar<q>* q
  tplLit<q>     = "&" q tplChunk<q>* q

  textChar<q>   = escape | ~(q | "\\" | "\n" | "\r") any

  tplChunk<q>   = "{{"                                             -- lbrace
                | "{" applySyntactic<Expr> "}"                     -- expr
                | tplRun<q>                                        -- text
  tplRun<q>     = tplChar<q>+
  tplChar<q>    = escape | ~(q | "\\" | "\n" | "\r" | "{") any

  escape        = "\\" escSimple | "\\u" hex4
  escSimple     = "\"" | "'" | "\\" | "n" | "r" | "t" | "b" | "f"
  hex4          = hexDigit hexDigit hexDigit hexDigit

  ident         = ("_" | letter) ("_" | letter | digit)*
}
`);

/* AST types */

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
  group: Expr;
  index: Expr;
  required: boolean;
}

export interface Member {
  type: "Member";
  group: Expr;
  name: Ident;
  required: boolean;
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

const IMPLICIT_PARAM = { type: "Ident", name: "_" } as Ident;

function buildBinaryChain(
  first: ohm.Node,
  ops: ohm.Node,
  rights: ohm.Node
): Expr {
  return ops.children.reduce(
    (node, opNode, i) => ({
      type: "Binary",
      op: opNode.sourceString,
      left: node,
      right: rights.children[i]!.ast,
    }),
    first.ast
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
  Lambda_paren(_open, list, _close, _arrow, body) {
    return {
      type: "Lambda",
      params: list
        .asIteration()
        .children.map((n) => ({ type: "Ident", name: n.sourceString })),
      body: body.ast,
    } as Lambda;
  },
  Lambda_single(nameTok, _arrow, body) {
    return {
      type: "Lambda",
      params: [{ type: "Ident", name: nameTok.sourceString }],
      body: body.ast,
    } as Lambda;
  },
  Lambda_implicit(_guard, body) {
    return {
      type: "Lambda",
      params: [IMPLICIT_PARAM],
      body: body.ast,
    } as Lambda;
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
    return ops.children.reduceRight((node, tok) => {
      if (tok.sourceString === ":") {
        return node.type === "Call"
          ? { ...node, args: [IMPLICIT_PARAM, ...node.args] }
          : { type: "Call", callee: node, args: [IMPLICIT_PARAM] };
      }
      return { type: "Unary", op: tok.sourceString, argument: node };
    }, operand.ast) as Expr;
  },

  Path(prim, parts) {
    return parts.children.reduce((node, p) => p.ast(node), prim.ast) as Expr;
  },
  Call(_open, list, _close) {
    return (callee: Expr): Call => ({
      type: "Call",
      callee,
      args: list.asIteration().children.map((n) => n.ast),
    });
  },
  Index_slice(_open, expr, _close) {
    return (receiver: Expr): Index => ({
      type: "Index",
      group: receiver,
      index: expr.ast,
      required: false,
    });
  },
  Index_expr(_open, expr, _close, maybeBang) {
    return (receiver: Expr): Index => ({
      type: "Index",
      group: receiver,
      index: expr.ast,
      required: !!maybeBang.sourceString,
    });
  },
  Member(_dot, nameTok, maybeBang) {
    return (receiver: Expr): Member => ({
      type: "Member",
      group: receiver,
      name: { type: "Ident", name: nameTok.sourceString },
      required: !!maybeBang.sourceString,
    });
  },
  Pipe(_colon, nameTok, _open, list, _close) {
    return (receiver: Expr): Call => ({
      type: "Call",
      callee: { type: "Ident", name: nameTok.sourceString },
      args: [receiver, ...list.asIteration().children.map((n) => n.ast)],
    });
  },

  Slice(start, _dots, end, _colon, step) {
    return {
      type: "Slice",
      start: start.children[0]?.ast,
      end: end.children[0]?.ast,
      step: step.children[0]?.ast,
    } as Slice;
  },

  Prim_ident(nameTok) {
    return { type: "Ident", name: nameTok.sourceString };
  },
  Prim_paren(_open, expr, _close) {
    return expr.ast;
  },
  Prim_dotindex(_dot, _open, expr, _close, maybeBang) {
    return {
      type: "Index",
      group: IMPLICIT_PARAM,
      index: expr.ast,
      required: !!maybeBang.sourceString,
    } as Index;
  },
  Prim_dot(_dot, nameTok, maybeBang) {
    return {
      type: "Member",
      group: IMPLICIT_PARAM,
      name: { type: "Ident", name: nameTok.sourceString },
      required: !!maybeBang.sourceString,
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
});

/* Operators */

function numericOp(
  map: (...numbers: number[]) => number,
  ...args: Content[]
): number | null {
  const nums = args.map((a) => numOpt(a));
  if (nums.some((n) => n === null)) return null;
  return map(...(nums as number[]));
}

const BINARY_OPS: Partial<
  Record<Binary["op"], (a: Content, b: Content) => boolean | number | null>
> = {
  "!=": (a, b) => primExpect(a) !== primExpect(b),
  "=": (a, b) => primExpect(a) === primExpect(b),

  "<=": (a, b) => numExpect(a) <= numExpect(b),
  "<": (a, b) => numExpect(a) < numExpect(b),
  ">=": (a, b) => numExpect(a) >= numExpect(b),
  ">": (a, b) => numExpect(a) > numExpect(b),

  "+": (a, b) => numericOp((x, y) => x + y, a, b),
  "-": (a, b) => numericOp((x, y) => x - y, a, b),
  "*": (a, b) => numericOp((x, y) => x * y, a, b),
  "/": (a, b) => numericOp((x, y) => x / y, a, b),
};

const UNARY_OPS: Record<Unary["op"], (v: Content) => boolean | number | null> =
  {
    "!": (v) => !isTruthy(v),

    "-": (v) => numericOp((x) => -x, v),
    "+": (v) => numericOp((x) => +x, v),

    "#": (v) => size(v),
  };

/* Evaluation */

function evalNumberOpt(
  e: Expr | undefined,
  scope: (name: string) => ContentSignal
): number | null {
  if (!e) return null;
  const sig = evalExpr(e, scope);
  return numOpt(sig.get());
}

function evalExpr(
  e: Expr,
  scope: (name: string) => ContentSignal
): ContentSignal {
  switch (e.type) {
    case "Lambda": {
      const params = e.params.map((p) => p.name);
      return createSignal(
        createFunction((...args: ContentSignal[]) =>
          evalExpr(e.body, (name: string) => {
            const i = params.indexOf(name);
            if (i !== -1) return args[i] ?? createSignal(createBlank());
            return scope(name);
          })
        )
      );
    }

    case "Binary": {
      const { op, left, right } = e;
      const f = BINARY_OPS[op]!;
      return createSignal(
        primitiveToContent(
          f(evalExpr(left, scope).get(), evalExpr(right, scope).get())
        )
      );
    }

    case "Unary": {
      const f = UNARY_OPS[e.op]!;
      return createSignal(
        primitiveToContent(f(evalExpr(e.argument, scope).get()))
      );
    }

    case "Call": {
      const callee = evalExpr(e.callee, scope).get();
      if (!isFunction(callee)) {
        throw new TypeError(ERR.function);
      }
      return callee.fn(...e.args.map((a) => evalExpr(a, scope)));
    }

    case "Index": {
      if (e.index.type === "Slice") {
        const targetSig = evalExpr(e.group, scope);
        const target = targetSig.get();

        const startN = evalNumberOpt(e.index.start, scope);
        const endN = evalNumberOpt(e.index.end, scope);
        const stepN = evalNumberOpt(e.index.step, scope);

        if (isScalar(target) && typeof target.value === "string") {
          return createSignal(
            createScalar(sliceText(target.value, startN, endN, stepN))
          );
        }

        if (isGroup(target)) {
          return createSignal(sliceGroup(target, startN, endN, stepN));
        }

        return createSignal(createBlank());
      }

      const target = evalExpr(e.group, scope).get();
      const indexOrName = evalExpr(e.index, scope).get();
      return createSignal(getByIndexOrName(target, indexOrName, e.required));
    }

    case "Member": {
      const target = evalExpr(e.group, scope).get();
      return createSignal(getByName(target, e.name.name, e.required));
    }

    case "Slice": {
      const startN = evalNumberOpt(e.start, scope);
      const endN = evalNumberOpt(e.end, scope);
      const stepN = evalNumberOpt(e.step, scope);
      return createSignal(createRangeGroup(startN, endN, stepN));
    }

    case "Lit":
      return createSignal(createScalar(e.value));

    case "Template": {
      let out = "";
      for (const p of e.parts) {
        if (typeof p === "string") {
          out += p;
        } else {
          const v = evalExpr(p, scope);
          out += textOpt(v.get()) ?? "";
        }
      }
      return createSignal(createScalar(out));
    }

    case "Blank":
      return createSignal(createBlank());

    case "Ident":
      return scope(e.name);
  }
}

export function evalCode(
  code: string,
  scope: (name: string) => ContentSignal
): Content {
  if (!code.trim()) return createBlank();
  const match = grammar.match(code, "Start");
  if (match.failed()) throw new SyntaxError(match.message);
  return evalExpr(semantics(match).ast, scope).get();
}
