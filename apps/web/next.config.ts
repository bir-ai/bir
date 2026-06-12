import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  reactStrictMode: true,
  // The image optimizer needs a server; the exported dashboard has none.
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
