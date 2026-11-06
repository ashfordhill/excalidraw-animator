import React from "react";

import {
  CaptureUpdateAction,
  newElementWith,
  newLinearElement,
} from "@excalidraw/element";

import { Excalidraw } from "../index";
import { serializeAsJSON } from "../data/json";
import { restoreElements } from "../data/restore";
import { actionGroup, actionUngroup } from "../actions/actionGroup";
import {
  getClips,
  watchAnimationPaths,
  getFrameElements,
  pause,
  seek,
  setDrawerOpen,
} from "../animation/animator";

import { API } from "./helpers/api";
import { Keyboard } from "./helpers/ui";
import { act, render, unmountComponent } from "./test-utils";

const { h } = window;
unmountComponent();
let stopWatching: (() => void) | undefined;

beforeEach(async () => {
  await render(<Excalidraw handleKeyboardGlobally />);
  act(() => {
    pause();
    setDrawerOpen(false);
    stopWatching = watchAnimationPaths(h.app);
  });
});

afterEach(() =>
  act(() => {
    stopWatching?.();
    pause();
    setDrawerOpen(false);
  }),
);

const setup = () => {
  const parts = [0, 40, 80].map((y) =>
    API.createElement({
      type: "rectangle",
      x: 100,
      y,
      width: 20,
      height: 20,
      groupIds: ["G1"],
    }),
  );
  const path = newLinearElement({
    type: "line",
    x: 110,
    y: 50,
    width: 200,
    height: 0,
    points: [
      [0, 0],
      [200, 0],
    ] as any,
    customData: {
      anim: {
        name: "Figure",
        start: 0,
        duration: 2000,
        targets: parts.map((el) => el.id),
        home: Object.fromEntries(
          parts.map((el) => [
            el.id,
            { dx: 0, dy: el.y - 40, width: 20, height: 20, angle: 0 },
          ]),
        ),
        keys: [
          [0, 0, 1, 1, 0],
          [1, 1, 1, 1, 0],
        ],
      },
    },
  });
  API.updateScene({
    elements: [...parts, path],
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
  act(() => seek(h.app, 1000));
  return { parts, path };
};

const group = (ids: string[]) => {
  act(() => h.app.selection.select(ids));
  act(() => h.app.actionManager.executeAction(actionGroup));
};

const ungroup = (id: string) => {
  act(() => h.app.selection.select(id));
  act(() => h.app.actionManager.executeAction(actionUngroup));
};

it("preserves G1's path when regrouping A, B, C with D, without changing their poses", () => {
  const { parts, path } = setup();
  const original = getClips(h.app)[0];
  ungroup(parts[0].id);
  expect(
    parts.every((part) => h.scene.getElement(part.id)!.groupIds.length === 0),
  ).toBe(true);
  expect(getClips(h.app)[0].customData.anim.targets).toEqual(
    parts.map((part) => part.id),
  );
  const added = API.createElement({
    type: "ellipse",
    x: 240,
    y: -30,
    width: 30,
    height: 30,
  });
  API.updateScene({
    elements: [...h.elements, added],
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
  group([...parts.map((part) => part.id), added.id]);
  const clip = getClips(h.app)[0];
  expect(clip.id).toBe(path.id);
  expect(clip.points).toEqual(original.points);
  expect(clip.customData.anim.keys).toEqual(original.customData.anim.keys);
  expect(clip.customData.anim.targets).toEqual([
    ...parts.map((part) => part.id),
    added.id,
  ]);
  for (const part of parts) {
    expect(clip.customData.anim.home[part.id]).toEqual(
      original.customData.anim.home[part.id],
    );
  }
  for (const time of [0, 1000, 2000]) {
    const frame = getFrameElements(h.elements, [clip], time);
    expect(frame.find((el) => el.id === added.id)?.x).toBeCloseTo(
      140 + time / 10,
    );
    expect(frame.find((el) => el.id === added.id)?.y).toBeCloseTo(-30);
    expect(frame.find((el) => el.id === parts[0].id)?.x).toBeCloseTo(
      100 + time / 10,
    );
  }
  Keyboard.undo();
  expect(getClips(h.app)[0].customData.anim.targets).toEqual(
    parts.map((part) => part.id),
  );
  expect(h.scene.getElement(added.id)?.groupIds).toEqual([]);
  Keyboard.redo();
  expect(getClips(h.app)[0].customData.anim.targets).toContain(added.id);
});

it("inherits through just one surviving original part and ignores unrelated groups", () => {
  const { parts } = setup();
  ungroup(parts[0].id);
  const added = API.createElement({
    type: "ellipse",
    x: 230,
    y: 0,
    width: 20,
    height: 20,
  });
  const unrelated = API.createElement({
    type: "ellipse",
    x: 600,
    y: 0,
    width: 20,
    height: 20,
    groupIds: ["unrelated"],
  });
  act(() => h.app.selection.clear());
  API.updateScene({
    elements: [
      ...h.elements.map((el) =>
        parts.slice(1).some((part) => part.id === el.id)
          ? newElementWith(el, { isDeleted: true })
          : el,
      ),
      added,
      unrelated,
    ],
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
  group([parts[0].id, added.id]);
  const [clip] = getClips(h.app);
  expect(clip.customData.anim.targets).toContain(added.id);
  expect(clip.customData.anim.targets).not.toContain(unrelated.id);
  expect(
    getFrameElements(h.elements, [clip], 2000).find((el) => el.id === added.id)
      ?.x,
  ).toBeCloseTo(330);
});

it("keeps additions in place when regrouping a scaled, rotated figure, including after saving", () => {
  const { parts, path } = setup();
  const original = getClips(h.app)[0];
  API.updateScene({
    elements: h.elements.map((el) =>
      el.id === path.id
        ? newElementWith(el, {
            customData: {
              anim: {
                ...original.customData.anim,
                keys: [
                  [0, 0, 1, 1, 0],
                  [1, 1, 2, 2, Math.PI / 2],
                ],
              },
            },
          })
        : el,
    ),
  });
  act(() => seek(h.app, 2000));
  ungroup(parts[0].id);
  const added = API.createElement({
    type: "rectangle",
    x: 380,
    y: 90,
    width: 20,
    height: 40,
    angle: Math.PI / 2,
  });
  API.updateScene({
    elements: [...h.elements, added],
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
  group([...parts.map((part) => part.id), added.id]);
  const [clip] = getClips(h.app);
  const end = getFrameElements(h.elements, [clip], 2000).find(
    (el) => el.id === added.id,
  )!;
  expect(end.x).toBeCloseTo(added.x);
  expect(end.y).toBeCloseTo(added.y);
  expect(end.width).toBeCloseTo(added.width);
  expect(end.height).toBeCloseTo(added.height);
  expect(end.angle).toBeCloseTo(added.angle);
  const restored = restoreElements(
    JSON.parse(serializeAsJSON(h.elements, h.state, {}, "local")).elements,
    null,
  );
  const restoredClip = restored.find((el) => el.id === clip.id) as typeof clip;
  const start = getFrameElements(restored, [restoredClip], 0).find(
    (el) => el.id === added.id,
  )!;
  expect(start.x).toBeCloseTo(135);
  expect(start.y).toBeCloseTo(0);
  expect(start.width).toBeCloseTo(10);
  expect(start.height).toBeCloseTo(20);
  expect(start.angle).toBeCloseTo(0);
});

it("inherits through nested groups and keeps the link on additions after another ungroup", () => {
  const { parts, path } = setup();
  const added = API.createElement({
    type: "rectangle",
    x: 240,
    y: -30,
    width: 30,
    height: 30,
  });
  API.updateScene({
    elements: [...h.elements, added],
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
  group([parts[0].id, added.id]);
  expect(h.scene.getElement(parts[0].id)?.groupIds.length).toBe(2);
  expect(getClips(h.app)[0].customData.anim.targets).toContain(added.id);
  ungroup(added.id);
  const next = API.createElement({
    type: "rectangle",
    x: 250,
    y: -50,
    width: 10,
    height: 10,
  });
  API.updateScene({
    elements: [...h.elements, next],
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
  group([added.id, next.id]);
  const [clip] = getClips(h.app);
  expect(clip.id).toBe(path.id);
  expect(clip.customData.anim.targets).toContain(next.id);
  const frame = getFrameElements(h.elements, [clip], 2000);
  expect(frame.find((el) => el.id === next.id)?.x).toBeCloseTo(350);
});

it("includes bound text and repairs an already regrouped scene without duplicating paths", () => {
  const { path } = setup();
  const container = API.createElement({
    type: "rectangle",
    x: 240,
    y: -30,
    width: 80,
    height: 40,
    groupIds: ["G1"],
  });
  const label = API.createElement({
    type: "text",
    text: "Hat",
    x: 250,
    y: -25,
    width: 50,
    height: 20,
    containerId: container.id,
    fontSize: 16,
  });
  API.updateScene({
    elements: [...h.elements, container, label],
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
  const off = watchAnimationPaths(h.app);
  try {
    const [clip] = getClips(h.app);
    expect(clip.id).toBe(path.id);
    expect(clip.customData.anim.targets).toContain(container.id);
    expect(clip.customData.anim.targets).toContain(label.id);
    const frame = getFrameElements(h.elements, [clip], 2000);
    expect(frame.find((el) => el.id === label.id)?.x).toBeCloseTo(350);
    act(() => seek(h.app, 2000));
    act(() => seek(h.app, 0));
    expect(getClips(h.app)).toHaveLength(1);
    expect(getClips(h.app)[0].customData.anim.targets).toEqual(
      clip.customData.anim.targets,
    );
  } finally {
    off();
  }
});
