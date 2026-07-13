/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // Keep ffmpeg-static un-bundled so require() returns its real node_modules
    // path (webpack inlining breaks its __dirname-based path computation).
    serverComponentsExternalPackages: ["ffmpeg-static"],
    // Ship the ffmpeg-static binary inside every API route's serverless
    // bundle on Vercel — the standard runtime has no system ffmpeg, and all
    // media routes (ingest/finalize/videogen/export) shell out to it.
    outputFileTracingIncludes: {
      "/api/**/*": ["./node_modules/ffmpeg-static/ffmpeg*"],
    },
  },
};

export default nextConfig;
