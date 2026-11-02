import clsx from "clsx";
import React, { useLayoutEffect, useRef } from "react";

import { useApp } from "../components/App";

import {
  deleteClip,
  isPreviewing,
  moveClip,
  pause,
  play,
  renameClip,
  seek,
  setDrawerOpen,
  setScrubbing,
  totalDuration,
  useAnimator,
} from "./animator";

import "./Player.scss";

const svg = (d: React.ReactNode) => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
    {d}
  </svg>
);
export const recordIcon = svg(<circle cx="12" cy="12" r="6" />);
export const timelineIcon = svg(
  <path d="M3 6h18v2H3zm0 5h12v2H3zm0 5h16v2H3z" />,
);
const playIcon = svg(<path d="M7 4l13 8-13 8z" />);
const pauseIcon = svg(<path d="M6 4h4v16H6zm8 0h4v16h-4z" />);
const restartIcon = svg(<path d="M5 4h2v16H5zm3 8l11-8v16z" />);
const upIcon = svg(<path d="M12 7l7 8H5z" />);
const downIcon = svg(<path d="M12 17l7-8H5z" />);

const fmt = (ms: number) => `${(ms / 1000).toFixed(2)}s`;

/** pointer-drag along an element, mapping the x position to a time */
const scrubHandlers = (
  app: ReturnType<typeof useApp>,
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

const Controls = () => {
  const app = useApp();
  const s = useAnimator();
  return (
    <>
      <button title="Play from beginning" onClick={() => play(app, true)}>
        {restartIcon}
      </button>
      <button
        title={s.playing ? "Pause" : "Play"}
        onClick={() => (s.playing ? pause() : play(app))}
      >
        {s.playing ? pauseIcon : playIcon}
      </button>
    </>
  );
};

const Timeline = () => {
  const app = useApp();
  const s = useAnimator();
  const total = totalDuration(s.clips);
  const view = Math.max(total * 1.25, 3000);
  const pct = (ms: number) => `${(ms / view) * 100}%`;

  const dragClip = (e: React.PointerEvent, id: string, start: number) => {
    e.stopPropagation();
    const lane = (e.currentTarget as HTMLElement).parentElement!;
    const width = lane.getBoundingClientRect().width;
    const x0 = e.clientX;
    const move = (ev: PointerEvent) =>
      moveClip(app, id, start + ((ev.clientX - x0) / width) * view);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const ticks = [];
  const step = view > 20000 ? 5000 : view > 8000 ? 2000 : 1000;
  for (let t = 0; t <= view; t += step) {
    ticks.push(
      <span key={t} className="anim-tick" style={{ left: pct(t) }}>
        {t / 1000}s
      </span>,
    );
  }

  return (
    <div className="anim-timeline" {...scrubHandlers(app, view)}>
      <div className="anim-ruler">{ticks}</div>
      {s.clips.map((c) => (
        <div key={c.id} className="anim-lane">
          <div
            className="anim-bar"
            style={{ left: pct(c.start), width: pct(c.duration) }}
            onPointerDown={(e) => dragClip(e, c.id, c.start)}
            title="Drag to move"
          >
            {c.name}
          </div>
        </div>
      ))}
      <div className="anim-playhead" style={{ left: pct(s.time) }} />
    </div>
  );
};

const Drawer = () => {
  const s = useAnimator();
  return (
    <div className="anim-drawer">
      <div className="anim-drawer__header">
        <Controls />
        <span className="anim-time">
          {fmt(s.time)} / {fmt(totalDuration(s.clips))}
        </span>
        <span style={{ flex: 1 }} />
        <button title="Close timeline" onClick={() => setDrawerOpen(false)}>
          {downIcon}
        </button>
      </div>
      <div className="anim-drawer__body">
        <div className="anim-list">
          <div className="anim-list__spacer" />
          {!s.clips.length && (
            <div className="anim-empty">
              Select something, press G, move it, press G again.
            </div>
          )}
          {s.clips.map((c) => (
            <div key={c.id} className="anim-list__item">
              <input
                value={c.name}
                onChange={(e) => renameClip(c.id, e.target.value)}
              />
              <button title="Delete" onClick={() => deleteClip(c.id)}>
                ×
              </button>
            </div>
          ))}
        </div>
        <Timeline />
      </div>
    </div>
  );
};

export const AnimationPlayer = () => {
  const app = useApp();
  const s = useAnimator();
  const ref = useRef<HTMLDivElement>(null);
  const preview = isPreviewing(s);
  const total = totalDuration(s.clips);

  // preview mode: hide the editor UI and lock editing
  useLayoutEffect(() => {
    if (!preview) {
      return;
    }
    // on <body>: React owns (and rewrites) the container's className
    const container = app.ownerDocument.body;
    const prevViewMode = app.state.viewModeEnabled;
    container.classList.add("anim-preview");
    app.setState({
      viewModeEnabled: true,
      selectedElementIds: {},
      selectedGroupIds: {},
    });
    return () => {
      container.classList.remove("anim-preview");
      app.setState({ viewModeEnabled: prevViewMode });
    };
  }, [preview, app]);

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
    <div className="anim-root" ref={ref}>
      {s.drawerOpen ? (
        <Drawer />
      ) : (
        <div className={clsx("anim-bar-mini", { recording: s.recording })}>
          {s.recording ? (
            <span className="anim-rec">● REC — press G to stop</span>
          ) : (
            <>
              <Controls />
              <div className="anim-scrub" {...scrubHandlers(app, total)}>
                <div
                  className="anim-scrub__fill"
                  style={{ width: `${(s.time / total) * 100}%` }}
                />
              </div>
              <button title="Open timeline" onClick={() => setDrawerOpen(true)}>
                {upIcon}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
};
