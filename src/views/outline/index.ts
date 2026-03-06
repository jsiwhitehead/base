import { defineView } from "../../dom";

import {
  createOutlineIntentHandler,
  createOutlineValueTabHandler,
} from "./intent";
import { buildOutlineRoot } from "./runtime";

export const outlineView = defineView(({ core, id: viewRootId, location }) => {
  const portals = location.portals;
  const onValueTab = createOutlineValueTabHandler({ core });
  const onIntent = createOutlineIntentHandler({ core, viewRootId, portals });

  const bodyRoot = buildOutlineRoot(core, viewRootId, portals, onValueTab);

  return { onIntent, bodyRoot };
});
