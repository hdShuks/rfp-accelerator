import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * CORS for /api/* so a separately-hosted frontend (e.g. a Lovable UI) can call
 * this backend. Set ALLOWED_ORIGIN to lock it down; defaults to "*" for the
 * open demo. The API is BYO-key and has a hard cost ceiling, so "*" is
 * acceptable for a private toolkit — tighten it for anything real.
 */
const ALLOW_ORIGIN = process.env.ALLOWED_ORIGIN || "*";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": ALLOW_ORIGIN,
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-anthropic-key",
  "Access-Control-Max-Age": "86400",
};

export function middleware(req: NextRequest) {
  if (req.method === "OPTIONS") {
    return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
  }
  const res = NextResponse.next();
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.headers.set(k, v);
  return res;
}

export const config = { matcher: "/api/:path*" };
