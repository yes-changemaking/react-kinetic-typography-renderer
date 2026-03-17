import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const DEFAULT_SCRIPT = `This is where your voiceover script goes.
Paste your full text here, upload audio, then preview/export.`;

const CANVAS_WIDTH = 1280;
const CANVAS_HEIGHT = 720;
const CANVAS_PADDING = 88;
const CANVAS_FONT_SIZE = 56;
const CANVAS_LINE_HEIGHT = 1.32;
const AUDIO_METADATA_TIMEOUT_MS = 12_000;

const PREVIEW_STATE_LABELS = {
  idle: "Ready",
  loading: "Loading audio...",
  playing: "Playing preview",
  ended: "Preview finished",
  error: "Preview error",
};

const EXPORT_STATE_LABELS = {
  idle: "Ready",
  preparing: "Preparing export...",
  recording: "Recording frames...",
  muxing: "Finalizing video blob...",
  done: "Export complete",
  error: "Export error",
};

const EXPORT_MIME_CANDIDATES = {
  webm: [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ],
  mp4: ["video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4"],
};

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";

  const totalSeconds = Math.floor(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const remainderSeconds = totalSeconds % 60;
  return `${minutes}:${String(remainderSeconds).padStart(2, "0")}`;
}

function clamp01(value) {
  return Math.min(Math.max(value, 0), 1);
}

function sanitizeFileBaseName(name) {
  return (name || "kinetic-typography")
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

function waitForAudioMetadata(
  audioElement,
  timeoutMs = AUDIO_METADATA_TIMEOUT_MS
) {
  return new Promise((resolve, reject) => {
    if (audioElement.readyState >= 1 && Number.isFinite(audioElement.duration)) {
      resolve();
      return;
    }

    const handleLoadedMetadata = () => {
      cleanup();
      resolve();
    };

    const handleAudioError = () => {
      cleanup();
      reject(new Error("Audio file could not be loaded."));
    };

    const handleTimeout = () => {
      cleanup();
      reject(
        new Error(
          "Audio metadata loading timed out. Try an MP3/WAV file or click Reset."
        )
      );
    };

    const timeoutId = setTimeout(handleTimeout, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeoutId);
      audioElement.removeEventListener("loadedmetadata", handleLoadedMetadata);
      audioElement.removeEventListener("error", handleAudioError);
    };

    audioElement.addEventListener("loadedmetadata", handleLoadedMetadata);
    audioElement.addEventListener("error", handleAudioError);
    audioElement.load();
  });
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
  return Math.floor(clamp01(currentTime / duration) * text.length);
}

function pickSupportedMimeType(format) {
  if (typeof window === "undefined") return null;
  if (typeof window.MediaRecorder === "undefined") return null;

  const candidates = EXPORT_MIME_CANDIDATES[format] ?? EXPORT_MIME_CANDIDATES.webm;
  const { isTypeSupported } = window.MediaRecorder;

  if (typeof isTypeSupported !== "function") {
    return candidates[0] ?? null;
  }

  return candidates.find((mimeType) => isTypeSupported(mimeType)) ?? null;
}

function drawTypewriterMode({
  ctx,
  scriptText,
  currentTime,
  duration,
  isPlaying,
  maxTextWidth,
  timelineBottomSpace,
}) {
  const visibleCharacters = getVisibleCharacterCount(scriptText, currentTime, duration);
  const visibleText = scriptText.slice(0, visibleCharacters);
  const lineHeightPx = CANVAS_FONT_SIZE * CANVAS_LINE_HEIGHT;
  const maxLines = Math.max(
    1,
    Math.floor(
      (CANVAS_HEIGHT - CANVAS_PADDING * 2 - timelineBottomSpace) / lineHeightPx
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
}

function drawKaraokeMode({ ctx, scriptText, currentTime, duration, maxTextWidth }) {
  const words = scriptText
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);

  if (!words.length) return;

  const progress = duration > 0 ? clamp01(currentTime / duration) : 1;
  const currentWordIndex = Math.min(
    words.length - 1,
    Math.floor(progress * words.length)
  );

  const windowSize = 8;
  let startIndex = Math.max(0, currentWordIndex - Math.floor(windowSize / 2));
  let endIndex = Math.min(words.length, startIndex + windowSize);
  startIndex = Math.max(0, endIndex - windowSize);

  const windowWords = words.slice(startIndex, endIndex).map((word, offset) => ({
    word,
    index: startIndex + offset,
  }));

  const karaokeFontSize = CANVAS_FONT_SIZE + 10;
  const lineHeightPx = karaokeFontSize * 1.18;

  ctx.font = `900 ${karaokeFontSize}px "Arial Black", "Segoe UI", sans-serif`;
  ctx.textBaseline = "top";
  const spaceWidth = ctx.measureText(" ").width;

  const lines = [];
  let currentLine = [];
  let currentLineWidth = 0;

  for (const entry of windowWords) {
    const wordWidth = ctx.measureText(entry.word).width;
    const leadingSpace = currentLine.length === 0 ? 0 : spaceWidth;
    const candidateWidth = currentLineWidth + leadingSpace + wordWidth;

    if (currentLine.length > 0 && candidateWidth > maxTextWidth) {
      lines.push({ words: currentLine, width: currentLineWidth });
      currentLine = [
        {
          ...entry,
          width: wordWidth,
          leadingSpace: 0,
        },
      ];
      currentLineWidth = wordWidth;
      continue;
    }

    currentLine.push({
      ...entry,
      width: wordWidth,
      leadingSpace,
    });
    currentLineWidth = candidateWidth;
  }

  if (currentLine.length > 0) {
    lines.push({ words: currentLine, width: currentLineWidth });
  }

  const totalTextHeight = lines.length * lineHeightPx;
  const textStartY = (CANVAS_HEIGHT - totalTextHeight) / 2 - 38;

  ctx.textAlign = "center";
  ctx.font = '700 26px "Segoe UI", "Inter", sans-serif';
  ctx.fillStyle = "rgba(148, 163, 184, 0.92)";
  ctx.fillText("KARAOKE TITLES", CANVAS_WIDTH / 2, 54);
  ctx.textAlign = "left";
  ctx.font = `900 ${karaokeFontSize}px "Arial Black", "Segoe UI", sans-serif`;

  let lineY = textStartY;
  for (const line of lines) {
    let x = (CANVAS_WIDTH - line.width) / 2;

    for (const word of line.words) {
      x += word.leadingSpace;

      if (word.index < currentWordIndex) {
        ctx.fillStyle = "rgba(226, 232, 240, 0.58)";
        ctx.shadowColor = "transparent";
      } else if (word.index === currentWordIndex) {
        ctx.fillStyle = "#fde047";
        ctx.shadowColor = "rgba(251, 191, 36, 0.45)";
        ctx.shadowBlur = 28;
      } else {
        ctx.fillStyle = "#f8fafc";
        ctx.shadowColor = "transparent";
      }

      ctx.strokeStyle = "rgba(2, 6, 23, 0.75)";
      ctx.lineWidth = 7;
      ctx.strokeText(word.word, x, lineY);
      ctx.fillText(word.word, x, lineY);
      x += word.width;
    }

    lineY += lineHeightPx;
  }

  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
}

function App() {
  const [scriptText, setScriptText] = useState(DEFAULT_SCRIPT);
  const [audioFile, setAudioFile] = useState(null);
  const [animationStyle, setAnimationStyle] = useState("typewriter");
  const [exportFormat, setExportFormat] = useState("webm");

  const [previewState, setPreviewState] = useState("idle");
  const [previewError, setPreviewError] = useState("");
  const [playheadSeconds, setPlayheadSeconds] = useState(0);
  const [durationSeconds, setDurationSeconds] = useState(0);

  const [exportState, setExportState] = useState("idle");
  const [exportError, setExportError] = useState("");
  const [exportDownloadUrl, setExportDownloadUrl] = useState("");
  const [exportFileName, setExportFileName] = useState("");

  const canvasRef = useRef(null);
  const animationFrameRef = useRef(null);
  const audioElementRef = useRef(null);
  const audioObjectUrlRef = useRef(null);
  const fallbackStartTimeRef = useRef(0);
  const lastUiSyncRef = useRef(0);
  const exportDownloadUrlRef = useRef(null);
  const previewSessionRef = useRef(0);
  const exportSessionRef = useRef(0);

  const selectedExportMimeType = useMemo(
    () => pickSupportedMimeType(exportFormat),
    [exportFormat]
  );

  const isExporting =
    exportState === "preparing" ||
    exportState === "recording" ||
    exportState === "muxing";

  const audioFileLabel = useMemo(() => {
    if (!audioFile) return "No audio selected";
    const sizeInMb = (audioFile.size / (1024 * 1024)).toFixed(2);
    return `${audioFile.name} (${sizeInMb} MB)`;
  }, [audioFile]);

  const previewStateLabel = PREVIEW_STATE_LABELS[previewState] ?? "Unknown";
  const previewTimeLabel = `${formatTime(playheadSeconds)} / ${formatTime(
    durationSeconds
  )}`;
  const previewProgressPercent =
    durationSeconds > 0 ? clamp01(playheadSeconds / durationSeconds) * 100 : 0;
  const exportStateLabel = EXPORT_STATE_LABELS[exportState] ?? "Unknown";

  const clearExportArtifact = useCallback(() => {
    if (exportDownloadUrlRef.current) {
      URL.revokeObjectURL(exportDownloadUrlRef.current);
      exportDownloadUrlRef.current = null;
    }
    setExportDownloadUrl("");
    setExportFileName("");
  }, []);

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

  const resetInteractionState = useCallback(() => {
    previewSessionRef.current += 1;
    exportSessionRef.current += 1;
    stopPreview();
    clearExportArtifact();
    setPreviewState("idle");
    setExportState("idle");
    setPreviewError("");
    setExportError("");
    setPlayheadSeconds(0);
    setDurationSeconds(0);
  }, [clearExportArtifact, stopPreview]);

  const drawFrame = useCallback(
    (currentTime, duration, { isPlaying, showHud }) => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      if (canvas.width !== CANVAS_WIDTH || canvas.height !== CANVAS_HEIGHT) {
        canvas.width = CANVAS_WIDTH;
        canvas.height = CANVAS_HEIGHT;
      }

      const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
      gradient.addColorStop(0, "#020617");
      gradient.addColorStop(1, "#111827");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      const vignette = ctx.createRadialGradient(
        canvas.width / 2,
        canvas.height / 2,
        180,
        canvas.width / 2,
        canvas.height / 2,
        canvas.width * 0.7
      );
      vignette.addColorStop(0, "rgba(15, 23, 42, 0)");
      vignette.addColorStop(1, "rgba(2, 6, 23, 0.65)");
      ctx.fillStyle = vignette;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      const timelineBottomSpace = showHud ? 62 : 24;
      const maxTextWidth = canvas.width - CANVAS_PADDING * 2;

      if (animationStyle === "karaoke") {
        drawKaraokeMode({
          ctx,
          scriptText,
          currentTime,
          duration,
          maxTextWidth,
        });
      } else {
        drawTypewriterMode({
          ctx,
          scriptText,
          currentTime,
          duration,
          isPlaying,
          maxTextWidth,
          timelineBottomSpace,
        });
      }

      if (!showHud) return;

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
    [animationStyle, scriptText]
  );

  const runSilentPreviewLoop = useCallback(
    (duration, previewSessionId) => {
      setPreviewState("playing");
      drawFrame(0, duration, { isPlaying: true, showHud: true });
      fallbackStartTimeRef.current = performance.now();

      const stepWithoutAudio = (now) => {
        if (previewSessionId !== previewSessionRef.current) {
          animationFrameRef.current = null;
          return;
        }

        const elapsedSeconds = (now - fallbackStartTimeRef.current) / 1000;
        const clampedTime = Math.min(elapsedSeconds, duration);

        drawFrame(clampedTime, duration, { isPlaying: true, showHud: true });

        if (now - lastUiSyncRef.current >= 120 || clampedTime >= duration) {
          setPlayheadSeconds(clampedTime);
          lastUiSyncRef.current = now;
        }

        if (clampedTime >= duration) {
          setPreviewState("ended");
          drawFrame(duration, duration, { isPlaying: false, showHud: true });
          animationFrameRef.current = null;
          return;
        }

        animationFrameRef.current = requestAnimationFrame(stepWithoutAudio);
      };

      animationFrameRef.current = requestAnimationFrame(stepWithoutAudio);
    },
    [drawFrame]
  );

  const handlePreview = useCallback(async () => {
    if (isExporting) return;

    const previewSessionId = previewSessionRef.current + 1;
    previewSessionRef.current = previewSessionId;

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
      runSilentPreviewLoop(fallbackDuration, previewSessionId);
      return;
    }

    try {
      setPreviewState("loading");
      const objectUrl = URL.createObjectURL(audioFile);
      audioObjectUrlRef.current = objectUrl;

      const audio = new Audio(objectUrl);
      audio.preload = "auto";
      audioElementRef.current = audio;
      await waitForAudioMetadata(audio, AUDIO_METADATA_TIMEOUT_MS);

      if (previewSessionId !== previewSessionRef.current) {
        return;
      }

      const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
      if (duration <= 0) {
        throw new Error("Audio duration could not be determined.");
      }

      setDurationSeconds(duration);
      drawFrame(0, duration, { isPlaying: false, showHud: true });

      let playbackStarted = false;
      try {
        await audio.play();
        playbackStarted = true;
      } catch (playbackError) {
        setPreviewError(
          playbackError instanceof Error
            ? `${playbackError.message} Running visual-only preview.`
            : "Audio playback was blocked. Running visual-only preview."
        );
      }

      if (previewSessionId !== previewSessionRef.current) {
        return;
      }

      if (!playbackStarted) {
        runSilentPreviewLoop(duration, previewSessionId);
        return;
      }

      setPreviewState("playing");

      const stepWithAudio = (now) => {
        if (previewSessionId !== previewSessionRef.current) {
          animationFrameRef.current = null;
          return;
        }

        const activeAudio = audioElementRef.current;
        if (!activeAudio) {
          animationFrameRef.current = null;
          return;
        }

        const clampedTime = Math.min(activeAudio.currentTime, duration);
        drawFrame(clampedTime, duration, { isPlaying: true, showHud: true });

        if (now - lastUiSyncRef.current >= 120 || activeAudio.ended) {
          setPlayheadSeconds(clampedTime);
          lastUiSyncRef.current = now;
        }

        if (activeAudio.ended || clampedTime >= duration) {
          setPlayheadSeconds(duration);
          setPreviewState("ended");
          drawFrame(duration, duration, { isPlaying: false, showHud: true });
          stopPreview();
          return;
        }

        animationFrameRef.current = requestAnimationFrame(stepWithAudio);
      };

      animationFrameRef.current = requestAnimationFrame(stepWithAudio);
    } catch (error) {
      if (previewSessionId !== previewSessionRef.current) {
        return;
      }
      stopPreview();
      setPreviewState("error");
      setPreviewError(
        error instanceof Error ? error.message : "Preview could not be started."
      );
    }
  }, [
    audioFile,
    drawFrame,
    isExporting,
    runSilentPreviewLoop,
    scriptText,
    stopPreview,
  ]);

  const handleExport = useCallback(async () => {
    if (isExporting) return;

    const exportSessionId = exportSessionRef.current + 1;
    exportSessionRef.current = exportSessionId;
    previewSessionRef.current += 1;

    setExportError("");
    setPreviewError("");

    if (!scriptText.trim()) {
      setExportState("error");
      setExportError("Please enter text before exporting.");
      return;
    }

    const canvas = canvasRef.current;
    if (!canvas) {
      setExportState("error");
      setExportError("Canvas is not ready yet.");
      return;
    }

    if (typeof window.MediaRecorder === "undefined") {
      setExportState("error");
      setExportError("MediaRecorder is not available in this browser.");
      return;
    }

    if (typeof canvas.captureStream !== "function") {
      setExportState("error");
      setExportError("Canvas captureStream() is not supported in this browser.");
      return;
    }

    if (!selectedExportMimeType) {
      setExportState("error");
      setExportError(
        `${exportFormat.toUpperCase()} recording is not supported in this browser.`
      );
      return;
    }

    stopPreview();
    clearExportArtifact();
    setPlayheadSeconds(0);
    lastUiSyncRef.current = 0;

    let canvasStream;
    let composedStream;
    let recorder;
    let recorderResultPromise;
    let exportAudio;
    let exportAudioUrl;
    let audioContext;
    let mediaSourceNode;
    let mediaDestinationNode;
    let duration = 0;
    let fallbackStartTimestamp = 0;

    try {
      setExportState("preparing");

      if (audioFile) {
        exportAudioUrl = URL.createObjectURL(audioFile);
        exportAudio = new Audio(exportAudioUrl);
        exportAudio.preload = "auto";
        await waitForAudioMetadata(exportAudio, AUDIO_METADATA_TIMEOUT_MS);

        if (exportSessionId !== exportSessionRef.current) {
          return;
        }

        duration = Number.isFinite(exportAudio.duration) ? exportAudio.duration : 0;
        if (duration <= 0) {
          throw new Error("Audio duration could not be determined for export.");
        }
      } else {
        duration = Math.min(Math.max(scriptText.length / 14, 3), 24);
      }

      setDurationSeconds(duration);
      drawFrame(0, duration, { isPlaying: false, showHud: false });

      canvasStream = canvas.captureStream(60);
      const videoTrack = canvasStream.getVideoTracks()[0];
      if (!videoTrack) {
        throw new Error("Canvas video track could not be created.");
      }

      composedStream = new MediaStream([videoTrack]);

      if (exportAudio) {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) {
          throw new Error("AudioContext is not available for audio export.");
        }

        audioContext = new AudioContextClass();
        mediaSourceNode = audioContext.createMediaElementSource(exportAudio);
        mediaDestinationNode = audioContext.createMediaStreamDestination();
        mediaSourceNode.connect(mediaDestinationNode);

        const audioTrack = mediaDestinationNode.stream.getAudioTracks()[0];
        if (audioTrack) {
          composedStream.addTrack(audioTrack);
        }
      }

      const chunks = [];
      recorderResultPromise = new Promise((resolve, reject) => {
        recorder = new MediaRecorder(composedStream, {
          mimeType: selectedExportMimeType,
          videoBitsPerSecond: 8_000_000,
        });

        recorder.ondataavailable = (event) => {
          if (event.data && event.data.size > 0) {
            chunks.push(event.data);
          }
        };

        recorder.onerror = (event) => {
          const details =
            event.error?.message || "MediaRecorder failed during export.";
          reject(new Error(details));
        };

        recorder.onstop = () => {
          resolve(new Blob(chunks, { type: selectedExportMimeType }));
        };
      });

      recorder.start(250);
      setExportState("recording");

      fallbackStartTimestamp = performance.now();
      if (exportAudio) {
        await audioContext.resume();
        await exportAudio.play();
      }

      if (exportSessionId !== exportSessionRef.current) {
        return;
      }

      await new Promise((resolve) => {
        const renderStep = (now) => {
          if (exportSessionId !== exportSessionRef.current) {
            cancelRenderLoop();
            resolve();
            return;
          }

          const playbackTime = exportAudio
            ? Math.min(exportAudio.currentTime, duration)
            : Math.min((now - fallbackStartTimestamp) / 1000, duration);

          drawFrame(playbackTime, duration, { isPlaying: true, showHud: false });

          if (now - lastUiSyncRef.current >= 120 || playbackTime >= duration) {
            setPlayheadSeconds(playbackTime);
            lastUiSyncRef.current = now;
          }

          const ended = playbackTime >= duration || (exportAudio?.ended ?? false);
          if (ended) {
            setPlayheadSeconds(duration);
            drawFrame(duration, duration, { isPlaying: false, showHud: false });
            cancelRenderLoop();
            resolve();
            return;
          }

          animationFrameRef.current = requestAnimationFrame(renderStep);
        };

        animationFrameRef.current = requestAnimationFrame(renderStep);
      });

      setExportState("muxing");
      if (recorder && recorder.state !== "inactive") {
        recorder.stop();
      }

      const exportBlob = await recorderResultPromise;
      if (exportSessionId !== exportSessionRef.current) {
        return;
      }
      const extension = selectedExportMimeType.includes("mp4") ? "mp4" : "webm";
      const sourceName = sanitizeFileBaseName(audioFile?.name || "kinetic-typography");
      const fileName = `${sourceName}-${animationStyle}.${extension}`;
      const downloadUrl = URL.createObjectURL(exportBlob);

      exportDownloadUrlRef.current = downloadUrl;
      setExportDownloadUrl(downloadUrl);
      setExportFileName(fileName);
      setExportState("done");

      const autoDownloadLink = document.createElement("a");
      autoDownloadLink.href = downloadUrl;
      autoDownloadLink.download = fileName;
      autoDownloadLink.rel = "noopener";
      autoDownloadLink.click();
    } catch (error) {
      if (exportSessionId !== exportSessionRef.current) {
        return;
      }
      setExportState("error");
      setExportError(
        error instanceof Error ? error.message : "Video export failed."
      );
    } finally {
      cancelRenderLoop();

      if (recorder && recorder.state !== "inactive") {
        recorder.stop();
      }

      if (composedStream) {
        composedStream.getTracks().forEach((track) => track.stop());
      }

      if (canvasStream) {
        canvasStream.getTracks().forEach((track) => track.stop());
      }

      if (mediaSourceNode) {
        mediaSourceNode.disconnect();
      }

      if (mediaDestinationNode) {
        mediaDestinationNode.disconnect();
      }

      if (exportAudio) {
        exportAudio.pause();
        exportAudio.src = "";
      }

      if (exportAudioUrl) {
        URL.revokeObjectURL(exportAudioUrl);
      }

      if (audioContext) {
        await audioContext.close();
      }
    }
  }, [
    animationStyle,
    audioFile,
    cancelRenderLoop,
    clearExportArtifact,
    drawFrame,
    exportFormat,
    isExporting,
    scriptText,
    selectedExportMimeType,
    stopPreview,
  ]);

  useEffect(() => {
    if (
      previewState === "playing" ||
      previewState === "loading" ||
      isExporting
    ) {
      return;
    }

    const referenceDuration = durationSeconds > 0 ? durationSeconds : 5;
    const referenceTime = previewState === "ended" ? referenceDuration : 0;
    drawFrame(referenceTime, referenceDuration, { isPlaying: false, showHud: true });
  }, [drawFrame, durationSeconds, isExporting, previewState]);

  useEffect(() => {
    return () => {
      previewSessionRef.current += 1;
      exportSessionRef.current += 1;
      stopPreview();
      clearExportArtifact();
    };
  }, [clearExportArtifact, stopPreview]);

  const handleReset = useCallback(() => {
    resetInteractionState();
  }, [resetInteractionState]);

  const handleAudioSelection = (event) => {
    const file = event.target.files?.[0] ?? null;

    resetInteractionState();
    setAudioFile(file);
  };

  const exportButtonDisabled = isExporting || !selectedExportMimeType;
  const previewButtonDisabled = isExporting;

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-8 md:px-8">
        <header className="rounded-2xl border border-slate-800 bg-slate-900/70 p-6">
          <h1 className="text-2xl font-bold md:text-3xl">
            React Kinetic Typography Renderer
          </h1>
          <p className="mt-2 text-sm text-slate-300">
            Browser-only typewriter or karaoke-title animation synced to audio.
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
                Animation Style
              </label>
              <select
                value={animationStyle}
                onChange={(event) => setAnimationStyle(event.target.value)}
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-cyan-400"
              >
                <option value="typewriter">Typewriter</option>
                <option value="karaoke">Karaoke Titles</option>
              </select>
            </div>

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

            <div className="mt-5">
              <label className="mb-2 block text-sm font-semibold text-slate-200">
                Export Format
              </label>
              <select
                value={exportFormat}
                onChange={(event) => setExportFormat(event.target.value)}
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-cyan-400"
              >
                <option value="webm">WebM (best browser support)</option>
                <option value="mp4">MP4 (browser dependent)</option>
              </select>
              <p className="mt-2 text-xs text-slate-400">
                {selectedExportMimeType
                  ? `Recorder codec: ${selectedExportMimeType}`
                  : `${exportFormat.toUpperCase()} export not supported in this browser.`}
              </p>
            </div>

            <div className="mt-6 flex flex-wrap gap-3">
              <button
                type="button"
                onClick={handlePreview}
                disabled={previewButtonDisabled}
                className="min-w-[120px] rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {previewState === "playing" ? "Restart Preview" : "Preview"}
              </button>
              <button
                type="button"
                onClick={handleExport}
                disabled={exportButtonDisabled}
                className="min-w-[120px] rounded-xl bg-orange-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-orange-400 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isExporting ? "Exporting..." : "Export Video"}
              </button>
              <button
                type="button"
                onClick={handleReset}
                className="min-w-[120px] rounded-xl border border-slate-600 px-4 py-2 text-sm font-semibold text-slate-200 hover:border-slate-400 hover:text-white"
              >
                Reset
              </button>
            </div>

            {exportDownloadUrl ? (
              <a
                href={exportDownloadUrl}
                download={exportFileName || "kinetic-typography.webm"}
                className="mt-3 inline-block rounded-lg border border-cyan-400/70 px-3 py-2 text-xs font-semibold text-cyan-300 hover:bg-cyan-500/10"
              >
                Download Again: {exportFileName || "video"}
              </a>
            ) : null}

            <div className="mt-4 rounded-lg border border-cyan-900/60 bg-slate-950/70 px-3 py-3 text-sm text-slate-200">
              <p className="font-semibold text-cyan-300">Preview: {previewStateLabel}</p>
              <p className="mt-1 text-xs text-slate-300">Timeline: {previewTimeLabel}</p>
              <div className="mt-2 h-2 w-full overflow-hidden rounded bg-slate-800">
                <div
                  className="h-full bg-cyan-400 transition-all"
                  style={{ width: `${previewProgressPercent}%` }}
                />
              </div>
              {previewError ? (
                <p className="mt-2 text-xs text-red-300">{previewError}</p>
              ) : null}
            </div>

            <div className="mt-3 rounded-lg border border-slate-700/70 bg-slate-950/70 px-3 py-2 text-xs text-slate-300">
              <p>Export: {exportStateLabel}</p>
              {exportError ? <p className="mt-2 text-red-300">{exportError}</p> : null}
              <p className="mt-2 text-slate-500">
                If controls seem stuck, click Reset.
              </p>
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
              {(previewState === "idle" || previewState === "loading") && (
                <div className="pointer-events-none absolute inset-0 grid place-items-center bg-slate-950/35 text-center">
                  <p className="rounded-md bg-slate-900/70 px-3 py-2 text-xs font-semibold text-slate-200">
                    {previewState === "loading"
                      ? "Loading audio metadata..."
                      : "Click Preview to start rendering"}
                  </p>
                </div>
              )}
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}

export default App;
