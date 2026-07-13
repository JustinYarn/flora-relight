/**
 * Diagnostic: one micro Gemini call (~$0.0001) that surfaces the RAW upstream
 * error the sanitized live routes hide. Gate-protected. Reveals key LENGTH
 * only, never the value.
 */

import { NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const key = process.env.GEMINI_API_KEY ?? "";
  const report: Record<string, unknown> = {
    keyPresent: key.length > 0,
    keyLength: key.length,
    keyHasWhitespace: /\s/.test(key),
  };
  try {
    const ai = new GoogleGenAI({ apiKey: key });
    const r = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: "Reply with exactly: OK",
    });
    report.call = "SUCCESS";
    report.reply = String(r.text ?? "").slice(0, 20);
  } catch (err) {
    report.call = "FAILED";
    report.error = (err instanceof Error ? err.message : String(err)).slice(0, 400);
  }
  return NextResponse.json(report);
}
