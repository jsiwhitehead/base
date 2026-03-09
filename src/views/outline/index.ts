import type { Location } from "../../core";
import { defineView } from "../../dom";

import {
  createOutlineItemTabHandler,
  createOutlineIntentHandler,
  createOutlineValueTabHandler,
  handleOutlineItemDelete,
} from "./intent";
import { buildOutlineRoot, handleOutlineItemNav } from "./runtime";

export const outlineView = defineView(({ core, id: viewRootId, location }) => {
  const portals = location.portals;
  const onValueTab = createOutlineValueTabHandler({ core, viewRootId });
  const onItemTab = createOutlineItemTabHandler({ core });
  const onIntent = createOutlineIntentHandler({ core, viewRootId, portals });
  const onItemDelete = (
    selection: Extract<ReturnType<typeof core.selection>, { type: "item" }>,
  ) => handleOutlineItemDelete({ core, viewRootId, portals, selection });
  const onItemNav = (
    location: Location,
    dir: "left" | "right" | "up" | "down",
  ) => handleOutlineItemNav({ core, viewRootId, portals, location, dir });

  const bodyRoot = buildOutlineRoot(
    core,
    viewRootId,
    portals,
    onValueTab,
    onItemTab,
    onItemDelete,
    onItemNav,
  );

  return { onIntent, bodyRoot };
});
