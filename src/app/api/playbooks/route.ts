import { NextResponse } from "next/server";
import { listPlaybooks } from "@/lib/playbooks/loader";

export const runtime = "nodejs";

export async function GET() {
  try {
    const playbooks = await listPlaybooks();
    return NextResponse.json({ playbooks });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load playbooks" },
      { status: 500 },
    );
  }
}
