import { describe, expect, it } from "vitest";

import { newLinearElement } from "@excalidraw/element";

import { serializeAsJSON } from "../data/json";
import { restoreElements } from "../data/restore";

const clip = {
  name: "Animation 1",
  start: 250,
  duration: 1500,
  targets: ["target-id"],
  home: {
    "target-id": {
      width: 100,
      height: 50,
      angle: 0,
      dx: 0,
      dy: 0,
    },
  },
  keys: [
    [0, 0, 1, 1, 0],
    [1, 1, 1.2, 1.2, 0.5],
  ],
} as const;

describe("animation scene persistence", () => {
  it("saves and restores clip data on motion paths", () => {
    const path = newLinearElement({
      type: "line",
      x: 10,
      y: 20,
      points: [
        [0, 0],
        [100, 50],
      ] as any,
      customData: { anim: clip },
    });

    const json = serializeAsJSON([path], {}, {}, "local");
    const saved = JSON.parse(json);

    expect(saved.elements[0].customData.anim).toEqual(clip);

    const [restored] = restoreElements(saved.elements, null, {
      deleteInvisibleElements: true,
    });
    expect((restored as any).customData.anim).toEqual(clip);
  });
});
