import React, { useEffect, useMemo, useRef, useState } from "react";

import { muteFSAbortError } from "@excalidraw/common";

import { fileSave } from "../data/filesystem";
import { Dialog } from "../components/Dialog";
import { FilledButton } from "../components/FilledButton";
import { RadioGroup } from "../components/RadioGroup";
import { Switch } from "../components/Switch";
import { downloadIcon } from "../components/icons";

import {
  createAnimationExportPlan,
  exportAnimation,
  isVideoFormatSupported,
} from "./exporter";

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
  const [scale, setScale] = useState<1 | 2 | 3>(() => {
    const initial = app.state.exportScale;
    return initial === 2 || initial === 3 ? initial : 1;
  });
  const [background, setBackground] = useState(app.state.exportBackground);
  const [darkMode, setDarkMode] = useState(app.state.exportWithDarkMode);
  const [loop, setLoop] = useState(true);

  const [previewError, setPreviewError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [previewNode, setPreviewNode] = useState<HTMLDivElement | null>(null);
  const previewRequest = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!previewNode || !plan) {
      return;
    }
    const requestId = ++previewRequest.current;
    const settings = { scale: 1, background, darkMode };
    plan
      .renderFrameAt(0, settings)
      .then((canvas) => {
        if (requestId !== previewRequest.current) {
          return;
        }
        previewNode.replaceChildren(canvas);
        setPreviewError(null);
      })
      .catch((error) => {
        if (requestId !== previewRequest.current) {
          return;
        }
        console.error(error);
        setPreviewError(error?.message || "Could not render a preview");
      });
  }, [previewNode, plan, background, darkMode]);

  const output = plan?.outputSize(scale);
  const settings: AnimationExportSettings = {
    format,
    fps,
    scale,
    background,
    darkMode,
    loop,
  };

  const close = () => {
    abortRef.current?.abort();
    onCloseRequest();
  };

  const onExport = async () => {
    if (!plan || exporting) {
      return;
    }
    const controller = new AbortController();
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
    <Dialog onCloseRequest={close} title="Export animation">
      <div className="AnimationExportDialog">
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

        <div className="AnimationExportDialog__side">
          <p className="AnimationExportDialog__hint">
            Crops to the content across the whole animation, so elements keep
            their padding wherever they move.
          </p>

          {plan && (
            <div className="AnimationExportDialog__meta">
              <span>{plan.clipCount} animation(s)</span>
              <span>{fmtTime(plan.duration)}</span>
              {output && (
                <span>
                  {output.width} × {output.height} px
                </span>
              )}
            </div>
          )}

          <div className="AnimationExportDialog__settings">
            <Setting label="Format">
              <RadioGroup
                name="animationFormat"
                value={format}
                onChange={setFormat}
                choices={formats}
              />
            </Setting>
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
            <Setting label="Scale">
              <RadioGroup
                name="animationScale"
                value={scale}
                onChange={setScale}
                choices={[
                  { value: 1, label: "1×" },
                  { value: 2, label: "2×" },
                  { value: 3, label: "3×" },
                ]}
              />
            </Setting>
            <Setting label="Background">
              <Switch
                name="animationBackground"
                checked={background}
                onChange={setBackground}
              />
            </Setting>
            <Setting label="Dark mode">
              <Switch
                name="animationDarkMode"
                checked={darkMode}
                onChange={setDarkMode}
              />
            </Setting>
            {format === "gif" && (
              <Setting label="Loop forever">
                <Switch
                  name="animationLoop"
                  checked={loop}
                  onChange={setLoop}
                />
              </Setting>
            )}
          </div>

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
              disabled={!plan || exporting}
            >
              Export {format.toUpperCase()}
            </FilledButton>
          </div>
        </div>
      </div>
    </Dialog>
  );
};
