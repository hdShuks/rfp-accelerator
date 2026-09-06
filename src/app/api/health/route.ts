import { NextResponse } from "next/server";
import { describeLlmAvailability } from "@/lib/llm/anthropic";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Tells the UI how Claude can be reached without a user-pasted key. */
export async function GET() {
  const llm = describeLlmAvailability();
  return NextResponse.json({
    llm: {
      // a run can proceed with no user key if either of these is true
      apiKeyFromEnv: llm.apiKeyEnv,
      localSubscription: llm.subscription,
      needsUserKey: !llm.apiKeyEnv && !llm.subscription,
    },
    maxRunUsd: Number(process.env.MAX_RUN_USD) || 0.5,
  });
}
