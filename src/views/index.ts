import type { ItemId, ViewId } from "../store";
import type { Editor, Region, Focus, EditorRuntime } from "../editor";
import { createTreeRegion } from "./tree";
import { createTableRegion } from "./table";
import { createSliderRegion } from "./slider";

export type RegionCtx = { editor: Editor };

export type RegionFactory = (
  ctx: RegionCtx,
  id: ItemId,
  focus?: Focus,
) => Region;

const factories = {
  tree: createTreeRegion,
  table: createTableRegion,
  slider: createSliderRegion,
} as const satisfies Record<ViewId, RegionFactory | undefined>;

export function createRegionForItem(
  ctx: RegionCtx,
  view: ViewId,
  id: ItemId,
  focus?: Focus,
): Region | null {
  return factories[view]?.(ctx, id, focus) ?? null;
}

export function hasRegion(view: ViewId): boolean {
  return view in factories;
}

export type MountedRegion = {
  id: string;
  region: Region;
  unmount(): void;
};

export function mountRegion(
  runtime: EditorRuntime,
  host: HTMLElement,
  region: Region,
): MountedRegion {
  runtime.registerRegion(region);
  host.replaceChildren(region.root);

  let mounted = true;

  const unmount = () => {
    if (!mounted) return;
    mounted = false;
    runtime.unregisterRegion(region.id);
    region.dispose();
  };

  return { id: region.id, region, unmount };
}

export function replaceMountedRegion(
  runtime: EditorRuntime,
  host: HTMLElement,
  current: MountedRegion | null,
  next: Region | null,
): MountedRegion | null {
  if (!next) {
    current?.unmount();
    return null;
  }

  if (current?.region === next) return current;

  current?.unmount();
  return mountRegion(runtime, host, next);
}
