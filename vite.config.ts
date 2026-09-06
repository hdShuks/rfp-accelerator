import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The backend (Next.js app on the `main` branch, deployed to Vercel) is reached
// via VITE_API_BASE. In local dev, proxy /api to it so there's no CORS dance.
export default defineConfig(({ mode }) => {
  const apiBase = process.env.VITE_API_BASE || "http://localhost:3000";
  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: mode === "development" ? { "/api": { target: apiBase, changeOrigin: true } } : undefined,
    },
  };
});
