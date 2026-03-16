import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const DEFAULT_SCRIPT = `This is where your voiceover script goes.
Paste your full text here, upload audio, then preview/export.`;

const CANVAS_WIDTH = 1280;
const CANVAS_HEIGHT = 720;
const CANVAS_PADDING = 88;
const CANVAS_FONT_SIZE = 56;
const CANVAS_LINE_HEIGHT = 1.32;

const PREVIEW_STATE_LABELS = {
  idle: "Ready",
  loading: "Loading audio...",
  playing: "Playing preview",
  ended: "Preview finished",
  error: "Preview error",
};

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";

  const totalSeconds = Math.floor(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const remainderSeconds = totalSeconds % 60;
  return `${minutes}:${String(remainderSeconds).padStart(2, "0")}`;
}

function wrapTextToLines(ctx, text, maxWidth) {
  const lines = [];
  const paragraphs = text.replace(/\r\n/g, "\n").split("\n");

  for (const paragraph of paragraphs) {
    const trimmedParagraph = paragraph.trim();
    if (!trimmedParagraph) {
      lines.push("");
      continue;
    }

    const words = paragraph.split(/\s+/).filter(Boolean);
    if (!words.length) {
      lines.push("");
      continue;
    }

    let currentLine = words[0];

    for (let index = 1; index < words.length; index += 1) {
      const candidate = `${currentLine} ${words[index]}`;
      if (ctx.measureText(candidate).width <= maxWidth) {
        currentLine = candidate;
      } else {
        lines.push(currentLine);
        currentLine = words[index];
      }
    }

    lines.push(currentLine);
  }

  return lines;
}

function getVisibleCharacterCount(text, currentTime, duration) {
  if (!text) return 0;
  if (!Number.isFinite(duration) || duration <= 0) return text.length;

  const progress = Math.min(Math.max(currentTime / duration, 0), 1);
  return Math.floor(progress * text.length);
}

function App() {
  const [scriptText, setScriptText] = useState(DEFAULT_SCRIPT);
  const [audioFile, setAudioFile] = useState(null);
  const [previewState, setPreviewState] = useState("idle");
  const [previewError, setPreviewError] = useState("");
  const [playheadSeconds, setPlayheadSeconds] = useState(0);
  const [durationSeconds, setDurationSeconds] = useState(0);

  const canvasRef = useRef(null);
  const animationFrameRef = useRef(null);
  const audioElementRef = useRef(null);
  const audioObjectUrlRef = useRef(null);
  const fallbackStartTimeRef = useRef(0);
  const lastUiSyncRef = useRef(0);

  const audioFileLabel = useMemo(() => {
    if (!audioFile) return "No audio selected";
    const sizeInMb = (audioFile.size / (1024 * 1024)).toFixed(2);
    return `${audioFile.name} (${sizeInMb} MB)`;
  }, [audioFile]);

  const previewStateLabel = PREVIEW_STATE_LABELS[previewState] ?? "Unknown";
  const previewTimeLabel = `${formatTime(playheadSeconds)} / ${formatTime(
    durationSeconds
  )}`;

  const cancelRenderLoop = useCallback(() => {
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
  }, []);

  const releaseAudioResources = useCallback(() => {
    if (audioElementRef.current) {
      audioElementRef.current.pause();
      audioElementRef.current.src = "";
      audioElementRef.current = null;
    }

    if (audioObjectUrlRef.current) {
      URL.revokeObjectURL(audioObjectUrlRef.current);
      audioObjectUrlRef.current = null;
    }
  }, []);

  const stopPreview = useCallback(() => {
    cancelRenderLoop();
    releaseAudioResources();
  }, [cancelRenderLoop, releaseAudioResources]);

  const drawFrame = useCallback(
    (currentTime, duration, isPlaying) => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      if (canvas.width !== CANVAS_WIDTH || canvas.height !== CANVAS_HEIGHT) {
        canvas.width = CANVAS_WIDTH;
        canvas.height = CANVAS_HEIGHT;
      }

      const visibleCharacters = getVisibleCharacterCount(
        scriptText,
        currentTime,
        duration
      );
      const visibleText = scriptText.slice(0, visibleCharacters);

      const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
      gradient.addColorStop(0, "#020617");
      gradient.addColorStop(1, "#111827");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      const timelineBottomSpace = 62;
      const maxTextWidth = canvas.width - CANVAS_PADDING * 2;
      const lineHeightPx = CANVAS_FONT_SIZE * CANVAS_LINE_HEIGHT;
      const maxLines = Math.max(
        1,
        Math.floor(
          (canvas.height - CANVAS_PADDING * 2 - timelineBottomSpace) / lineHeightPx
        )
      );

      ctx.fillStyle = "#f8fafc";
      ctx.font = `700 ${CANVAS_FONT_SIZE}px "Segoe UI", "Inter", sans-serif`;
      ctx.textBaseline = "top";

      const wrappedLines = wrapTextToLines(ctx, visibleText, maxTextWidth);
      const drawableLines = wrappedLines.slice(0, maxLines);
      let yPosition = CANVAS_PADDING;

      for (const line of drawableLines) {
        ctx.fillText(line, CANVAS_PADDING, yPosition);
        yPosition += lineHeightPx;
      }

      if (isPlaying && visibleCharacters < scriptText.length) {
        const shouldBlink = Math.floor(currentTime * 2) % 2 === 0;
        if (shouldBlink) {
          const currentLine = drawableLines[drawableLines.length - 1] ?? "";
          const cursorX = CANVAS_PADDING + ctx.measureText(currentLine).width + 6;
          const cursorY =
            CANVAS_PADDING + Math.max(drawableLines.length - 1, 0) * lineHeightPx;

          ctx.fillStyle = "#22d3ee";
          ctx.fillRect(cursorX, cursorY + 8, 6, CANVAS_FONT_SIZE - 12);
        }
      }

      const progress = duration > 0 ? Math.min(currentTime / duration, 1) : 0;
      const timelineY = canvas.height - 34;
      const timelineWidth = canvas.width - CANVAS_PADDING * 2;

      ctx.fillStyle = "rgba(148, 163, 184, 0.35)";
      ctx.fillRect(CANVAS_PADDING, timelineY, timelineWidth, 6);

      ctx.fillStyle = "#06b6d4";
      ctx.fillRect(CANVAS_PADDING, timelineY, timelineWidth * progress, 6);

      ctx.font = '500 20px "Segoe UI", "Inter", sans-serif';
      ctx.fillStyle = "rgba(226, 232, 240, 0.9)";
      ctx.fillText(
        `${formatTime(currentTime)} / ${formatTime(duration)}`,
        CANVAS_PADDING,
        timelineY - 28
      );
    },
    [scriptText]
  );

  const handlePreview = useCallback(async () => {
    setPreviewError("");

    if (!scriptText.trim()) {
      setPreviewState("error");
      setPreviewError("Please enter text before starting preview.");
      return;
    }

    stopPreview();
    lastUiSyncRef.current = 0;
    setPlayheadSeconds(0);

    if (!audioFile) {
      const fallbackDuration = Math.min(Math.max(scriptText.length / 14, 3), 24);
      setDurationSeconds(fallbackDuration);
      setPreviewState("playing");
      drawFrame(0, fallbackDuration, true);
      fallbackStartTimeRef.current = performance.now();

      const stepWithoutAudio = (now) => {
        const elapsedSeconds = (now - fallbackStartTimeRef.current) / 1000;
        const clampedTime = Math.min(elapsedSeconds, fallbackDuration);

        drawFrame(clampedTime, fallbackDuration, true);

        if (now - lastUiSyncRef.current >= 120 || clampedTime >= fallbackDuration) {
          setPlayheadSeconds(clampedTime);
          lastUiSyncRef.current = now;
        }

        if (clampedTime >= fallbackDuration) {
          setPreviewState("ended");
          drawFrame(fallbackDuration, fallbackDuration, false);
          animationFrameRef.current = null;
          return;
        }

        animationFrameRef.current = requestAnimationFrame(stepWithoutAudio);
      };

      animationFrameRef.current = requestAnimationFrame(stepWithoutAudio);
      return;
    }

    try {
      setPreviewState("loading");
      const objectUrl = URL.createObjectURL(audioFile);
      audioObjectUrlRef.current = objectUrl;

      const audio = new Audio(objectUrl);
      audio.preload = "auto";
      audioElementRef.current = audio;

      await new Promise((resolve, reject) => {
        const handleLoadedMetadata = () => {
          cleanup();
          resolve();
        };
        const handleAudioError = () => {
          cleanup();
          reject(new Error("Audio file could not be loaded."));
        };
        const cleanup = () => {
          audio.removeEventListener("loadedmetadata", handleLoadedMetadata);
          audio.removeEventListener("error", handleAudioError);
        };

        audio.addEventListener("loadedmetadata", handleLoadedMetadata);
        audio.addEventListener("error", handleAudioError);
        audio.load();
      });

      const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
      if (duration <= 0) {
        throw new Error("Audio duration could not be determined.");
      }

      setDurationSeconds(duration);
      drawFrame(0, duration, false);

      await audio.play();
      setPreviewState("playing");

      const stepWithAudio = (now) => {
        const activeAudio = audioElementRef.current;
        if (!activeAudio) {
          animationFrameRef.current = null;
          return;
        }

        const clampedTime = Math.min(activeAudio.currentTime, duration);
        drawFrame(clampedTime, duration, true);

        if (now - lastUiSyncRef.current >= 120 || activeAudio.ended) {
          setPlayheadSeconds(clampedTime);
          lastUiSyncRef.current = now;
        }

        if (activeAudio.ended || clampedTime >= duration) {
          setPlayheadSeconds(duration);
          setPreviewState("ended");
          drawFrame(duration, duration, false);
          stopPreview();
          return;
        }

        animationFrameRef.current = requestAnimationFrame(stepWithAudio);
      };

      animationFrameRef.current = requestAnimationFrame(stepWithAudio);
    } catch (error) {
      stopPreview();
      setPreviewState("error");
      setPreviewError(
        error instanceof Error ? error.message : "Preview could not be started."
      );
    }
  }, [audioFile, drawFrame, scriptText, stopPreview]);

  const handleExport = () => {
    setPreviewError("Export Video follows in Step 3 (MediaRecorder API).");
  };

  useEffect(() => {
    if (previewState === "playing" || previewState === "loading") return;

    const referenceDuration = durationSeconds > 0 ? durationSeconds : 5;
    const referenceTime = previewState === "ended" ? referenceDuration : 0;
    drawFrame(referenceTime, referenceDuration, false);
  }, [drawFrame, durationSeconds, previewState]);

  useEffect(() => () => stopPreview(), [stopPreview]);

  const handleAudioSelection = (event) => {
    const file = event.target.files?.[0] ?? null;

    stopPreview();
    setAudioFile(file);
    setPreviewState("idle");
    setPreviewError("");
    setPlayheadSeconds(0);
    setDurationSeconds(0);
  };

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-8 md:px-8">
        <header className="rounded-2xl border border-slate-800 bg-slate-900/70 p-6">
          <h1 className="text-2xl font-bold md:text-3xl">
            React Kinetic Typography Renderer
          </h1>
          <p className="mt-2 text-sm text-slate-300">
            Browser-only typewriter animation synced to audio.
          </p>
        </header>

        <section className="grid gap-6 lg:grid-cols-[420px_1fr]">
          <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-5">
            <label className="mb-2 block text-sm font-semibold text-slate-200">
              Script Text
            </label>
            <textarea
              value={scriptText}
              onChange={(event) => setScriptText(event.target.value)}
              rows={12}
              className="w-full resize-y rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none ring-0 placeholder:text-slate-500 focus:border-cyan-400"
              placeholder="Paste voiceover text..."
            />

            <div className="mt-5">
              <label className="mb-2 block text-sm font-semibold text-slate-200">
                Audio Upload (MP3/WAV/M4A)
              </label>
              <input
                type="file"
                accept="audio/*"
                onChange={handleAudioSelection}
                className="block w-full text-sm text-slate-300 file:mr-3 file:rounded-lg file:border-0 file:bg-cyan-500 file:px-3 file:py-2 file:text-sm file:font-semibold file:text-slate-950 hover:file:bg-cyan-400"
              />
              <p className="mt-2 text-xs text-slate-400">{audioFileLabel}</p>
            </div>

            <div className="mt-6 flex gap-3">
              <button
                type="button"
                onClick={handlePreview}
                disabled={previewState === "loading"}
                className="rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-emerald-400"
              >
                {previewState === "playing" ? "Restart Preview" : "Preview"}
              </button>
              <button
                type="button"
                onClick={handleExport}
                disabled={previewState === "loading"}
                className="rounded-xl bg-orange-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-orange-400"
              >
                Export Video
              </button>
            </div>

            <div className="mt-4 rounded-lg border border-slate-700/70 bg-slate-950/70 px-3 py-2 text-xs text-slate-300">
              <p>Status: {previewStateLabel}</p>
              <p className="mt-1">Timeline: {previewTimeLabel}</p>
              {previewError ? (
                <p className="mt-2 text-red-300">{previewError}</p>
              ) : null}
            </div>
          </div>

          <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-5">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-200">Canvas Stage</h2>
              <span className="text-xs text-slate-400">1280 x 720 preview</span>
            </div>

            <div className="relative aspect-video w-full overflow-hidden rounded-xl border border-slate-700 bg-slate-950">
              <canvas
                ref={canvasRef}
                id="kinetic-canvas"
                className="h-full w-full"
                width={CANVAS_WIDTH}
                height={CANVAS_HEIGHT}
              />
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}

export default App;
