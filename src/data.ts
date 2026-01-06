import {
  type Signal as PSignal,
  type ReadonlySignal as PReadonlySignal,
  signal,
  computed,
  batch,
} from "@preact/signals-core";

/* Errors */

export const ERR = {
  flag: "Expected flag (true or blank)",
  literal: "Expected literal value",
  number: "Expected number",
  numOrBlank: "Expected number or blank",
  text: "Expected text",
  textOrBlank: "Expected text or blank",
  textOrGroup: "Expected text or group",
  group: "Expected group",
  function: "Expected function",
  funcOrBlank: "Expected function or blank",

  sliceStepZero: "Slice step cannot be 0",

  indexFinite: "Index must be a finite number",
  indexOneBased: "Index must be 1 or greater",
  indexNonGroup: "Cannot index into a non-group content",
  indexOutOfRange: (index: number, len: number) =>
    `Index ${index} is out of range (length ${len})`,
  indexNameMustBeTextOrNumber: "Index/name must evaluate to text or number",
  nameOnNonGroup: (name: string) =>
    `Cannot access name '${name}' of non-group content`,
  unknownName: (name: string) => `Unknown name '${name}'`,

  unboundIdentifier: (name: string) => `Unbound identifier: ${name}`,
  templateParameter: (name: string) => `Template parameter: ${name}`,
  cannotResolveFunctionContent: "Cannot statically resolve a function content",
} as const;

/* Types */

export type ScalarPrimitive = true | number | string;

export type ErrorContent = {
  kind: "error";
  message: string;
};

export type BlankContent = { kind: "blank" };

export type ScalarContent = {
  kind: "scalar";
  value: ScalarPrimitive;
};

export type GroupContent = {
  kind: "group";
  items: Item[];
  contentItemUid?: number;
};

export type StructuralContent = BlankContent | ScalarContent | GroupContent;

export type FunctionContent = {
  kind: "function";
  fn: (...args: ContentSignal[]) => ContentSignal;
};

export type DataContent = StructuralContent | FunctionContent;

export type Content = DataContent | ErrorContent;

export type DerivedContent = {
  kind: "derived";
  code: string;
  result: ReadSignal<Content>;
};

export type LensContent = {
  kind: "lens";
  source: string;
  filter: string;
  result: ReadSignal<Content>;
};

export type MatchPattern =
  | { kind: "pany" }
  | { kind: "plit"; value: ScalarPrimitive }
  | { kind: "pgroup"; items: { name?: string; pat: MatchPattern }[] };

export type MatchContent = {
  kind: "match";
  arg: string;
  matches: {
    uid: number;
    pattern: Signal<MatchPattern>;
    body: ItemContentSignal;
  }[];
  match: ReadSignal<number | null>;
  result: ReadSignal<Content>;
};

export type TemplateContent<
  Body extends DataContent | DerivedContent | LensContent =
    | DataContent
    | DerivedContent
    | LensContent
> = {
  kind: "template";
  params: string[];
  body: Body;
};

export type EvalContent =
  | DerivedContent
  | LensContent
  | MatchContent
  | TemplateContent;

type ReadSignal<T> = {
  kind: "signal";
  get(): T;
  peek(): T;
};

export type WriteSignal<T> = ReadSignal<T> & {
  set(next: T): void;
};

export type Signal<T> = ReadSignal<T> | WriteSignal<T>;

export type ContentSignal<T extends Content = Content> = Signal<T>;

export type ItemContentSignal =
  | ReadSignal<Content>
  | WriteSignal<DataContent | EvalContent>;

export type Item = {
  uid: number;
  name: Signal<string>;
  view: Signal<string>;
  content: ItemContentSignal;
};

export type StaticError = { kind: "error"; message: string };

export type StaticItem = {
  name?: string;
  view?: string;
  content: StaticContent;
};

export type StaticGroupContent = {
  kind: "group";
  items: StaticItem[];
};

export type StaticContent =
  | StaticError
  | BlankContent
  | ScalarPrimitive
  | StaticGroupContent;

/* Guards */

function hasKind(v: unknown, k: string): boolean {
  return typeof v === "object" && v !== null && (v as any).kind === k;
}

export const isError = (v: unknown): v is ErrorContent => hasKind(v, "error");
export const isBlank = (v: unknown): v is BlankContent => hasKind(v, "blank");
export const isScalar = (v: unknown): v is ScalarContent =>
  hasKind(v, "scalar");
export const isGroup = (v: unknown): v is GroupContent => hasKind(v, "group");
export const isFunction = (v: unknown): v is FunctionContent =>
  hasKind(v, "function");
export const isContent = (v: unknown): v is Content =>
  isError(v) || isBlank(v) || isScalar(v) || isGroup(v) || isFunction(v);
export const isDerived = (v: unknown): v is DerivedContent =>
  hasKind(v, "derived");
export const isLens = (v: unknown): v is LensContent => hasKind(v, "lens");
export const isMatch = (v: unknown): v is MatchContent => hasKind(v, "match");
export const isTemplate = (v: unknown): v is TemplateContent =>
  hasKind(v, "template");
export const isSignal = (
  v: unknown
): v is ReadSignal<unknown> | WriteSignal<unknown> => hasKind(v, "signal");
export const isWritableSignal = (v: unknown): v is WriteSignal<unknown> =>
  isSignal(v) && typeof (v as any).set === "function";
export const isStaticError = (v: unknown): v is StaticError =>
  hasKind(v, "error");
export const isStaticGroup = (v: unknown): v is StaticGroupContent =>
  hasKind(v, "group");

/* Parents */

type ParentOwnerSig = WriteSignal<
  GroupContent | TemplateContent<GroupContent> | MatchContent
>;
type ParentSig = PSignal<ParentOwnerSig | undefined>;
const parentMap = new WeakMap<ItemContentSignal, ParentSig>();

export function getParentSignal(sig: ItemContentSignal): ParentSig {
  let p = parentMap.get(sig);
  if (!p) {
    p = signal(undefined);
    parentMap.set(sig, p);
  }
  return p;
}

export function getParent(
  content: ItemContentSignal
): ParentOwnerSig | undefined {
  return getParentSignal(content).value;
}

/* Groups */

function groupItemSignals(src: GroupContent): {
  item: Item;
  indexSig: ContentSignal;
  nameSig: ContentSignal;
  contentSig: ContentSignal;
}[] {
  return src.items.map((c, i) => {
    const indexSig = createSignal(createScalar(i + 1));
    const nameSig = createComputed(() => {
      const n = c.name.get();
      return n ? createScalar(n) : createBlank();
    });
    const contentSig = createComputed(() => evalContent(c.content));
    return { item: c, indexSig, nameSig, contentSig };
  });
}

export function groupMap(
  src: GroupContent,
  f: (
    content: ContentSignal,
    index: ContentSignal,
    name: ContentSignal
  ) => ContentSignal
): GroupContent {
  return createGroup(
    groupItemSignals(src).map(({ item, indexSig, nameSig, contentSig }) => ({
      uid: newUid(),
      name: item.name,
      content: createComputed(() => {
        try {
          return f(contentSig, indexSig, nameSig).get();
        } catch (err) {
          return createError(err instanceof Error ? err.message : String(err));
        }
      }),
    }))
  );
}

export function groupFilter(
  src: GroupContent,
  pred: (
    content: ContentSignal,
    index: ContentSignal,
    name: ContentSignal
  ) => ContentSignal
): GroupContent {
  return createGroup(
    groupItemSignals(src)
      .filter(({ contentSig, indexSig, nameSig }) =>
        isTruthy(pred(contentSig, indexSig, nameSig).get())
      )
      .map(({ item }) => item),
    src.contentItemUid
  );
}

export function groupReduce(
  src: GroupContent,
  rf: (
    acc: ContentSignal,
    content: ContentSignal,
    index: ContentSignal,
    name: ContentSignal
  ) => ContentSignal,
  init: ContentSignal
): ContentSignal {
  const seq = groupItemSignals(src);
  if (seq.length === 0) return init;

  const step = (acc: ContentSignal, e: (typeof seq)[number]) =>
    rf(acc, e.contentSig, e.indexSig, e.nameSig);

  if (!isBlank(init.get())) {
    return seq.reduce(step, init);
  }

  const first = createSignal(evalContent(src.items[0]!.content));
  return seq.slice(1).reduce(step, first);
}

function sortRank(v: Content): [number, any] {
  // numbers < text < true < other < blank
  if (isBlank(v)) return [4, null];
  if (isScalar(v)) {
    const lit = v.value;
    if (typeof lit === "number") return [0, lit];
    if (typeof lit === "string") return [1, lit];
    if (lit === true) return [2, 1];
  }
  return [3, null];
}

const collator = new Intl.Collator(undefined, { sensitivity: "base" });

function sortCmp<T extends { sortKey: Content; index: number }>(
  a: T,
  b: T
): number {
  const [ra, va] = sortRank(a.sortKey);
  const [rb, vb] = sortRank(b.sortKey);
  if (ra !== rb) return ra - rb;
  if (ra === 0) {
    const d = va - vb;
    if (d) return d;
  } else if (ra === 1) {
    const d = collator.compare(va, vb);
    if (d) return d;
  }
  return a.index - b.index;
}

export function groupSort(
  src: GroupContent,
  keySelector:
    | null
    | ((
        content: ContentSignal,
        index: ContentSignal,
        name: ContentSignal
      ) => ContentSignal)
): GroupContent {
  const rows = groupItemSignals(src).map(
    ({ item, indexSig, nameSig, contentSig }, i) => ({
      uid: item.uid,
      name: item.name,
      view: item.view,
      content: item.content,
      index: i,
      sortKey: keySelector
        ? keySelector(contentSig, indexSig, nameSig).get()
        : evalContent(item.content),
    })
  );

  rows.sort(sortCmp);
  return createGroup(rows, src.contentItemUid);
}

/* Constructors */

let nextItemUid = 1;
export function newUid() {
  return nextItemUid++;
}

export const createError = (message: string): ErrorContent => ({
  kind: "error",
  message,
});

export const createBlank = (): BlankContent => ({ kind: "blank" });

export const createScalar = (value: ScalarPrimitive): ScalarContent => ({
  kind: "scalar",
  value,
});

export function createGroup(
  items: {
    uid?: number;
    name?: string | Signal<string>;
    view?: string | Signal<string>;
    content: ItemContentSignal;
  }[] = [],
  contentItemUid?: number
): GroupContent {
  const outItems = items.map((c) => {
    let nameSig: Signal<string>;
    if (isSignal(c.name)) {
      nameSig = c.name;
    } else {
      nameSig = createSignal<string>(c.name ?? "");
    }

    let viewSig: Signal<string>;
    if (isSignal(c.view)) {
      viewSig = c.view;
    } else {
      viewSig = createSignal<string>(c.view ?? "");
    }

    return {
      uid: c.uid ?? newUid(),
      name: nameSig,
      view: viewSig,
      content: c.content,
    };
  });
  return {
    kind: "group",
    items: outItems,
    contentItemUid: outItems.find((c) => c.uid === contentItemUid)?.uid,
  };
}

export const createFunction = (
  fn: (...args: ContentSignal[]) => ContentSignal
): FunctionContent => ({ kind: "function", fn });

function derivedComputed(
  owner: ItemContentSignal,
  code: string,
  params?: ScopeParams
): ReadSignal<Content> {
  return createComputed<Content>(() => {
    try {
      return evalCode(code, (name: string) =>
        lookupInScope(name, owner, params)
      );
    } catch (err) {
      return createError(err instanceof Error ? err.message : String(err));
    }
  });
}

export function createDerived(
  owner: ItemContentSignal,
  code: string
): DerivedContent {
  return { kind: "derived", code, result: derivedComputed(owner, code) };
}

export function createLens(
  owner: ItemContentSignal,
  source: string,
  filter: string
): LensContent {
  const result = createComputed<Content>(() => {
    try {
      if (!source.trim()) return createBlank();

      const target = lookupInScope(source, owner).get();
      if (!isGroup(target)) throw new TypeError(ERR.group);

      const code = filter.trim();
      if (!code) return createGroup(target.items, target.contentItemUid);

      const pred = evalCode(code, (n: string) => lookupInScope(n, owner));
      if (!isFunction(pred)) throw new TypeError(ERR.function);

      return groupFilter(target, pred.fn);
    } catch (err) {
      return createError(err instanceof Error ? err.message : String(err));
    }
  });

  return { kind: "lens", source, filter, result };
}

function patternToText(p: MatchPattern): string {
  return JSON.stringify(p);
}

function textToPattern(text: string): MatchPattern {
  try {
    return JSON.parse(text) as MatchPattern;
  } catch {
    return { kind: "pany" };
  }
}

function matchPattern(
  content: Content,
  pat: MatchPattern,
  params?: ScopeParams
) {
  if (isError(content)) return false;

  switch (pat.kind) {
    case "pany":
      return true;

    case "plit":
      return isScalar(content) && content.value === pat.value;

    case "pgroup": {
      if (!isGroup(content)) return false;

      for (let i = 0; i < pat.items.length; i++) {
        const { name, pat: sub } = pat.items[i]!;
        let item: Item | undefined;

        if (name) item = content.items.find((c) => c.name.get() === name);
        else item = content.items[i];

        if (!item) return false;

        const v = evalContent(item.content, params);
        if (!matchPattern(v, sub, params)) return false;
      }
      return true;
    }
  }
}

export function createMatchSignal(
  arg: string,
  matches: {
    uid?: number;
    pattern: MatchPattern;
    body: ItemContentSignal;
  }[] = []
): WriteSignal<MatchContent> {
  const sig = createSignal<MatchContent>(null as any);

  batch(() => {
    const norm = matches.map((m) => ({
      uid: m.uid ?? newUid(),
      pattern: createSignal<MatchPattern>(m.pattern),
      body: m.body,
    }));

    for (const m of norm) getParentSignal(m.body).value = sig;

    const match = createComputed(() => {
      try {
        const name = arg.trim();
        if (!name) return null;

        const v = lookupInScope(name, sig).get();

        for (const arm of norm) {
          if (matchPattern(v, arm.pattern.get())) return arm.uid;
        }
        return null;
      } catch {
        return null;
      }
    });

    const result = createComputed(() => {
      try {
        const uid = match.get();
        if (uid == null) return createBlank();

        const arm = norm.find((m) => m.uid === uid);
        if (!arm) return createBlank();

        return evalContent(arm.body);
      } catch (err) {
        return createError(err instanceof Error ? err.message : String(err));
      }
    });

    sig.set({ kind: "match", arg, matches: norm, match, result });
  });

  return sig;
}

export function createTemplate<
  Body extends DataContent | DerivedContent | LensContent
>(params: string[], body: Body): TemplateContent<Body> {
  return { kind: "template", params, body };
}

export function createComputed<T>(fn: () => T): ReadSignal<T> {
  const rsig: PReadonlySignal<T> = computed(fn);
  return { kind: "signal", get: () => rsig.value, peek: () => rsig.peek() };
}

export function createSignal<T>(initial: T): WriteSignal<T> {
  const sig = signal(initial);
  return {
    kind: "signal",
    get: () => sig.value,
    peek: () => sig.peek(),
    set: (next: T) => {
      sig.value = next;
    },
  };
}

export function createGroupSignal(
  items: {
    uid?: number;
    name?: string | Signal<string>;
    view?: string | Signal<string>;
    content: ItemContentSignal;
  }[] = [],
  contentItemUid?: number
): WriteSignal<GroupContent> {
  const sig = createSignal<GroupContent>(null as any);

  batch(() => {
    for (const c of items) {
      getParentSignal(c.content).value = sig;
    }
    sig.set(createGroup(items, contentItemUid));
  });

  return sig;
}

export function createTemplateGroupSignal(
  params: string[],
  items: {
    uid?: number;
    name?: string | Signal<string>;
    view?: string | Signal<string>;
    content: ItemContentSignal;
  }[] = [],
  contentItemUid?: number
): WriteSignal<TemplateContent<GroupContent>> {
  const sig = createSignal<TemplateContent<GroupContent>>(null as any);

  batch(() => {
    for (const c of items) {
      getParentSignal(c.content).value = sig;
    }
    sig.set(createTemplate(params, createGroup(items, contentItemUid)));
  });

  return sig;
}

function asReadOnlySignal<T>(sig: Signal<T>): ReadSignal<T> {
  return { kind: "signal", get: () => sig.get(), peek: () => sig.peek() };
}

function readonlyContent(v: Content, params?: ScopeParams): Content {
  if (isError(v) || isBlank(v) || isScalar(v) || isFunction(v)) return v;
  return createGroup(
    v.items.map((c) => ({
      uid: newUid(),
      name: asReadOnlySignal(c.name),
      view: asReadOnlySignal(c.view),
      content: createComputed(() =>
        readonlyContent(evalContent(c.content, params), params)
      ),
    })),
    v.contentItemUid
  );
}

/* Conversions */

export function isTruthy(content: Content): boolean {
  if (isError(content) || isBlank(content)) return false;
  return true;
}

export function toNumber(content: Content): number | null {
  if (isBlank(content)) return null;
  if (isScalar(content)) {
    const v = content.value;
    if (typeof v === "number") return v;
    if (v === true) return 1;
    if (typeof v === "string") {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }
  }
  return null;
}

export function toText(content: Content): string | null {
  if (isError(content)) return content.message;
  if (isBlank(content)) return null;
  if (isScalar(content)) return String(content.value);
  return null;
}

export function numOpt(content: Content): number | null {
  if (isBlank(content)) return null;
  if (isScalar(content) && typeof content.value === "number")
    return content.value;
  throw new TypeError(ERR.numOrBlank);
}

export function textOpt(content: Content): string | null {
  if (isBlank(content)) return null;
  if (isScalar(content) && typeof content.value === "string")
    return content.value;
  throw new TypeError(ERR.textOrBlank);
}

export function groupOpt(content: Content): GroupContent | null {
  if (isBlank(content)) return null;
  if (isGroup(content)) return content;
  throw new TypeError(ERR.group);
}

export function fnOpt(content: Content): FunctionContent | null {
  if (isBlank(content)) return null;
  if (isFunction(content)) return content as FunctionContent;
  throw new TypeError(ERR.function);
}

export function flagExpect(content: Content): boolean {
  if (isBlank(content)) return false;
  if (isScalar(content) && content.value === true) return true;
  throw new TypeError(ERR.flag);
}

export function primExpect(content: Content): ScalarPrimitive {
  if (isScalar(content)) return content.value;
  throw new TypeError(ERR.literal);
}

export function numExpect(content: Content): number {
  if (isScalar(content) && typeof content.value === "number")
    return content.value;
  throw new TypeError(ERR.number);
}

export function primitiveToContent(
  v: boolean | number | string | null
): BlankContent | ScalarContent {
  if (v === null || v === false) return createBlank();
  return createScalar(v);
}

export function size(content: Content): number | null {
  if (isError(content)) return null;
  if (isBlank(content)) return null;
  if (isScalar(content) && typeof content.value === "string")
    return content.value.length;
  if (isGroup(content)) return content.items.length;
  throw new TypeError(ERR.textOrGroup);
}

const NUM_RE = /^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

export function parseScalarInput(text: string): DataContent {
  const trimmed = text.trim();
  if (NUM_RE.test(trimmed)) {
    const n = Number(trimmed);
    if (Number.isFinite(n)) return createScalar(n);
  }
  return createScalar(text);
}

/* Slice */

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}
function rangeIndices(start: number, end: number, step: number): number[] {
  if (step === 0) throw new RangeError(ERR.sliceStepZero);
  const delta = end - start;
  if (delta === 0) return [start];
  if (Math.sign(delta) !== Math.sign(step)) return [];
  const n = Math.floor(Math.abs(delta) / Math.abs(step)) + 1;
  return Array.from({ length: n }, (_, i) => start + i * step);
}
function computeSliceIndices(
  start: number | null,
  end: number | null,
  step: number | null,
  len: number | null
): number[] {
  if (len == null) {
    const s = Math.trunc(start ?? 1);
    if (end == null) return [];
    const e = Math.trunc(end);
    const st = step != null ? Math.trunc(step) : e >= s ? 1 : -1;
    return rangeIndices(s, e, st);
  }
  const st =
    step != null ? Math.trunc(step) : (end ?? len) >= (start ?? 1) ? 1 : -1;
  const sDefault = st > 0 ? 1 : len;
  const eDefault = st > 0 ? len : 1;
  const s = clamp(Math.trunc(start ?? sDefault), 1, len);
  const e = clamp(Math.trunc(end ?? eDefault), 1, len);
  return rangeIndices(s, e, st);
}

export function sliceText(
  text: string,
  start: number | null,
  end: number | null,
  step: number | null
): string {
  const indices = computeSliceIndices(start, end, step, text.length);
  return indices.map((i) => text.charAt(i - 1)).join("");
}

export function sliceGroup(
  group: GroupContent,
  start: number | null,
  end: number | null,
  step: number | null
): GroupContent {
  const indices = computeSliceIndices(start, end, step, group.items.length);
  const items = indices.map((oneBased) => group.items[oneBased - 1]!);
  return createGroup(items, group.contentItemUid);
}

export function createRangeGroup(
  start: number | null,
  end: number | null,
  step: number | null = null
): GroupContent {
  const indices = computeSliceIndices(start, end, step, null);
  const items = indices.map((n) => ({
    content: createSignal(createScalar(n)),
  }));
  return createGroup(items);
}

/* Evaluation */

const evalCode: (
  code: string,
  scope: (name: string) => ContentSignal
) => Content = require("./code").evalCode;

function toStaticError(err: unknown): StaticError {
  return {
    kind: "error",
    message: err instanceof Error ? err.message : String(err),
  };
}

let __globalLib: Map<string, ContentSignal> | null = null;
export function setGlobalLibrary(entries: Record<string, ContentSignal>) {
  __globalLib = new Map(
    Object.entries(entries).map(([k, v]) => [k.toLowerCase(), v])
  );
}

type ScopeParams = Map<ItemContentSignal, Record<string, ContentSignal>>;

function lookupInScope(
  name: string,
  start: ItemContentSignal,
  params?: ScopeParams
): ContentSignal {
  let scope = getParentSignal(start).value;
  while (scope) {
    const outer = scope.get();
    const inner = isTemplate(outer) ? outer.body : outer;

    if (isGroup(inner)) {
      const found = inner.items.find((c) => c.name.get() === name);
      if (found) return createSignal(evalContent(found.content, params));
    }

    if (isTemplate(outer) && outer.params.includes(name)) {
      const found = params?.get(scope)?.[name];
      if (found) return createSignal(evalContent(found, params));
      throw new Error(ERR.templateParameter(name));
    }

    scope = getParentSignal(scope).value;
  }

  const libSig = __globalLib?.get(name.toLowerCase());
  if (libSig) return createSignal(libSig.get());

  throw new Error(ERR.unboundIdentifier(name));
}

export function evalStructural(
  sig: ItemContentSignal,
  params?: ScopeParams
): Content {
  const v = sig.get();

  if (isDerived(v)) {
    const out = params
      ? derivedComputed(sig, v.code, params).get()
      : v.result.get();
    return readonlyContent(out, params);
  }

  if (isLens(v)) {
    return v.result.get();
  }

  if (isMatch(v)) {
    return createGroup(
      v.matches.map((m) => ({
        uid: m.uid,
        name: createSignal(""),
        view: createSignal(""),
        content: m.body,
      }))
    );
  }

  if (isTemplate(v)) {
    return evalStructural(createSignal(v.body), params);
  }

  return v;
}

export function evalContent(
  sig: ItemContentSignal,
  params?: ScopeParams
): Content {
  const v = sig.get();

  if (isMatch(v)) {
    return v.result.get();
  }

  if (isTemplate(v)) {
    return createFunction((...args) =>
      createComputed(() => {
        const nextParams = new Map(params);
        nextParams.set(
          sig,
          Object.fromEntries(
            v.params.map((p, i) => [p, args[i] ?? createSignal(createBlank())])
          )
        );
        return readonlyContent(
          evalContent(createSignal(v.body), nextParams),
          nextParams
        );
      })
    );
  }

  const content = evalStructural(sig, params);
  if (!isGroup(content) || content.contentItemUid === undefined) return content;

  return evalContent(
    content.items.find((c) => c.uid === content.contentItemUid)!.content,
    params
  );
}

export function resolveContent(content: Content): StaticContent {
  if (content.kind === "error") return content;

  if (content.kind === "blank") return { kind: "blank" };
  if (content.kind === "scalar") return content.value;

  if (content.kind === "group") {
    if (content.contentItemUid !== undefined) {
      return resolveContent(
        evalContent(
          content.items.find((c) => c.uid === content.contentItemUid)!.content
        )
      );
    }

    const items: StaticItem[] = content.items.map((c) => {
      const nm = c.name.get();
      const vw = c.view.get();
      const outName = nm === "" ? undefined : nm;
      const outView = vw === "" ? undefined : vw;
      try {
        return {
          name: outName,
          view: outView,
          content: resolveContent(evalContent(c.content)),
        };
      } catch (err) {
        return {
          name: outName,
          view: outView,
          content: toStaticError(err),
        };
      }
    });
    return { kind: "group", items };
  }

  return {
    kind: "error",
    message: ERR.cannotResolveFunctionContent,
  };
}

/* Getters */

function softWrap<T>(required: boolean, fn: () => T): T | BlankContent {
  if (required) return fn();
  try {
    return fn();
  } catch (err) {
    if (
      err instanceof TypeError ||
      err instanceof RangeError ||
      err instanceof ReferenceError
    ) {
      return createBlank();
    }
    throw err;
  }
}

export function getByName(
  group: Content,
  name: string,
  required = false
): Content {
  return softWrap(required, () => {
    if (!isGroup(group)) throw new TypeError(ERR.nameOnNonGroup(name));
    const item = group.items.find((v) => v.name.get() === name);
    if (!item) throw new ReferenceError(ERR.unknownName(name));
    return evalContent(item.content);
  });
}

export function getByIndex(
  group: Content,
  index1: number,
  required = false
): Content {
  return softWrap(required, () => {
    if (!Number.isFinite(index1)) throw new TypeError(ERR.indexFinite);
    const idx0 = Math.trunc(index1) - 1;
    if (idx0 < 0) throw new RangeError(ERR.indexOneBased);
    if (!isGroup(group)) throw new TypeError(ERR.indexNonGroup);
    const item = group.items[idx0];
    if (!item)
      throw new RangeError(ERR.indexOutOfRange(index1, group.items.length));
    return evalContent(item.content);
  });
}

export function getByIndexOrName(
  group: Content,
  content: Content,
  required = false
): Content {
  return softWrap(required, () => {
    if (!isGroup(group)) throw new TypeError(ERR.indexNonGroup);
    if (isScalar(content)) {
      const lit = content.value;
      if (typeof lit === "number") return getByIndex(group, lit, required);
      if (typeof lit === "string") return getByName(group, lit, required);
    }
    throw new TypeError(ERR.indexNameMustBeTextOrNumber);
  });
}

/* Projections */

export type NavLayoutContext = "default" | "table-cell" | "bar-child";

export function getLayoutContext(
  parentItem?: Item,
  grandparentItem?: Item
): NavLayoutContext {
  const parentView = parentItem?.view.peek() ?? "";
  const grandparentView = grandparentItem?.view.peek() ?? "";

  return grandparentView === "table"
    ? "table-cell"
    : parentView === "bar"
    ? "bar-child"
    : "default";
}

export type RenderScalar = {
  kind: "scalar";
  text: string;
  number?: number;
  isError: boolean;
  editable: boolean;
};

export type RenderModel = RenderScalar | GroupContent;

export function getRenderModel(
  sig: ItemContentSignal,
  params?: ScopeParams
): RenderModel {
  const v = evalStructural(sig, params);

  if (isGroup(v)) return v;

  const stored = sig.get();
  const bodyEditable =
    isWritableSignal(sig) &&
    !isDerived(stored) &&
    !isLens(stored) &&
    !isMatch(stored) &&
    !isTemplate(stored);

  if (isError(v)) {
    return {
      kind: "scalar",
      text: v.message,
      isError: true,
      editable: bodyEditable,
    };
  }

  if (isBlank(v)) {
    return {
      kind: "scalar",
      text: "",
      isError: false,
      editable: bodyEditable,
    };
  }

  if (isScalar(v)) {
    return {
      kind: "scalar",
      text: String(v.value),
      isError: false,
      editable: bodyEditable,
      number: typeof v.value === "number" ? v.value : undefined,
    };
  }

  if (isFunction(v)) {
    return {
      kind: "scalar",
      text: "[function]",
      isError: false,
      editable: false,
    };
  }

  return {
    kind: "scalar",
    text: "[unknown]",
    isError: false,
    editable: false,
  };
}

export function getRenderChildren(
  sig: ItemContentSignal,
  params?: ScopeParams
): Item[] {
  const v = evalStructural(sig, params);
  return isGroup(v) ? v.items : [];
}

export type EditorFieldMode =
  | "body"
  | "name"
  | "header"
  | "header-multi"
  | "pattern";

export type EditorField = {
  mode: EditorFieldMode;
  label?: string;
  get: PReadonlySignal<string | null>;
  set?: (next: string) => void;
};

export function getRenderEditors(item: Item): EditorField[] {
  const childSig = item.content;
  const fields: EditorField[] = [];

  if (isDerived(childSig.get())) {
    fields.push({
      mode: "header-multi",
      label: "=",
      get: computed(() => {
        const v = childSig.get();
        return isDerived(v) ? v.code : null;
      }),
      set: isWritableSignal(childSig)
        ? (next) => {
            const cur = childSig.peek();
            if (isDerived(cur) && cur.code !== next) {
              childSig.set(createDerived(childSig, next));
            }
          }
        : undefined,
    });
    return fields;
  }

  if (isLens(childSig.get())) {
    fields.push({
      mode: "header",
      label: "~",
      get: computed(() => {
        const v = childSig.get();
        return isLens(v) ? v.source : null;
      }),
      set: isWritableSignal(childSig)
        ? (next) => {
            const cur = childSig.peek();
            if (isLens(cur) && cur.source !== next) {
              childSig.set(createLens(childSig, next, cur.filter));
            }
          }
        : undefined,
    });

    fields.push({
      mode: "header-multi",
      label: "filter:",
      get: computed(() => {
        const v = childSig.get();
        return isLens(v) ? v.filter : null;
      }),
      set: isWritableSignal(childSig)
        ? (next) => {
            const cur = childSig.peek();
            if (isLens(cur) && cur.filter !== next) {
              childSig.set(createLens(childSig, cur.source, next));
            }
          }
        : undefined,
    });

    return fields;
  }

  if (isMatch(childSig.get())) {
    fields.push({
      mode: "header",
      label: "◇",
      get: computed(() => {
        const v = childSig.get();
        return isMatch(v) ? v.arg : null;
      }),
      set: isWritableSignal(childSig)
        ? (next) => {
            const cur = childSig.peek();
            if (isMatch(cur) && cur.arg !== next) {
              childSig.set({ ...cur, arg: next });
            }
          }
        : undefined,
    });
    return fields;
  }

  if (isTemplate(childSig.get())) {
    fields.push({
      mode: "header",
      label: "=>",
      get: computed(() => {
        const v = childSig.get();
        return isTemplate(v) ? v.params.join(", ") : null;
      }),
      set: isWritableSignal(childSig)
        ? (next) => {
            const cur = childSig.peek();
            if (isTemplate(cur)) {
              const nextParams = next
                .split(",")
                .map((s) => s.trim())
                .filter((s) => s.length > 0);

              const same =
                cur.params.length === nextParams.length &&
                cur.params.every((p, i) => p === nextParams[i]);

              if (!same) childSig.set(createTemplate(nextParams, cur.body));
            }
          }
        : undefined,
    });

    return fields;
  }

  const parent = getParent(item.content);
  const pv = parent?.get();
  if (pv && isMatch(pv)) {
    const arm = pv.matches.find((m) => m.uid === item.uid);
    if (arm) {
      const pattern = arm.pattern;
      fields.push({
        mode: "pattern",
        label: "pattern:",
        get: computed(() => patternToText(pattern.get())),
        set: isWritableSignal(pattern)
          ? (nextText) => {
              const nextPat = textToPattern(nextText);
              pattern.set(nextPat);
            }
          : undefined,
      });
    }
  }

  return fields;
}

type RenderProps = {
  truthy(name: string): boolean;
  text(name: string): string | null;
  num(name: string): number | null;
  setFlag(name: string, on: boolean): boolean;
};

export function getRenderProps(
  sig: ItemContentSignal,
  params?: ScopeParams
): RenderProps | null {
  const v = evalStructural(sig, params);
  if (!isGroup(v)) return null;

  const byName = new Map<string, Item>();
  for (const c of v.items) {
    const n = c.name.get();
    if (n) byName.set(n, c);
  }

  const read = (name: string): Content => {
    const c = byName.get(name);
    return c ? evalStructural(c.content, params) : createBlank();
  };

  return {
    truthy: (name) => isTruthy(read(name)),

    text: (name) => toText(read(name)),

    num: (name) => toNumber(read(name)),

    setFlag(name: string, value: boolean): boolean {
      const c = byName.get(name);
      if (!c || !isWritableSignal(c.content)) return false;
      c.content.set(primitiveToContent(value));
      return true;
    },
  };
}

type ParentEditContext = {
  parent: WriteSignal<GroupContent | TemplateContent<GroupContent>>;
  before: Item[];
  index: number;
  contentItemUid?: number;
  params?: string[];
};

type ParentEditResult = {
  after: Item[];
  contentItemUid?: number;
};

export function editParentGroup(
  content: ItemContentSignal,
  childUid: number,
  fn: (ctx: ParentEditContext) => ParentEditResult
): ParentEditResult | null {
  const parentAny = getParent(content);
  if (!parentAny) return null;

  const pv = parentAny.peek?.();
  if (!pv) return null;

  const isTpl = isTemplate(pv);
  const group = isTpl ? pv.body : pv;
  if (!isGroup(group)) return null;

  const parent = parentAny as WriteSignal<
    GroupContent | TemplateContent<GroupContent>
  >;

  const before = group.items;
  const index = before.findIndex((c) => c.uid === childUid);
  if (index < 0) return null;

  let result: ParentEditResult | null = null;

  batch(() => {
    const edit = fn({
      parent,
      before,
      index,
      contentItemUid: group.contentItemUid,
      params: isTpl ? pv.params : undefined,
    });

    const contentItemUid = edit.contentItemUid ?? group.contentItemUid;
    const nextGroup = createGroup(edit.after, contentItemUid);

    parent.set(isTpl ? createTemplate(pv.params, nextGroup) : nextGroup);
    result = { after: edit.after, contentItemUid: edit.contentItemUid };
  });

  return result;
}
