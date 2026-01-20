import * as ohm from "ohm-js";
import {
  type ItemId,
  type Scalar,
  type LabeledValue,
  type Value,
  type EvalEnv,
  V,
  isPresent,
  isTrue,
} from "./store";

const ISSUE = {
  literal: "Expected literal value",
  number: "Expected number",
  numOrBlank: "Expected number or blank",
  text: "Expected text",
  textOrBlank: "Expected text or blank",
  group: "Expected group",
  posLabelMustBeTextOrNumber: "Label/position must be text or number",
  unknownLabel: (label: string) => `Unknown label '${label}'`,
  labelOnNonItemGroup: (label: string) =>
    `Cannot access label '${label}' of non-item-group content`,
  positionFinite: "Position must be a finite number",
  positionOneBased: "Position must be 1 or greater",
  positionOutOfRange: (position: number, len: number) =>
    `Position ${position} is out of range (length ${len})`,
} as const;

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

const IMPLICIT_PARAM: Ident = { type: "Ident", label: "_" };

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
      right: (rights.children[i] as any).ast,
    }),
    (first as any).ast
  ) as Expr;
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
      (node: Expr, tok: any) => ({
        type: "Unary",
        op: tok.sourceString,
        argument: node,
      }),
      (operand as any).ast
    ) as Expr;
  },

  Path(prim, parts) {
    return parts.children.reduce(
      (node: Expr, p: any) => p.ast(node),
      (prim as any).ast
    ) as Expr;
  },

  Call(_open, list, _close) {
    return (callee: Expr): Call => ({
      type: "Call",
      callee,
      args: (list as any).asIteration().children.map((n: any) => n.ast),
    });
  },

  Select_expr(_open, expr, _close) {
    return (receiver: Expr): Select => ({
      type: "Select",
      group: receiver,
      select: (expr as any).ast,
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
      args: [
        receiver,
        ...(list as any).asIteration().children.map((n: any) => n.ast),
      ],
    });
  },

  Prim_ident(labelTok) {
    return { type: "Ident", label: labelTok.sourceString } as Ident;
  },

  Prim_paren(_open, expr, _close) {
    return (expr as any).ast;
  },

  Prim_dotsel(_dot, _open, expr, _close) {
    return {
      type: "Select",
      group: IMPLICIT_PARAM,
      select: (expr as any).ast,
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

function isBlank(v: Value): boolean {
  return v.kind === "blank";
}

function isScalar(v: Value): v is { kind: "scalar"; value: Scalar } {
  return v.kind === "scalar";
}

function isItemGroup(v: Value): v is { kind: "item-group"; items: ItemId[] } {
  return v.kind === "item-group";
}

function isValueGroup(
  v: Value
): v is { kind: "value-group"; items: LabeledValue[] } {
  return v.kind === "value-group";
}

function firstIssue(...vs: Value[]): Value | null {
  for (const v of vs) if (v.kind === "issue") return v;
  return null;
}

function primExpect(v: Value): Scalar {
  if (isScalar(v)) return v.value;
  throw new TypeError(ISSUE.literal);
}

function numOpt(v: Value): number | null {
  if (v.kind === "blank") return null;
  if (v.kind === "issue") throw new TypeError(v.message);

  if (v.kind === "scalar") {
    const x = v.value;
    if (typeof x === "number") return x;
    if (x === true) return 1;
    if (typeof x === "string") {
      const n = Number(x);
      return Number.isFinite(n) ? n : null;
    }
  }

  throw new TypeError(ISSUE.numOrBlank);
}

function textOpt(v: Value): string | null {
  if (v.kind === "blank") return null;
  if (v.kind === "issue") throw new TypeError(v.message);

  if (v.kind === "scalar" && typeof v.value === "string") return v.value;
  throw new TypeError(ISSUE.textOrBlank);
}

function numExpect(v: Value): number {
  if (v.kind === "issue") throw new TypeError(v.message);
  if (isScalar(v) && typeof v.value === "number") return v.value;
  throw new TypeError(ISSUE.number);
}

function toNumber(v: Value): number | null {
  if (v.kind === "blank") return null;
  if (v.kind === "issue") throw new TypeError(v.message);

  if (v.kind === "scalar") {
    const x = v.value;
    if (typeof x === "number") return x;
    if (x === true) return 1;
    if (typeof x === "string") {
      const n = Number(x);
      return Number.isFinite(n) ? n : null;
    }
  }
  return null;
}

function toText(v: Value): string | null {
  if (v.kind === "blank") return null;
  if (v.kind === "issue") throw new TypeError(v.message);

  if (v.kind === "scalar") return String(v.value);
  return null;
}

function primitiveToValue(x: boolean | number | string | null): Value {
  if (x === null || x === false) return V.blank();
  if (x === true) return V.scalar(true);
  return V.scalar(x);
}

function numericOp(
  map: (...nums: number[]) => number,
  ...args: Value[]
): number | null {
  const issue = firstIssue(...args);
  if (issue) throw new TypeError(issue.message);

  const nums = args.map((a) => numOpt(a));
  if (nums.some((n) => n === null)) return null;
  return map(...(nums as number[]));
}

function getItemGroupByLabel(group: Value, label: string, env: EvalEnv): Value {
  if (group.kind === "issue") return group;
  if (!isItemGroup(group)) return V.issue(ISSUE.labelOnNonItemGroup(label));

  const id = group.items.find((cid) => env.getLabel(cid) === label);
  if (id == null) return V.issue(ISSUE.unknownLabel(label));

  return env.resolve(id);
}

function getItemGroupByPosition(
  group: Value,
  position: number,
  env: EvalEnv
): Value {
  if (group.kind === "issue") return group;

  if (!Number.isFinite(position)) return V.issue(ISSUE.positionFinite);

  const index = Math.trunc(position) - 1;
  if (index < 0) return V.issue(ISSUE.positionOneBased);

  if (!isItemGroup(group))
    return V.issue("Cannot select a position from non-item-group content");

  const id = group.items[index];
  if (id == null)
    return V.issue(ISSUE.positionOutOfRange(position, group.items.length));

  return env.resolve(id);
}

function getValueGroupByPosition(group: Value, position: number): Value {
  if (group.kind === "issue") return group;

  if (!Number.isFinite(position)) return V.issue(ISSUE.positionFinite);

  const index = Math.trunc(position) - 1;
  if (index < 0) return V.issue(ISSUE.positionOneBased);

  if (!isValueGroup(group))
    return V.issue("Cannot select a position from non-value-group content");

  const it = group.items[index];
  if (it == null)
    return V.issue(ISSUE.positionOutOfRange(position, group.items.length));
  return it.value;
}

function getByPositionOrLabel(group: Value, selV: Value, env: EvalEnv): Value {
  if (group.kind === "issue") return group;
  if (selV.kind === "issue") return selV;

  if (isScalar(selV)) {
    const lit = selV.value;
    if (typeof lit === "number") {
      if (isItemGroup(group)) return getItemGroupByPosition(group, lit, env);
      if (isValueGroup(group)) return getValueGroupByPosition(group, lit);
      return V.issue("Cannot select a position from non-group content");
    }
    if (typeof lit === "string") {
      return getItemGroupByLabel(group, lit, env);
    }
  }
  return V.issue(ISSUE.posLabelMustBeTextOrNumber);
}

const BINARY_OPS: Record<
  Binary["op"],
  (a: Value, b: Value) => boolean | number | string | null
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
  (v: Value) => boolean | number | string | null
> = {
  "!": (v) => {
    if (v.kind === "issue") throw new TypeError(v.message);
    return !isTrue(v);
  },
  "-": (v) => numericOp((x) => -x, v),
  "+": (v) => numericOp((x) => +x, v),
};

type Builtin = (env: EvalEnv, ...args: Value[]) => Value;

function contentFn(op: (env: EvalEnv, ...args: Value[]) => Value): Builtin {
  return (env, ...args) => {
    const want = Math.max(0, op.length - 1);
    const filled = Array.from({ length: want }, (_, i) =>
      i < args.length ? args[i]! : V.blank()
    );
    return op(env, ...filled);
  };
}

type ArgSpec<T> =
  | { kind: "req"; convert: (v: Value) => T | null }
  | { kind: "opt"; convert: (v: Value) => T | null; fallback: T };

const reqNum = { kind: "req", convert: numOpt } as const;
const optNum = (d: number) =>
  ({ kind: "opt", convert: numOpt, fallback: d } as const);

const reqText = { kind: "req", convert: textOpt } as const;
const optText = (d: string) =>
  ({ kind: "opt", convert: textOpt, fallback: d } as const);

function typedFn<A extends unknown[]>(
  specs: { [K in keyof A]: ArgSpec<A[K]> },
  impl: (env: EvalEnv, ...args: A) => Value
): Builtin {
  return (env: EvalEnv, ...args: Value[]) => {
    for (const v of args) if (v.kind === "issue") return v;

    const inputs: Value[] = Array.from({ length: specs.length }, (_, i) =>
      i < args.length ? args[i]! : V.blank()
    );

    const resolved: unknown[] = [];
    for (let i = 0; i < specs.length; i++) {
      const spec = specs[i]!;
      const v = spec.convert(inputs[i]!);
      if (spec.kind === "req") {
        if (v === null) return V.blank();
        resolved.push(v);
      } else {
        resolved.push(v === null ? spec.fallback : v);
      }
    }
    return impl(env, ...(resolved as A));
  };
}

function iterGroupValues(g: Value, env: EvalEnv): Value[] {
  if (g.kind === "issue") throw new TypeError(g.message);
  if (isItemGroup(g)) return g.items.map((id) => env.resolve(id));
  if (isValueGroup(g)) return g.items.map((it) => it.value);
  throw new TypeError(ISSUE.group);
}

function groupNumbersOpt(g: Value, env: EvalEnv): number[] {
  const out: number[] = [];
  for (const v of iterGroupValues(g, env)) {
    if (v.kind === "issue") throw new TypeError(v.message);
    if (v.kind === "blank") continue;
    if (v.kind === "scalar" && typeof v.value === "number") out.push(v.value);
    else throw new TypeError(ISSUE.numOrBlank);
  }
  return out;
}

function groupTextsOpt(g: Value, env: EvalEnv): string[] {
  const out: string[] = [];
  for (const v of iterGroupValues(g, env)) {
    if (v.kind === "issue") throw new TypeError(v.message);
    if (v.kind === "blank") continue;
    if (v.kind === "scalar" && typeof v.value === "string") out.push(v.value);
    else throw new TypeError(ISSUE.textOrBlank);
  }
  return out;
}

function reduceNumbers(
  g: Value,
  env: EvalEnv,
  op: (ns: number[]) => number | null
): number | null {
  const ns = groupNumbersOpt(g, env);
  return ns.length ? op(ns) : null;
}

export const library: Record<string, Builtin> = {
  is_blank: contentFn((_env, v) => primitiveToValue(isBlank(v))),
  is_present: contentFn((_env, v) => primitiveToValue(isPresent(v))),
  is_true: contentFn((_env, v) => primitiveToValue(isTrue(v))),
  to_number: contentFn((_env, v) => primitiveToValue(toNumber(v))),
  to_text: contentFn((_env, v) => primitiveToValue(toText(v))),

  number_or: contentFn((_env, content, fallback) => {
    if (content.kind === "issue") return content;
    const n = numOpt(content);
    if (n !== null) return V.scalar(n);

    if (fallback.kind === "issue") return fallback;
    const fb = numOpt(fallback);
    return fb !== null ? V.scalar(fb) : V.blank();
  }),

  text_or: contentFn((_env, content, fallback) => {
    if (content.kind === "issue") return content;
    const t = textOpt(content);
    if (t !== null) return V.scalar(t);

    if (fallback.kind === "issue") return fallback;
    const fb = textOpt(fallback);
    return fb !== null ? V.scalar(fb) : V.blank();
  }),

  if_blank: contentFn((_env, content, fallback) => {
    if (content.kind === "issue") return content;
    return isBlank(content) ? fallback ?? V.blank() : content;
  }),

  if_issue: contentFn((_env, content, fallback) =>
    content.kind === "issue" ? fallback ?? V.blank() : content
  ),

  first_present: (_env, ...contents) => {
    for (const v of contents) {
      if (v.kind === "issue") return v;
      if (isPresent(v)) return v;
    }
    return V.blank();
  },

  not: contentFn((_env, v) => {
    if (v.kind === "issue") return v;
    return isTrue(v) ? V.blank() : V.scalar(true);
  }),

  and: contentFn((_env, l, r) => {
    if (l.kind === "issue") return l;
    if (r.kind === "issue") return r;
    return isTrue(l) && isTrue(r) ? V.scalar(true) : V.blank();
  }),

  or: contentFn((_env, l, r) => {
    if (l.kind === "issue") return l;
    if (r.kind === "issue") return r;
    return isTrue(l) || isTrue(r) ? V.scalar(true) : V.blank();
  }),

  if: contentFn((_env, cond, thenV, elseV) => {
    if (cond.kind === "issue") return cond;
    return isTrue(cond) ? thenV : elseV;
  }),

  abs: typedFn([reqNum], (_env, n) => V.scalar(Math.abs(n))),

  round: typedFn([reqNum, optNum(0)], (_env, n, p) => {
    const f = 10 ** p;
    return V.scalar(Math.round(n * f) / f);
  }),

  ceil: typedFn([reqNum], (_env, n) => V.scalar(Math.ceil(n))),

  floor: typedFn([reqNum], (_env, n) => V.scalar(Math.floor(n))),

  clamp: typedFn(
    [
      reqNum,
      optNum(Number.NEGATIVE_INFINITY),
      optNum(Number.POSITIVE_INFINITY),
    ],
    (_env, n, lo, hi) => V.scalar(Math.min(Math.max(n, lo), hi))
  ),

  mod: typedFn([reqNum, optNum(1)], (_env, d, m) =>
    V.scalar(((d % m) + m) % m)
  ),

  trim: typedFn([reqText], (_env, t) => V.scalar(t.trim())),

  contains: typedFn([reqText, reqText], (_env, t, s) =>
    t.includes(s) ? V.scalar(true) : V.blank()
  ),

  lower: typedFn([reqText], (_env, t) => V.scalar(t.toLowerCase())),

  upper: typedFn([reqText], (_env, t) => V.scalar(t.toUpperCase())),

  pad_start: typedFn(
    [reqText, optNum(0), optText(" ")],
    (_env, t, targetLen, padText) => V.scalar(t.padStart(targetLen, padText))
  ),

  pad_end: typedFn(
    [reqText, optNum(0), optText(" ")],
    (_env, t, targetLen, padText) => V.scalar(t.padEnd(targetLen, padText))
  ),

  split: typedFn([reqText, optText("")], (_env, t, sep) =>
    V.valueGroup(t.split(sep).map((p) => ({ value: V.scalar(p) })))
  ),

  join: typedFn(
    [
      {
        kind: "req",
        convert: (v: Value) => (isItemGroup(v) || isValueGroup(v) ? v : null),
      } as any,
      optText(","),
    ],
    (env, groupV: Value, sep: string) => {
      const parts = groupTextsOpt(groupV, env);
      return parts.length ? V.scalar(parts.join(sep)) : V.blank();
    }
  ),

  count: typedFn(
    [
      {
        kind: "req",
        convert: (v: Value) => (isItemGroup(v) || isValueGroup(v) ? v : null),
      } as any,
    ],
    (env, source: Value) => {
      const vs = iterGroupValues(source, env);
      return V.scalar(vs.filter((c) => c.kind !== "blank").length);
    }
  ),

  count_blank: typedFn(
    [
      {
        kind: "req",
        convert: (v: Value) => (isItemGroup(v) || isValueGroup(v) ? v : null),
      } as any,
    ],
    (env, source: Value) => {
      const vs = iterGroupValues(source, env);
      return V.scalar(vs.filter((c) => c.kind === "blank").length);
    }
  ),

  sum: typedFn(
    [
      {
        kind: "req",
        convert: (v: Value) => (isItemGroup(v) || isValueGroup(v) ? v : null),
      } as any,
    ],
    (env, source: Value) =>
      primitiveToValue(
        reduceNumbers(source, env, (ns) => ns.reduce((a, b) => a + b, 0))
      )
  ),

  avg: typedFn(
    [
      {
        kind: "req",
        convert: (v: Value) => (isItemGroup(v) || isValueGroup(v) ? v : null),
      } as any,
    ],
    (env, source: Value) =>
      primitiveToValue(
        reduceNumbers(
          source,
          env,
          (ns) => ns.reduce((a, b) => a + b, 0) / ns.length
        )
      )
  ),

  min: typedFn(
    [
      {
        kind: "req",
        convert: (v: Value) => (isItemGroup(v) || isValueGroup(v) ? v : null),
      } as any,
    ],
    (env, source: Value) =>
      primitiveToValue(reduceNumbers(source, env, (ns) => Math.min(...ns)))
  ),

  max: typedFn(
    [
      {
        kind: "req",
        convert: (v: Value) => (isItemGroup(v) || isValueGroup(v) ? v : null),
      } as any,
    ],
    (env, source: Value) =>
      primitiveToValue(reduceNumbers(source, env, (ns) => Math.max(...ns)))
  ),
};

function callBuiltin(env: EvalEnv, name: string, args: Value[]): Value {
  const fn = library[name] ?? library[name.toLowerCase()];
  if (!fn) throw new TypeError(`Unknown function: ${name}`);
  return fn(env, ...args);
}

function interpretAst(e: Expr, env: EvalEnv): Value {
  try {
    switch (e.type) {
      case "Binary": {
        const l = interpretAst(e.left, env);
        if (l.kind === "issue") return l;

        const r = interpretAst(e.right, env);
        if (r.kind === "issue") return r;

        return primitiveToValue(BINARY_OPS[e.op](l, r));
      }

      case "Unary": {
        const v = interpretAst(e.argument, env);
        if (v.kind === "issue") return v;

        return primitiveToValue(UNARY_OPS[e.op](v));
      }

      case "Call": {
        const callee = e.callee;
        if (callee.type !== "Ident")
          throw new TypeError("Expected function name");

        const args = e.args.map((a) => interpretAst(a, env));
        const issue = firstIssue(...args);
        if (issue) return issue;

        return callBuiltin(env, callee.label, args);
      }

      case "Select": {
        const target = interpretAst(e.group, env);
        if (target.kind === "issue") return target;

        const selV = interpretAst(e.select, env);
        if (selV.kind === "issue") return selV;

        return getByPositionOrLabel(target, selV, env);
      }

      case "Member": {
        const target = interpretAst(e.group, env);
        if (target.kind === "issue") return target;
        return getItemGroupByLabel(target, e.label.label, env);
      }

      case "Lit":
        return V.scalar(e.value);

      case "Blank":
        return V.blank();

      case "Ident":
        return env.lookup(e.label);
    }
  } catch (err) {
    return V.issue(err instanceof Error ? err.message : String(err));
  }
}

export function interpretExpr(code: string, env: EvalEnv): Value {
  if (!code.trim()) return V.blank();
  const match = grammar.match(code, "Start");
  if (match.failed()) return V.issue(match.message);
  return interpretAst((semantics(match) as any).ast, env);
}
