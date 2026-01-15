import * as ohm from "ohm-js";

import {
  type GroupContent,
  type BodyContent,
  isBlank,
  isScalar,
  createBlank,
  createScalar,
  createGroup,
  createSignal,
  primitiveToContent,
  isPresent,
  toNumber,
  toText,
  primExpect,
  numExpect,
  numOpt,
  textOpt,
  groupOpt,
  getByLabel,
  getByPositionOrLabel,
  resolveBody,
  ISSUE,
} from "./model";

/* Grammar */

const grammar = ohm.grammar(String.raw`
Script {
  Start         = Expr

  Expr          = Eq

  Eq            = Rel (("!=" | "=") Rel)*

  Rel           = Add (("<=" | "<" | ">=" | ">") Add)*

  Add           = Mul (("+" | "-") Mul)*

  Mul           = Unary (("*" | "/") Unary)*

  Unary         = ("!" | "-" | "+")* Path

  Path          = Prim PathPart*
  PathPart      = Call
                | Select
                | Member
                | Pipe

  Call          = "(" ListOf<Expr, ","> ")"

  Select        = "[" Expr "]"                                    -- expr

  Member        = "." ident

  Pipe          = ":" ident "(" ListOf<Expr, ","> ")"

  Prim          = Literal                                          -- lit
                | ident                                            -- ident
                | "(" Expr ")"                                     -- paren
                | "." "[" Expr "]"                                 -- dotsel
                | "." ident                                        -- dot

  Literal       = "blank"                                          -- blank
                | "true"                                           -- true
                | number                                           -- number
                | text                                             -- text

  number        = digit+ ("." digit+)? exponent?                   -- intdec
                | "." digit+ exponent?                             -- dot
  exponent      = ("e" | "E") ("+" | "-")? digit+

  text          = textLit<"\"">
                | textLit<"'">

  textLit<q>    = q textChar<q>* q
  textChar<q>   = escape | ~(q | "\\" | "\n" | "\r") any

  escape        = "\\" escSimple | "\\u" hex4
  escSimple     = "\"" | "'" | "\\" | "n" | "r" | "t" | "b" | "f"
  hex4          = hexDigit hexDigit hexDigit hexDigit

  ident         = ("_" | letter) ("_" | letter | digit)*
}
`);

/* AST types */

export type Expr =
  | Binary
  | Unary
  | Call
  | Select
  | Member
  | Lit
  | Blank
  | Ident;

export interface Binary {
  type: "Binary";
  op: "!=" | "=" | "<=" | "<" | ">=" | ">" | "+" | "-" | "*" | "/";
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

export interface Select {
  type: "Select";
  group: Expr;
  select: Expr;
}

export interface Member {
  type: "Member";
  group: Expr;
  label: Ident;
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
  label: string;
}

/* Semantics */

const IMPLICIT_PARAM = { type: "Ident", label: "_" } as Ident;

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
    return ops.children.reduceRight(
      (node, tok) => ({ type: "Unary", op: tok.sourceString, argument: node }),
      operand.ast
    ) as Expr;
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
  Select_expr(_open, expr, _close) {
    return (receiver: Expr): Select => ({
      type: "Select",
      group: receiver,
      select: expr.ast,
    });
  },
  Member(_dot, labelTok) {
    return (receiver: Expr): Member => ({
      type: "Member",
      group: receiver,
      label: { type: "Ident", label: labelTok.sourceString },
    });
  },
  Pipe(_colon, labelTok, _open, list, _close) {
    return (receiver: Expr): Call => ({
      type: "Call",
      callee: { type: "Ident", label: labelTok.sourceString },
      args: [receiver, ...list.asIteration().children.map((n) => n.ast)],
    });
  },

  Prim_ident(labelTok) {
    return { type: "Ident", label: labelTok.sourceString };
  },
  Prim_paren(_open, expr, _close) {
    return expr.ast;
  },
  Prim_dotsel(_dot, _open, expr, _close) {
    return {
      type: "Select",
      group: IMPLICIT_PARAM,
      select: expr.ast,
    } as Select;
  },
  Prim_dot(_dot, labelTok) {
    return {
      type: "Member",
      group: IMPLICIT_PARAM,
      label: { type: "Ident", label: labelTok.sourceString },
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
});

/* Operators */

function numericOp(
  map: (...numbers: number[]) => number,
  ...args: BodyContent[]
): number | null {
  const nums = args.map((a) => numOpt(a));
  if (nums.some((n) => n === null)) return null;
  return map(...(nums as number[]));
}

const BINARY_OPS: Partial<
  Record<
    Binary["op"],
    (a: BodyContent, b: BodyContent) => boolean | number | null
  >
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

const UNARY_OPS: Record<
  Unary["op"],
  (v: BodyContent) => boolean | number | null
> = {
  "!": (v) => !isPresent(v),
  "-": (v) => numericOp((x) => -x, v),
  "+": (v) => numericOp((x) => +x, v),
};

/* Library */

function contentFn(
  op: (...contents: BodyContent[]) => BodyContent
): (...args: BodyContent[]) => BodyContent {
  return (...args: BodyContent[]) => {
    const contents = Array.from({ length: op.length }, (_, i) =>
      i < args.length ? args[i]! : createBlank()
    );
    return op(...contents);
  };
}

type ArgSpec<T> =
  | { kind: "req"; convert: (content: BodyContent) => T | null }
  | { kind: "opt"; convert: (content: BodyContent) => T | null; fallback: T };

const reqNum = { kind: "req", convert: numOpt } as const;
const optNum = (d: number) =>
  ({ kind: "opt", convert: numOpt, fallback: d } as const);

const reqText = { kind: "req", convert: textOpt } as const;
const optText = (d: string) =>
  ({ kind: "opt", convert: textOpt, fallback: d } as const);

const reqGroup = { kind: "req", convert: groupOpt } as const;
const optGroup = (d: GroupContent) =>
  ({ kind: "opt", convert: groupOpt, fallback: d } as const);

function typedFn<A extends any[]>(
  specs: { [K in keyof A]: ArgSpec<A[K]> },
  impl: (...args: A) => BodyContent
): (...args: BodyContent[]) => BodyContent {
  return (...args: BodyContent[]) => {
    const inputs: BodyContent[] = Array.from({ length: specs.length }, (_, i) =>
      i < args.length ? args[i]! : createBlank()
    );

    const resolved: unknown[] = [];
    for (let i = 0; i < specs.length; i++) {
      const spec = specs[i]!;
      const v = spec.convert(inputs[i]!);
      if (spec.kind === "req") {
        if (v === null) return createBlank();
        resolved.push(v);
      } else {
        resolved.push(v === null ? spec.fallback : v);
      }
    }

    return impl(...(resolved as A));
  };
}

function groupNumbersOpt(group: GroupContent): number[] {
  const out: number[] = [];
  for (const { content } of group.items) {
    const v = resolveBody(content);
    if (isBlank(v)) continue;
    if (isScalar(v) && typeof v.value === "number") out.push(v.value);
    else throw new TypeError(ISSUE.numOrBlank);
  }
  return out;
}

function groupTextsOpt(group: GroupContent): string[] {
  const out: string[] = [];
  for (const { content } of group.items) {
    const v = resolveBody(content);
    if (isBlank(v)) continue;
    if (isScalar(v) && typeof v.value === "string") out.push(v.value);
    else throw new TypeError(ISSUE.textOrBlank);
  }
  return out;
}

function reduceNumbers(
  source: GroupContent,
  op: (nums: number[]) => number | null
): number | null {
  const nums = groupNumbersOpt(source);
  return nums.length ? op(nums) : null;
}

const library: Record<string, (...args: BodyContent[]) => BodyContent> = {
  /* Converters */

  to_flag: contentFn((v) => primitiveToContent(isPresent(v))),

  to_number: contentFn((v) => primitiveToContent(toNumber(v))),

  to_text: contentFn((v) => primitiveToContent(toText(v))),

  number_or: contentFn((content, fallback) => {
    const n = numOpt(content);
    return createScalar(n === null ? numOpt(fallback) ?? 0 : n);
  }),

  text_or: contentFn((content, fallback) => {
    const t = textOpt(content);
    return t === null ? createScalar(textOpt(fallback) ?? "") : createScalar(t);
  }),

  if_blank: contentFn((content, fallback) =>
    isBlank(content) ? fallback ?? createBlank() : content
  ),

  first_present: (...contents) => {
    for (const v of contents) if (!isBlank(v)) return v;
    return createBlank();
  },

  /* Logic */

  not: contentFn((v) => (isPresent(v) ? createBlank() : createScalar(true))),

  and: contentFn((l, r) =>
    isPresent(l) && isPresent(r) ? createScalar(true) : createBlank()
  ),

  or: contentFn((l, r) =>
    isPresent(l) || isPresent(r) ? createScalar(true) : createBlank()
  ),

  if: contentFn((cond, thenV, elseV) => (isPresent(cond) ? thenV : elseV)),

  /* Number */

  abs: typedFn([reqNum], (n) => createScalar(Math.abs(n))),

  round: typedFn([reqNum, optNum(0)], (n, p) => {
    const f = 10 ** p;
    return createScalar(Math.round(n * f) / f);
  }),

  ceil: typedFn([reqNum], (n) => createScalar(Math.ceil(n))),

  floor: typedFn([reqNum], (n) => createScalar(Math.floor(n))),

  clamp: typedFn(
    [
      reqNum,
      optNum(Number.NEGATIVE_INFINITY),
      optNum(Number.POSITIVE_INFINITY),
    ],
    (n, lo, hi) => createScalar(Math.min(Math.max(n, lo), hi))
  ),

  mod: typedFn([reqNum, optNum(1)], (d, m) => createScalar(((d % m) + m) % m)),

  /* Text */

  trim: typedFn([reqText], (t) => createScalar(t.trim())),

  contains: typedFn([reqText, reqText], (t, s) =>
    t.includes(s) ? createScalar(true) : createBlank()
  ),

  lower: typedFn([reqText], (t) => createScalar(t.toLowerCase())),

  upper: typedFn([reqText], (t) => createScalar(t.toUpperCase())),

  pad_start: typedFn(
    [reqText, optNum(0), optText(" ")],
    (t, targetLen, padText) => createScalar(t.padStart(targetLen, padText))
  ),

  pad_end: typedFn(
    [reqText, optNum(0), optText(" ")],
    (t, targetLen, padText) => createScalar(t.padEnd(targetLen, padText))
  ),

  split: typedFn([reqText, optText("")], (t, sep) => {
    return createGroup(
      t.split(sep).map((p) => ({ content: createSignal(createScalar(p)) }))
    );
  }),

  /* Groups */

  join: typedFn([reqGroup, optText(",")], (groupV, sep) => {
    const parts = groupTextsOpt(groupV);
    return parts.length ? createScalar(parts.join(sep)) : createBlank();
  }),

  count: typedFn([reqGroup], (source) =>
    createScalar(
      source.items.filter((c) => !isBlank(resolveBody(c.content))).length
    )
  ),

  count_blank: typedFn([reqGroup], (source) =>
    createScalar(
      source.items.filter((c) => isBlank(resolveBody(c.content))).length
    )
  ),

  /* Number reducers */

  sum: typedFn([reqGroup], (source) =>
    primitiveToContent(
      reduceNumbers(source, (ns) => ns.reduce((a, b) => a + b, 0))
    )
  ),

  avg: typedFn([reqGroup], (source) =>
    primitiveToContent(
      reduceNumbers(source, (ns) => ns.reduce((a, b) => a + b, 0) / ns.length)
    )
  ),

  min: typedFn([reqGroup], (source) =>
    primitiveToContent(reduceNumbers(source, (ns) => Math.min(...ns)))
  ),

  max: typedFn([reqGroup], (source) =>
    primitiveToContent(reduceNumbers(source, (ns) => Math.max(...ns)))
  ),
};

function callBuiltin(name: string, args: BodyContent[]): BodyContent {
  const fn = library[name] ?? library[name.toLowerCase()];
  if (!fn) throw new TypeError(`Unknown function: ${name}`);
  return fn(...args);
}

/* Interpret */

function interpretAst(
  e: Expr,
  context: (label: string) => BodyContent
): BodyContent {
  switch (e.type) {
    case "Binary": {
      const { op, left, right } = e;
      const f = BINARY_OPS[op]!;
      return primitiveToContent(
        f(interpretAst(left, context), interpretAst(right, context))
      );
    }

    case "Unary": {
      const f = UNARY_OPS[e.op]!;
      return primitiveToContent(f(interpretAst(e.argument, context)));
    }

    case "Call": {
      const callee = e.callee;
      if (callee.type !== "Ident") {
        throw new TypeError("Expected function name");
      }
      const name = callee.label;
      const args = e.args.map((a) => interpretAst(a, context));
      return callBuiltin(name, args);
    }

    case "Select": {
      const target = interpretAst(e.group, context);
      const positionOrLabel = interpretAst(e.select, context);
      return getByPositionOrLabel(target, positionOrLabel);
    }

    case "Member": {
      const target = interpretAst(e.group, context);
      return getByLabel(target, e.label.label);
    }

    case "Lit":
      return createScalar(e.value);

    case "Blank":
      return createBlank();

    case "Ident":
      return context(e.label);
  }
}

export function interpretExpr(
  code: string,
  context: (label: string) => BodyContent
): BodyContent {
  if (!code.trim()) return createBlank();
  const match = grammar.match(code, "Start");
  if (match.failed()) throw new SyntaxError(match.message);
  return interpretAst(semantics(match).ast, context);
}
