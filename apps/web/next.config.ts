import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // agent-core is a workspace package shipped as TypeScript source.
  transpilePackages: ["agent-core"],
  // No Next.js dev-tools badge over the board (config-shared.d.ts: devIndicators?: false | {...}).
  devIndicators: false,
};

export default nextConfig;
