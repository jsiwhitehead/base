import * as ohm from "ohm-js";

import type { EvalEnv, Result } from "./eval";
import {
  Results,
  isBlankResult,
  isEntryGroupResult,
  isIssueResult,
  isPresent,
  isResultGroupResult,
  isScalarResult,
  isTrue,
} from "./eval";

const ISSUE = {
  literal: "Expected literal value",
  number: "Expected number",
  numOrBlank: "Expected number or blank",
  text: "Expected text",
  textOrBlank: "Expected text or blank",
  group: "Expected group",
  posLabelMustBeTextOrNumber: "Label/position must be text or number",
  unknownLabel: (label: string) => `Unknown label '${label}'`,
  labelOnNonEntryGroup: (label: string) =>
    `Cannot access label '${label}' of non-entry-group content`,
  positionFinite: "Position must be a finite number",
  positionOneBased: "Position must be 1 or greater",
  positionOutOfRange: (position: number, len: number) =>
    `Position ${position} is out of range (length ${len})`,
  selectPosNonEntryGroup:
    "Cannot select a position from non-entry-group content",
  selectPosNonResultGroup:
    "Cannot select a position from non-result-group content",
  selectPosNonGroup: "Cannot select a position from non-group content",
  fnName: "Expected function name",
} as const;

const GRAMMAR = ohm.grammar(String.raw`
Script {
  Start         = Expr

  Expr          = Or

  Or            = And ("or" And)*

  And           = Eq ("and" Eq)*

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

type Expr = Binary | Unary | Call | Select | Member | Lit | Blank | Ident;
type IssueResult = Extract<Result, { type: "issue" }>;

type PrimitiveBinaryOp =
  | "!="
  | "="
  | "<="
  | "<"
  | ">="
  | ">"
  | "+"
  | "-"
  | "*"
  | "/";

type LogicalBinaryOp = "and" | "or";

interface Binary {
  type: "Binary";
  op: PrimitiveBinaryOp | LogicalBinaryOp;
  left: Expr;
  right: Expr;
}

interface Unary {
  type: "Unary";
  op: "!" | "-" | "+";
  argument: Expr;
}

interface Call {
  type: "Call";
  callee: Expr;
  args: Expr[];
}

interface Select {
  type: "Select";
  group: Expr;
  select: Expr;
}

interface Member {
  type: "Member";
  group: Expr;
  label: Ident;
}

interface Lit {
  type: "Lit";
  value: true | number | string;
}

interface Blank {
  type: "Blank";
}

interface Ident {
  type: "Ident";
  label: string;
}

const IMPLICIT_PARAM: Ident = { type: "Ident", label: "_" };

function assertNever(_exhaustive: never, message: string): never {
  throw new TypeError(message);
}

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

const SEMANTICS = GRAMMAR.createSemantics().addAttribute("ast", {
  Expr(expr) {
    return expr.ast;
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

function firstIssue(...results: Result[]): IssueResult | null {
  for (const result of results) if (isIssueResult(result)) return result;
  return null;
}

function ensureNotIssue(result: Result): Result {
  if (isIssueResult(result)) throw new TypeError(result.message);
  return result;
}

function primExpect(result: Result): true | number | string {
  if (isScalarResult(result)) return result.result;
  throw new TypeError(ISSUE.literal);
}

function numOpt(result: Result): number | null {
  if (isBlankResult(result)) return null;
  if (isIssueResult(result)) throw new TypeError(result.message);

  if (isScalarResult(result)) {
    const scalar = result.result;
    if (typeof scalar === "number") return scalar;
    if (scalar === true) return 1;
    if (typeof scalar === "string") {
      const parsedNumber = Number(scalar);
      return Number.isFinite(parsedNumber) ? parsedNumber : null;
    }
  }

  throw new TypeError(ISSUE.numOrBlank);
}

function textOpt(result: Result): string | null {
  if (isBlankResult(result)) return null;
  if (isIssueResult(result)) throw new TypeError(result.message);
  if (isScalarResult(result) && typeof result.result === "string")
    return result.result;
  throw new TypeError(ISSUE.textOrBlank);
}

function numExpect(result: Result): number {
  if (isIssueResult(result)) throw new TypeError(result.message);
  if (isScalarResult(result) && typeof result.result === "number")
    return result.result;
  throw new TypeError(ISSUE.number);
}

function toNumber(result: Result): number | null {
  if (isBlankResult(result)) return null;
  if (isIssueResult(result)) throw new TypeError(result.message);

  if (isScalarResult(result)) {
    const scalar = result.result;
    if (typeof scalar === "number") return scalar;
    if (scalar === true) return 1;
    if (typeof scalar === "string") {
      const parsedNumber = Number(scalar);
      return Number.isFinite(parsedNumber) ? parsedNumber : null;
    }
  }
  return null;
}

function toText(result: Result): string | null {
  if (isBlankResult(result)) return null;
  if (isIssueResult(result)) throw new TypeError(result.message);
  if (isScalarResult(result)) return String(result.result);
  return null;
}

function primitiveToResult(value: boolean | number | string | null): Result {
  if (value === null || value === false) return Results.blank();
  if (value === true) return Results.scalar(true);
  return Results.scalar(value);
}

function numericOp(
  map: (...nums: number[]) => number,
  ...args: Result[]
): number | null {
  const issue = firstIssue(...args);
  if (issue) throw new TypeError(issue.message);

  const nums = args.map(numOpt);
  if (nums.some((n) => n === null)) return null;
  return map(...(nums as number[]));
}

function getEntryGroupByLabel(
  group: Result,
  label: string,
  env: EvalEnv,
): Result {
  if (isIssueResult(group)) return group;
  if (!isEntryGroupResult(group))
    return Results.issue(ISSUE.labelOnNonEntryGroup(label));

  const want = label.trim();
  const id = group.entryIds.find((cid) => env.getLabel(cid) === want);
  if (id == null) return Results.issue(ISSUE.unknownLabel(want));
  return env.resolve(id);
}

function normalizePosition(position: number): { index: number } | Result {
  if (!Number.isFinite(position)) return Results.issue(ISSUE.positionFinite);
  const index = Math.trunc(position) - 1;
  if (index < 0) return Results.issue(ISSUE.positionOneBased);
  return { index };
}

function getEntryGroupByPosition(
  group: Result,
  position: number,
  env: EvalEnv,
): Result {
  if (isIssueResult(group)) return group;

  const norm = normalizePosition(position);
  if ("type" in norm) return norm;

  if (!isEntryGroupResult(group))
    return Results.issue(ISSUE.selectPosNonEntryGroup);

  const id = group.entryIds[norm.index];
  if (id == null)
    return Results.issue(
      ISSUE.positionOutOfRange(position, group.entryIds.length),
    );
  return env.resolve(id);
}

function getValueGroupByPosition(group: Result, position: number): Result {
  if (isIssueResult(group)) return group;

  const norm = normalizePosition(position);
  if ("type" in norm) return norm;

  if (!isResultGroupResult(group))
    return Results.issue(ISSUE.selectPosNonResultGroup);

  const item = group.items[norm.index];
  if (item == null)
    return Results.issue(
      ISSUE.positionOutOfRange(position, group.items.length),
    );
  return item.result;
}

function getByPositionOrLabel(
  group: Result,
  selectionValue: Result,
  env: EvalEnv,
): Result {
  if (isIssueResult(group)) return group;
  if (isIssueResult(selectionValue)) return selectionValue;

  if (isScalarResult(selectionValue)) {
    const lit = selectionValue.result;
    if (typeof lit === "number") {
      if (isEntryGroupResult(group))
        return getEntryGroupByPosition(group, lit, env);
      if (isResultGroupResult(group))
        return getValueGroupByPosition(group, lit);
      return Results.issue(ISSUE.selectPosNonGroup);
    }
    if (typeof lit === "string") return getEntryGroupByLabel(group, lit, env);
  }

  return Results.issue(ISSUE.posLabelMustBeTextOrNumber);
}

const BINARY_OPS: Record<
  PrimitiveBinaryOp,
  (a: Result, b: Result) => boolean | number | string | null
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
} as const;

function isPrimitiveBinaryOp(op: Binary["op"]): op is PrimitiveBinaryOp {
  return op !== "and" && op !== "or";
}

const UNARY_OPS: Record<
  Unary["op"],
  (v: Result) => boolean | number | string | null
> = {
  "!": (v) => !isTrue(ensureNotIssue(v)),
  "-": (v) => numericOp((x) => -x, v),
  "+": (v) => numericOp((x) => +x, v),
};

type Builtin = (env: EvalEnv, ...args: Result[]) => Result;

function contentFn(op: (env: EvalEnv, ...args: Result[]) => Result): Builtin {
  return (env, ...args) => {
    const want = Math.max(0, op.length - 1);
    const filled = Array.from(
      { length: want },
      (_, i) => args[i] ?? Results.blank(),
    );
    return op(env, ...filled);
  };
}

type ArgSpec<T> =
  | { type: "req"; convert: (v: Result) => T | null }
  | { type: "opt"; convert: (v: Result) => T | null; fallback: T };

const REQ_NUM = { type: "req", convert: numOpt } as const;
const optNum = (d: number) =>
  ({ type: "opt", convert: numOpt, fallback: d }) as const;

const REQ_TEXT = { type: "req", convert: textOpt } as const;
const optText = (d: string) =>
  ({ type: "opt", convert: textOpt, fallback: d }) as const;

function typedFn<A extends unknown[]>(
  specs: { [K in keyof A]: ArgSpec<A[K]> },
  impl: (env: EvalEnv, ...args: A) => Result,
): Builtin {
  return (env, ...args) => {
    const issue = firstIssue(...args);
    if (issue) return issue;

    const inputs = Array.from(
      { length: specs.length },
      (_, i) => args[i] ?? Results.blank(),
    );

    const resolved: unknown[] = [];
    for (let i = 0; i < specs.length; i++) {
      const spec = specs[i]!;
      const v = spec.convert(inputs[i]!);
      if (spec.type === "req") {
        if (v === null) return Results.blank();
        resolved.push(v);
      } else {
        resolved.push(v ?? spec.fallback);
      }
    }
    return impl(env, ...(resolved as A));
  };
}

function iterGroupValues(group: Result, env: EvalEnv): Result[] {
  if (isIssueResult(group)) throw new TypeError(group.message);
  if (isEntryGroupResult(group))
    return group.entryIds.map((id) => env.resolve(id));
  if (isResultGroupResult(group)) return group.items.map((item) => item.result);
  throw new TypeError(ISSUE.group);
}

function groupNumbersOpt(group: Result, env: EvalEnv): number[] {
  const out: number[] = [];
  for (const result of iterGroupValues(group, env)) {
    if (isIssueResult(result)) throw new TypeError(result.message);
    if (isBlankResult(result)) continue;
    if (isScalarResult(result) && typeof result.result === "number")
      out.push(result.result);
    else throw new TypeError(ISSUE.numOrBlank);
  }
  return out;
}

function groupTextsOpt(group: Result, env: EvalEnv): string[] {
  const out: string[] = [];
  for (const result of iterGroupValues(group, env)) {
    if (isIssueResult(result)) throw new TypeError(result.message);
    if (isBlankResult(result)) continue;
    if (isScalarResult(result) && typeof result.result === "string")
      out.push(result.result);
    else throw new TypeError(ISSUE.textOrBlank);
  }
  return out;
}

function reduceNumbers(
  group: Result,
  env: EvalEnv,
  op: (numbers: number[]) => number | null,
): number | null {
  const numbers = groupNumbersOpt(group, env);
  return numbers.length ? op(numbers) : null;
}

const GROUP_SPEC = {
  type: "req",
  convert: (v: Result) =>
    isEntryGroupResult(v) || isResultGroupResult(v) ? v : null,
} as const;

const BUILTINS: Record<string, Builtin> = {
  is_blank: contentFn((_env, v) => primitiveToResult(isBlankResult(v))),
  is_present: contentFn((_env, v) => primitiveToResult(isPresent(v))),
  is_true: contentFn((_env, v) => primitiveToResult(isTrue(v))),
  to_number: contentFn((_env, v) => primitiveToResult(toNumber(v))),
  to_text: contentFn((_env, v) => primitiveToResult(toText(v))),

  number_or: contentFn((_env, content, fallback) => {
    if (isIssueResult(content)) return content;
    const n = numOpt(content);
    if (n !== null) return Results.scalar(n);

    if (isIssueResult(fallback)) return fallback;
    const fb = numOpt(fallback);
    return fb !== null ? Results.scalar(fb) : Results.blank();
  }),

  text_or: contentFn((_env, content, fallback) => {
    if (isIssueResult(content)) return content;
    const t = textOpt(content);
    if (t !== null) return Results.scalar(t);

    if (isIssueResult(fallback)) return fallback;
    const fb = textOpt(fallback);
    return fb !== null ? Results.scalar(fb) : Results.blank();
  }),

  if_blank: contentFn((_env, content, fallback) => {
    if (isIssueResult(content)) return content;
    return isBlankResult(content) ? (fallback ?? Results.blank()) : content;
  }),

  if_issue: contentFn((_env, content, fallback) =>
    isIssueResult(content) ? (fallback ?? Results.blank()) : content,
  ),

  first_present: (_env, ...contents) => {
    for (const v of contents) {
      if (isIssueResult(v)) return v;
      if (isPresent(v)) return v;
    }
    return Results.blank();
  },

  not: contentFn((_env, v) => {
    if (isIssueResult(v)) return v;
    return isTrue(v) ? Results.blank() : Results.scalar(true);
  }),

  and: contentFn((_env, l, r) => {
    if (isIssueResult(l)) return l;
    if (isIssueResult(r)) return r;
    return isTrue(l) && isTrue(r) ? Results.scalar(true) : Results.blank();
  }),

  or: contentFn((_env, l, r) => {
    if (isIssueResult(l)) return l;
    if (isIssueResult(r)) return r;
    return isTrue(l) || isTrue(r) ? Results.scalar(true) : Results.blank();
  }),

  if: contentFn((_env, cond, thenV, elseV) => {
    if (isIssueResult(cond)) return cond;
    return isTrue(cond) ? thenV : elseV;
  }),

  abs: typedFn([REQ_NUM], (_env, n) => Results.scalar(Math.abs(n))),

  round: typedFn([REQ_NUM, optNum(0)], (_env, n, p) => {
    const f = 10 ** p;
    return Results.scalar(Math.round(n * f) / f);
  }),

  ceil: typedFn([REQ_NUM], (_env, n) => Results.scalar(Math.ceil(n))),

  floor: typedFn([REQ_NUM], (_env, n) => Results.scalar(Math.floor(n))),

  clamp: typedFn(
    [
      REQ_NUM,
      optNum(Number.NEGATIVE_INFINITY),
      optNum(Number.POSITIVE_INFINITY),
    ],
    (_env, n, lo, hi) => Results.scalar(Math.min(Math.max(n, lo), hi)),
  ),

  mod: typedFn([REQ_NUM, optNum(1)], (_env, d, m) =>
    Results.scalar(((d % m) + m) % m),
  ),

  trim: typedFn([REQ_TEXT], (_env, t) => Results.scalar(t.trim())),

  contains: typedFn([REQ_TEXT, REQ_TEXT], (_env, t, s) =>
    t.includes(s) ? Results.scalar(true) : Results.blank(),
  ),

  lower: typedFn([REQ_TEXT], (_env, t) => Results.scalar(t.toLowerCase())),

  upper: typedFn([REQ_TEXT], (_env, t) => Results.scalar(t.toUpperCase())),

  pad_start: typedFn(
    [REQ_TEXT, optNum(0), optText(" ")],
    (_env, t, targetLen, padText) =>
      Results.scalar(t.padStart(targetLen, padText)),
  ),

  pad_end: typedFn(
    [REQ_TEXT, optNum(0), optText(" ")],
    (_env, t, targetLen, padText) =>
      Results.scalar(t.padEnd(targetLen, padText)),
  ),

  split: typedFn([REQ_TEXT, optText("")], (_env, t, sep) =>
    Results.resultGroup(
      t.split(sep).map((p) => ({ result: Results.scalar(p) })),
    ),
  ),

  join: typedFn(
    [GROUP_SPEC, optText(",")],
    (env, groupValue: Result, sep: string) => {
      const parts = groupTextsOpt(groupValue, env);
      return parts.length ? Results.scalar(parts.join(sep)) : Results.blank();
    },
  ),

  count: typedFn([GROUP_SPEC], (env, source: Result) => {
    const values = iterGroupValues(source, env);
    return Results.scalar(values.filter((c) => !isBlankResult(c)).length);
  }),

  count_blank: typedFn([GROUP_SPEC], (env, source: Result) => {
    const values = iterGroupValues(source, env);
    return Results.scalar(values.filter((c) => isBlankResult(c)).length);
  }),

  sum: typedFn([GROUP_SPEC], (env, source: Result) =>
    primitiveToResult(
      reduceNumbers(source, env, (ns) => ns.reduce((a, b) => a + b, 0)),
    ),
  ),

  avg: typedFn([GROUP_SPEC], (env, source: Result) =>
    primitiveToResult(
      reduceNumbers(
        source,
        env,
        (ns) => ns.reduce((a, b) => a + b, 0) / ns.length,
      ),
    ),
  ),

  min: typedFn([GROUP_SPEC], (env, source: Result) =>
    primitiveToResult(reduceNumbers(source, env, (ns) => Math.min(...ns))),
  ),

  max: typedFn([GROUP_SPEC], (env, source: Result) =>
    primitiveToResult(reduceNumbers(source, env, (ns) => Math.max(...ns))),
  ),
};

function callBuiltin(env: EvalEnv, name: string, args: Result[]): Result {
  const fn = BUILTINS[name] ?? BUILTINS[name.toLowerCase()];
  if (!fn) throw new TypeError(`Unknown function: ${name}`);
  return fn(env, ...args);
}

function interpretAst(expr: Expr, env: EvalEnv): Result {
  try {
    switch (expr.type) {
      case "Binary": {
        if (expr.op === "and" || expr.op === "or") {
          const left = interpretAst(expr.left, env);
          if (isIssueResult(left)) return left;

          const leftIsTrue = isTrue(left);
          if (expr.op === "and") {
            if (!leftIsTrue) return Results.blank();
            const right = interpretAst(expr.right, env);
            if (isIssueResult(right)) return right;
            return isTrue(right) ? Results.scalar(true) : Results.blank();
          }

          if (leftIsTrue) return Results.scalar(true);
          const right = interpretAst(expr.right, env);
          if (isIssueResult(right)) return right;
          return isTrue(right) ? Results.scalar(true) : Results.blank();
        }

        if (!isPrimitiveBinaryOp(expr.op)) {
          throw new TypeError(`Unknown operator: ${expr.op}`);
        }

        const left = interpretAst(expr.left, env);
        if (isIssueResult(left)) return left;

        const right = interpretAst(expr.right, env);
        if (isIssueResult(right)) return right;

        return primitiveToResult(BINARY_OPS[expr.op](left, right));
      }

      case "Unary": {
        const value = interpretAst(expr.argument, env);
        if (isIssueResult(value)) return value;
        return primitiveToResult(UNARY_OPS[expr.op](value));
      }

      case "Call": {
        const callee = expr.callee;
        if (callee.type !== "Ident") throw new TypeError(ISSUE.fnName);

        const args = expr.args.map((a) => interpretAst(a, env));
        const issue = firstIssue(...args);
        if (issue) return issue;

        return callBuiltin(env, callee.label, args);
      }

      case "Select": {
        const target = interpretAst(expr.group, env);
        if (isIssueResult(target)) return target;

        const selectionValue = interpretAst(expr.select, env);
        if (isIssueResult(selectionValue)) return selectionValue;

        return getByPositionOrLabel(target, selectionValue, env);
      }

      case "Member": {
        const target = interpretAst(expr.group, env);
        if (isIssueResult(target)) return target;
        return getEntryGroupByLabel(target, expr.label.label, env);
      }

      case "Lit":
        return Results.scalar(expr.value);

      case "Blank":
        return Results.blank();

      case "Ident":
        return env.lookup(expr.label);

      default:
        return assertNever(expr, "Unhandled expression variant");
    }
  } catch (err) {
    return Results.issue(err instanceof Error ? err.message : String(err));
  }
}

export function interpretExpr(code: string, env: EvalEnv): Result {
  if (!code.trim()) return Results.blank();
  const match = GRAMMAR.match(code, "Start");
  if (match.failed()) return Results.issue(match.message ?? "Parse error");
  return interpretAst(SEMANTICS(match).ast, env);
}
