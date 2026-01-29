import * as ohm from "ohm-js";
import {
  type Value,
  V,
  isPresent,
  isTrue,
  isBlankValue,
  isIssueValue,
  isScalarValue,
  isItemGroupValue,
  isValueGroupValue,
  type EvalEnv,
} from "./compute";

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
  selectPosNonItemGroup: "Cannot select a position from non-item-group content",
  selectPosNonValueGroup:
    "Cannot select a position from non-value-group content",
  selectPosNonGroup: "Cannot select a position from non-group content",
  fnName: "Expected function name",
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
  rights: ohm.Node,
): Expr {
  return ops.children.reduce<Expr>(
    (node, opNode, i) => ({
      type: "Binary",
      op: opNode.sourceString as Binary["op"],
      left: node,
      right: rights.children[i]!.ast,
    }),
    first.ast,
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
    return ops.children.reduceRight<Expr>(
      (node, tok) => ({
        type: "Unary",
        op: tok.sourceString as Unary["op"],
        argument: node,
      }),
      operand.ast,
    );
  },

  Path(prim, parts) {
    return parts.children.reduce((node, p) => p.ast(node), prim.ast);
  },

  Call(_open, list, _close) {
    const args = list.asIteration().children.map((n) => n.ast);
    return (callee: Expr): Call => ({ type: "Call", callee, args });
  },

  Select_expr(_open, expr, _close) {
    const select = expr.ast;
    return (receiver: Expr): Select => ({
      type: "Select",
      group: receiver,
      select,
    });
  },

  Member(_dot, labelTok) {
    const label: Ident = { type: "Ident", label: labelTok.sourceString };
    return (receiver: Expr): Member => ({
      type: "Member",
      group: receiver,
      label,
    });
  },

  Pipe(_colon, labelTok, _open, list, _close) {
    const extra = list.asIteration().children.map((n) => n.ast);
    return (receiver: Expr): Call => ({
      type: "Call",
      callee: { type: "Ident", label: labelTok.sourceString },
      args: [receiver, ...extra],
    });
  },

  Prim_ident(labelTok) {
    const ident: Ident = { type: "Ident", label: labelTok.sourceString };
    return ident;
  },

  Prim_paren(_open, expr, _close) {
    return expr.ast;
  },

  Prim_dotsel(_dot, _open, expr, _close) {
    const select: Select = {
      type: "Select",
      group: IMPLICIT_PARAM,
      select: expr.ast,
    };
    return select;
  },

  Prim_dot(_dot, labelTok) {
    const member: Member = {
      type: "Member",
      group: IMPLICIT_PARAM,
      label: { type: "Ident", label: labelTok.sourceString },
    };
    return member;
  },

  Literal_blank(_) {
    const blank: Blank = { type: "Blank" };
    return blank;
  },

  Literal_true(_) {
    const lit: Lit = { type: "Lit", value: true };
    return lit;
  },

  Literal_number(n) {
    const lit: Lit = { type: "Lit", value: Number(n.sourceString) };
    return lit;
  },

  Literal_text(t) {
    const lit: Lit = {
      type: "Lit",
      value: decodeEscapes(t.sourceString.slice(1, -1)),
    };
    return lit;
  },
});

type IssueValue = Extract<Value, { kind: "issue" }>;

function firstIssue(...vs: Value[]): IssueValue | null {
  for (const v of vs) if (isIssueValue(v)) return v;
  return null;
}

function ensureNotIssue(v: Value): Value {
  if (isIssueValue(v)) throw new TypeError(v.message);
  return v;
}

function primExpect(v: Value): true | number | string {
  if (isScalarValue(v)) return v.value;
  throw new TypeError(ISSUE.literal);
}

function numOpt(v: Value): number | null {
  if (isBlankValue(v)) return null;
  if (isIssueValue(v)) throw new TypeError(v.message);

  if (isScalarValue(v)) {
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
  if (isBlankValue(v)) return null;
  if (isIssueValue(v)) throw new TypeError(v.message);
  if (isScalarValue(v) && typeof v.value === "string") return v.value;
  throw new TypeError(ISSUE.textOrBlank);
}

function numExpect(v: Value): number {
  if (isIssueValue(v)) throw new TypeError(v.message);
  if (isScalarValue(v) && typeof v.value === "number") return v.value;
  throw new TypeError(ISSUE.number);
}

function toNumber(v: Value): number | null {
  if (isBlankValue(v)) return null;
  if (isIssueValue(v)) throw new TypeError(v.message);

  if (isScalarValue(v)) {
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
  if (isBlankValue(v)) return null;
  if (isIssueValue(v)) throw new TypeError(v.message);
  if (isScalarValue(v)) return String(v.value);
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

  const nums = args.map(numOpt);
  if (nums.some((n) => n === null)) return null;
  return map(...(nums as number[]));
}

function getItemGroupByLabel(group: Value, label: string, env: EvalEnv): Value {
  if (isIssueValue(group)) return group;
  if (!isItemGroupValue(group))
    return V.issue(ISSUE.labelOnNonItemGroup(label));

  const want = label;
  const id = group.itemIds.find((cid) => env.getLabel(cid) === want);
  if (id == null) return V.issue(ISSUE.unknownLabel(label));
  return env.resolve(id);
}

function normalizePosition(position: number): { index: number } | Value {
  if (!Number.isFinite(position)) return V.issue(ISSUE.positionFinite);
  const index = Math.trunc(position) - 1;
  if (index < 0) return V.issue(ISSUE.positionOneBased);
  return { index };
}

function getItemGroupByPosition(
  group: Value,
  position: number,
  env: EvalEnv,
): Value {
  if (isIssueValue(group)) return group;

  const norm = normalizePosition(position);
  if ("kind" in norm) return norm;

  if (!isItemGroupValue(group)) return V.issue(ISSUE.selectPosNonItemGroup);

  const id = group.itemIds[norm.index];
  if (id == null)
    return V.issue(ISSUE.positionOutOfRange(position, group.itemIds.length));
  return env.resolve(id);
}

function getValueGroupByPosition(group: Value, position: number): Value {
  if (isIssueValue(group)) return group;

  const norm = normalizePosition(position);
  if ("kind" in norm) return norm;

  if (!isValueGroupValue(group)) return V.issue(ISSUE.selectPosNonValueGroup);

  const it = group.items[norm.index];
  if (it == null)
    return V.issue(ISSUE.positionOutOfRange(position, group.items.length));
  return it.value;
}

function getByPositionOrLabel(group: Value, selV: Value, env: EvalEnv): Value {
  if (isIssueValue(group)) return group;
  if (isIssueValue(selV)) return selV;

  if (isScalarValue(selV)) {
    const lit = selV.value;
    if (typeof lit === "number") {
      if (isItemGroupValue(group))
        return getItemGroupByPosition(group, lit, env);
      if (isValueGroupValue(group)) return getValueGroupByPosition(group, lit);
      return V.issue(ISSUE.selectPosNonGroup);
    }
    if (typeof lit === "string") return getItemGroupByLabel(group, lit, env);
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
  "!": (v) => !isTrue(ensureNotIssue(v)),
  "-": (v) => numericOp((x) => -x, v),
  "+": (v) => numericOp((x) => +x, v),
};

type Builtin = (env: EvalEnv, ...args: Value[]) => Value;

function contentFn(op: (env: EvalEnv, ...args: Value[]) => Value): Builtin {
  return (env, ...args) => {
    const want = Math.max(0, op.length - 1);
    const filled = Array.from({ length: want }, (_, i) => args[i] ?? V.blank());
    return op(env, ...filled);
  };
}

type ArgSpec<T> =
  | { kind: "req"; convert: (v: Value) => T | null }
  | { kind: "opt"; convert: (v: Value) => T | null; fallback: T };

const reqNum = { kind: "req", convert: numOpt } as const;
const optNum = (d: number) =>
  ({ kind: "opt", convert: numOpt, fallback: d }) as const;

const reqText = { kind: "req", convert: textOpt } as const;
const optText = (d: string) =>
  ({ kind: "opt", convert: textOpt, fallback: d }) as const;

function typedFn<A extends unknown[]>(
  specs: { [K in keyof A]: ArgSpec<A[K]> },
  impl: (env: EvalEnv, ...args: A) => Value,
): Builtin {
  return (env, ...args) => {
    const issue = firstIssue(...args);
    if (issue) return issue;

    const inputs = Array.from(
      { length: specs.length },
      (_, i) => args[i] ?? V.blank(),
    );

    const resolved: unknown[] = [];
    for (let i = 0; i < specs.length; i++) {
      const spec = specs[i]!;
      const v = spec.convert(inputs[i]!);
      if (spec.kind === "req") {
        if (v === null) return V.blank();
        resolved.push(v);
      } else {
        resolved.push(v ?? spec.fallback);
      }
    }
    return impl(env, ...(resolved as A));
  };
}

function iterGroupValues(g: Value, env: EvalEnv): Value[] {
  if (isIssueValue(g)) throw new TypeError(g.message);
  if (isItemGroupValue(g)) return g.itemIds.map((id) => env.resolve(id));
  if (isValueGroupValue(g)) return g.items.map((it) => it.value);
  throw new TypeError(ISSUE.group);
}

function groupNumbersOpt(g: Value, env: EvalEnv): number[] {
  const out: number[] = [];
  for (const v of iterGroupValues(g, env)) {
    if (isIssueValue(v)) throw new TypeError(v.message);
    if (isBlankValue(v)) continue;
    if (isScalarValue(v) && typeof v.value === "number") out.push(v.value);
    else throw new TypeError(ISSUE.numOrBlank);
  }
  return out;
}

function groupTextsOpt(g: Value, env: EvalEnv): string[] {
  const out: string[] = [];
  for (const v of iterGroupValues(g, env)) {
    if (isIssueValue(v)) throw new TypeError(v.message);
    if (isBlankValue(v)) continue;
    if (isScalarValue(v) && typeof v.value === "string") out.push(v.value);
    else throw new TypeError(ISSUE.textOrBlank);
  }
  return out;
}

function reduceNumbers(
  g: Value,
  env: EvalEnv,
  op: (ns: number[]) => number | null,
): number | null {
  const ns = groupNumbersOpt(g, env);
  return ns.length ? op(ns) : null;
}

const groupSpec = {
  kind: "req",
  convert: (v: Value) =>
    isItemGroupValue(v) || isValueGroupValue(v) ? v : null,
} as const;

export const builtins: Record<string, Builtin> = {
  is_blank: contentFn((_env, v) => primitiveToValue(isBlankValue(v))),
  is_present: contentFn((_env, v) => primitiveToValue(isPresent(v))),
  is_true: contentFn((_env, v) => primitiveToValue(isTrue(v))),
  to_number: contentFn((_env, v) => primitiveToValue(toNumber(v))),
  to_text: contentFn((_env, v) => primitiveToValue(toText(v))),

  number_or: contentFn((_env, content, fallback) => {
    if (isIssueValue(content)) return content;
    const n = numOpt(content);
    if (n !== null) return V.scalar(n);

    if (isIssueValue(fallback)) return fallback;
    const fb = numOpt(fallback);
    return fb !== null ? V.scalar(fb) : V.blank();
  }),

  text_or: contentFn((_env, content, fallback) => {
    if (isIssueValue(content)) return content;
    const t = textOpt(content);
    if (t !== null) return V.scalar(t);

    if (isIssueValue(fallback)) return fallback;
    const fb = textOpt(fallback);
    return fb !== null ? V.scalar(fb) : V.blank();
  }),

  if_blank: contentFn((_env, content, fallback) => {
    if (isIssueValue(content)) return content;
    return isBlankValue(content) ? (fallback ?? V.blank()) : content;
  }),

  if_issue: contentFn((_env, content, fallback) =>
    isIssueValue(content) ? (fallback ?? V.blank()) : content,
  ),

  first_present: (_env, ...contents) => {
    for (const v of contents) {
      if (isIssueValue(v)) return v;
      if (isPresent(v)) return v;
    }
    return V.blank();
  },

  not: contentFn((_env, v) => {
    if (isIssueValue(v)) return v;
    return isTrue(v) ? V.blank() : V.scalar(true);
  }),

  and: contentFn((_env, l, r) => {
    if (isIssueValue(l)) return l;
    if (isIssueValue(r)) return r;
    return isTrue(l) && isTrue(r) ? V.scalar(true) : V.blank();
  }),

  or: contentFn((_env, l, r) => {
    if (isIssueValue(l)) return l;
    if (isIssueValue(r)) return r;
    return isTrue(l) || isTrue(r) ? V.scalar(true) : V.blank();
  }),

  if: contentFn((_env, cond, thenV, elseV) => {
    if (isIssueValue(cond)) return cond;
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
    (_env, n, lo, hi) => V.scalar(Math.min(Math.max(n, lo), hi)),
  ),

  mod: typedFn([reqNum, optNum(1)], (_env, d, m) =>
    V.scalar(((d % m) + m) % m),
  ),

  trim: typedFn([reqText], (_env, t) => V.scalar(t.trim())),

  contains: typedFn([reqText, reqText], (_env, t, s) =>
    t.includes(s) ? V.scalar(true) : V.blank(),
  ),

  lower: typedFn([reqText], (_env, t) => V.scalar(t.toLowerCase())),

  upper: typedFn([reqText], (_env, t) => V.scalar(t.toUpperCase())),

  pad_start: typedFn(
    [reqText, optNum(0), optText(" ")],
    (_env, t, targetLen, padText) => V.scalar(t.padStart(targetLen, padText)),
  ),

  pad_end: typedFn(
    [reqText, optNum(0), optText(" ")],
    (_env, t, targetLen, padText) => V.scalar(t.padEnd(targetLen, padText)),
  ),

  split: typedFn([reqText, optText("")], (_env, t, sep) =>
    V.valueGroup(t.split(sep).map((p) => ({ value: V.scalar(p) }))),
  ),

  join: typedFn(
    [groupSpec, optText(",")],
    (env, groupV: Value, sep: string) => {
      const parts = groupTextsOpt(groupV, env);
      return parts.length ? V.scalar(parts.join(sep)) : V.blank();
    },
  ),

  count: typedFn([groupSpec], (env, source: Value) => {
    const vs = iterGroupValues(source, env);
    return V.scalar(vs.filter((c) => !isBlankValue(c)).length);
  }),

  count_blank: typedFn([groupSpec], (env, source: Value) => {
    const vs = iterGroupValues(source, env);
    return V.scalar(vs.filter((c) => isBlankValue(c)).length);
  }),

  sum: typedFn([groupSpec], (env, source: Value) =>
    primitiveToValue(
      reduceNumbers(source, env, (ns) => ns.reduce((a, b) => a + b, 0)),
    ),
  ),

  avg: typedFn([groupSpec], (env, source: Value) =>
    primitiveToValue(
      reduceNumbers(
        source,
        env,
        (ns) => ns.reduce((a, b) => a + b, 0) / ns.length,
      ),
    ),
  ),

  min: typedFn([groupSpec], (env, source: Value) =>
    primitiveToValue(reduceNumbers(source, env, (ns) => Math.min(...ns))),
  ),

  max: typedFn([groupSpec], (env, source: Value) =>
    primitiveToValue(reduceNumbers(source, env, (ns) => Math.max(...ns))),
  ),
};

function callBuiltin(env: EvalEnv, name: string, args: Value[]): Value {
  const fn = builtins[name] ?? builtins[name.toLowerCase()];
  if (!fn) throw new TypeError(`Unknown function: ${name}`);
  return fn(env, ...args);
}

function interpretAst(e: Expr, env: EvalEnv): Value {
  try {
    switch (e.type) {
      case "Binary": {
        const l = interpretAst(e.left, env);
        if (isIssueValue(l)) return l;

        const r = interpretAst(e.right, env);
        if (isIssueValue(r)) return r;

        return primitiveToValue(BINARY_OPS[e.op](l, r));
      }

      case "Unary": {
        const v = interpretAst(e.argument, env);
        if (isIssueValue(v)) return v;
        return primitiveToValue(UNARY_OPS[e.op](v));
      }

      case "Call": {
        const callee = e.callee;
        if (callee.type !== "Ident") throw new TypeError(ISSUE.fnName);

        const args = e.args.map((a) => interpretAst(a, env));
        const issue = firstIssue(...args);
        if (issue) return issue;

        return callBuiltin(env, callee.label, args);
      }

      case "Select": {
        const target = interpretAst(e.group, env);
        if (isIssueValue(target)) return target;

        const selV = interpretAst(e.select, env);
        if (isIssueValue(selV)) return selV;

        return getByPositionOrLabel(target, selV, env);
      }

      case "Member": {
        const target = interpretAst(e.group, env);
        if (isIssueValue(target)) return target;
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
  if (match.failed()) return V.issue(match.message ?? "Parse error");
  return interpretAst(semantics(match).ast, env);
}
