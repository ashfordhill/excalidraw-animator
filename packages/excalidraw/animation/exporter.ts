import { DEFAULT_EXPORT_PADDING, THEME } from "@excalidraw/common";
import { getCommonBounds, isAnimPath } from "@excalidraw/element";

import type { Bounds } from "@excalidraw/common";

import type { ExcalidrawElement } from "@excalidraw/element/types";

import { cleanAppStateForExport } from "../appState";
import { AbortError } from "../errors";
import { exportScene } from "../scene/export";

import { getClips, getFrameElements, totalDuration } from "./animator";
import { createGifWriter } from "./gif";

import type { AppClassProperties } from "../types";
import type { ClipElement } from "./animator";

export type AnimationFormat = "gif" | "webm" | "mp4";

export type AnimationRenderSettings = {
  scale: number;
  background: boolean;
  darkMode: boolean;
};

export type AnimationExportSettings = AnimationRenderSettings & {
  format: AnimationFormat;
  fps: number;
  loop: boolean;
};

export type AnimationExportProgress = (progress: number, label: string) => void;

export type AnimationExportPlan = {
  duration: number;
  clipCount: number;
  contentWidth: number;
  contentHeight: number;
  outputSize: (scale: number) => { width: number; height: number };
  renderFrameAt: (
    time: number,
    settings: AnimationRenderSettings,
  ) => Promise<HTMLCanvasElement>;
};

const padding = DEFAULT_EXPORT_PADDING;

const unionBounds = (current: Bounds | null, next: Bounds): Bounds => {
  if (!current) {
    return next;
  }
  return [
    Math.min(current[0], next[0]),
    Math.min(current[1], next[1]),
    Math.max(current[2], next[2]),
    Math.max(current[3], next[3]),
  ] as const;
};

/**
 * Bounds of everything that is visible during the animation, including where
 * animated elements travel. This is the animation equivalent of the image
 * export's "crop to content".
 */
const getAnimationBounds = (
  elements: readonly ExcalidrawElement[],
  clips: readonly ClipElement[],
  duration: number,
) => {
  const animatedIds = new Set(
    clips.flatMap((clip) =>
      clip.customData.anim.targets.filter(
        (id) => clip.customData.anim.home[id],
      ),
    ),
  );
  const staticElements = elements.filter(
    (el) => !el.isDeleted && !isAnimPath(el) && !animatedIds.has(el.id),
  );

  let bounds: Bounds | null = staticElements.length
    ? getCommonBounds(staticElements)
    : null;

  // sample the same rate as the default preview; this only needs to be
  // accurate enough to include the extremes, not to render
  const samples = Math.max(2, Math.min(600, Math.ceil((duration / 1000) * 24)));
  for (let i = 0; i < samples; i++) {
    const time = samples === 1 ? 0 : (i / (samples - 1)) * duration;
    const frame = getFrameElements(elements, clips, time).filter(
      (el) => !el.isDeleted && !isAnimPath(el) && animatedIds.has(el.id),
    );
    if (frame.length) {
      bounds = unionBounds(bounds, getCommonBounds(frame));
    }
  }

  if (!bounds) {
    return [0, 0, 1, 1] as const;
  }
  return bounds;
};

export const createAnimationExportPlan = (
  app: AppClassProperties,
): AnimationExportPlan => {
  const clips = getClips(app);
  if (!clips.length) {
    throw new Error("There are no animations to export");
  }

  const elements = app.scene.getNonDeletedElements();
  const duration = totalDuration(clips);
  const [minX, minY, maxX, maxY] = getAnimationBounds(
    elements,
    clips,
    duration,
  );
  const contentWidth = Math.max(1, maxX - minX);
  const contentHeight = Math.max(1, maxY - minY);
  const appState = cleanAppStateForExport(app.state);
  const files = app.files;
  const environment = app.renderEnvironment;

  const outputSize = (scale: number) => ({
    width: Math.max(1, Math.round((contentWidth + padding * 2) * scale)),
    height: Math.max(1, Math.round((contentHeight + padding * 2) * scale)),
  });

  const renderFrameAt = async (
    time: number,
    settings: AnimationRenderSettings,
  ) => {
    const frameElements = getFrameElements(elements, clips, time);
    return exportScene({
      type: "canvas",
      data: {
        elements: frameElements as any,
        appState,
        files,
      },
      config: {
        theme: settings.darkMode ? THEME.DARK : THEME.LIGHT,
        canvasBackgroundColor: settings.background
          ? app.state.viewBackgroundColor
          : false,
        scale: settings.scale,
        padding,
        // pin the crop to the union bounds across the whole animation
        x: minX,
        y: minY,
        width: contentWidth,
        height: contentHeight,
        fit: "none",
        position: "topLeft",
        origin: "canvas",
        frames: { name: false, outline: false, clip: true },
        environment,
      },
    });
  };

  return {
    duration,
    clipCount: clips.length,
    contentWidth,
    contentHeight,
    outputSize,
    renderFrameAt,
  };
};

export const getAnimationFrameCount = (duration: number, fps: number) =>
  Math.max(1, Math.round((duration / 1000) * fps));

export const getFrameTime = (duration: number, fps: number, index: number) => {
  const count = getAnimationFrameCount(duration, fps);
  return (index / count) * duration;
};

const videoTypes: Record<Exclude<AnimationFormat, "gif">, readonly string[]> = {
  webm: ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"],
  mp4: ["video/mp4;codecs=avc1.42E01E", "video/mp4;codecs=avc1", "video/mp4"],
};

export const isVideoFormatSupported = (
  ownerWindow: Window & typeof globalThis,
  format: Exclude<AnimationFormat, "gif">,
) => {
  const MediaRecorderCtor = ownerWindow.MediaRecorder;
  if (
    !MediaRecorderCtor ||
    typeof MediaRecorderCtor.isTypeSupported !== "function"
  ) {
    return false;
  }
  return videoTypes[format].some((type) =>
    MediaRecorderCtor.isTypeSupported(type),
  );
};

const getVideoMimeType = (
  ownerWindow: Window & typeof globalThis,
  format: Exclude<AnimationFormat, "gif">,
) => {
  const MediaRecorderCtor = ownerWindow.MediaRecorder;
  if (
    !MediaRecorderCtor ||
    typeof MediaRecorderCtor.isTypeSupported !== "function"
  ) {
    return null;
  }
  return (
    videoTypes[format].find((type) =>
      MediaRecorderCtor.isTypeSupported(type),
    ) ?? null
  );
};

const sleep = (ownerWindow: Window & typeof globalThis, ms: number) =>
  new Promise<void>((resolve) => ownerWindow.setTimeout(resolve, ms));

const assertNotAborted = (signal: AbortSignal | undefined) => {
  if (signal?.aborted) {
    throw new AbortError();
  }
};

const renderGif = async ({
  app,
  plan,
  settings,
  onProgress,
  signal,
}: {
  app: AppClassProperties;
  plan: AnimationExportPlan;
  settings: AnimationExportSettings;
  onProgress?: AnimationExportProgress;
  signal?: AbortSignal;
}) => {
  const ownerWindow = app.ownerWindow;
  const frameCount = getAnimationFrameCount(plan.duration, settings.fps);
  let width = 0;
  let height = 0;

  const readFrame = async (index: number) => {
    const canvas = await plan.renderFrameAt(
      getFrameTime(plan.duration, settings.fps, index),
      settings,
    );
    width = canvas.width;
    height = canvas.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) {
      throw new Error("Could not read the animation frame");
    }
    return context.getImageData(0, 0, canvas.width, canvas.height).data;
  };

  // Sample a handful of frames for the global palette, then encode frames as
  // they're rendered. Holding every RGBA frame would be prohibitively large
  // for long or high-resolution exports.
  const sampleCount = Math.min(12, frameCount);
  const sampleIndexes = new Set<number>();
  for (let i = 0; i < sampleCount; i++) {
    sampleIndexes.add(
      sampleCount === 1
        ? 0
        : Math.round((i / (sampleCount - 1)) * (frameCount - 1)),
    );
  }
  const sampledFrames = new Map<number, Uint8ClampedArray>();
  let sampled = 0;
  for (const index of sampleIndexes) {
    assertNotAborted(signal);
    sampledFrames.set(index, await readFrame(index));
    sampled++;
    onProgress?.(
      (sampled / (sampleCount + frameCount)) * 0.99,
      "Preparing colors…",
    );
  }

  const writer = createGifWriter({
    width,
    height,
    delay: 100 / settings.fps,
    loop: settings.loop,
    transparent: !settings.background,
    paletteFrames: [...sampledFrames.values()],
  });

  for (let i = 0; i < frameCount; i++) {
    assertNotAborted(signal);
    let frame = sampledFrames.get(i);
    if (!frame) {
      frame = await readFrame(i);
    }
    sampledFrames.delete(i);
    writer.addFrame(frame);
    onProgress?.(
      (sampleCount + i + 1) / (sampleCount + frameCount),
      `Rendering frame ${i + 1} of ${frameCount}…`,
    );
    // let the progress UI paint between frames
    if (i % 2 === 1) {
      await sleep(ownerWindow, 0);
    }
  }

  assertNotAborted(signal);
  onProgress?.(1, "Encoding GIF…");
  await sleep(ownerWindow, 0);

  return writer.finish();
};

const renderVideo = async ({
  app,
  plan,
  settings,
  format,
  onProgress,
  signal,
}: {
  app: AppClassProperties;
  plan: AnimationExportPlan;
  settings: AnimationExportSettings;
  format: Exclude<AnimationFormat, "gif">;
  onProgress?: AnimationExportProgress;
  signal?: AbortSignal;
}) => {
  const ownerWindow = app.ownerWindow;
  const MediaRecorderCtor = ownerWindow.MediaRecorder;
  const mimeType = getVideoMimeType(ownerWindow, format);

  if (!MediaRecorderCtor || !mimeType) {
    throw new Error(`${format.toUpperCase()} recording isn't supported`);
  }

  const frameCount = getAnimationFrameCount(plan.duration, settings.fps);
  const firstFrame = await plan.renderFrameAt(0, settings);
  const canvas = app.ownerDocument.createElement("canvas");
  canvas.width = firstFrame.width;
  canvas.height = firstFrame.height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Could not create the animation canvas");
  }
  context.drawImage(firstFrame, 0, 0);

  const stream = canvas.captureStream(settings.fps);
  const recorder = new MediaRecorderCtor(stream, {
    mimeType,
    videoBitsPerSecond: Math.min(
      20_000_000,
      Math.max(2_000_000, canvas.width * canvas.height * settings.fps * 0.12),
    ),
  });
  const chunks: Blob[] = [];
  let recorderError: unknown = null;
  const stopped = new Promise<void>((resolve) => {
    recorder.addEventListener("stop", () => resolve(), { once: true });
    recorder.addEventListener(
      "error",
      (event) => {
        recorderError = (event as ErrorEvent).error;
        resolve();
      },
      { once: true },
    );
  });
  recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size) {
      chunks.push(event.data);
    }
  });

  const interval = 1000 / settings.fps;
  const started = new Promise<void>((resolve, reject) => {
    recorder.addEventListener("start", () => resolve(), { once: true });
    recorder.addEventListener(
      "error",
      (event) => reject((event as ErrorEvent).error),
      { once: true },
    );
  });

  let recording = false;
  try {
    recorder.start();
    await started;
    recording = true;
    const start = ownerWindow.performance.now();

    for (let i = 1; i < frameCount; i++) {
      assertNotAborted(signal);
      const frame = await plan.renderFrameAt(
        getFrameTime(plan.duration, settings.fps, i),
        settings,
      );
      const wait = start + i * interval - ownerWindow.performance.now();
      if (wait > 0) {
        await sleep(ownerWindow, wait);
      }
      context.drawImage(frame, 0, 0);
      onProgress?.(
        (i + 1) / frameCount,
        `Recording frame ${i + 1} of ${frameCount}…`,
      );
    }

    const wait = start + frameCount * interval - ownerWindow.performance.now();
    if (wait > 0) {
      await sleep(ownerWindow, wait);
    }
  } finally {
    if (recording && recorder.state !== "inactive") {
      recorder.stop();
      await stopped.catch(() => undefined);
    }
    stream.getTracks().forEach((track) => track.stop());
  }

  if (!recording) {
    throw new Error("Could not start recording");
  }
  if (recorderError) {
    throw recorderError;
  }

  return new Blob(chunks, { type: recorder.mimeType || mimeType });
};

export type AnimationExportResult = {
  blob: Blob;
  extension: "gif" | "webm" | "mp4";
  mimeType: string;
};

export const exportAnimation = async ({
  app,
  plan,
  settings,
  onProgress,
  signal,
}: {
  app: AppClassProperties;
  plan: AnimationExportPlan;
  settings: AnimationExportSettings;
  onProgress?: AnimationExportProgress;
  signal?: AbortSignal;
}): Promise<AnimationExportResult> => {
  if (settings.format === "gif") {
    const bytes = await renderGif({
      app,
      plan,
      settings,
      onProgress,
      signal,
    });
    return {
      blob: new Blob([bytes as BlobPart], { type: "image/gif" }),
      extension: "gif",
      mimeType: "image/gif",
    };
  }

  const blob = await renderVideo({
    app,
    plan,
    settings,
    format: settings.format,
    onProgress,
    signal,
  });
  return {
    blob,
    extension: settings.format,
    mimeType: blob.type.split(";")[0] || `video/${settings.format}`,
  };
};
