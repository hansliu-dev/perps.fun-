import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep the dev badge out of the bottom-left corner, where activity popups appear.
  devIndicators: { position: "bottom-right" },
  /* config options here */
};

export default nextConfig;
