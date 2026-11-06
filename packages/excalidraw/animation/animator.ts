import { useSyncExternalStore } from "react";
import { pointsOnBezierCurves, simplify } from "points-on-curve";
import { curveToBezier } from "points-on-curve/lib/curve-to-bezier";

import { ROUNDNESS, getSizeFromPoints } from "@excalidraw/common";
import {
  CaptureUpdateAction,
  LinearElementEditor,
  animPathVisibility,
  isAnimPath,
  isTextElement,
  newElementWith,
  newLinearElement,
} from "@excalidraw/element";

import type { Merge } from "@excalidraw/common/utility-types";
import type { LocalPoint } from "@excalidraw/math";
import type {
  ElementsMap,
  ExcalidrawElement,
  ExcalidrawLineElement,
} from "@excalidraw/element/types";

import type { AppClassProperties } from "../types";

/**
 * An animation clip lives on a hidden, dashed `line` element (the motion
 * path) in `customData.anim`. That makes clips regular scene elements: undo,
 * save/load and point editing are shared with the canvas.
 *
 * The targets' center follows the path; `keys` hold, over normalized time,
 * the progress along the path and the scale/rotation relative to `home`.
 */

type App = AppClassProperties;

type Pose = {
  x: number;
  y: number;
  width: number;
  height: number;
  angle: number;
  points?: readonly (readonly [number, number])[];
  fontSize?: number;
};
type Home = Omit<Pose, "x" | "y"> & { dx: number; dy: number };
/** [t (0..1), path progress (0..1), scaleX, scaleY, rotation] */
type Key = [number, number, number, number, number];

export type ClipData = {
  name: string;
  start: number;
  duration: number;
  targets: string[];
  home: Record<string, Home>;
  keys: Key[];
};
export type ClipElement = Merge<
  ExcalidrawLineElement,
  {
    customData: { anim: ClipData };
  }
>;

// ------------------------------------------------------------------ UI state

type State = {
  time: number;
  playing: boolean;
  recording: boolean;
  drawerOpen: boolean;
  scrubbing: boolean;
};

let state: State = {
  time: 0,
  playing: false,
  recording: false,
  drawerOpen: false,
  scrubbing: false,
};
const listeners = new Set<() => void>();
const set = (next: Partial<State>) => {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
};

export const useAnimator = () =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );

/**
 * Scene.onUpdate throws on a re-registered callback and on a second removal
 * (the App clears all callbacks on unmount, before child effects clean up)
 */
export const onSceneUpdate = (app: App, cb: () => void) => {
  const off = app.scene.onUpdate(() => cb());
  return () => {
    try {
      off();
    } catch {}
  };
};

/** re-render on every scene change (clips are scene elements) */
export const useSceneNonce = (app: App) =>
  useSyncExternalStore(
    (l) => onSceneUpdate(app, l),
    () => app.scene.getSceneNonce(),
  );

export const getClips = (app: App) =>
  app.scene.getNonDeletedElements().filter(isAnimPath) as ClipElement[];

export const totalDuration = (clips: readonly ClipElement[]) =>
  Math.max(
    1000,
    ...clips.map((c) => c.customData.anim.start + c.customData.anim.duration),
  );

// ------------------------------------------------------------------ geometry

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const TAU = Math.PI * 2;
const wrapDelta = (d: number) => d - TAU * Math.round(d / TAU);
const normAngle = (a: number) => ((a % TAU) + TAU) % TAU;

const readPose = (el: ExcalidrawElement): Pose => ({
  x: el.x,
  y: el.y,
  width: el.width,
  height: el.height,
  angle: el.angle,
  points: "points" in el ? el.points : undefined,
  fontSize: "fontSize" in el ? el.fontSize : undefined,
});

const samePose = (a: Pose, b: Pose) =>
  a.x === b.x &&
  a.y === b.y &&
  a.width === b.width &&
  a.height === b.height &&
  a.angle === b.angle &&
  a.points === b.points &&
  a.fontSize === b.fontSize;

/** center of the element relative to its x/y */
const localCenter = (p: Omit<Pose, "x" | "y">): [number, number] => {
  if (!p.points?.length) {
    return [p.width / 2, p.height / 2];
  }
  const xs = p.points.map((pt) => pt[0]);
  const ys = p.points.map((pt) => pt[1]);
  return [
    (Math.min(...xs) + Math.max(...xs)) / 2,
    (Math.min(...ys) + Math.max(...ys)) / 2,
  ];
};
const centerOf = (p: Pose): [number, number] => {
  const [cx, cy] = localCenter(p);
  return [p.x + cx, p.y + cy];
};
const meanCenter = (poses: Pose[]): [number, number] => {
  const cs = poses.map(centerOf);
  return [
    cs.reduce((s, c) => s + c[0], 0) / cs.length,
    cs.reduce((s, c) => s + c[1], 0) / cs.length,
  ];
};

const homesFor = (poses: Map<string, Pose>) => {
  const [cx, cy] = meanCenter([...poses.values()]);
  const home: Record<string, Home> = {};
  for (const [id, p] of poses) {
    const [ex, ey] = centerOf(p);
    const { x, y, ...rest } = p;
    home[id] = { ...rest, dx: ex - cx, dy: ey - cy };
  }
  return home;
};

/** the path as rendered (roughjs curve for round lines), as a polyline */
const polylineCache = new WeakMap<
  ExcalidrawElement,
  { version: number; pts: [number, number][]; cum: number[] }
>();
const pathPolyline = (el: ClipElement, elementsMap: ElementsMap) => {
  // elements are mutated in place while edited: key on the version too
  let cached = polylineCache.get(el);
  if (!cached || cached.version !== el.version) {
    const global = LinearElementEditor.getPointsGlobalCoordinates(
      el,
      elementsMap,
    ).map((p) => [p[0], p[1]] as [number, number]);
    const pts =
      el.roundness && global.length > 2
        ? // roughjs' curve() duplicates the end points before fitting
          (pointsOnBezierCurves(
            curveToBezier([global[0], ...global, global[global.length - 1]]),
            0.5,
          ) as [number, number][])
        : global;
    const cum = [0];
    for (let i = 1; i < pts.length; i++) {
      cum.push(
        cum[i - 1] +
          Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]),
      );
    }
    cached = { version: el.version, pts, cum };
    polylineCache.set(el, cached);
  }
  return cached;
};
const pointAt = (
  el: ClipElement,
  elementsMap: ElementsMap,
  p: number,
): [number, number] => {
  const { pts, cum } = pathPolyline(el, elementsMap);
  const target = p * cum[cum.length - 1];
  let i = 1;
  while (i < pts.length - 1 && cum[i] < target) {
    i++;
  }
  const seg = cum[i] - cum[i - 1] || 1;
  const k = Math.max(0, Math.min(1, (target - cum[i - 1]) / seg));
  return [lerp(pts[i - 1][0], pts[i][0], k), lerp(pts[i - 1][1], pts[i][1], k)];
};

// ----------------------------------------------------------------- recording

type Sample = Pose & { t: number };

const sampleTrack = (kfs: Sample[], t: number): Pose => {
  if (t <= kfs[0].t) {
    return kfs[0];
  }
  const last = kfs[kfs.length - 1];
  if (t >= last.t) {
    return last;
  }
  let i = 1;
  while (kfs[i].t < t) {
    i++;
  }
  const a = kfs[i - 1];
  const b = kfs[i];
  const k = (t - a.t) / (b.t - a.t || 1);
  return {
    x: lerp(a.x, b.x, k),
    y: lerp(a.y, b.y, k),
    width: lerp(a.width, b.width, k),
    height: lerp(a.height, b.height, k),
    angle: a.angle + wrapDelta(b.angle - a.angle) * k,
    points: k < 0.5 ? a.points : b.points,
    fontSize:
      a.fontSize && b.fontSize ? lerp(a.fontSize, b.fontSize, k) : a.fontSize,
  };
};

let rec: {
  t0: number;
  base: Map<string, Pose>;
  tracks: Map<string, Sample[]>;
  unsubscribe: () => void;
} | null = null;

export const isRecording = () => Boolean(rec);

/** whether there is a selected element that a new clip could record */
export const hasRecordableSelection = (app: App) =>
  app.scene.getSelectedElements(app.state).some((el) => !isAnimPath(el));

const HOLD_GAP = 50;

const sample = (app: App) => {
  if (!rec) {
    return;
  }
  const now = app.ownerWindow.performance.now() - rec.t0;
  for (const el of app.scene.getNonDeletedElements()) {
    const base = rec.base.get(el.id);
    if (!base) {
      continue;
    }
    const pose = readPose(el);
    let track = rec.tracks.get(el.id);
    const last = track ? track[track.length - 1] : { ...base, t: 0 };
    if (samePose(last, pose)) {
      continue;
    }
    if (!track) {
      track = [last];
      rec.tracks.set(el.id, track);
    }
    // the element sat still since the last sample: hold it there
    if (now - last.t > HOLD_GAP) {
      track.push({ ...last, t: now - 16 });
    }
    track.push({ ...pose, t: now });
  }
};

export const toggleRecording = (app: App) => {
  if (state.drawerOpen || state.playing || app.state.openDialog) {
    return;
  }
  if (rec) {
    stopRecording(app);
    return;
  }
  const selected = app.scene
    .getSelectedElements({
      selectedElementIds: app.state.selectedElementIds,
      includeBoundTextElement: true,
      includeElementsInFrames: true,
    })
    .filter((el) => !isAnimPath(el));
  if (!selected.length) {
    app.setState({
      toast: { message: "Select something to animate, then press G" },
    });
    return;
  }
  // recording always starts a new clip at 0s: bring the preview back to the
  // first frame so the base pose (and playhead) match where the clip begins
  seek(app, 0);
  const targetIds = new Set(selected.map((el) => el.id));
  rec = {
    t0: app.ownerWindow.performance.now(),
    base: new Map(
      app.scene
        .getNonDeletedElements()
        .filter((el) => targetIds.has(el.id))
        .map((el) => [el.id, readPose(el)]),
    ),
    tracks: new Map(),
    unsubscribe: onSceneUpdate(app, () => sample(app)),
  };
  set({ recording: true });
};

const r4 = (n: number) => Math.round(n * 10000) / 10000;

const stopRecording = (app: App) => {
  if (!rec) {
    return;
  }
  sample(app);
  rec.unsubscribe();
  const tracks = [...rec.tracks.entries()];
  const base = rec.base;
  rec = null;
  set({ recording: false });
  if (!tracks.length) {
    app.setState({ toast: { message: "Nothing moved — no animation made" } });
    return;
  }

  // trim idle time before the first and after the last change
  const t0 = Math.min(
    ...tracks.map(([, kfs]) => {
      // Keep the sample immediately BEFORE the first change. Starting at the
      // changed sample discards the first motion and shifts fast, wide paths.
      const firstChange = kfs.findIndex((pose) => !samePose(pose, kfs[0]));
      return kfs[Math.max(0, firstChange - 1)].t;
    }),
  );
  const t1 = Math.max(...tracks.map(([, kfs]) => kfs[kfs.length - 1].t));
  const duration = Math.max(16, t1 - t0);

  const basePoses = new Map(tracks.map(([id]) => [id, base.get(id)!]));
  const home = homesFor(basePoses);
  const ids = [...basePoses.keys()];

  const centers: [number, number][] = [];
  const raw: [number, number, number, number][] = []; // t, sx, sy, rot
  let prevRot = 0;
  for (let t = t0; ; t += 16) {
    const tt = Math.min(t, t1);
    const poses = tracks.map(([, kfs]) => sampleTrack(kfs, tt));
    centers.push(meanCenter(poses));
    const ratio = (key: "width" | "height") => {
      const rs = poses
        .map((p, i) => [p[key], home[ids[i]][key]])
        .filter(([, b]) => b > 1)
        .map(([a, b]) => a / b);
      return rs.length ? rs.reduce((s, r) => s + r, 0) / rs.length : 1;
    };
    // keep rotation continuous (no jumps at ±π)
    const rot =
      prevRot + wrapDelta(poses[0].angle - home[ids[0]].angle - prevRot);
    prevRot = rot;
    raw.push([(tt - t0) / duration, ratio("width"), ratio("height"), rot]);
    if (tt === t1) {
      break;
    }
  }

  const cum = [0];
  for (let i = 1; i < centers.length; i++) {
    cum.push(
      cum[i - 1] +
        Math.hypot(
          centers[i][0] - centers[i - 1][0],
          centers[i][1] - centers[i - 1][1],
        ),
    );
  }
  const length = cum[cum.length - 1];
  const moved = length > 0.5;
  const [ox, oy] = centers[0];
  const simplified: [number, number][] = moved
    ? (simplify(centers, 2) as [number, number][])
    : [centers[0], [ox + 1, oy]];
  const points = simplified.map(
    ([x, y]) => [x - ox, y - oy] as unknown as LocalPoint,
  );

  const clipCount = getClips(app).length;
  const data: ClipData = {
    name: `Animation ${clipCount + 1}`,
    start: 0,
    duration: Math.round(duration),
    targets: ids,
    home,
    keys: raw.map(([t, sx, sy, rot], i) => [
      r4(t),
      moved ? r4(cum[i] / length) : 0,
      r4(sx),
      r4(sy),
      r4(rot),
    ]),
  };

  const path = newLinearElement({
    type: "line",
    x: ox,
    y: oy,
    points,
    ...getSizeFromPoints(points),
    strokeColor: "#7c3aed",
    backgroundColor: "transparent",
    strokeWidth: 1,
    strokeStyle: "dashed",
    roughness: 0,
    roundness: { type: ROUNDNESS.PROPORTIONAL_RADIUS },
    customData: { anim: data },
  });
  app.updateScene({
    elements: [...app.scene.getElementsIncludingDeleted(), path],
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
  set({ time: data.duration });
};

// ------------------------------------------------------------------ playback

const keyAt = (keys: Key[], u: number): Key => {
  if (keys.length === 1 || u <= keys[0][0]) {
    return keys[0];
  }
  let i = 1;
  while (i < keys.length - 1 && keys[i][0] < u) {
    i++;
  }
  const a = keys[i - 1];
  const b = keys[i];
  const k = Math.max(0, Math.min(1, (u - a[0]) / (b[0] - a[0] || 1)));
  return a.map((v, j) => lerp(v, b[j], k)) as Key;
};

const posesAt = (
  clip: ClipElement,
  u: number,
  elementsMap: ElementsMap,
  out: Map<string, Pose>,
) => {
  const { targets, home, keys } = clip.customData.anim;
  const [, p, sx, sy, rot] = keyAt(keys, u);
  const [cx, cy] = pointAt(clip, elementsMap, p);
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  for (const id of targets) {
    const h = home[id];
    if (!h) {
      continue;
    }
    const ox = h.dx * sx;
    const oy = h.dy * sy;
    const pose = {
      width: h.width * sx,
      height: h.height * sy,
      angle: normAngle(h.angle + rot),
      points: h.points?.map(([a, b]) => [a * sx, b * sy] as const),
      fontSize: h.fontSize ? h.fontSize * sy : undefined,
    };
    const [lx, ly] = localCenter(pose);
    out.set(id, {
      ...pose,
      x: cx + ox * cos - oy * sin - lx,
      y: cy + ox * sin + oy * cos - ly,
    });
  }
};

/**
 * The scene elements with every clip's pose applied at `t`.
 *
 * Pure (doesn't touch the live scene) so the exporter can sample frames
 * without seeking the editor.
 */
export const getFrameElements = (
  elements: readonly ExcalidrawElement[],
  clips: readonly ClipElement[],
  t: number,
): ExcalidrawElement[] => {
  const sorted = [...clips].sort(
    (a, b) => a.customData.anim.start - b.customData.anim.start,
  );
  if (!sorted.length) {
    return [...elements];
  }
  const elementsMap = new Map(
    elements.filter((el) => !el.isDeleted).map((el) => [el.id, el]),
  ) as ElementsMap;
  const frame = new Map<string, Pose>();
  for (const clip of sorted) {
    const { start, duration, targets } = clip.customData.anim;
    const u = (t - start) / duration;
    if (u >= 0) {
      posesAt(clip, Math.min(1, u), elementsMap, frame);
    } else if (targets.some((id) => !frame.has(id))) {
      // before any clip touched these elements: hold the first frame
      const first = new Map<string, Pose>();
      posesAt(clip, 0, elementsMap, first);
      first.forEach((pose, id) => !frame.has(id) && frame.set(id, pose));
    }
  }
  return elements.map((el) => {
    const pose = frame.get(el.id);
    if (!pose || el.isDeleted) {
      return el;
    }
    const { points, fontSize, ...rest } = pose;
    return newElementWith(el, {
      ...rest,
      angle: rest.angle as ExcalidrawElement["angle"],
      ...(points && "points" in el ? { points: points as any } : {}),
      ...(fontSize && "fontSize" in el ? { fontSize } : {}),
    });
  });
};

let applyingFrame = false;
const applyFrame = (app: App, t: number) => {
  const clips = getClips(app);
  if (!clips.length) {
    return;
  }
  applyingFrame = true;
  try {
    app.updateScene({
      elements: getFrameElements(
        app.scene.getElementsIncludingDeleted(),
        clips,
        t,
      ),
      captureUpdate: CaptureUpdateAction.NEVER,
    });
  } finally {
    applyingFrame = false;
  }
};

export const seek = (app: App, time: number) => {
  const t = Math.max(0, Math.min(time, totalDuration(getClips(app))));
  set({ time: t });
  applyFrame(app, t);
};

let raf = 0;
let playbackWindow: App["ownerWindow"] | null = null;
export const play = (app: App, fromStart = false) => {
  if (rec) {
    return;
  }
  playbackWindow?.cancelAnimationFrame(raf);
  playbackWindow = app.ownerWindow;
  const total = totalDuration(getClips(app));
  let t = fromStart || state.time >= total ? 0 : state.time;
  set({ playing: true });
  seek(app, t);
  let prev = app.ownerWindow.performance.now();
  const tick = (now: number) => {
    t += now - prev;
    prev = now;
    if (t >= total) {
      seek(app, total);
      set({ playing: false });
      return;
    }
    seek(app, t);
    raf = app.ownerWindow.requestAnimationFrame(tick);
  };
  raf = app.ownerWindow.requestAnimationFrame(tick);
};

export const pause = () => {
  playbackWindow?.cancelAnimationFrame(raf);
  set({ playing: false });
};

export const setScrubbing = (scrubbing: boolean) => set({ scrubbing });
export const setDrawerOpen = (drawerOpen: boolean) => {
  if (!state.recording) {
    set({ drawerOpen });
  }
};

/** Objects remain visible, but only motion paths are selectable in the editor. */
export const isAnimEditorPathsOnly = () => state.drawerOpen;

export const setPathsVisible = (app: App, visible: boolean) => {
  if (animPathVisibility.visible === visible) {
    return;
  }
  animPathVisibility.visible = visible;
  if (!visible && app.scene.getSelectedElements(app.state).some(isAnimPath)) {
    app.setState({ selectedElementIds: {}, selectedLinearElement: null });
  }
  app.scene.triggerUpdate();
};

// --------------------------------------------------------- editing clips

/**
 * Paths belong to their parts, even while those parts are ungrouped. Any group
 * containing a linked part inherits the motion, including newly added pieces.
 * Keep the old homes and path unchanged; express additions in the same local
 * coordinates by undoing the linked part's current scale and rotation.
 */
export const inheritAnimationGroupTargets = (
  elements: readonly ExcalidrawElement[],
): readonly ExcalidrawElement[] => {
  const visible = elements.filter((el) => !el.isDeleted && !isAnimPath(el));
  const byId = new Map(visible.map((el) => [el.id, el]));
  let changed = false;
  const nextElements = elements.map((clip) => {
    if (clip.isDeleted || !isAnimPath(clip)) {
      return clip;
    }
    const data = clip.customData!.anim as ClipData;
    const anchors = data.targets.flatMap((id) => {
      const element = byId.get(id);
      return element && data.home[id] ? [{ element, home: data.home[id] }] : [];
    });
    const byGroup = new Map<string, typeof anchors[number]>();
    for (const anchor of anchors) {
      for (const groupId of anchor.element.groupIds) {
        if (!byGroup.has(groupId)) {
          byGroup.set(groupId, anchor);
        }
      }
    }
    if (!byGroup.size) {
      return clip;
    }

    const targets = new Set(data.targets);
    const home = { ...data.home };
    for (const element of visible) {
      if (targets.has(element.id)) {
        continue;
      }
      // Bound labels travel with their container, even without their own group ID.
      const container =
        isTextElement(element) && element.containerId
          ? byId.get(element.containerId)
          : undefined;
      const groupId = [
        ...element.groupIds,
        ...(container?.groupIds ?? []),
      ].find((id) => byGroup.has(id));
      const anchor = groupId ? byGroup.get(groupId) : undefined;
      if (!anchor) {
        continue;
      }
      const scale = (axis: "width" | "height") => {
        // A horizontal/vertical line cannot tell us scale along its flat axis.
        // Use a sibling with extent on that axis, or unit scale if all are flat.
        const reference = [anchor, ...anchors].find(
          ({ element: part, home: base }) =>
            part.groupIds.includes(groupId!) &&
            Math.abs(base[axis]) > 1e-6 &&
            Math.abs(part[axis]) > 1e-6,
        );
        return reference ? reference.element[axis] / reference.home[axis] : 1;
      };
      const sx = scale("width");
      const sy = scale("height");
      const rotation = wrapDelta(anchor.element.angle - anchor.home.angle);
      const cos = Math.cos(rotation);
      const sin = Math.sin(rotation);
      const [ax, ay] = centerOf(readPose(anchor.element));
      const [ex, ey] = centerOf(readPose(element));
      const pose = readPose(element);
      home[element.id] = {
        dx: anchor.home.dx + ((ex - ax) * cos + (ey - ay) * sin) / sx,
        dy: anchor.home.dy + (-(ex - ax) * sin + (ey - ay) * cos) / sy,
        width: pose.width / sx,
        height: pose.height / sy,
        angle: normAngle(pose.angle - rotation),
        ...(pose.points
          ? { points: pose.points.map(([x, y]) => [x / sx, y / sy] as const) }
          : {}),
        ...(pose.fontSize ? { fontSize: pose.fontSize / sy } : {}),
      };
      targets.add(element.id);
    }
    if (targets.size === data.targets.length) {
      return clip;
    }
    changed = true;
    return newElementWith(clip, {
      customData: {
        ...clip.customData,
        anim: { ...data, targets: [...targets], home },
      },
    });
  });
  return changed ? nextElements : elements;
};

const updateClipElement = (
  app: App,
  id: string,
  next: Partial<ClipElement>,
) => {
  app.updateScene({
    elements: app.scene
      .getElementsIncludingDeleted()
      .map((el) => (el.id === id ? newElementWith(el, next as any) : el)),
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
};

export const updateClip = (app: App, id: string, patch: Partial<ClipData>) => {
  const clip = app.scene.getElement(id) as ClipElement | null;
  if (!clip) {
    return;
  }
  updateClipElement(app, id, {
    customData: {
      ...clip.customData,
      anim: { ...clip.customData.anim, ...patch },
    },
  });
  applyFrame(app, state.time);
};

/** Delete the animation, preserving the objects and clearing its selection. */
export const deleteClip = (app: App, id: string) => {
  const selectedElementIds = { ...app.state.selectedElementIds };
  delete selectedElementIds[id];
  app.updateScene({
    elements: app.scene
      .getElementsIncludingDeleted()
      .map((el) =>
        el.id === id ? newElementWith(el, { isDeleted: true }) : el,
      ),
    appState: {
      selectedElementIds,
      selectedGroupIds: {},
      selectedLinearElement: null,
    },
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
  seek(app, state.time);
};

/** Keep paths and their linked parts together, including newly grouped pieces. */
export const watchAnimationPaths = (app: App) => {
  let previous = new Map<string, { x: number; y: number; version: number }>();
  let syncing = false;
  const snapshot = () => {
    previous = new Map(
      app.scene
        .getNonDeletedElements()
        .map((el) => [el.id, { x: el.x, y: el.y, version: el.version }]),
    );
  };
  snapshot();
  const sync = () => {
    if (syncing) {
      return;
    }
    if (applyingFrame || state.recording || state.playing || state.scrubbing) {
      snapshot();
      return;
    }
    syncing = true;
    try {
      const elements = app.scene.getElementsIncludingDeleted();
      const inherited = inheritAnimationGroupTargets(elements);
      if (inherited !== elements) {
        // Covers loaded scenes and additions made while editing an existing group.
        // The group action itself includes this update in its undoable result.
        app.updateScene({
          elements: inherited,
          captureUpdate: CaptureUpdateAction.EVENTUALLY,
        });
      }
      const clips = getClips(app);
      const changedPath = clips.some((clip) => {
        const prev = previous.get(clip.id);
        return prev && prev.version !== clip.version;
      });
      if (state.drawerOpen && changedPath) {
        applyFrame(app, state.time);
      } else if (!state.drawerOpen) {
        const translated = new Map<string, ClipElement>();
        const previousElements = previous;
        for (const clip of clips) {
          const prev = previous.get(clip.id);
          // Undo/redo can restore both the object and its path in one update.
          if (!prev || prev.version !== clip.version) {
            continue;
          }
          const deltas = clip.customData.anim.targets.flatMap((id) => {
            const target = app.scene.getElement(id);
            const before = previousElements.get(id);
            return target && !target.isDeleted && before
              ? [[target.x - before.x, target.y - before.y]]
              : [];
          });
          if (!deltas.length) {
            continue;
          }
          const dx =
            deltas.reduce((sum, delta) => sum + delta[0], 0) / deltas.length;
          const dy =
            deltas.reduce((sum, delta) => sum + delta[1], 0) / deltas.length;
          if (dx || dy) {
            translated.set(
              clip.id,
              newElementWith(clip, { x: clip.x + dx, y: clip.y + dy }),
            );
          }
        }
        if (translated.size) {
          app.updateScene({
            elements: app.scene
              .getElementsIncludingDeleted()
              .map((el) => translated.get(el.id) ?? el),
            captureUpdate: CaptureUpdateAction.NEVER,
          });
        }
      }
      snapshot();
    } finally {
      syncing = false;
    }
  };
  const off = onSceneUpdate(app, sync);
  sync();
  return off;
};
