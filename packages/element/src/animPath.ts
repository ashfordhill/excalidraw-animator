import type { ExcalidrawElement } from "./types";

/** motion paths (animator) are line elements tagged via customData */
export const isAnimPath = (element: ExcalidrawElement | null | undefined) =>
  !!element?.customData?.anim;

/** paths are only visible/interactive while the animation editor is open */
export const animPathVisibility = { visible: false };

export const isHiddenAnimPath = (element: ExcalidrawElement) =>
  !animPathVisibility.visible && isAnimPath(element);
