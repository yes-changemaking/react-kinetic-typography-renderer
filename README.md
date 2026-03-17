# React Kinetic Typography Renderer 🎬

![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)
![Environment: Browser-Only](https://img.shields.io/badge/Environment-Browser--Only-success.svg)
![Tech Stack: React + Canvas](https://img.shields.io/badge/Tech-React%20%7C%20Canvas%20%7C%20FFmpeg-orange.svg)

A lightweight, purely client-side React application that synchronizes audio with text to generate dynamic kinetic typography (typewriter animations) and renders the result directly into an MP4/WebM video file entirely within the browser.

## 🚨 The Problem
Generating text-to-video or audio-synced typography traditionally requires heavy server-side rendering (for example Node.js with Remotion or Python-based FFmpeg wrappers). This creates high server costs and latency.

## 💡 The Solution
This project proves that modern browser APIs are capable of handling complex multimedia rendering tasks offline. By leveraging the HTML5 Canvas API for frame-by-frame animation, the Web Audio API for playback synchronization, and `MediaRecorder` (or `FFmpeg.wasm`) for encoding, this tool eliminates the need for backend infrastructure.

## 🛠 Technical Highlights
- **100% Client-Side:** Zero backend dependencies. All processing happens in the user's browser.
- **Dual Sync Modes:** `Auto Align (Beta)` runs optional in-browser speech alignment, and `Proportional` provides a deterministic fallback.
- **Canvas Animation:** High-performance, frame-accurate rendering of typography using native Canvas context.
- **In-Browser Export:** Captures the Canvas stream and encodes it directly to a downloadable video file.
- **NGO Engineering Demo:** Built as a browser-only multimedia engineering demonstrator for grant-facing technical credibility, not a niche musician-only tool.

## 🚀 How it Works (Architecture)
1. **Input:** The user provides a text script and uploads an optional audio file.
2. **Optional Local Analyze:** In `Auto Align (Beta)`, audio is analyzed on-device in a Web Worker to estimate speech word timestamps.
3. **State Management:** React builds a cue/page timeline from alignment output (or proportional fallback) and keeps preview/export in lockstep.
4. **Canvas Drawing:** A `requestAnimationFrame` loop paints only the active cue/page with page-flip typewriter progression.
5. **Recording:** The `MediaRecorder` API captures the canvas stream (along with the audio track) and multiplexes them into a final video blob.

## 🧪 Local Test
```bash
npm install
npm run dev
```

Then open the shown localhost URL (usually `http://localhost:5173`).

## 📄 License
This project is open-source and released under the [MIT License](LICENSE).
