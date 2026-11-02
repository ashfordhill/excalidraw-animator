import { useSyncExternalStore } from "react";

import { CaptureUpdateAction, newElementWith } from "@excalidraw/element";

import type { ExcalidrawElement } from "@excalidraw/element/types";

import type { AppClassProperties } from "../types";

type App = AppClassProperties;

type Props = {
  x: number;
  y: number;
  width: number;
  height: number;
  angle: number;
  points?: readonly (readonly [number, number])[];
};
type Keyframe = Props & { t: number };

export type Clip = {
  id: string;
  name: string;
  start: number;
  duration: number;
  tracks: Record<string, Keyframe[]>;
};

type State = {
  clips: Clip[];
  time: number;
  playing: boolean;
  recording: boolean;
  drawerOpen: boolean;
  scrubbing: boolean;
};

const STORAGE_KEY = "excalidraw-animator-clips";
const HOLD_GAP = 50;

const loadClips = (): Clip[] => {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
  } catch {
    return [];
  }
};

let state: State = {
  clips: loadClips(),
  time: 0,
  playing: false,
  recording: false,
  drawerOpen: false,
  scrubbing: false,
};
const listeners = new Set<() => void>();

const set = (next: Partial<State>) => {
  const clipsChanged = next.clips && next.clips !== state.clips;
  state = { ...state, ...next };
  if (clipsChanged) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.clips));
    } catch {}
  }
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

export const isPreviewing = (s: State = state) =>
  s.playing || s.drawerOpen || s.scrubbing;

export const totalDuration = (clips = state.clips) =>
  Math.max(1000, ...clips.map((c) => c.start + c.duration));

// ---------------------------------------------------------------- recording

const readProps = (el: ExcalidrawElement): Props => ({
  x: el.x,
  y: el.y,
  width: el.width,
  height: el.height,
  angle: el.angle,
  points: "points" in el ? el.points : undefined,
});

const sameProps = (a: Props, b: Props) =>
  a.x === b.x &&
  a.y === b.y &&
  a.width === b.width &&
  a.height === b.height &&
  a.angle === b.angle &&
  a.points === b.points;

let rec: {
  t0: number;
  base: Map<string, Props>;
  tracks: Map<string, Keyframe[]>;
  unsubscribe: () => void;
} | null = null;

const sample = (app: App) => {
  if (!rec) {
    return;
  }
  const now = performance.now() - rec.t0;
  for (const el of app.scene.getNonDeletedElements()) {
    const base = rec.base.get(el.id);
    if (!base) {
      continue;
    }
    const props = readProps(el);
    let track = rec.tracks.get(el.id);
    const last = track ? track[track.length - 1] : { ...base, t: 0 };
    if (sameProps(last, props)) {
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
    track.push({ ...props, t: now });
  }
};

export const toggleRecording = (app: App) => {
  if (rec) {
    stopRecording(app);
    return;
  }
  if (isPreviewing()) {
    return;
  }
  if (!app.scene.getSelectedElements(app.state).length) {
    app.setState({
      toast: { message: "Select something to animate, then press G" },
    });
    return;
  }
  rec = {
    t0: performance.now(),
    base: new Map(
      app.scene.getNonDeletedElements().map((el) => [el.id, readProps(el)]),
    ),
    tracks: new Map(),
    unsubscribe: app.scene.onUpdate(() => sample(app)),
  };
  set({ recording: true });
};

const stopRecording = (app: App) => {
  if (!rec) {
    return;
  }
  sample(app);
  rec.unsubscribe();
  const tracks = [...rec.tracks.entries()];
  rec = null;
  set({ recording: false });
  if (!tracks.length) {
    app.setState({ toast: { message: "Nothing moved — no animation made" } });
    return;
  }
  // trim the idle time before the first movement
  const offset = Math.min(...tracks.map(([, kfs]) => kfs[1].t));
  const clip: Clip = {
    id: Math.random().toString(36).slice(2),
    name: `Animation ${state.clips.length + 1}`,
    start: 0,
    duration: 0,
    tracks: {},
  };
  for (const [id, kfs] of tracks) {
    clip.tracks[id] = kfs.map((kf, i) => ({
      ...kf,
      t: i === 0 ? 0 : Math.max(0, kf.t - offset),
    }));
    clip.duration = Math.max(
      clip.duration,
      clip.tracks[id][clip.tracks[id].length - 1].t,
    );
  }
  set({ clips: [...state.clips, clip], time: clip.duration });
};

// ---------------------------------------------------------------- playback

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const lerpAngle = (a: number, b: number, k: number) => {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) {
    d -= Math.PI * 2;
  } else if (d < -Math.PI) {
    d += Math.PI * 2;
  }
  return (((a + d * k) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
};

const sampleTrack = (kfs: Keyframe[], t: number): Props => {
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
    angle: lerpAngle(a.angle, b.angle, k),
    points:
      a.points && b.points && a.points.length === b.points.length
        ? a.points.map(
            (p, j) =>
              [
                lerp(p[0], b.points![j][0], k),
                lerp(p[1], b.points![j][1], k),
              ] as const,
          )
        : k < 0.5
        ? a.points
        : b.points,
  };
};

const evaluate = (t: number) => {
  const out = new Map<string, Props>();
  const clips = [...state.clips].sort((a, b) => a.start - b.start);
  for (const clip of clips) {
    for (const [id, kfs] of Object.entries(clip.tracks)) {
      if (t < clip.start) {
        // before any clip touched this element: hold its first frame
        if (!out.has(id)) {
          out.set(id, kfs[0]);
        }
      } else {
        out.set(id, sampleTrack(kfs, t - clip.start));
      }
    }
  }
  return out;
};

const applyFrame = (app: App, t: number) => {
  const frame = evaluate(t);
  if (!frame.size) {
    return;
  }
  app.updateScene({
    elements: app.scene.getElementsIncludingDeleted().map((el) => {
      const p = frame.get(el.id);
      if (!p) {
        return el;
      }
      const { points, ...rest } = p;
      return newElementWith(el, {
        ...rest,
        angle: rest.angle as ExcalidrawElement["angle"],
        ...(points && "points" in el ? { points: points as any } : {}),
      });
    }),
    captureUpdate: CaptureUpdateAction.NEVER,
  });
};

export const seek = (app: App, time: number) => {
  const t = Math.max(0, Math.min(time, totalDuration()));
  set({ time: t });
  applyFrame(app, t);
};

let raf = 0;
export const play = (app: App, fromStart = false) => {
  if (rec) {
    return;
  }
  cancelAnimationFrame(raf);
  const total = totalDuration();
  let t = fromStart || state.time >= total ? 0 : state.time;
  set({ playing: true });
  seek(app, t);
  let prev = performance.now();
  const tick = (now: number) => {
    t += now - prev;
    prev = now;
    if (t >= total) {
      seek(app, total);
      set({ playing: false });
      return;
    }
    seek(app, t);
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
};

export const pause = () => {
  cancelAnimationFrame(raf);
  set({ playing: false });
};

export const setScrubbing = (scrubbing: boolean) => set({ scrubbing });
export const setDrawerOpen = (drawerOpen: boolean) => set({ drawerOpen });

export const moveClip = (app: App, id: string, start: number) => {
  set({
    clips: state.clips.map((c) =>
      c.id === id ? { ...c, start: Math.max(0, Math.round(start)) } : c,
    ),
  });
  applyFrame(app, state.time);
};

export const deleteClip = (id: string) =>
  set({ clips: state.clips.filter((c) => c.id !== id) });

export const renameClip = (id: string, name: string) =>
  set({ clips: state.clips.map((c) => (c.id === id ? { ...c, name } : c)) });
