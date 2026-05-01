import type { Location } from "../../core";
import { defineView } from "../../dom";

import {
  createOutlineNodeTabHandler,
  createOutlineIntentHandler,
  createOutlineValueTabHandler,
  handleOutlineNodeDelete,
} from "./intent";
import { buildOutlineRoot, handleOutlineNodeNav } from "./runtime";

export const outlineView = defineView(({ core, id: viewRootId, location }) => {
  const portals = location.portals;
  const onValueTab = createOutlineValueTabHandler({ core, viewRootId });
  const onNodeTab = createOutlineNodeTabHandler({ core });
  const onIntent = createOutlineIntentHandler({ core, viewRootId, portals });
  const onNodeDelete = (
    selection: Extract<ReturnType<typeof core.selection>, { type: "node" }>,
  ) => handleOutlineNodeDelete({ core, viewRootId, portals, selection });
  const onNodeNav = (
    location: Location,
    dir: "left" | "right" | "up" | "down",
  ) => handleOutlineNodeNav({ core, viewRootId, portals, location, dir });

  const bodyRoot = buildOutlineRoot(
    core,
    viewRootId,
    portals,
    onValueTab,
    onNodeTab,
    onNodeDelete,
    onNodeNav,
  );

  return { onIntent, bodyRoot };
});
