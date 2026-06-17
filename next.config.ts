import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  assetPrefix: process.env.NEXT_PUBLIC_BASE_PATH ?? "",
};

export default nextConfig;
