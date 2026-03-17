import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const DEFAULT_SCRIPT = `This is where your voiceover script goes.
Paste your full text here, upload audio, then preview/export.`;

const CANVAS_WIDTH = 1280;
const CANVAS_HEIGHT = 720;
const CANVAS_PADDING = 88;
const CANVAS_FONT_SIZE = 56;
const CANVAS_LINE_HEIGHT = 1.32;
const AUDIO_METADATA_TIMEOUT_MS = 12_000;
const MIN_CUE_DURATION_SEC = 0.2;
const MIN_PAGE_DURATION_SEC = 0.14;
const TYPEWRITER_FONT = `700 ${CANVAS_FONT_SIZE}px "Segoe UI", "Inter", sans-serif`;

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

const EMPTY_TYPEWRITER_STATUS = {
  cueNumber: 0,
  cueTotal: 0,
  pageNumber: 0,
  pageTotal: 0,
  inLyricsRange: false,
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

function clampRange(value, min, max) {
  return Math.min(Math.max(value, min), max);
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

function countNonWhitespaceChars(text) {
  return (text || "").replace(/\s+/g, "").length;
}

function chunkLines(lines, maxVisibleLines) {
  const chunks = [];

  for (let index = 0; index < lines.length; index += maxVisibleLines) {
    chunks.push(lines.slice(index, index + maxVisibleLines));
  }

  return chunks;
}

function allocateWeightedDurations(weights, totalDuration, minDurationPerItem) {
  const count = weights.length;
  if (!count) return [];

  const safeDuration = Number.isFinite(totalDuration) ? Math.max(totalDuration, 0) : 0;
  if (safeDuration <= 0) {
    return Array(count).fill(0);
  }

  const safeWeights = weights.map((weight) => Math.max(weight, 1));
  const minTotal = minDurationPerItem * count;
  let durations;

  if (safeDuration <= minTotal) {
    durations = Array(count).fill(safeDuration / count);
  } else {
    const extra = safeDuration - minTotal;
    const weightTotal = safeWeights.reduce((sum, weight) => sum + weight, 0);
    durations = safeWeights.map(
      (weight) => minDurationPerItem + (weight / weightTotal) * extra
    );
  }

  const cumulative = durations.reduce((sum, duration) => sum + duration, 0);
  const correction = safeDuration - cumulative;
  durations[durations.length - 1] += correction;

  return durations;
}

function buildTypewriterTimeline({
  scriptText,
  audioDuration,
  lyricsStartOffsetSec,
  maxVisibleLines,
  maxTextWidth,
  measurementCtx,
}) {
  if (!scriptText.trim()) {
    return {
      cues: [],
      pages: [],
      lyricsDurationSec: 0,
      lyricsStartOffsetSec,
      lyricsEndSec: lyricsStartOffsetSec,
    };
  }

  const normalizedText = scriptText.replace(/\r\n/g, "\n").trim();
  const stanzas = normalizedText
    .split(/\n\s*\n+/)
    .map((stanza) => stanza.trim())
    .filter(Boolean);

  const cueTexts = stanzas.length ? stanzas : [normalizedText];
  const cueWeights = cueTexts.map((text) => Math.max(countNonWhitespaceChars(text), 1));

  const lyricsDurationSec = Math.max(
    0.1,
    audioDuration - Math.max(0, lyricsStartOffsetSec)
  );
  const cueDurations = allocateWeightedDurations(
    cueWeights,
    lyricsDurationSec,
    MIN_CUE_DURATION_SEC
  );

  const cues = [];
  const pages = [];
  let cueStartRel = 0;

  cueTexts.forEach((cueText, cueIndex) => {
    const cueDuration = cueDurations[cueIndex];
    const cueEndRel = cueStartRel + cueDuration;
    const cueLines = wrapTextToLines(measurementCtx, cueText, maxTextWidth);
    const lineGroups = chunkLines(cueLines.length ? cueLines : [""], maxVisibleLines);
    const pageWeights = lineGroups.map((lines) =>
      Math.max(countNonWhitespaceChars(lines.join("")), 1)
    );
    const pageDurations = allocateWeightedDurations(
      pageWeights,
      cueDuration,
      MIN_PAGE_DURATION_SEC
    );

    let pageStartRel = cueStartRel;
    const cuePages = lineGroups.map((lines, pageIndexInCue) => {
      const pageDuration = pageDurations[pageIndexInCue];
      const pageEndRel = pageStartRel + pageDuration;
      const lineCharCounts = lines.map((line) => line.length);
      const totalChars = Math.max(
        1,
        lineCharCounts.reduce((sum, lineCharCount) => sum + lineCharCount, 0)
      );

      const pageModel = {
        lines,
        text: lines.join("\n"),
        charWeight: pageWeights[pageIndexInCue],
        startRel: pageStartRel,
        endRel: pageEndRel,
        startSec: lyricsStartOffsetSec + pageStartRel,
        endSec: lyricsStartOffsetSec + pageEndRel,
        cueIndex,
        pageIndexInCue,
        lineCharCounts,
        totalChars,
      };

      pageStartRel = pageEndRel;
      return pageModel;
    });

    cuePages.forEach((pageModel) => pages.push(pageModel));
    cues.push({
      text: cueText,
      startRel: cueStartRel,
      endRel: cueEndRel,
      startSec: lyricsStartOffsetSec + cueStartRel,
      endSec: lyricsStartOffsetSec + cueEndRel,
      charWeight: cueWeights[cueIndex],
      pages: cuePages,
    });

    cueStartRel = cueEndRel;
  });

  if (pages.length) {
    const lastPage = pages[pages.length - 1];
    lastPage.endRel = lyricsDurationSec;
    lastPage.endSec = lyricsStartOffsetSec + lyricsDurationSec;
  }

  if (cues.length) {
    const lastCue = cues[cues.length - 1];
    lastCue.endRel = lyricsDurationSec;
    lastCue.endSec = lyricsStartOffsetSec + lyricsDurationSec;
  }

  return {
    cues,
    pages,
    lyricsDurationSec,
    lyricsStartOffsetSec,
    lyricsEndSec: lyricsStartOffsetSec + lyricsDurationSec,
  };
}

function resolvePageRenderState(timelineModel, currentAudioTime) {
  if (!timelineModel.pages.length) {
    return {
      activePage: null,
      pageProgress: 0,
      inLyricsRange: false,
      cueNumber: 0,
      cueTotal: 0,
      pageNumber: 0,
      pageTotal: 0,
    };
  }

  const lyricsTimeRel = currentAudioTime - timelineModel.lyricsStartOffsetSec;
  const cueTotal = timelineModel.cues.length;

  if (lyricsTimeRel < 0) {
    return {
      activePage: null,
      pageProgress: 0,
      inLyricsRange: false,
      cueNumber: 0,
      cueTotal,
      pageNumber: 0,
      pageTotal: 0,
    };
  }

  const clampedRelTime = Math.min(
    Math.max(lyricsTimeRel, 0),
    timelineModel.lyricsDurationSec
  );

  let activePage = timelineModel.pages[timelineModel.pages.length - 1];
  for (const candidatePage of timelineModel.pages) {
    if (clampedRelTime < candidatePage.endRel) {
      activePage = candidatePage;
      break;
    }
  }

  const activeCue = timelineModel.cues[activePage.cueIndex];
  const cueDuration = Math.max(activeCue.endRel - activeCue.startRel, 0.0001);
  const pageDuration = Math.max(activePage.endRel - activePage.startRel, 0.0001);
  const pageProgress =
    clampedRelTime >= timelineModel.lyricsDurationSec
      ? 1
      : clamp01((clampedRelTime - activePage.startRel) / pageDuration);

  return {
    activePage,
    pageProgress,
    inLyricsRange: true,
    cueNumber: activePage.cueIndex + 1,
    cueTotal,
    pageNumber: activePage.pageIndexInCue + 1,
    pageTotal: activeCue.pages.length,
    cueProgress: clamp01((clampedRelTime - activeCue.startRel) / cueDuration),
  };
}

function drawTypewriterMode({
  ctx,
  timelineModel,
  currentTime,
  isPlaying,
  maxTextWidth,
}) {
  ctx.fillStyle = "#f8fafc";
  ctx.font = TYPEWRITER_FONT;
  ctx.textBaseline = "top";

  const renderState = resolvePageRenderState(timelineModel, currentTime);
  if (!renderState.activePage || !renderState.inLyricsRange) {
    return renderState;
  }

  const activePage = renderState.activePage;
  const visibleChars = Math.floor(renderState.pageProgress * activePage.totalChars);
  const lineHeightPx = CANVAS_FONT_SIZE * CANVAS_LINE_HEIGHT;

  let remainingChars = visibleChars;
  const visibleLines = activePage.lines.map((line) => {
    const charsForLine = Math.min(Math.max(remainingChars, 0), line.length);
    remainingChars -= line.length;
    return line.slice(0, charsForLine);
  });

  let yPosition = CANVAS_PADDING;
  for (const visibleLine of visibleLines) {
    ctx.fillText(visibleLine, CANVAS_PADDING, yPosition);
    yPosition += lineHeightPx;
  }

  if (isPlaying && renderState.pageProgress < 1) {
    let cursorLineIndex = 0;
    let charsBeforeCursor = visibleChars;

    for (let index = 0; index < activePage.lines.length; index += 1) {
      const lineLength = activePage.lines[index].length;
      if (charsBeforeCursor <= lineLength) {
        cursorLineIndex = index;
        break;
      }

      charsBeforeCursor -= lineLength;
      cursorLineIndex = Math.min(index + 1, activePage.lines.length - 1);
    }

    const cursorPrefix = activePage.lines[cursorLineIndex].slice(0, charsBeforeCursor);
    const cursorX = CANVAS_PADDING + Math.min(ctx.measureText(cursorPrefix).width + 6, maxTextWidth);
    const cursorY = CANVAS_PADDING + cursorLineIndex * lineHeightPx;

    const shouldBlink = Math.floor(currentTime * 2) % 2 === 0;
    if (shouldBlink) {
      ctx.fillStyle = "#22d3ee";
      ctx.fillRect(cursorX, cursorY + 8, 6, CANVAS_FONT_SIZE - 12);
    }
  }

  return renderState;
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
  const [maxVisibleLines, setMaxVisibleLines] = useState(4);
  const [lyricsStartOffsetSec, setLyricsStartOffsetSec] = useState(0);

  const [previewState, setPreviewState] = useState("idle");
  const [previewError, setPreviewError] = useState("");
  const [playheadSeconds, setPlayheadSeconds] = useState(0);
  const [durationSeconds, setDurationSeconds] = useState(0);
  const [typewriterStatus, setTypewriterStatus] = useState(
    EMPTY_TYPEWRITER_STATUS
  );

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
  const measureCanvasRef = useRef(null);
  const typewriterTimelineCacheRef = useRef(null);

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
  const cueLabel =
    animationStyle !== "typewriter"
      ? "n/a (karaoke)"
      : typewriterStatus.cueTotal > 0
      ? `${typewriterStatus.cueNumber}/${typewriterStatus.cueTotal}`
      : "0/0";
  const pageLabel =
    animationStyle !== "typewriter"
      ? "n/a (karaoke)"
      : typewriterStatus.pageTotal > 0
      ? `${typewriterStatus.pageNumber}/${typewriterStatus.pageTotal}`
      : "0/0";
  const waitingForOffset =
    animationStyle === "typewriter" &&
    previewState === "playing" &&
    !typewriterStatus.inLyricsRange &&
    playheadSeconds < lyricsStartOffsetSec;

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
    setTypewriterStatus(EMPTY_TYPEWRITER_STATUS);
  }, [clearExportArtifact, stopPreview]);

  const getMeasurementContext = useCallback(() => {
    if (!measureCanvasRef.current) {
      measureCanvasRef.current = document.createElement("canvas");
    }

    const measurementCtx = measureCanvasRef.current.getContext("2d");
    if (!measurementCtx) return null;

    measurementCtx.font = TYPEWRITER_FONT;
    measurementCtx.textBaseline = "top";
    return measurementCtx;
  }, []);

  const getTypewriterTimeline = useCallback(
    (duration, maxTextWidth) => {
      const safeDuration = Number.isFinite(duration) ? Math.max(duration, 0.1) : 0.1;
      const cache = typewriterTimelineCacheRef.current;
      const cacheHit =
        cache &&
        cache.scriptText === scriptText &&
        cache.duration === safeDuration &&
        cache.maxVisibleLines === maxVisibleLines &&
        cache.lyricsStartOffsetSec === lyricsStartOffsetSec &&
        cache.maxTextWidth === maxTextWidth;

      if (cacheHit) return cache.model;

      const measurementCtx = getMeasurementContext();
      if (!measurementCtx) {
        return {
          cues: [],
          pages: [],
          lyricsDurationSec: 0,
          lyricsStartOffsetSec,
          lyricsEndSec: lyricsStartOffsetSec,
        };
      }

      const timelineModel = buildTypewriterTimeline({
        scriptText,
        audioDuration: safeDuration,
        lyricsStartOffsetSec,
        maxVisibleLines,
        maxTextWidth,
        measurementCtx,
      });

      typewriterTimelineCacheRef.current = {
        scriptText,
        duration: safeDuration,
        maxVisibleLines,
        lyricsStartOffsetSec,
        maxTextWidth,
        model: timelineModel,
      };

      return timelineModel;
    },
    [getMeasurementContext, lyricsStartOffsetSec, maxVisibleLines, scriptText]
  );

  const drawFrame = useCallback(
    (currentTime, duration, { isPlaying, showHud }) => {
      const canvas = canvasRef.current;
      if (!canvas) return { typewriterStatus: EMPTY_TYPEWRITER_STATUS };

      const ctx = canvas.getContext("2d");
      if (!ctx) return { typewriterStatus: EMPTY_TYPEWRITER_STATUS };

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

      const maxTextWidth = canvas.width - CANVAS_PADDING * 2;
      let nextTypewriterStatus = EMPTY_TYPEWRITER_STATUS;

      if (animationStyle === "karaoke") {
        drawKaraokeMode({
          ctx,
          scriptText,
          currentTime,
          duration,
          maxTextWidth,
        });
      } else {
        const timelineModel = getTypewriterTimeline(duration, maxTextWidth);
        const renderState = drawTypewriterMode({
          ctx,
          timelineModel,
          currentTime,
          isPlaying,
          maxTextWidth,
        });

        nextTypewriterStatus = {
          cueNumber: renderState.cueNumber ?? 0,
          cueTotal: renderState.cueTotal ?? 0,
          pageNumber: renderState.pageNumber ?? 0,
          pageTotal: renderState.pageTotal ?? 0,
          inLyricsRange: renderState.inLyricsRange ?? false,
        };
      }

      if (!showHud) {
        return { typewriterStatus: nextTypewriterStatus };
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

      return { typewriterStatus: nextTypewriterStatus };
    },
    [animationStyle, getTypewriterTimeline, scriptText]
  );

  const runSilentPreviewLoop = useCallback(
    (duration, previewSessionId) => {
      setPreviewState("playing");
      const initialRender = drawFrame(0, duration, { isPlaying: true, showHud: true });
      setTypewriterStatus(initialRender.typewriterStatus);
      fallbackStartTimeRef.current = performance.now();

      const stepWithoutAudio = (now) => {
        if (previewSessionId !== previewSessionRef.current) {
          animationFrameRef.current = null;
          return;
        }

        const elapsedSeconds = (now - fallbackStartTimeRef.current) / 1000;
        const clampedTime = Math.min(elapsedSeconds, duration);

        const renderMeta = drawFrame(clampedTime, duration, {
          isPlaying: true,
          showHud: true,
        });

        if (now - lastUiSyncRef.current >= 120 || clampedTime >= duration) {
          setPlayheadSeconds(clampedTime);
          setTypewriterStatus(renderMeta.typewriterStatus);
          lastUiSyncRef.current = now;
        }

        if (clampedTime >= duration) {
          setPreviewState("ended");
          const finalRender = drawFrame(duration, duration, {
            isPlaying: false,
            showHud: true,
          });
          setTypewriterStatus(finalRender.typewriterStatus);
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
    setTypewriterStatus(EMPTY_TYPEWRITER_STATUS);

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
      const firstFrameMeta = drawFrame(0, duration, {
        isPlaying: false,
        showHud: true,
      });
      setTypewriterStatus(firstFrameMeta.typewriterStatus);

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
        const renderMeta = drawFrame(clampedTime, duration, {
          isPlaying: true,
          showHud: true,
        });

        if (now - lastUiSyncRef.current >= 120 || activeAudio.ended) {
          setPlayheadSeconds(clampedTime);
          setTypewriterStatus(renderMeta.typewriterStatus);
          lastUiSyncRef.current = now;
        }

        if (activeAudio.ended || clampedTime >= duration) {
          setPlayheadSeconds(duration);
          setPreviewState("ended");
          const finalRender = drawFrame(duration, duration, {
            isPlaying: false,
            showHud: true,
          });
          setTypewriterStatus(finalRender.typewriterStatus);
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
      setTypewriterStatus(EMPTY_TYPEWRITER_STATUS);
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
    setTypewriterStatus(EMPTY_TYPEWRITER_STATUS);
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
      const initialExportFrame = drawFrame(0, duration, {
        isPlaying: false,
        showHud: false,
      });
      setTypewriterStatus(initialExportFrame.typewriterStatus);

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

          const renderMeta = drawFrame(playbackTime, duration, {
            isPlaying: true,
            showHud: false,
          });

          if (now - lastUiSyncRef.current >= 120 || playbackTime >= duration) {
            setPlayheadSeconds(playbackTime);
            setTypewriterStatus(renderMeta.typewriterStatus);
            lastUiSyncRef.current = now;
          }

          const ended = playbackTime >= duration || (exportAudio?.ended ?? false);
          if (ended) {
            setPlayheadSeconds(duration);
            const finalExportFrame = drawFrame(duration, duration, {
              isPlaying: false,
              showHud: false,
            });
            setTypewriterStatus(finalExportFrame.typewriterStatus);
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
    const renderMeta = drawFrame(referenceTime, referenceDuration, {
      isPlaying: false,
      showHud: true,
    });
    setTypewriterStatus(renderMeta.typewriterStatus);
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

  const handleMaxVisibleLinesChange = (event) => {
    const value = clampRange(Number(event.target.value), 1, 5);
    setMaxVisibleLines(value);
  };

  const handleLyricsOffsetChange = (event) => {
    const nextOffset = clampRange(Number(event.target.value), -5, 15);
    setLyricsStartOffsetSec(nextOffset);
  };

  const settingsLocked =
    previewState === "playing" || previewState === "loading" || isExporting;
  const exportButtonDisabled =
    isExporting || previewState === "loading" || !selectedExportMimeType;
  const previewButtonDisabled = isExporting || previewState === "loading";

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
                Max Visible Lines (Typewriter)
              </label>
              <select
                value={maxVisibleLines}
                onChange={handleMaxVisibleLinesChange}
                disabled={animationStyle !== "typewriter" || settingsLocked}
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-cyan-400 disabled:opacity-60"
              >
                <option value={1}>1 line</option>
                <option value={2}>2 lines</option>
                <option value={3}>3 lines</option>
                <option value={4}>4 lines</option>
                <option value={5}>5 lines</option>
              </select>
            </div>

            <div className="mt-5">
              <label className="mb-2 block text-sm font-semibold text-slate-200">
                Lyrics Start Offset (sec)
              </label>
              <input
                type="range"
                min="-5"
                max="15"
                step="0.1"
                value={lyricsStartOffsetSec}
                onChange={handleLyricsOffsetChange}
                disabled={animationStyle !== "typewriter" || settingsLocked}
                className="w-full accent-cyan-400 disabled:opacity-60"
              />
              <div className="mt-1 flex items-center justify-between text-xs text-slate-400">
                <span>-5.0s</span>
                <span>{lyricsStartOffsetSec.toFixed(1)}s</span>
                <span>+15.0s</span>
              </div>
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
              <p className="mt-1 text-xs text-slate-300">Cue: {cueLabel}</p>
              <p className="mt-1 text-xs text-slate-300">Page: {pageLabel}</p>
              <div className="mt-2 h-2 w-full overflow-hidden rounded bg-slate-800">
                <div
                  className="h-full bg-cyan-400 transition-all"
                  style={{ width: `${previewProgressPercent}%` }}
                />
              </div>
              {waitingForOffset ? (
                <p className="mt-2 text-xs text-amber-300">
                  Waiting for offset start at {lyricsStartOffsetSec.toFixed(1)}s
                </p>
              ) : null}
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
