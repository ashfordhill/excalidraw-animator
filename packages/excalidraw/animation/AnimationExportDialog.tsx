import React, {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { muteFSAbortError } from "@excalidraw/common";

import { fileSave } from "../data/filesystem";
import { Dialog } from "../components/Dialog";
import { FilledButton } from "../components/FilledButton";
import { RadioGroup } from "../components/RadioGroup";
import { Switch } from "../components/Switch";
import { downloadIcon } from "../components/icons";

import {
  ANIMATION_SIZE_PRESETS,
  createAnimationExportPlan,
  exportAnimation,
  getAnimationSizeError,
  isVideoFormatSupported,
} from "./exporter";

import { pause } from "./animator";
import { TimeRange } from "./TimeRange";

import "./AnimationExportDialog.scss";

import type { AppClassProperties } from "../types";

import type { AnimationExportSettings, AnimationFormat } from "./exporter";

const fmtTime = (ms: number) => `${(ms / 1000).toFixed(2)}s`;

const Setting = ({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) => (
  <div className="AnimationExportDialog__setting">
    <div className="AnimationExportDialog__setting__label">{label}</div>
    <div className="AnimationExportDialog__setting__content">{children}</div>
  </div>
);

export const AnimationExportDialog = ({
  app,
  onCloseRequest,
}: {
  app: AppClassProperties;
  onCloseRequest: () => void;
}) => {
  const { plan, planError } = useMemo(() => {
    try {
      return { plan: createAnimationExportPlan(app), planError: null };
    } catch (error: any) {
      return {
        plan: null,
        planError: error?.message || "Could not read the animations",
      };
    }
  }, [app]);

  const formats = useMemo(() => {
    const choices: { value: AnimationFormat; label: string }[] = [
      { value: "gif", label: "GIF" },
    ];
    if (isVideoFormatSupported(app.ownerWindow, "webm")) {
      choices.push({ value: "webm", label: "WebM" });
    }
    if (isVideoFormatSupported(app.ownerWindow, "mp4")) {
      choices.push({ value: "mp4", label: "MP4" });
    }
    return choices;
  }, [app]);

  const [format, setFormat] = useState<AnimationFormat>("gif");
  const [fps, setFps] = useState(20);
  const [size, setSize] = useState(() => {
    const original = plan?.outputSize(1) ?? { width: 1280, height: 720 };
    return {
      preset: "original",
      width: String(original.width),
      height: String(original.height),
    };
  });
  const output = useMemo(
    () => ({ width: Number(size.width), height: Number(size.height) }),
    [size.width, size.height],
  );
  const sizeError = getAnimationSizeError(output, format);
  const [background, setBackground] = useState(app.state.exportBackground);
  const [darkMode, setDarkMode] = useState(app.state.exportWithDarkMode);
  const [range, setRange] = useState({ start: 0, end: plan?.duration ?? 1000 });
  const [previewPlaying, setPreviewPlaying] = useState(true);
  const [previewTime, setPreviewTime] = useState(0);
  const previewPosition = useRef(0);
  useLayoutEffect(() => pause(), []);

  const [previewError, setPreviewError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [previewNode, setPreviewNode] = useState<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!previewNode || !plan || sizeError) {
      return;
    }
    let cancelled = false;
    let timer = 0;
    let previous = app.ownerWindow.performance.now();
    const render = async () => {
      const now = app.ownerWindow.performance.now();
      if (previewPlaying && !exporting) {
        previewPosition.current =
          range.start +
          ((Math.max(0, previewPosition.current - range.start) +
            now -
            previous) %
            (range.end - range.start));
      }
      previous = now;
      const time = Math.max(
        range.start,
        Math.min(range.end, previewPosition.current),
      );
      try {
        const canvas = await plan.renderFrameAt(time, {
          scale: Math.min(1, 600 / output.width, 320 / output.height),
          size: output,
          background,
          darkMode,
        });
        if (cancelled) {
          return;
        }
        previewNode.replaceChildren(canvas);
        setPreviewTime(time);
        setPreviewError(null);
        if (previewPlaying && !exporting) {
          timer = app.ownerWindow.setTimeout(
            render,
            Math.max(0, 50 - (app.ownerWindow.performance.now() - now)),
          );
        }
      } catch (error: any) {
        if (!cancelled) {
          setPreviewError(error?.message || "Could not render a preview");
        }
      }
    };
    void render();
    return () => {
      cancelled = true;
      app.ownerWindow.clearTimeout(timer);
    };
  }, [
    app,
    previewNode,
    plan,
    background,
    darkMode,
    previewPlaying,
    range,
    exporting,
    output,
    sizeError,
  ]);

  const settings: AnimationExportSettings = {
    format,
    fps,
    scale: 1,
    size: output,
    background,
    darkMode,
    loop: true,
    startTime: range.start,
    endTime: range.end,
  };

  const close = () => {
    abortRef.current?.abort();
    onCloseRequest();
  };

  const onExport = async () => {
    if (!plan || exporting || sizeError) {
      return;
    }
    const controller = new app.ownerWindow.AbortController();
    abortRef.current = controller;
    setExporting(true);
    setExportError(null);
    setStatus("Preparing…");
    setProgress(0);

    try {
      const result = await exportAnimation({
        app,
        plan,
        settings,
        signal: controller.signal,
        onProgress: (value, label) => {
          setProgress(value);
          setStatus(label);
        },
      });

      setStatus("Saving…");
      try {
        await fileSave(result.blob, {
          name: `${app.getName()}-animation`,
          extension: result.extension,
          description: "Animation",
          mimeTypes: [result.mimeType],
        });
      } catch (error: any) {
        if (error?.name === "AbortError") {
          muteFSAbortError(error);
          return;
        }
        throw error;
      }
      setStatus("Saved");
      setProgress(1);
    } catch (error: any) {
      if (error?.name !== "AbortError") {
        console.error(error);
        setExportError(error?.message || "Could not export the animation");
      }
    } finally {
      abortRef.current = null;
      setExporting(false);
      setProgress(null);
    }
  };

  return (
    <Dialog onCloseRequest={close} title="Export animation" size="wide">
      <div className="AnimationExportDialog">
        <div className="AnimationExportDialog__main">
          <div className="AnimationExportDialog__preview">
            {planError && (
              <div className="AnimationExportDialog__preview__message">
                {planError}
              </div>
            )}
            {!planError && previewError && (
              <div className="AnimationExportDialog__preview__message">
                {previewError}
              </div>
            )}
            {!planError && !previewError && !plan && (
              <div className="AnimationExportDialog__preview__message">
                Preparing preview…
              </div>
            )}
            <div
              className="AnimationExportDialog__preview__canvas"
              ref={setPreviewNode}
            />
          </div>

          {plan && (
            <>
              <div className="AnimationExportDialog__transport">
                <button
                  type="button"
                  disabled={exporting}
                  onClick={() => setPreviewPlaying((playing) => !playing)}
                  aria-label={previewPlaying ? "Pause preview" : "Play preview"}
                >
                  {previewPlaying ? "Pause" : "Play"}
                </button>
                <span>
                  {fmtTime(previewTime)} / {fmtTime(plan.duration)}
                </span>
                <span className="AnimationExportDialog__loop-hint">
                  Looping preview
                </span>
              </div>
              <input
                className="AnimationExportDialog__seek"
                type="range"
                aria-label="Preview time"
                min={range.start}
                max={range.end}
                step={10}
                value={previewTime}
                disabled={exporting}
                onChange={(event) => {
                  const time = Number(event.target.value);
                  previewPosition.current = time;
                  setPreviewTime(time);
                  setPreviewPlaying(false);
                  // A new range object refreshes the paused preview at the requested time.
                  setRange((current) => ({ ...current }));
                }}
              />
              <div className="AnimationExportDialog__trim-label">
                <strong>Trim animation</strong>
                <button
                  type="button"
                  disabled={
                    exporting ||
                    (range.start === 0 && range.end === plan.duration)
                  }
                  onClick={() => {
                    previewPosition.current = 0;
                    setRange({ start: 0, end: plan.duration });
                  }}
                >
                  Reset
                </button>
              </div>
              <TimeRange
                duration={plan.duration}
                value={range}
                time={previewTime}
                disabled={exporting}
                onChange={(next) => {
                  previewPosition.current = next.start;
                  setPreviewTime(next.start);
                  setRange(next);
                }}
              />
              <div className="AnimationExportDialog__range-labels">
                <span>{fmtTime(range.start)}</span>
                <strong>{fmtTime(range.end - range.start)} selected</strong>
                <span>{fmtTime(range.end)}</span>
              </div>
              <p className="AnimationExportDialog__hint">
                Drag either end to trim. Drag the middle to move the range.
              </p>
            </>
          )}
        </div>

        <div className="AnimationExportDialog__side">
          <p className="AnimationExportDialog__hint">
            Exports your whole scene, including objects that don’t move.
            Trimming only changes which part of the animation is saved.
          </p>

          {plan && (
            <div className="AnimationExportDialog__meta">
              <span>{plan.clipCount} animation(s)</span>
              <span>{fmtTime(range.end - range.start)}</span>
              {!sizeError && (
                <span>
                  {output.width} × {output.height} px
                </span>
              )}
            </div>
          )}

          <fieldset
            className="AnimationExportDialog__settings"
            disabled={exporting}
          >
            <Setting label="Format">
              <RadioGroup
                name="animationFormat"
                value={format}
                onChange={setFormat}
                choices={formats}
              />
            </Setting>
            <div className="AnimationExportDialog__size">
              <label htmlFor="animation-size-preset">Size</label>
              <select
                id="animation-size-preset"
                value={size.preset}
                onChange={(event) => {
                  const preset = event.target.value;
                  const dimensions =
                    preset === "original"
                      ? plan?.outputSize(1)
                      : ANIMATION_SIZE_PRESETS.find(
                          (entry) => entry.id === preset,
                        );
                  setSize((current) =>
                    dimensions
                      ? {
                          preset,
                          width: String(dimensions.width),
                          height: String(dimensions.height),
                        }
                      : { ...current, preset },
                  );
                }}
              >
                <option value="original">Original scene size</option>
                {ANIMATION_SIZE_PRESETS.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.label}
                  </option>
                ))}
                <option value="custom">Custom size</option>
              </select>
              <div className="AnimationExportDialog__dimensions">
                <label>
                  Width <span>px</span>
                  <input
                    type="number"
                    min={16}
                    max={4096}
                    step={1}
                    value={size.width}
                    aria-invalid={!!sizeError}
                    aria-describedby={
                      sizeError ? "animation-size-error" : undefined
                    }
                    onChange={(event) =>
                      setSize((current) => ({
                        ...current,
                        preset: "custom",
                        width: event.target.value,
                      }))
                    }
                  />
                </label>
                <span aria-hidden="true">×</span>
                <label>
                  Height <span>px</span>
                  <input
                    type="number"
                    min={16}
                    max={4096}
                    step={1}
                    value={size.height}
                    aria-invalid={!!sizeError}
                    aria-describedby={
                      sizeError ? "animation-size-error" : undefined
                    }
                    onChange={(event) =>
                      setSize((current) => ({
                        ...current,
                        preset: "custom",
                        height: event.target.value,
                      }))
                    }
                  />
                </label>
              </div>
              {sizeError && (
                <div
                  id="animation-size-error"
                  role="alert"
                  className="AnimationExportDialog__error"
                >
                  {sizeError}
                </div>
              )}
              <p className="AnimationExportDialog__hint">
                Fits the whole scene without stretching. Extra space is added
                when the shape of the output differs.
              </p>
            </div>
            <Setting label="Background">
              <Switch
                name="animationBackground"
                checked={background}
                onChange={setBackground}
              />
            </Setting>
            <details className="AnimationExportDialog__advanced">
              <summary>More options</summary>
              <Setting label="Frame rate">
                <RadioGroup
                  name="animationFps"
                  value={fps}
                  onChange={setFps}
                  choices={[
                    { value: 12, label: "12 fps" },
                    { value: 20, label: "20 fps" },
                    { value: 30, label: "30 fps" },
                  ]}
                />
              </Setting>
              <Setting label="Dark mode">
                <Switch
                  name="animationDarkMode"
                  checked={darkMode}
                  onChange={setDarkMode}
                />
              </Setting>
            </details>
          </fieldset>

          {exportError && (
            <div className="AnimationExportDialog__error">{exportError}</div>
          )}

          {exporting && (
            <div className="AnimationExportDialog__progress">
              <div className="AnimationExportDialog__progress__bar">
                <div
                  style={{ width: `${Math.round((progress ?? 0) * 100)}%` }}
                />
              </div>
              <span>{status}</span>
            </div>
          )}

          <div className="AnimationExportDialog__footer">
            <FilledButton
              label={`Export ${format.toUpperCase()}`}
              icon={downloadIcon}
              onClick={onExport}
              disabled={!plan || exporting || !!sizeError}
            >
              Export {format.toUpperCase()}
            </FilledButton>
          </div>
        </div>
      </div>
    </Dialog>
  );
};
