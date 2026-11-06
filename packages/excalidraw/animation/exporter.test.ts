import { vi } from "vitest";

import { newElement, newLinearElement } from "@excalidraw/element";

import { getDefaultAppState } from "../appState";
import { exportScene } from "../scene/export";

import {
  ANIMATION_SIZE_PRESETS,
  createAnimationExportPlan,
  getAnimationSizeError,
  exportAnimation,
  getExportRange,
} from "./exporter";
import { moveTimeRange } from "./TimeRange";

import type { AppClassProperties } from "../types";
import type { AnimationExportPlan } from "./exporter";

vi.mock("../scene/export", () => ({ exportScene: vi.fn() }));

it("renders the complete scene, including static objects, throughout the export", async () => {
  const target = newElement({
    type: "rectangle",
    x: 0,
    y: 0,
    width: 100,
    height: 100,
  });
  const staticObject = newElement({
    type: "ellipse",
    x: 900,
    y: 300,
    width: 100,
    height: 100,
  });
  const path = newLinearElement({
    type: "line",
    x: 50,
    y: 50,
    points: [
      [0, 0],
      [200, 0],
    ] as any,
    customData: {
      anim: {
        name: "Move",
        start: 0,
        duration: 2000,
        targets: [target.id],
        home: {
          [target.id]: { dx: 0, dy: 0, width: 100, height: 100, angle: 0 },
        },
        keys: [
          [0, 0, 1, 1, 0],
          [1, 1, 1, 1, 0],
        ],
      },
    },
  });
  const app = {
    scene: { getNonDeletedElements: () => [target, staticObject, path] },
    state: getDefaultAppState(),
    files: {},
    renderEnvironment: {},
  } as unknown as AppClassProperties;
  const plan = createAnimationExportPlan(app);
  expect(plan.contentWidth).toBeGreaterThanOrEqual(1000);
  expect(plan.contentHeight).toBeGreaterThanOrEqual(400);
  for (const time of [0, 1000, 2000]) {
    await plan.renderFrameAt(time, {
      scale: 1,
      background: true,
      darkMode: false,
    });
    expect(exportScene).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          elements: expect.arrayContaining([
            expect.objectContaining({ id: target.id, x: time / 10 }),
            staticObject,
          ]),
        }),
      }),
    );
  }
  // All presets and custom sizes keep a fixed camera, exact pixel dimensions,
  // and enough room for both the moving object and the distant static object.
  for (const size of [...ANIMATION_SIZE_PRESETS, { width: 853, height: 479 }]) {
    let firstViewport: unknown;
    for (const time of [0, 1000, 2000]) {
      await plan.renderFrameAt(time, {
        scale: 1,
        size,
        background: true,
        darkMode: false,
      });
      const call = vi.mocked(exportScene).mock.calls.at(-1)![0];
      const config = call.config as {
        width: number;
        height: number;
        scale: number;
        x: number;
        y: number;
        padding: number;
      };
      expect(Math.round(config.width * config.scale)).toBe(size.width);
      expect(Math.round(config.height * config.scale)).toBe(size.height);
      expect(config.padding).toBe(0);
      expect(config.x).toBeLessThan(0);
      expect(config.y).toBeLessThan(0);
      expect(config.x + config.width).toBeGreaterThan(1000);
      expect(config.y + config.height).toBeGreaterThan(400);
      const viewport = [
        config.x,
        config.y,
        config.width,
        config.height,
        config.scale,
      ];
      if (firstViewport) {
        expect(viewport).toEqual(firstViewport);
      }
      firstViewport = viewport;
    }
  }
});

it("encodes only the selected time range, offset from the beginning of the scene", async () => {
  const canvas = document.createElement("canvas");
  canvas.width = 2;
  canvas.height = 2;
  const renderFrameAt = vi.fn(async () => canvas);
  const plan = {
    duration: 5000,
    renderFrameAt,
  } as unknown as AnimationExportPlan;
  const result = await exportAnimation({
    app: { ownerWindow: window } as unknown as AppClassProperties,
    plan,
    settings: {
      format: "gif",
      fps: 10,
      scale: 1,
      background: true,
      darkMode: false,
      loop: true,
      startTime: 1200,
      endTime: 1700,
    },
  });
  expect(result.blob.type).toBe("image/gif");
  expect(renderFrameAt.mock.calls.map((call: any[]) => call[0]).sort()).toEqual(
    [1200, 1300, 1400, 1500, 1600],
  );
});

it("clamps export ranges to a nonempty interval", () => {
  expect(getExportRange(2000, {})).toEqual({
    start: 0,
    end: 2000,
    duration: 2000,
  });
  expect(getExportRange(2000, { startTime: -100, endTime: 5000 })).toEqual({
    start: 0,
    end: 2000,
    duration: 2000,
  });
  expect(getExportRange(2000, { startTime: 1500, endTime: 500 })).toEqual({
    start: 1500,
    end: 1550,
    duration: 50,
  });
});

it("moves a trimmed window without changing its length or leaving the timeline", () => {
  const range = { start: 1000, end: 3000 };
  expect(moveTimeRange(range, 500, "move", 5000)).toEqual({
    start: 1500,
    end: 3500,
  });
  expect(moveTimeRange(range, -2000, "move", 5000)).toEqual({
    start: 0,
    end: 2000,
  });
  expect(moveTimeRange(range, 4000, "move", 5000)).toEqual({
    start: 3000,
    end: 5000,
  });
  expect(moveTimeRange(range, 4000, "start", 5000)).toEqual({
    start: 2950,
    end: 3000,
  });
  expect(moveTimeRange(range, -4000, "end", 5000)).toEqual({
    start: 1000,
    end: 1050,
  });
});

it("validates custom dimensions before rendering or encoding", async () => {
  for (const size of [
    { width: 0, height: 720 },
    { width: 640, height: NaN },
    { width: 100.5, height: 100 },
    { width: 8192, height: 1080 },
  ]) {
    expect(getAnimationSizeError(size)).not.toBeNull();
  }
  expect(getAnimationSizeError({ width: 853, height: 479 }, "gif")).toBeNull();
  expect(getAnimationSizeError({ width: 853, height: 479 }, "mp4")).toContain(
    "even",
  );
  expect(
    getAnimationSizeError({ width: 1920, height: 1080 }, "mp4"),
  ).toBeNull();
  await expect(
    exportAnimation({
      app: {} as AppClassProperties,
      plan: {} as AnimationExportPlan,
      settings: {
        format: "gif",
        fps: 20,
        scale: 1,
        size: { width: 0, height: 720 },
        loop: true,
        background: true,
        darkMode: false,
      },
    }),
  ).rejects.toThrow("whole pixels");
});
