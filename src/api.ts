// In production, VITE_API_BASE points at the deployed backend (the Next.js app
// on the `main` branch). In dev, it's proxied through Vite (see vite.config.ts)
// so this can stay a relative path.
export const API_BASE = import.meta.env.VITE_API_BASE?.replace(/\/$/, "") ?? "";

export function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}
