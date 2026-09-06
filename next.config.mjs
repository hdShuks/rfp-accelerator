/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // We run `tsc --noEmit` and `vitest` in CI/pre-push instead; keep the build lean.
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
