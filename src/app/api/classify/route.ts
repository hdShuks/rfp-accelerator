import { NextResponse } from "next/server";
import { resolveApiKey, MissingApiKeyError } from "@/lib/llm/anthropic";
import { classify } from "@/lib/orchestrator/classifier";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: { description?: string; proposalType?: string; clientName?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const apiKey = resolveApiKey(req.headers.get("x-anthropic-key"));
    const classification = await classify(
      {
        clientName: body.clientName ?? "",
        description: body.description ?? "",
        proposalType: body.proposalType,
      },
      apiKey,
    );
    return NextResponse.json(classification);
  } catch (err) {
    const status = err instanceof MissingApiKeyError ? 401 : 500;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Classification failed" },
      { status },
    );
  }
}
