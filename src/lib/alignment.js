const TOKEN_PATTERN = /[^\s]+/g;
const DEFAULT_AVG_TOKEN_DURATION_SEC = 0.22;
const MIN_TOKEN_DURATION_SEC = 0.05;

export const DEFAULT_MIN_CUE_MATCH_RATIO = 0.4;

export function splitScriptIntoCues(scriptText) {
  const normalizedText = String(scriptText || "").replace(/\r\n/g, "\n").trim();
  if (!normalizedText) return [];

  const cues = normalizedText
    .split(/\n\s*\n+/)
    .map((cue) => cue.trim())
    .filter(Boolean);

  return cues.length ? cues : [normalizedText];
}

export function normalizeToken(token) {
  if (!token) return "";

  return token
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’`]/g, "'")
    .toLowerCase()
    .replace(/^[^a-z0-9']+|[^a-z0-9']+$/g, "")
    .replace(/[^a-z0-9']+/g, "");
}

function hasFiniteTiming(token) {
  return Number.isFinite(token.startSec) && Number.isFinite(token.endSec);
}

function tokenDuration(token) {
  if (!hasFiniteTiming(token)) return 0;
  return Math.max(token.endSec - token.startSec, MIN_TOKEN_DURATION_SEC);
}

function isEditDistanceAtMostOne(left, right) {
  if (left === right) return true;

  const leftLength = left.length;
  const rightLength = right.length;
  if (Math.abs(leftLength - rightLength) > 1) return false;

  let leftIndex = 0;
  let rightIndex = 0;
  let edits = 0;

  while (leftIndex < leftLength && rightIndex < rightLength) {
    if (left[leftIndex] === right[rightIndex]) {
      leftIndex += 1;
      rightIndex += 1;
      continue;
    }

    edits += 1;
    if (edits > 1) return false;

    if (leftLength > rightLength) {
      leftIndex += 1;
    } else if (rightLength > leftLength) {
      rightIndex += 1;
    } else {
      leftIndex += 1;
      rightIndex += 1;
    }
  }

  if (leftIndex < leftLength || rightIndex < rightLength) {
    edits += 1;
  }

  return edits <= 1;
}

function wordsFromText(text) {
  return String(text || "")
    .match(TOKEN_PATTERN)
    ?.filter(Boolean) ?? [];
}

function normalizeAsrWords(asrWords) {
  return (Array.isArray(asrWords) ? asrWords : [])
    .map((entry) => {
      const word = String(entry?.text || "").trim();
      const normalized = normalizeToken(word);
      const startSec = Number(entry?.startSec);
      const endSec = Number(entry?.endSec);

      return {
        word,
        normalized,
        startSec,
        endSec,
      };
    })
    .filter(
      (entry) =>
        entry.normalized &&
        Number.isFinite(entry.startSec) &&
        Number.isFinite(entry.endSec) &&
        entry.endSec > entry.startSec
    );
}

function buildCueTokenMap(cueTexts) {
  return cueTexts.map((cueText, cueIndex) =>
    wordsFromText(cueText)
      .map((raw, tokenIndex) => {
        const normalized = normalizeToken(raw);
        if (!normalized) return null;

        return {
          cueIndex,
          tokenIndex,
          raw,
          normalized,
          matched: false,
          startSec: null,
          endSec: null,
        };
      })
      .filter(Boolean)
  );
}

function averageKnownDuration(tokens) {
  const durations = tokens
    .map((token) => tokenDuration(token))
    .filter((duration) => duration > 0);

  if (!durations.length) return DEFAULT_AVG_TOKEN_DURATION_SEC;
  return durations.reduce((sum, duration) => sum + duration, 0) / durations.length;
}

function fillUnknownTimings(tokens) {
  if (!tokens.length) return;

  const avgDuration = averageKnownDuration(tokens);
  let tokenIndex = 0;

  while (tokenIndex < tokens.length) {
    if (hasFiniteTiming(tokens[tokenIndex])) {
      tokenIndex += 1;
      continue;
    }

    const runStart = tokenIndex;
    while (tokenIndex < tokens.length && !hasFiniteTiming(tokens[tokenIndex])) {
      tokenIndex += 1;
    }
    const runEnd = tokenIndex - 1;
    const runCount = runEnd - runStart + 1;

    const previous = runStart > 0 ? tokens[runStart - 1] : null;
    const next = tokenIndex < tokens.length ? tokens[tokenIndex] : null;

    if (
      previous &&
      hasFiniteTiming(previous) &&
      next &&
      hasFiniteTiming(next) &&
      next.startSec > previous.endSec
    ) {
      const gap = next.startSec - previous.endSec;
      const duration = Math.max(gap / (runCount + 1), MIN_TOKEN_DURATION_SEC);

      for (let offset = 0; offset < runCount; offset += 1) {
        const startSec = previous.endSec + duration * offset;
        const current = tokens[runStart + offset];
        current.startSec = startSec;
        current.endSec = startSec + duration;
      }
      continue;
    }

    if (previous && hasFiniteTiming(previous)) {
      for (let offset = 0; offset < runCount; offset += 1) {
        const startSec = previous.endSec + avgDuration * offset;
        const current = tokens[runStart + offset];
        current.startSec = startSec;
        current.endSec = startSec + avgDuration;
      }
      continue;
    }

    if (next && hasFiniteTiming(next)) {
      for (let reverse = runCount - 1; reverse >= 0; reverse -= 1) {
        const index = runStart + reverse;
        const tailOffset = runCount - 1 - reverse;
        const endSec = next.startSec - avgDuration * tailOffset;
        const startSec = Math.max(0, endSec - avgDuration);
        const current = tokens[index];
        current.startSec = startSec;
        current.endSec = Math.max(endSec, startSec + MIN_TOKEN_DURATION_SEC);
      }
      continue;
    }

    for (let offset = 0; offset < runCount; offset += 1) {
      const current = tokens[runStart + offset];
      const startSec = avgDuration * offset;
      current.startSec = startSec;
      current.endSec = startSec + avgDuration;
    }
  }

  let lastEndSec = 0;
  for (const token of tokens) {
    const startSec = Number.isFinite(token.startSec) ? token.startSec : lastEndSec;
    const endSec = Number.isFinite(token.endSec) ? token.endSec : startSec + avgDuration;

    token.startSec = Math.max(startSec, lastEndSec);
    token.endSec = Math.max(endSec, token.startSec + MIN_TOKEN_DURATION_SEC);
    lastEndSec = token.endSec;
  }
}

function findTokenMatch(scriptToken, asrTokens, startIndex, windowSize = 14) {
  const endIndex = Math.min(asrTokens.length, startIndex + windowSize);
  let fuzzyCandidate = -1;

  for (let index = startIndex; index < endIndex; index += 1) {
    const candidate = asrTokens[index];
    if (candidate.normalized === scriptToken.normalized) {
      return index;
    }

    if (
      fuzzyCandidate === -1 &&
      scriptToken.normalized.length >= 5 &&
      candidate.normalized.length >= 5 &&
      isEditDistanceAtMostOne(scriptToken.normalized, candidate.normalized)
    ) {
      fuzzyCandidate = index;
    }
  }

  return fuzzyCandidate;
}

export function buildAlignmentFromAsrWords({
  scriptText,
  asrWords,
  minCueMatchRatio = DEFAULT_MIN_CUE_MATCH_RATIO,
}) {
  const cueTexts = splitScriptIntoCues(scriptText);
  if (!cueTexts.length) {
    return {
      cues: [],
      wordTimings: [],
      quality: {
        matchedRatio: 0,
        fallbackCueCount: 0,
      },
    };
  }

  const asrTokens = normalizeAsrWords(asrWords);
  const cueTokens = buildCueTokenMap(cueTexts);

  let asrCursor = 0;
  let matchedTokenCount = 0;
  let totalTokenCount = 0;

  cueTokens.forEach((tokens) => {
    tokens.forEach((token) => {
      totalTokenCount += 1;
      if (!asrTokens.length) return;

      const matchIndex = findTokenMatch(token, asrTokens, asrCursor);
      if (matchIndex === -1) return;

      const matchedAsr = asrTokens[matchIndex];
      token.matched = true;
      token.startSec = matchedAsr.startSec;
      token.endSec = matchedAsr.endSec;
      matchedTokenCount += 1;
      asrCursor = matchIndex + 1;
    });

    fillUnknownTimings(tokens);
  });

  const cues = cueTokens.map((tokens, cueIndex) => {
    const cueMatchedCount = tokens.filter((token) => token.matched).length;
    const tokenCount = tokens.length;
    const matchRatio = tokenCount > 0 ? cueMatchedCount / tokenCount : 0;

    const hasTokens = tokens.length > 0;
    const startSec = hasTokens ? tokens[0].startSec : null;
    const endSec = hasTokens ? tokens[tokens.length - 1].endSec : null;

    return {
      cueIndex,
      text: cueTexts[cueIndex],
      tokens,
      matchRatio,
      tokenCount,
      matchedCount: cueMatchedCount,
      startSec,
      endSec,
      useAutoTiming:
        matchRatio >= minCueMatchRatio &&
        Number.isFinite(startSec) &&
        Number.isFinite(endSec) &&
        endSec > startSec,
    };
  });

  const wordTimings = cues.flatMap((cue) =>
    cue.tokens
      .filter((token) => hasFiniteTiming(token))
      .map((token) => ({
        word: token.raw,
        startSec: token.startSec,
        endSec: token.endSec,
        cueIndex: cue.cueIndex,
        matched: token.matched,
      }))
  );

  const matchedRatio = totalTokenCount > 0 ? matchedTokenCount / totalTokenCount : 0;
  const fallbackCueCount = cues.filter((cue) => !cue.useAutoTiming).length;

  return {
    cues,
    wordTimings,
    quality: {
      matchedRatio,
      fallbackCueCount,
    },
  };
}

export function buildPageTimingHintsFromCue(cueAlignment, pageWordCounts) {
  if (!cueAlignment?.useAutoTiming) return null;

  const tokens = cueAlignment.tokens.filter(hasFiniteTiming);
  if (!tokens.length) return null;

  const hints = [];
  let cursor = 0;

  pageWordCounts.forEach((wordCount) => {
    const safeCount = Math.max(Number(wordCount) || 0, 0);
    if (safeCount === 0) {
      hints.push(null);
      return;
    }

    const slice = tokens.slice(cursor, cursor + safeCount);
    cursor += safeCount;

    if (!slice.length) {
      hints.push(null);
      return;
    }

    const first = slice[0];
    const last = slice[slice.length - 1];
    if (!hasFiniteTiming(first) || !hasFiniteTiming(last)) {
      hints.push(null);
      return;
    }

    hints.push({
      startSec: first.startSec,
      endSec: last.endSec,
    });
  });

  return hints;
}

export function countWordsInLines(lines) {
  return wordsFromText((lines || []).join(" ")).length;
}
