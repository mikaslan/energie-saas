import { resolve } from "node:path";

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Feature worktrees share node_modules with sibling worktrees. The common
  // parent keeps both the project and the resolved dependency target inside
  // Turbopack's supported filesystem boundary.
  turbopack: {
    root: resolve(import.meta.dirname, ".."),
  },
  experimental: {
    // F7.4 pinnt seinen gueltigen Whole-Tree-Payload auf maximal 900.000
    // Bytes. Die verbleibende Marge gehoert Multipart-/Action-Metadaten.
    serverActions: { bodySizeLimit: "1mb" },
  },
};

export default nextConfig;
