import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Qonto transaction logos are served from arbitrary CDNs; allow remote images.
  images: {
    remotePatterns: [{ protocol: "https", hostname: "**" }],
  },
};

export default nextConfig;
