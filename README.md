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
- **Precise Audio Sync:** Utilizes robust React state management to map text characters to audio timestamps.
- **Canvas Animation:** High-performance, frame-accurate rendering of typography using native Canvas context.
- **In-Browser Export:** Captures the Canvas stream and encodes it directly to a downloadable video file.

## 🚀 How it Works (Architecture)
1. **Input:** The user provides a text script and uploads an optional audio file.
2. **State Management:** React calculates the duration of the audio and synchronizes the typewriter effect speed to match.
3. **Canvas Drawing:** A `requestAnimationFrame` loop paints the text progressively onto a hidden `<canvas>` element.
4. **Recording:** The `MediaRecorder` API captures the canvas stream (along with the audio track) and multiplexes them into a final video blob.

## 🧪 Local Test (Current Step 1)
```bash
npm install
npm run dev
```

Then open the shown localhost URL (usually `http://localhost:5173`).

## 📄 License
This project is open-source and released under the [MIT License](LICENSE).
