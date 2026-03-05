import { defineView } from "../../dom";

import {
  createOutlineIntentHandler,
  createOutlineValueTabHandler,
} from "./intent";
import { buildOutlineRoot } from "./runtime";

export const outlineView = defineView(({ core, id: rootId, focus }) => {
  const rootPortals = focus.portals;
  const onValueTab = createOutlineValueTabHandler({ core });
  const onIntent = createOutlineIntentHandler({ core, rootId, rootPortals });

  const body = buildOutlineRoot(core, rootId, rootPortals, onValueTab);

  return { onIntent, body };
});
