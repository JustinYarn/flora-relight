import { withWorkflow } from "workflow/next";

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Keep ffmpeg-static un-bundled so require() returns its real node_modules
  // path (webpack inlining breaks its __dirname-based path computation).
  serverExternalPackages: ["ffmpeg-static"],
  // Ship the ffmpeg-static binary inside every API route and generated
  // Workflow step bundle. Vercel's standard runtime has no system ffmpeg.
  outputFileTracingIncludes: {
    "/api/**/*": ["./node_modules/ffmpeg-static/ffmpeg*"],
    "/.well-known/workflow/**/*": ["./node_modules/ffmpeg-static/ffmpeg*"],
  },
  // Production is cloud-storage-only. Never package local grading history or
  // private media into serverless function traces.
  outputFileTracingExcludes: {
    "/api/**/*": ["./data/**/*"],
    "/.well-known/workflow/**/*": ["./data/**/*"],
  },
};

export default withWorkflow(nextConfig);
