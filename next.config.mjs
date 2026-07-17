import { withWorkflow } from "workflow/next";

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Keep ffmpeg-static un-bundled so require() returns its real node_modules
  // path (webpack inlining breaks its __dirname-based path computation).
  // The GazeMeter stack stays external too: @vladmandic/human's node entry
  // requires @tensorflow/tfjs-node (not installed — the meter runs the pure
  // wasm backend), and bundling tfjs drags GLSL shader sources through
  // webpack. External = resolved from node_modules at runtime, like ffmpeg.
  serverExternalPackages: [
    "ffmpeg-static",
    "@vladmandic/human",
    "@tensorflow/tfjs",
    "@tensorflow/tfjs-backend-wasm",
    "sharp",
  ],
  // Ship the ffmpeg-static binary inside every API route and generated
  // Workflow step bundle. Vercel's standard runtime has no system ffmpeg.
  // The GazeMeter's runtime assets ride along: the three face models it
  // loads (blazeface, facemesh, iris) and the tfjs wasm binaries.
  outputFileTracingIncludes: {
    "/api/**/*": [
      "./node_modules/ffmpeg-static/ffmpeg*",
      "./node_modules/@vladmandic/human/models/blazeface*",
      "./node_modules/@vladmandic/human/models/facemesh*",
      "./node_modules/@vladmandic/human/models/iris*",
      "./node_modules/@tensorflow/tfjs-backend-wasm/dist/*.wasm",
    ],
    "/.well-known/workflow/**/*": [
      "./node_modules/ffmpeg-static/ffmpeg*",
      "./node_modules/@vladmandic/human/models/blazeface*",
      "./node_modules/@vladmandic/human/models/facemesh*",
      "./node_modules/@vladmandic/human/models/iris*",
      "./node_modules/@tensorflow/tfjs-backend-wasm/dist/*.wasm",
    ],
  },
  // Production is cloud-storage-only. Never package local grading history or
  // private media into serverless function traces.
  outputFileTracingExcludes: {
    "/api/**/*": ["./data/**/*"],
    "/.well-known/workflow/**/*": ["./data/**/*"],
  },
};

export default withWorkflow(nextConfig);
