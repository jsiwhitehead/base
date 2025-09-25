import {
  type Signal,
  library,
  createLiteral,
  createBlock,
  createFunction,
  createSignal,
  isLiteral,
  isBlock,
  resolveShallow,
} from "./data";

library.len = createSignal(
  createFunction((x: Signal) => {
    const n = resolveShallow(x);

    if (isBlock(n)) {
      const count = n.values.length + n.items.length;
      return createSignal(createLiteral(count));
    }

    if (isLiteral(n)) {
      const v = n.value;
      if (typeof v === "string") {
        return createSignal(createLiteral(v.length));
      }
      throw new TypeError("len expects a block or a string literal");
    }

    throw new TypeError("len expects a block or a literal");
  })
);

library.math = createSignal(
  createBlock({
    sin: createSignal(
      createFunction((x: Signal) => {
        const n = resolveShallow(x);
        if (!isLiteral(n)) throw new TypeError("sin expects a number");
        const num = Number(n.value);
        if (Number.isNaN(num)) throw new TypeError("sin expects a number");
        return createSignal(createLiteral(Math.sin(num)));
      })
    ),
    pi: createSignal(createLiteral(Math.PI)),
  })
);
