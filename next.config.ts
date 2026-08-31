import { resolve } from "node:path";

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Feature worktrees share node_modules with sibling worktrees. The common
  // parent keeps both the project and the resolved dependency target inside
  // Turbopack's supported filesystem boundary.
  turbopack: {
    root: resolve(import.meta.dirname, ".."),
  },
};

export default nextConfig;
