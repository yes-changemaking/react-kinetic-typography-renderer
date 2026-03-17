let transcriberPromise = null;

async function getTranscriber() {
  if (!transcriberPromise) {
    transcriberPromise = (async () => {
      const { env, pipeline } = await import("@xenova/transformers");

      env.allowLocalModels = false;
      env.useBrowserCache = true;

      if (env.backends?.onnx?.wasm) {
        env.backends.onnx.wasm.numThreads = 1;
      }

      return pipeline("automatic-speech-recognition", "Xenova/whisper-tiny.en", {
        quantized: true,
      });
    })();
  }

  return transcriberPromise;
}

function parseTimestampPair(chunk) {
  const pair = chunk?.timestamp ?? chunk?.timestamps ?? null;
  if (!Array.isArray(pair) || pair.length < 2) return null;

  const startSec = Number(pair[0]);
  const endSec = Number(pair[1]);

  if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) {
    return null;
  }

  return { startSec, endSec };
}

function parseAsrWords(asrOutput) {
  const chunks = Array.isArray(asrOutput?.chunks) ? asrOutput.chunks : [];

  return chunks
    .map((chunk) => {
      const text = String(chunk?.text ?? "").trim();
      const timing = parseTimestampPair(chunk);

      if (!text || !timing) return null;

      return {
        text,
        startSec: timing.startSec,
        endSec: timing.endSec,
      };
    })
    .filter(Boolean);
}

async function transcribeWordTimings(samples, sampleRate) {
  const transcriber = await getTranscriber();

  const commonOptions = {
    return_timestamps: "word",
    chunk_length_s: 28,
    stride_length_s: 5,
    task: "transcribe",
  };

  try {
    return await transcriber(
      {
        array: samples,
        sampling_rate: sampleRate,
      },
      commonOptions
    );
  } catch {
    return transcriber(samples, commonOptions);
  }
}

self.onmessage = async (event) => {
  const { data } = event;
  if (!data || data.type !== "align") return;

  const requestId = data.requestId;

  try {
    const samples = new Float32Array(data.samples);
    const sampleRate = Number(data.sampleRate) || 16_000;

    const output = await transcribeWordTimings(samples, sampleRate);
    const words = parseAsrWords(output);

    self.postMessage({
      type: "alignment-result",
      requestId,
      words,
    });
  } catch (error) {
    self.postMessage({
      type: "alignment-error",
      requestId,
      error: error instanceof Error ? error.message : "Alignment worker failed.",
    });
  }
};
