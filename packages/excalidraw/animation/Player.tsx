import clsx from "clsx";
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";

import { isAnimPath } from "@excalidraw/element";

import { useApp } from "../components/App";
import { useAppStateValue } from "../hooks/useAppStateValue";

import {
  cloneClip,
  deleteClip,
  getClips,
  onEditorPointerUp,
  onSceneUpdate,
  pause,
  play,
  seek,
  setDrawerOpen,
  setPathsVisible,
  setScrubbing,
  toggleRecording,
  totalDuration,
  trackPaths,
  updateClip,
  useAnimator,
  useSceneNonce,
} from "./animator";

import "./Player.scss";

import type { ClipElement } from "./animator";

const svg = (d: React.ReactNode) => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
    {d}
  </svg>
);
const recordIcon = svg(<circle cx="12" cy="12" r="6" />);
const stopIcon = svg(<rect x="6" y="6" width="12" height="12" rx="1" />);
const playIcon = svg(<path d="M7 4l13 8-13 8z" />);
const pauseIcon = svg(<path d="M6 4h4v16H6zm8 0h4v16h-4z" />);
const restartIcon = svg(<path d="M5 4h2v16H5zm3 8l11-8v16z" />);
const filmIcon = (
  <svg
    viewBox="0 0 24 24"
    width="16"
    height="16"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinejoin="round"
  >
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4" />
  </svg>
);
const closeIcon = (
  <svg
    viewBox="0 0 24 24"
    width="12"
    height="12"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
  >
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);
const mouseWheelIcon = (
  <svg
    viewBox="0 0 24 24"
    width="15"
    height="15"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect x="7" y="2.5" width="10" height="19" rx="5" />
    <path d="M12 6v4M9.5 12.5 12 15l2.5-2.5" />
  </svg>
);

const fmt = (ms: number) => `${(ms / 1000).toFixed(2)}s`;

const MIN_TIMELINE_VIEW = 1000;
const MAX_TIMELINE_VIEW = 120000;
const DEFAULT_TIMELINE_VIEW = 10000;

type App = ReturnType<typeof useApp>;

/** pointer-drag along an element, mapping the x position to a time */
const scrubHandlers = (
  app: App,
  duration: number,
): React.HTMLAttributes<HTMLDivElement> => {
  const toTime = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return ((e.clientX - r.left) / r.width) * duration;
  };
  return {
    onPointerDown: (e) => {
      pause();
      e.currentTarget.setPointerCapture(e.pointerId);
      setScrubbing(true);
      seek(app, toTime(e));
    },
    onPointerMove: (e) => {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        seek(app, toTime(e));
      }
    },
    onPointerUp: () => setScrubbing(false),
  };
};

type Drag = { id: string; start: number; duration: number };

const Timeline = ({ clips }: { clips: ClipElement[] }) => {
  const app = useApp();
  const s = useAnimator();
  const [drag, setDrag] = useState<Drag | null>(null);
  const total = totalDuration(clips);
  const [view, setView] = useState(() =>
    Math.max(DEFAULT_TIMELINE_VIEW, total * 1.25),
  );
  const timelineRef = useRef<HTMLDivElement>(null);
  const pct = (ms: number) => `${(ms / view) * 100}%`;

  // keep the whole animation in view when a clip grows past the current scale
  useEffect(() => {
    setView((current) =>
      Math.max(current, Math.min(MAX_TIMELINE_VIEW, total * 1.25)),
    );
  }, [total]);

  // wheel-to-zoom. native listener so preventDefault() actually works
  useEffect(() => {
    const timeline = timelineRef.current;
    if (!timeline) {
      return;
    }
    const onWheel = (event: WheelEvent) => {
      if (!event.deltaY) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const factor = Math.exp(event.deltaY * 0.002);
      setView((current) =>
        Math.max(
          MIN_TIMELINE_VIEW,
          Math.min(MAX_TIMELINE_VIEW, Math.round(current * factor)),
        ),
      );
    };
    timeline.addEventListener("wheel", onWheel, { passive: false });
    return () => timeline.removeEventListener("wheel", onWheel);
  }, []);

  /** move the clip, or stretch it from either edge (changes its speed) */
  const startDrag = (
    e: React.PointerEvent,
    clip: ClipElement,
    mode: "move" | "left" | "right",
  ) => {
    e.stopPropagation();
    const { start, duration } = clip.customData.anim;
    const lane = (e.currentTarget as HTMLElement).closest(".anim-lane")!;
    const width = lane.getBoundingClientRect().width;
    const x0 = e.clientX;
    let next: Drag = { id: clip.id, start, duration };
    let moved = false;
    const move = (ev: PointerEvent) => {
      const dt = ((ev.clientX - x0) / width) * view;
      moved = moved || Math.abs(ev.clientX - x0) > 2;
      if (mode === "move") {
        next = { ...next, start: Math.max(0, start + dt) };
      } else if (mode === "right") {
        next = { ...next, duration: Math.max(50, duration + dt) };
      } else {
        const s2 = Math.max(0, Math.min(start + dt, start + duration - 50));
        next = { ...next, start: s2, duration: start + duration - s2 };
      }
      setDrag(next);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDrag(null);
      if (moved) {
        updateClip(app, clip.id, {
          start: Math.round(next.start),
          duration: Math.round(next.duration),
        });
      } else {
        app.setState({ selectedElementIds: { [clip.id]: true } });
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const ticks = [];
  const step =
    view <= 3000
      ? 500
      : view <= 12000
      ? 1000
      : view <= 30000
      ? 2000
      : view <= 60000
      ? 5000
      : 10000;
  for (let t = 0; t <= view; t += step) {
    ticks.push(
      <span key={t} className="anim-tick" style={{ left: pct(t) }}>
        {t / 1000}s
      </span>,
    );
  }

  return (
    <div
      ref={timelineRef}
      className="anim-timeline"
      {...scrubHandlers(app, view)}
    >
      <div className="anim-ruler">{ticks}</div>
      {clips.map((c) => {
        const d = drag?.id === c.id ? drag : c.customData.anim;
        return (
          <div key={c.id} className="anim-lane">
            <div
              className={clsx("anim-bar", {
                selected: app.state.selectedElementIds[c.id],
              })}
              style={{ left: pct(d.start), width: pct(d.duration) }}
              onPointerDown={(e) => startDrag(e, c, "move")}
              title={`${fmt(d.start)} → ${fmt(d.start + d.duration)}`}
            >
              <span
                className="anim-bar__edge left"
                onPointerDown={(e) => startDrag(e, c, "left")}
              />
              {c.customData.anim.name}
              <span
                className="anim-bar__edge right"
                onPointerDown={(e) => startDrag(e, c, "right")}
              />
            </div>
          </div>
        );
      })}
      <div className="anim-playhead" style={{ left: pct(s.time) }} />
    </div>
  );
};

const ClipName = ({ clip }: { clip: ClipElement }) => {
  const app = useApp();
  const name = clip.customData.anim.name;
  const [value, setValue] = useState(name);
  useEffect(() => setValue(name), [name]);
  const commit = () =>
    value !== name && updateClip(app, clip.id, { name: value });
  return (
    <input
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
      onFocus={() => app.setState({ selectedElementIds: { [clip.id]: true } })}
    />
  );
};

const Drawer = ({ clips }: { clips: ClipElement[] }) => {
  const app = useApp();
  return (
    <div className="anim-drawer">
      <div className="anim-list">
        <div className="anim-list__spacer" />
        {!clips.length && (
          <div className="anim-empty">
            Select something, press R (or ●), move it, press R again.
          </div>
        )}
        {clips.map((c) => (
          <div key={c.id} className="anim-list__item">
            <ClipName clip={c} />
            <div className="anim-list__actions">
              <button
                className="anim-clone-btn"
                title="Clone animation"
                onClick={() => cloneClip(app, c.id)}
              >
                Clone
              </button>
              <button
                className="anim-delete-btn"
                title="Delete animation"
                aria-label="Delete animation"
                onClick={() => deleteClip(app, c.id)}
              >
                {closeIcon}
              </button>
            </div>
          </div>
        ))}
      </div>
      <Timeline clips={clips} />
    </div>
  );
};

export const AnimationPlayer = () => {
  const app = useApp();
  const s = useAnimator();
  useSceneNonce(app);
  const selectedElementIds = useAppStateValue(
    (appState) => appState.selectedElementIds,
  );
  const clips = getClips(app);
  const total = totalDuration(clips);
  const editor = s.drawerOpen && !s.playing;
  const canRecord =
    s.recording ||
    app.scene
      .getNonDeletedElements()
      .some((el) => selectedElementIds[el.id] && !isAnimPath(el));
  const recordHint = s.recording
    ? "Stop recording — R"
    : s.playing
    ? "Pause playback to record — R"
    : canRecord
    ? "Record — R"
    : "Select something to record — R";

  // hide the editor UI (everything but the canvas and this player)
  const hideUI = s.drawerOpen || s.playing || s.scrubbing;
  useLayoutEffect(() => {
    if (!hideUI) {
      return;
    }
    // on <body>: React owns (and rewrites) the container's className
    const body = app.ownerDocument.body;
    body.classList.add("anim-preview");
    return () => body.classList.remove("anim-preview");
  }, [hideUI, app]);

  // while playing: lock editing
  useLayoutEffect(() => {
    if (!s.playing) {
      return;
    }
    const prevViewMode = app.state.viewModeEnabled;
    app.setState({
      viewModeEnabled: true,
      selectedElementIds: {},
      selectedGroupIds: {},
    });
    return () => app.setState({ viewModeEnabled: prevViewMode });
  }, [s.playing, app]);

  // editor: motion paths are visible and editable
  useLayoutEffect(() => {
    setPathsVisible(app, editor);
    if (!editor) {
      return;
    }
    trackPaths(app);
    const offUpdate = onSceneUpdate(app, () => trackPaths(app));
    const offUp = app.onPointerUpEmitter.on(() =>
      // let the gesture's own scene update land first
      setTimeout(() => onEditorPointerUp(app)),
    );
    return () => {
      offUpdate();
      offUp();
    };
  }, [editor, app]);

  // drawer covers the bottom half: shift the view so the scene stays visible
  useLayoutEffect(() => {
    if (!s.drawerOpen) {
      return;
    }
    const dy = (app.state.height * 0.45) / 2 / app.state.zoom.value;
    app.setState({ scrollY: app.state.scrollY - dy });
    return () => app.setState({ scrollY: app.state.scrollY + dy });
  }, [s.drawerOpen, app]);

  return (
    <div className="anim-root">
      {s.drawerOpen && <Drawer clips={clips} />}
      {s.drawerOpen && !s.playing && (
        <div className="anim-scroll-hint">
          {mouseWheelIcon}
          <span>scale timeline</span>
        </div>
      )}
      <div className={clsx("anim-bar-mini", { recording: s.recording })}>
        <button
          className="anim-rec-btn"
          aria-label={recordHint}
          data-tooltip={recordHint}
          onClick={() => toggleRecording(app)}
          disabled={s.playing || !canRecord}
        >
          {s.recording ? stopIcon : recordIcon}
        </button>
        <button
          title="Play from beginning"
          onClick={() => play(app, true)}
          disabled={s.recording}
        >
          {restartIcon}
        </button>
        <button
          title={s.playing ? "Pause" : "Play"}
          onClick={() => (s.playing ? pause() : play(app))}
          disabled={s.recording}
        >
          {s.playing ? pauseIcon : playIcon}
        </button>
        <div className="anim-scrub" {...scrubHandlers(app, total)}>
          <div
            className="anim-scrub__fill"
            style={{ width: `${(Math.min(s.time, total) / total) * 100}%` }}
          />
        </div>
        <span className="anim-time">
          {s.recording ? "REC" : fmt(Math.min(s.time, total))}
        </span>
        <button
          className={clsx({ active: s.drawerOpen })}
          title={s.drawerOpen ? "Close animation editor" : "Animation editor"}
          onClick={() => setDrawerOpen(!s.drawerOpen)}
        >
          {filmIcon}
        </button>
      </div>
    </div>
  );
};
