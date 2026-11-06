import React, { useRef } from "react";

export type TimeRangeValue = { start: number; end: number };

export const moveTimeRange = (
  range: TimeRangeValue,
  delta: number,
  mode: "move" | "start" | "end",
  duration: number,
): TimeRangeValue => {
  const minimum = Math.min(50, duration);
  if (mode === "start") {
    return {
      ...range,
      start: Math.max(0, Math.min(range.end - minimum, range.start + delta)),
    };
  }
  if (mode === "end") {
    return {
      ...range,
      end: Math.min(
        duration,
        Math.max(range.start + minimum, range.end + delta),
      ),
    };
  }
  const shift = Math.max(-range.start, Math.min(duration - range.end, delta));
  return { start: range.start + shift, end: range.end + shift };
};

/** A draggable time window with independently adjustable, keyboard-accessible ends. */
export const TimeRange = ({
  duration,
  value,
  time,
  disabled,
  onChange,
}: {
  duration: number;
  value: TimeRangeValue;
  time: number;
  disabled: boolean;
  onChange: (value: TimeRangeValue) => void;
}) => {
  const track = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    x: number;
    width: number;
    range: TimeRangeValue;
    mode: "move" | "start" | "end";
  } | null>(null);
  const handlers = (
    mode: "move" | "start" | "end",
  ): React.HTMLAttributes<HTMLDivElement> => ({
    onPointerDown: (event) => {
      if (disabled || event.button !== 0 || !track.current) {
        return;
      }
      event.stopPropagation();
      event.preventDefault();
      event.currentTarget.focus();
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = {
        x: event.clientX,
        width: track.current.getBoundingClientRect().width,
        range: value,
        mode,
      };
    },
    onPointerMove: (event) => {
      if (
        !drag.current ||
        !event.currentTarget.hasPointerCapture(event.pointerId)
      ) {
        return;
      }
      const { x, width, range, mode: dragMode } = drag.current;
      if (width > 0) {
        onChange(
          moveTimeRange(
            range,
            Math.round(((event.clientX - x) / width) * duration),
            dragMode,
            duration,
          ),
        );
      }
    },
    onPointerUp: (event) => {
      drag.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    },
    onPointerCancel: () => {
      drag.current = null;
    },
    onLostPointerCapture: () => {
      drag.current = null;
    },
    onKeyDown: (event) => {
      if (
        disabled ||
        !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const step = event.shiftKey ? 1000 : 100;
      const delta =
        event.key === "Home"
          ? -duration
          : event.key === "End"
          ? duration
          : event.key === "ArrowLeft"
          ? -step
          : step;
      onChange(moveTimeRange(value, delta, mode, duration));
    },
  });

  return (
    <div className="AnimationExportDialog__trim" ref={track}>
      <div
        className="AnimationExportDialog__trim__window"
        style={{
          left: `${(value.start / duration) * 100}%`,
          width: `${((value.end - value.start) / duration) * 100}%`,
        }}
      >
        <div
          className="AnimationExportDialog__trim__handle"
          role="slider"
          tabIndex={disabled ? -1 : 0}
          aria-disabled={disabled}
          aria-label="Trim start"
          aria-valuemin={0}
          aria-valuemax={(value.end - 50) / 1000}
          aria-valuenow={value.start / 1000}
          aria-valuetext={`${(value.start / 1000).toFixed(2)} seconds`}
          {...handlers("start")}
        />
        <div
          className="AnimationExportDialog__trim__move"
          role="slider"
          tabIndex={disabled ? -1 : 0}
          aria-disabled={disabled}
          aria-label="Move trim range"
          aria-valuemin={0}
          aria-valuemax={(duration - (value.end - value.start)) / 1000}
          aria-valuenow={value.start / 1000}
          aria-valuetext={`${(value.start / 1000).toFixed(2)} to ${(
            value.end / 1000
          ).toFixed(2)} seconds`}
          {...handlers("move")}
        />
        <div
          className="AnimationExportDialog__trim__handle"
          role="slider"
          tabIndex={disabled ? -1 : 0}
          aria-disabled={disabled}
          aria-label="Trim end"
          aria-valuemin={(value.start + 50) / 1000}
          aria-valuemax={duration / 1000}
          aria-valuenow={value.end / 1000}
          aria-valuetext={`${(value.end / 1000).toFixed(2)} seconds`}
          {...handlers("end")}
        />
      </div>
      <div
        className="AnimationExportDialog__trim__playhead"
        style={{ left: `${(time / duration) * 100}%` }}
      />
    </div>
  );
};
