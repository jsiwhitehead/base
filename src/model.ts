import {
  type Signal as PSignal,
  type ReadonlySignal as PGetSignal,
  signal,
  computed,
  batch,
} from "@preact/signals-core";

/* Issues */

export const ISSUE = {
  flag: "Expected flag (true or blank)",
  literal: "Expected literal value",
  number: "Expected number",
  numOrBlank: "Expected number or blank",
  text: "Expected text",
  textOrBlank: "Expected text or blank",
  textOrGroup: "Expected text or group",
  group: "Expected group",

  sliceStepZero: "Slice step cannot be 0",

  positionFinite: "Position must be a finite number",
  positionOneBased: "Position must be 1 or greater",
  positionNonGroup: "Cannot select a position from non-group content",
  positionOutOfRange: (position: number, len: number) =>
    `Position ${position} is out of range (length ${len})`,
  posLabelMustBeTextOrNumber: "Label/position must be text or number",
  labelOnNonGroup: (label: string) =>
    `Cannot access label '${label}' of non-group content`,
  unknownLabel: (label: string) => `Unknown label '${label}'`,

  unboundIdentifier: (label: string) => `Unbound identifier: ${label}`,
} as const;

/* Types */

export type ScalarPrimitive = true | number | string;

export type Uid = number | string;

export type IssueContent = {
  kind: "issue";
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
};

export type PrimitiveContent = BlankContent | ScalarContent | GroupContent;

export type BodyContent = PrimitiveContent | IssueContent;

export type DerivedContent = {
  kind: "derived";
  code: string;
  result: GetSignal<BodyContent>;
};

export type LensContent = {
  kind: "lens";
  source: string;
  filter: string;
  sort: string;
  result: GetSignal<BodyContent>;
};

export type RelationalContent = DerivedContent | LensContent;

export type StoredContent = PrimitiveContent | RelationalContent;

type GetSignal<T> = {
  kind: "signal";
  get(): T;
  peek(): T;
};

export type SetSignal<T> = GetSignal<T> & {
  set(next: T): void;
};

export type Signal<T> = GetSignal<T> | SetSignal<T>;

export type ContentSignal<T extends BodyContent = BodyContent> = Signal<T>;

export type ItemContentSignal =
  | GetSignal<BodyContent>
  | SetSignal<StoredContent>;

export type Item = {
  uid: Uid;
  label: Signal<string>;
  view: Signal<string>;
  content: ItemContentSignal;
};

export type StaticIssue = { kind: "issue"; message: string };

export type StaticItem = {
  label?: string;
  view?: string;
  content: StaticContent;
};

export type StaticGroupContent = {
  kind: "group";
  items: StaticItem[];
};

export type StaticContent =
  | StaticIssue
  | BlankContent
  | ScalarPrimitive
  | StaticGroupContent;

/* Guards */

function hasKind(v: unknown, k: string): boolean {
  return typeof v === "object" && v !== null && (v as any).kind === k;
}

export const isIssue = (v: unknown): v is IssueContent => hasKind(v, "issue");
export const isBlank = (v: unknown): v is BlankContent => hasKind(v, "blank");
export const isScalar = (v: unknown): v is ScalarContent =>
  hasKind(v, "scalar");
export const isGroup = (v: unknown): v is GroupContent => hasKind(v, "group");
export const isContent = (v: unknown): v is BodyContent =>
  isIssue(v) || isBlank(v) || isScalar(v) || isGroup(v);
export const isDerived = (v: unknown): v is DerivedContent =>
  hasKind(v, "derived");
export const isLens = (v: unknown): v is LensContent => hasKind(v, "lens");
export const isSignal = (
  v: unknown
): v is GetSignal<unknown> | SetSignal<unknown> => hasKind(v, "signal");
export const isSetSignal = (v: unknown): v is SetSignal<unknown> =>
  isSignal(v) && typeof (v as any).set === "function";
export const isStaticIssue = (v: unknown): v is StaticIssue =>
  hasKind(v, "issue");
export const isStaticGroup = (v: unknown): v is StaticGroupContent =>
  hasKind(v, "group");

/* Parents */

type ParentOwnerSig = SetSignal<GroupContent>;
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

function getOwnerUidFromParent(content: ItemContentSignal): Uid | null {
  const parent = getParent(content);
  if (!parent) return null;

  return parent.peek().items.find((it) => it.content === content)?.uid ?? null;
}

/* Groups */

function groupItemValues(src: GroupContent): {
  item: Item;
  position: BodyContent;
  label: BodyContent;
  content: BodyContent;
}[] {
  return src.items.map((item, i) => {
    const labelText = item.label.get();
    return {
      item,
      position: createScalar(i + 1),
      label: labelText ? createScalar(labelText) : createBlank(),
      content: resolveBody(item.content),
    };
  });
}

export function groupFilter(
  src: GroupContent,
  pred: (
    content: BodyContent,
    position: BodyContent,
    label: BodyContent
  ) => BodyContent
): GroupContent {
  return createGroup(
    groupItemValues(src)
      .filter(({ content, position, label }) =>
        isPresent(pred(content, position, label))
      )
      .map(({ item }) => item)
  );
}

function sortRank(v: BodyContent): [number, any] {
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

function sortCmp<T extends { sortKey: BodyContent; index: number }>(
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
        content: BodyContent,
        position: BodyContent,
        label: BodyContent
      ) => BodyContent)
): GroupContent {
  const rows = groupItemValues(src).map(
    ({ item, position, label, content }, i) => ({
      uid: item.uid,
      label: item.label,
      view: item.view,
      content: item.content,
      index: i,
      sortKey: keySelector ? keySelector(content, position, label) : content,
    })
  );

  rows.sort(sortCmp);
  return createGroup(rows);
}

/* Constructors */

let nextItemUid = 1;
export function newUid() {
  return nextItemUid++;
}

export const createIssue = (message: string): IssueContent => ({
  kind: "issue",
  message,
});

export const createBlank = (): BlankContent => ({ kind: "blank" });

export const createScalar = (value: ScalarPrimitive): ScalarContent => ({
  kind: "scalar",
  value,
});

export function createGroup(
  items: {
    uid?: Uid;
    label?: string | Signal<string>;
    view?: string | Signal<string>;
    content: ItemContentSignal;
  }[] = []
): GroupContent {
  const outItems = items.map((c) => {
    let labelSig: Signal<string>;
    if (isSignal(c.label)) {
      labelSig = c.label;
    } else {
      labelSig = createSignal<string>(c.label ?? "");
    }

    let viewSig: Signal<string>;
    if (isSignal(c.view)) {
      viewSig = c.view;
    } else {
      viewSig = createSignal<string>(c.view ?? "");
    }

    return {
      uid: c.uid ?? newUid(),
      label: labelSig,
      view: viewSig,
      content: c.content,
    };
  });
  return { kind: "group", items: outItems };
}

function derivedComputed(
  owner: ItemContentSignal,
  code: string
): GetSignal<BodyContent> {
  return createComputed<BodyContent>(() => {
    try {
      return interpretExpr(code, (label: string) =>
        lookupInContext(label, owner)
      );
    } catch (err) {
      return createIssue(err instanceof Error ? err.message : String(err));
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
  filter: string,
  sort: string
): LensContent {
  const result = createComputed<BodyContent>(() => {
    try {
      if (!source.trim()) return createBlank();

      const target = lookupInContext(source, owner);
      if (!isGroup(target)) throw new TypeError(ISSUE.group);

      const filterCode = filter.trim();
      const sortCode = sort.trim();

      const evalRow = (
        code: string,
        row: BodyContent,
        position: BodyContent,
        label: BodyContent
      ): BodyContent => {
        try {
          return interpretExpr(code, (name: string) => {
            if (name === "_") return row;
            if (name === "position") return position;
            if (name === "label") return label;
            return lookupInContext(name, owner);
          });
        } catch (err) {
          return createIssue(err instanceof Error ? err.message : String(err));
        }
      };

      let out: GroupContent = target;

      if (filterCode) {
        out = groupFilter(out, (row, position, label) =>
          evalRow(filterCode, row, position, label)
        );
      }

      if (sortCode) {
        out = groupSort(out, (row, position, label) =>
          evalRow(sortCode, row, position, label)
        );
      }

      return out;
    } catch (err) {
      return createIssue(err instanceof Error ? err.message : String(err));
    }
  });

  return { kind: "lens", source, filter, sort, result };
}

export function createComputed<T>(fn: () => T): GetSignal<T> {
  const rsig: PGetSignal<T> = computed(fn);
  return { kind: "signal", get: () => rsig.value, peek: () => rsig.peek() };
}

export function createSignal<T>(initial: T): SetSignal<T> {
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
    uid?: Uid;
    label?: string | Signal<string>;
    view?: string | Signal<string>;
    content: ItemContentSignal;
  }[] = []
): SetSignal<GroupContent> {
  const sig = createSignal<GroupContent>(null as any);

  batch(() => {
    for (const c of items) {
      getParentSignal(c.content).value = sig;
    }
    sig.set(createGroup(items));
  });

  return sig;
}

function asGetSignal<T>(sig: Signal<T>): GetSignal<T> {
  return { kind: "signal", get: () => sig.get(), peek: () => sig.peek() };
}

function notSettableContent(path: string, v: BodyContent): BodyContent {
  if (isIssue(v) || isBlank(v) || isScalar(v)) return v;

  return createGroup(
    v.items.map((c, i) => {
      const childPath = `${path}.${i}`;
      return {
        uid: childPath,
        label: asGetSignal(c.label),
        view: asGetSignal(c.view),
        content: createComputed(() =>
          notSettableContent(childPath, resolveBody(c.content))
        ),
      };
    })
  );
}

/* Conversions */

export function isPresent(content: BodyContent): boolean {
  if (isIssue(content) || isBlank(content)) return false;
  return true;
}

export function toNumber(content: BodyContent): number | null {
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

export function toText(content: BodyContent): string | null {
  if (isBlank(content)) return null;
  if (isScalar(content)) return String(content.value);
  return null;
}

export function numOpt(content: BodyContent): number | null {
  if (isBlank(content)) return null;
  if (isScalar(content) && typeof content.value === "number")
    return content.value;
  throw new TypeError(ISSUE.numOrBlank);
}

export function textOpt(content: BodyContent): string | null {
  if (isBlank(content)) return null;
  if (isScalar(content) && typeof content.value === "string")
    return content.value;
  throw new TypeError(ISSUE.textOrBlank);
}

export function groupOpt(content: BodyContent): GroupContent | null {
  if (isBlank(content)) return null;
  if (isGroup(content)) return content;
  throw new TypeError(ISSUE.group);
}

export function flagExpect(content: BodyContent): boolean {
  if (isBlank(content)) return false;
  if (isScalar(content) && content.value === true) return true;
  throw new TypeError(ISSUE.flag);
}

export function primExpect(content: BodyContent): ScalarPrimitive {
  if (isScalar(content)) return content.value;
  throw new TypeError(ISSUE.literal);
}

export function numExpect(content: BodyContent): number {
  if (isScalar(content) && typeof content.value === "number")
    return content.value;
  throw new TypeError(ISSUE.number);
}

export function primitiveToContent(
  v: boolean | number | string | null
): BlankContent | ScalarContent {
  if (v === null || v === false) return createBlank();
  return createScalar(v);
}

export function size(content: BodyContent): number | null {
  if (isIssue(content)) return null;
  if (isBlank(content)) return null;
  if (isScalar(content) && typeof content.value === "string")
    return content.value.length;
  if (isGroup(content)) return content.items.length;
  throw new TypeError(ISSUE.textOrGroup);
}

const NUM_RE = /^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

export function parseScalarInput(text: string): PrimitiveContent {
  const trimmed = text.trim();
  if (NUM_RE.test(trimmed)) {
    const n = Number(trimmed);
    if (Number.isFinite(n)) return createScalar(n);
  }
  return createScalar(text);
}

/* Resolve */

export type Interpreter = (
  code: string,
  context: (label: string) => BodyContent
) => BodyContent;

let interpretExpr: Interpreter = () =>
  createIssue("Interpreter not set (call setInterpreter)");

export function setInterpreter(fn: Interpreter) {
  interpretExpr = fn;
}

function lookupInContext(label: string, start: ItemContentSignal): BodyContent {
  let context = getParentSignal(start).value;
  while (context) {
    const outer = context.get();
    if (isGroup(outer)) {
      const found = outer.items.find((c) => c.label.get() === label);
      if (found) return resolveBody(found.content);
    }
    context = getParentSignal(context).value;
  }
  throw new Error(ISSUE.unboundIdentifier(label));
}

export function resolveBody(sig: ItemContentSignal): BodyContent {
  const v = sig.get();

  if (isDerived(v)) {
    const ownerUid = getOwnerUidFromParent(sig);
    const seed = ownerUid == null ? "root" : String(ownerUid);
    return notSettableContent(seed, v.result.get());
  }

  if (isLens(v)) return v.result.get();

  return v;
}

export function toStatic(content: BodyContent): StaticContent {
  if (content.kind === "issue") return content;
  if (content.kind === "blank") return { kind: "blank" };
  if (content.kind === "scalar") return content.value;

  if (content.kind === "group") {
    const items: StaticItem[] = content.items.map((c) => {
      const nm = c.label.get();
      const vw = c.view.get();
      const outLabel = nm === "" ? undefined : nm;
      const outView = vw === "" ? undefined : vw;
      try {
        return {
          label: outLabel,
          view: outView,
          content: toStatic(resolveBody(c.content)),
        };
      } catch (err) {
        return {
          label: outLabel,
          view: outView,
          content: {
            kind: "issue",
            message: err instanceof Error ? err.message : String(err),
          },
        };
      }
    });
    return { kind: "group", items };
  }

  return { kind: "issue", message: "[unknown]" };
}

/* Getters */

export function getByLabel(group: BodyContent, label: string): BodyContent {
  if (!isGroup(group)) return createIssue(ISSUE.labelOnNonGroup(label));

  const item = group.items.find((v) => v.label.get() === label);
  if (!item) return createIssue(ISSUE.unknownLabel(label));

  return resolveBody(item.content);
}

export function getByPosition(
  group: BodyContent,
  position: number
): BodyContent {
  if (!Number.isFinite(position)) return createIssue(ISSUE.positionFinite);

  const index = Math.trunc(position) - 1;
  if (index < 0) return createIssue(ISSUE.positionOneBased);

  if (!isGroup(group)) return createIssue(ISSUE.positionNonGroup);

  const item = group.items[index];
  if (!item)
    return createIssue(ISSUE.positionOutOfRange(position, group.items.length));

  return resolveBody(item.content);
}

export function getByPositionOrLabel(
  group: BodyContent,
  content: BodyContent
): BodyContent {
  if (!isGroup(group)) return createIssue(ISSUE.positionNonGroup);

  if (isScalar(content)) {
    const lit = content.value;
    if (typeof lit === "number") return getByPosition(group, lit);
    if (typeof lit === "string") return getByLabel(group, lit);
  }

  return createIssue(ISSUE.posLabelMustBeTextOrNumber);
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

export type ViewScalar = {
  kind: "scalar";
  text: string;
  number?: number;
  isIssue: boolean;
  settable: boolean;
};

export type ViewModel = ViewScalar | GroupContent;

export function getViewModel(sig: ItemContentSignal): ViewModel {
  const v = resolveBody(sig);

  if (isGroup(v)) return v;

  const stored = sig.get();
  const bodySettable =
    isSetSignal(sig) && !isDerived(stored) && !isLens(stored);

  if (isIssue(v)) {
    return {
      kind: "scalar",
      text: v.message,
      isIssue: true,
      settable: bodySettable,
    };
  }

  if (isBlank(v)) {
    return { kind: "scalar", text: "", isIssue: false, settable: bodySettable };
  }

  if (isScalar(v)) {
    return {
      kind: "scalar",
      text: String(v.value),
      isIssue: false,
      settable: bodySettable,
      number: typeof v.value === "number" ? v.value : undefined,
    };
  }

  return { kind: "scalar", text: "[unknown]", isIssue: false, settable: false };
}

export function getViewChildren(sig: ItemContentSignal): Item[] {
  const v = resolveBody(sig);
  return isGroup(v) ? v.items : [];
}

export type InputFieldMode = "body" | "label" | "header" | "header-multi";

export type InputField = {
  mode: InputFieldMode;
  label?: string;
  get: PGetSignal<string | null>;
  set?: (next: string) => void;
};

export function getViewInputs(item: Item): InputField[] {
  const childSig = item.content;
  const fields: InputField[] = [];

  if (isDerived(childSig.get())) {
    fields.push({
      mode: "header-multi",
      label: "=",
      get: computed(() => {
        const v = childSig.get();
        return isDerived(v) ? v.code : null;
      }),
      set: isSetSignal(childSig)
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
      set: isSetSignal(childSig)
        ? (next) => {
            const cur = childSig.peek();
            if (isLens(cur) && cur.source !== next) {
              childSig.set(createLens(childSig, next, cur.filter, cur.sort));
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
      set: isSetSignal(childSig)
        ? (next) => {
            const cur = childSig.peek();
            if (isLens(cur) && cur.filter !== next) {
              childSig.set(createLens(childSig, cur.source, next, cur.sort));
            }
          }
        : undefined,
    });

    fields.push({
      mode: "header-multi",
      label: "sort:",
      get: computed(() => {
        const v = childSig.get();
        return isLens(v) ? v.sort : null;
      }),
      set: isSetSignal(childSig)
        ? (next) => {
            const cur = childSig.peek();
            if (isLens(cur) && cur.sort !== next) {
              childSig.set(createLens(childSig, cur.source, cur.filter, next));
            }
          }
        : undefined,
    });

    return fields;
  }

  return fields;
}

type ParentUpdateContext = {
  parent: SetSignal<GroupContent>;
  before: Item[];
  index: number;
};

type ParentUpdateResult = {
  after: Item[];
};

export function updateParentGroup(
  content: ItemContentSignal,
  childUid: Uid,
  fn: (ctx: ParentUpdateContext) => ParentUpdateResult
): ParentUpdateResult | null {
  const parentAny = getParent(content);
  if (!parentAny) return null;

  const pv = parentAny.peek?.();
  if (!pv || !isGroup(pv)) return null;

  const parent = parentAny as SetSignal<GroupContent>;

  const before = pv.items;
  const index = before.findIndex((c) => c.uid === childUid);
  if (index < 0) return null;

  let result: ParentUpdateResult | null = null;

  batch(() => {
    const update = fn({ parent, before, index });
    const nextGroup = createGroup(update.after);
    parent.set(nextGroup);
    result = { after: update.after };
  });

  return result;
}
