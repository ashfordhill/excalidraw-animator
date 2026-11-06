import React from "react";

import {
  CaptureUpdateAction,
  newElementWith,
  newLinearElement,
} from "@excalidraw/element";

import type { NonDeleted } from "@excalidraw/element/types";

import { Excalidraw } from "../index";
import { actionSelectAll } from "../actions/actionSelectAll";
import { actionDuplicateSelection } from "../actions/actionDuplicateSelection";
import {
  deleteClip,
  getClips,
  getFrameElements,
  isRecording,
  pause,
  seek,
  setDrawerOpen,
  toggleRecording,
  watchAnimationPaths,
} from "../animation/animator";
import { getSelectionStateForElements } from "../components/App.selection";

import { API } from "./helpers/api";
import { Keyboard } from "./helpers/ui";
import { act, render, unmountComponent } from "./test-utils";

import type { ClipElement } from "../animation/animator";

const { h } = window;
unmountComponent();

const setupScene = () => {
  const target = API.createElement({
    type: "rectangle",
    x: 0,
    y: 0,
    width: 100,
    height: 100,
  });
  const other = API.createElement({
    type: "rectangle",
    x: 500,
    y: 0,
    width: 100,
    height: 100,
  });
  const path = newLinearElement({
    type: "line",
    x: 50,
    y: 50,
    width: 200,
    height: 0,
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
  }) as NonDeleted<ClipElement>;
  API.updateScene({
    elements: [target, other, path],
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
  return { target, other, path };
};

beforeEach(async () => {
  await render(<Excalidraw handleKeyboardGlobally />);
  act(() => {
    pause();
    setDrawerOpen(false);
  });
});
afterEach(() => {
  act(() => {
    setDrawerOpen(false);
    if (isRecording()) {
      toggleRecording(h.app);
    }
    pause();
  });
});

it("uses G for recording and preserves R for rectangles even with a selection", () => {
  const { target } = setupScene();
  API.setSelectedElements([target]);
  Keyboard.keyPress("r");
  expect(h.state.activeTool.type).toBe("rectangle");
  expect(isRecording()).toBe(false);
  API.setAppState({
    activeTool: { ...h.state.activeTool, type: "selection", customType: null },
  });
  API.setSelectedElements([target]);
  Keyboard.keyPress("g");
  expect(isRecording()).toBe(true);
  Keyboard.keyPress("g");
  expect(isRecording()).toBe(false);
});

it("blocks recording from both the controller and shortcut while editing", () => {
  const { target } = setupScene();
  API.setSelectedElements([target]);
  act(() => setDrawerOpen(true));
  act(() => toggleRecording(h.app));
  Keyboard.keyPress("g");
  expect(isRecording()).toBe(false);
});

it("only selects paths through hit testing, box selection and select all", () => {
  const { target, other, path } = setupScene();
  act(() => setDrawerOpen(true));
  expect(h.app.getElementsAtPosition(0, 0)).toEqual([]);
  expect(
    getSelectionStateForElements(
      [target, other, path],
      h.scene.getNonDeletedElements(),
      h.state,
    ).selectedElementIds,
  ).toEqual({ [path.id]: true });
  act(() => h.app.actionManager.executeAction(actionSelectAll));
  expect(h.state.selectedElementIds).toEqual({ [path.id]: true });
  act(() => h.app.actionManager.executeAction(actionDuplicateSelection));
  expect(getClips(h.app)).toHaveLength(1);
});

it("deletes the animation without deleting its objects, and supports undo", () => {
  const { target, other, path } = setupScene();
  // Establish an undoable scene before deleting the clip.
  API.updateScene({
    elements: h.elements,
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
  act(() => setDrawerOpen(true));
  API.setSelectedElements([path]);
  act(() => deleteClip(h.app, path.id));
  expect(getClips(h.app)).toHaveLength(0);
  expect(h.scene.getNonDeletedElements().map((el) => el.id)).toEqual([
    target.id,
    other.id,
  ]);
  expect(h.state.selectedElementIds).toEqual({});
  Keyboard.undo();
  expect(getClips(h.app)).toHaveLength(1);
});

it("moves the original target with its path without attaching to another object", () => {
  const { target, other, path } = setupScene();
  act(() => {
    seek(h.app, 0);
    setDrawerOpen(true);
  });
  const off = watchAnimationPaths(h.app);
  API.updateScene({
    elements: h.elements.map((el) =>
      el.id === path.id ? newElementWith(el, { x: 550 }) : el,
    ),
  });
  expect(h.scene.getElement(target.id)?.x).toBe(500);
  expect(getClips(h.app)[0].customData.anim.targets).toEqual([target.id]);
  expect(h.scene.getElement(other.id)?.x).toBe(500);
  off();
});

it("moves a hidden path with its object, without drifting during playback", () => {
  const { target, path } = setupScene();
  act(() => seek(h.app, 0));
  const off = watchAnimationPaths(h.app);
  API.updateScene({
    elements: h.elements.map((el) =>
      el.id === target.id ? newElementWith(el, { x: 100, y: 30 }) : el,
    ),
  });
  expect(h.scene.getElement(path.id)).toMatchObject({ x: 150, y: 80 });
  act(() => seek(h.app, 1000));
  expect(h.scene.getElement(path.id)).toMatchObject({ x: 150, y: 80 });
  expect(h.scene.getElement(target.id)).toMatchObject({ x: 200, y: 30 });
  off();
});

it("keeps unanimated objects in every rendered scene frame", () => {
  const { target, other, path } = setupScene();
  const frame = getFrameElements(h.elements, [path], 1000);
  expect(frame.find((el) => el.id === target.id)?.x).toBe(100);
  expect(frame.find((el) => el.id === other.id)).toEqual(other);
});

it("keeps the original start of a fast, wide leftward recording", () => {
  const target = API.createElement({
    type: "rectangle",
    x: 1400,
    y: 400,
    width: 100,
    height: 100,
  });
  API.updateScene({
    elements: [target],
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
  API.setSelectedElements([target]);
  let now = 0;
  const clock = vi
    .spyOn(h.app.ownerWindow.performance, "now")
    .mockImplementation(() => now);
  try {
    act(() => toggleRecording(h.app));
    now = 32;
    API.updateScene({ elements: [newElementWith(target, { x: 200 })] });
    now = 40;
    act(() => toggleRecording(h.app));
    const [clip] = getClips(h.app);
    expect(clip.x).toBe(1450);
    expect(clip.y).toBe(450);
    expect(clip.points[0]).toEqual([0, 0]);
    expect(clip.points[clip.points.length - 1]).toEqual([-1200, 0]);
    expect(clip.customData.anim.keys.length).toBeGreaterThanOrEqual(2);
    expect(
      getFrameElements(h.elements, [clip], 0).find((el) => el.id === target.id)
        ?.x,
    ).toBe(1400);
    expect(
      getFrameElements(h.elements, [clip], clip.customData.anim.duration).find(
        (el) => el.id === target.id,
      )?.x,
    ).toBe(200);
  } finally {
    clock.mockRestore();
  }
});

it("does not let unselected objects shift the center of a recording", () => {
  const target = API.createElement({
    type: "rectangle",
    x: 1400,
    y: 400,
    width: 100,
    height: 100,
  });
  const unrelated = API.createElement({
    type: "rectangle",
    x: -1000,
    y: 0,
    width: 100,
    height: 100,
  });
  API.updateScene({
    elements: [target, unrelated],
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
  API.setSelectedElements([target]);
  let now = 0;
  const clock = vi
    .spyOn(h.app.ownerWindow.performance, "now")
    .mockImplementation(() => now);
  try {
    act(() => toggleRecording(h.app));
    now = 600;
    API.updateScene({
      elements: [
        newElementWith(target, { x: 1300 }),
        newElementWith(unrelated, { x: -1010 }),
      ],
    });
    API.setAppState({
      scrollX: -800,
      scrollY: -300,
      zoom: { value: 0.5 as any },
    });
    now = 900;
    API.updateScene({
      elements: h.elements.map((el) =>
        el.id === target.id ? newElementWith(el, { x: 200 }) : el,
      ),
    });
    act(() => toggleRecording(h.app));
    const [clip] = getClips(h.app);
    expect(clip.customData.anim.targets).toEqual([target.id]);
    expect(clip.x).toBe(1450);
    expect(clip.y).toBe(450);
    expect(clip.points[clip.points.length - 1]).toEqual([-1200, 0]);
  } finally {
    clock.mockRestore();
  }
});
