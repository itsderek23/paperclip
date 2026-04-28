import fs from "node:fs/promises";
import Anthropic from "@anthropic-ai/sdk";
import type { BBox } from "./types.ts";

const MODEL = "claude-opus-4-7";

export interface Region {
  bbox: BBox;
  caption: string;
  labelPosition?: "top" | "bottom" | "left" | "right" | "top-left" | "top-right" | "bottom-left" | "bottom-right";
  source: "llm-vision";
}

export interface AnnotatorContext {
  rawPngPath: string;
  htmlPath?: string;
  plannerBboxes: BBox[];
  stepDescription: string;
  planRationale: string;
  reviewObservation: string;
  prTitle: string;
  imageWidth: number;
  imageHeight: number;
}

export interface VisionResult {
  regions: Region[];
  rawJson: string;
  errorMessage?: string;
}

const VISION_SYSTEM = `You are a screenshot annotator helping a code reviewer notice the visual changes a PR introduces.

You see two screenshots: BEFORE (the PR base) and AFTER (the PR head), both at exactly ${1440}x${900} pixels. You also receive a plain-language observation of what visually changed (already produced by another reviewer LLM) and the step's stated goal.

Your job: pick the 1 to 3 regions of the AFTER screenshot that best illustrate the change a developer would skitch-mark for the reviewer. Output bounding boxes in pixel coordinates of the AFTER image, plus a short noun-phrase caption (4-10 words) per region.

Rules:
- bbox.x and bbox.y are top-left, in pixels (0 <= x, y; x+w <= 1440; y+h <= 900).
- Each region must point at a real, visible UI element in the AFTER image. Don't invent regions.
- Captions must be the change itself, not a description of the element. Good: "Descendant issue PAP-3 now visible". Bad: "Sub-issues panel".
- labelPosition is where the caption text should be drawn relative to the box. Pick the side with the most empty space.
- Skip regions that are unchanged between before and after.

Return ONLY valid JSON. No markdown fences, no commentary.

Schema:
{ "regions": [ { "bbox": {"x": int, "y": int, "w": int, "h": int}, "caption": "string", "labelPosition": "top|bottom|left|right|top-left|top-right|bottom-left|bottom-right" } ] }`;

async function readPngBase64(filePath: string): Promise<string> {
  const buf = await fs.readFile(filePath);
  return buf.toString("base64");
}

function userTextHeader(ctx: AnnotatorContext, label: "before" | "after"): string {
  if (label === "before") {
    return [
      `PR: ${ctx.prTitle}`,
      `Step: ${ctx.stepDescription}`,
      `Plan rationale: ${ctx.planRationale}`,
      `Review observation (vision-grounded summary of what visually changed): ${ctx.reviewObservation}`,
      `Image dimensions: ${ctx.imageWidth} x ${ctx.imageHeight}`,
      "",
      "BEFORE (PR base):",
    ].join("\n");
  }
  return "AFTER (PR head):";
}

function tryParseJson(text: string): { json: any; raw: string } {
  const trimmed = text.trim();
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  const slice = first >= 0 && last > first ? trimmed.slice(first, last + 1) : trimmed;
  return { json: JSON.parse(slice), raw: trimmed };
}

function clampBox(b: { x: number; y: number; w: number; h: number }, W: number, H: number): BBox {
  const x = Math.max(0, Math.min(W - 1, Math.round(b.x)));
  const y = Math.max(0, Math.min(H - 1, Math.round(b.y)));
  const w = Math.max(1, Math.min(W - x, Math.round(b.w)));
  const h = Math.max(1, Math.min(H - y, Math.round(b.h)));
  return { x, y, width: w, height: h };
}

export async function runVision(
  ctx: AnnotatorContext,
  beforeRawPath: string,
  options: { apiKey: string },
): Promise<VisionResult> {
  const client = new Anthropic({ apiKey: options.apiKey });
  const [beforeB64, afterB64] = await Promise.all([readPngBase64(beforeRawPath), readPngBase64(ctx.rawPngPath)]);
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 800,
    system: VISION_SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: userTextHeader(ctx, "before") },
          { type: "image", source: { type: "base64", media_type: "image/png", data: beforeB64 } },
          { type: "text", text: userTextHeader(ctx, "after") },
          { type: "image", source: { type: "base64", media_type: "image/png", data: afterB64 } },
        ],
      },
    ],
  });
  const text = resp.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
  try {
    const { json, raw } = tryParseJson(text);
    const regions: Region[] = (json.regions ?? []).map((r: any) => ({
      bbox: clampBox(r.bbox, ctx.imageWidth, ctx.imageHeight),
      caption: String(r.caption ?? "").trim(),
      labelPosition: r.labelPosition,
      source: "llm-vision",
    })).filter((r: Region) => r.caption.length > 0);
    return { regions, rawJson: raw };
  } catch (err) {
    return { regions: [], rawJson: text, errorMessage: (err as Error).message };
  }
}
