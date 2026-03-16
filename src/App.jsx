import { useMemo, useState } from "react";

const DEFAULT_SCRIPT = `This is where your voiceover script goes.
Paste your full text here, upload audio, then preview/export.`;

function App() {
  const [scriptText, setScriptText] = useState(DEFAULT_SCRIPT);
  const [audioFile, setAudioFile] = useState(null);

  const audioFileLabel = useMemo(() => {
    if (!audioFile) return "No audio selected";
    const sizeInMb = (audioFile.size / (1024 * 1024)).toFixed(2);
    return `${audioFile.name} (${sizeInMb} MB)`;
  }, [audioFile]);

  const handlePreview = () => {
    // Step 2: Canvas drawing and audio sync logic
  };

  const handleExport = () => {
    // Step 3: MediaRecorder export logic
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
                onChange={(event) =>
                  setAudioFile(event.target.files?.[0] ?? null)
                }
                className="block w-full text-sm text-slate-300 file:mr-3 file:rounded-lg file:border-0 file:bg-cyan-500 file:px-3 file:py-2 file:text-sm file:font-semibold file:text-slate-950 hover:file:bg-cyan-400"
              />
              <p className="mt-2 text-xs text-slate-400">{audioFileLabel}</p>
            </div>

            <div className="mt-6 flex gap-3">
              <button
                type="button"
                onClick={handlePreview}
                className="rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-emerald-400"
              >
                Preview
              </button>
              <button
                type="button"
                onClick={handleExport}
                className="rounded-xl bg-orange-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-orange-400"
              >
                Export Video
              </button>
            </div>
          </div>

          <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-5">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-200">Canvas Stage</h2>
              <span className="text-xs text-slate-400">Step 2 will render here</span>
            </div>

            <div className="relative aspect-video w-full overflow-hidden rounded-xl border border-slate-700 bg-slate-950">
              <canvas
                id="kinetic-canvas"
                className="h-full w-full"
                width="1280"
                height="720"
              />
              <div className="pointer-events-none absolute inset-0 grid place-items-center text-center text-slate-500">
                <p className="text-sm">Canvas preview placeholder</p>
              </div>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}

export default App;
