import sharp from "sharp";
import type { BBox } from "./types.ts";
import type { Region } from "./annotators.ts";

const ACCENT = "#4f46e5";
const CARD_BG = "#ffffff";
const CARD_TEXT = "#0f172a";
const CARD_FONT_SIZE = 16;
const CARD_PAD_X = 14;
const CARD_PIN_RADIUS = 13;
const SPOTLIGHT_DIM_OPACITY = 0.55;

interface LabelExtent {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface PinCardLayout {
  cardX: number;
  cardY: number;
  cardW: number;
  cardH: number;
  connector: { x1: number; y1: number; x2: number; y2: number };
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function approximateTextWidth(text: string, fontSizePx: number): number {
  return Math.ceil(text.length * fontSizePx * 0.58);
}

function bboxToExtent(b: BBox): LabelExtent {
  return { x: b.x, y: b.y, w: b.width, h: b.height };
}

function rectsOverlap(a: LabelExtent, b: LabelExtent): number {
  const dx = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const dy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return dx * dy;
}

function pickPinCardLayout(box: BBox, caption: string, W: number, H: number, placed: LabelExtent[]): PinCardLayout {
  const pinDiameter = CARD_PIN_RADIUS * 2 + 4;
  const textW = approximateTextWidth(caption, CARD_FONT_SIZE);
  const cardH = pinDiameter + 6;
  const cardW = pinDiameter + 8 + textW + CARD_PAD_X;
  const gap = 16;

  type Side = "right" | "left" | "bottom" | "top";
  const sides: Side[] = ["right", "bottom", "left", "top"];

  let best: { layout: PinCardLayout; overlap: number } | null = null;
  for (const side of sides) {
    const positions: { x: number; y: number; anchorEdge: Side }[] = [];
    if (side === "right") {
      const x = box.x + box.width + gap;
      const yCenter = box.y + box.height / 2;
      positions.push({ x, y: yCenter - cardH / 2, anchorEdge: side });
      positions.push({ x, y: box.y, anchorEdge: side });
      positions.push({ x, y: box.y + box.height - cardH, anchorEdge: side });
    } else if (side === "left") {
      const x = box.x - gap - cardW;
      const yCenter = box.y + box.height / 2;
      positions.push({ x, y: yCenter - cardH / 2, anchorEdge: side });
      positions.push({ x, y: box.y, anchorEdge: side });
      positions.push({ x, y: box.y + box.height - cardH, anchorEdge: side });
    } else if (side === "bottom") {
      const y = box.y + box.height + gap;
      const xCenter = box.x + box.width / 2;
      positions.push({ x: xCenter - cardW / 2, y, anchorEdge: side });
      positions.push({ x: box.x, y, anchorEdge: side });
      positions.push({ x: box.x + box.width - cardW, y, anchorEdge: side });
    } else {
      const y = box.y - gap - cardH;
      const xCenter = box.x + box.width / 2;
      positions.push({ x: xCenter - cardW / 2, y, anchorEdge: side });
      positions.push({ x: box.x, y, anchorEdge: side });
      positions.push({ x: box.x + box.width - cardW, y, anchorEdge: side });
    }

    for (const pos of positions) {
      if (pos.x < 0 || pos.y < 0 || pos.x + cardW > W || pos.y + cardH > H) continue;
      const ext: LabelExtent = { x: pos.x, y: pos.y, w: cardW, h: cardH };
      let overlap = 0;
      for (const p of placed) overlap += rectsOverlap(ext, p);
      let conn: PinCardLayout["connector"];
      const cx = pos.x + cardW / 2;
      const cy = pos.y + cardH / 2;
      const bx = box.x + box.width / 2;
      const by = box.y + box.height / 2;
      if (pos.anchorEdge === "right") conn = { x1: pos.x, y1: cy, x2: box.x + box.width, y2: by };
      else if (pos.anchorEdge === "left") conn = { x1: pos.x + cardW, y1: cy, x2: box.x, y2: by };
      else if (pos.anchorEdge === "bottom") conn = { x1: cx, y1: pos.y, x2: bx, y2: box.y + box.height };
      else conn = { x1: cx, y1: pos.y + cardH, x2: bx, y2: box.y };
      const layout: PinCardLayout = { cardX: pos.x, cardY: pos.y, cardW, cardH, connector: conn };
      if (best === null || overlap < best.overlap) best = { layout, overlap };
      if (overlap === 0) break;
    }
    if (best && best.overlap === 0) break;
  }
  if (!best) {
    const x = Math.max(0, Math.min(W - cardW, box.x + box.width + gap));
    const y = Math.max(0, Math.min(H - cardH, box.y + box.height / 2 - cardH / 2));
    best = {
      layout: {
        cardX: x,
        cardY: y,
        cardW,
        cardH,
        connector: { x1: x, y1: y + cardH / 2, x2: box.x + box.width, y2: box.y + box.height / 2 },
      },
      overlap: 0,
    };
  }
  return best.layout;
}

function pinCardCropExtent(layout: PinCardLayout): LabelExtent {
  return { x: layout.cardX, y: layout.cardY, w: layout.cardW, h: layout.cardH };
}

function layoutPinCards(regions: Region[], W: number, H: number): PinCardLayout[] {
  const placed: LabelExtent[] = regions.map((r) => bboxToExtent(r.bbox));
  const out: PinCardLayout[] = [];
  for (const region of regions) {
    const layout = pickPinCardLayout(region.bbox, region.caption, W, H, placed);
    out.push(layout);
    placed.push(pinCardCropExtent(layout));
  }
  return out;
}

function shadowFilterDef(): string {
  return `<defs><filter id="cardshadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="3" stdDeviation="4" flood-color="black" flood-opacity="0.15"/></filter></defs>`;
}

function renderPinCard(box: BBox, layout: PinCardLayout, caption: string, idx: number, offsetX: number, offsetY: number): string {
  const captionEsc = escapeXml(caption);
  const pinD = CARD_PIN_RADIUS * 2 + 4;
  const pinCx = layout.cardX - offsetX + pinD / 2 + 2;
  const pinCy = layout.cardY - offsetY + layout.cardH / 2;
  const textX = layout.cardX - offsetX + pinD + 8;
  const textY = layout.cardY - offsetY + layout.cardH / 2 + CARD_FONT_SIZE / 2 - 4;
  const cardX = layout.cardX - offsetX;
  const cardY = layout.cardY - offsetY;
  const conn = layout.connector;
  return [
    `<line x1="${conn.x1 - offsetX}" y1="${conn.y1 - offsetY}" x2="${conn.x2 - offsetX}" y2="${conn.y2 - offsetY}" stroke="${ACCENT}" stroke-width="1.5" stroke-opacity="0.6"/>`,
    `<rect x="${cardX}" y="${cardY}" width="${layout.cardW}" height="${layout.cardH}" rx="${layout.cardH / 2}" fill="${CARD_BG}" stroke="${ACCENT}" stroke-width="1.5" filter="url(#cardshadow)"/>`,
    `<circle cx="${pinCx}" cy="${pinCy}" r="${CARD_PIN_RADIUS}" fill="${ACCENT}"/>`,
    `<text x="${pinCx}" y="${pinCy + 5}" font-family="Helvetica, Arial, -apple-system, system-ui, sans-serif" font-size="14" font-weight="700" fill="white" text-anchor="middle">${idx + 1}</text>`,
    `<text x="${textX}" y="${textY}" font-family="Helvetica, Arial, -apple-system, system-ui, sans-serif" font-size="${CARD_FONT_SIZE}" font-weight="500" fill="${CARD_TEXT}">${captionEsc}</text>`,
    `<rect x="${box.x - offsetX - 2}" y="${box.y - offsetY - 2}" width="${box.width + 4}" height="${box.height + 4}" fill="none" stroke="${ACCENT}" stroke-width="2" stroke-opacity="0.7" rx="4"/>`,
  ].join("");
}

export async function renderPinCardSpotlightCropped(rawPath: string, regions: Region[], outPath: string, W: number, H: number): Promise<void> {
  if (regions.length === 0) {
    await sharp(rawPath).toFile(outPath);
    return;
  }
  const layouts = layoutPinCards(regions, W, H);
  const extents = layouts.map(pinCardCropExtent);
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const r of regions) {
    x1 = Math.min(x1, r.bbox.x);
    y1 = Math.min(y1, r.bbox.y);
    x2 = Math.max(x2, r.bbox.x + r.bbox.width);
    y2 = Math.max(y2, r.bbox.y + r.bbox.height);
  }
  for (const e of extents) {
    x1 = Math.min(x1, e.x);
    y1 = Math.min(y1, e.y);
    x2 = Math.max(x2, e.x + e.w);
    y2 = Math.max(y2, e.y + e.h);
  }
  const PAD = 32;
  const left = Math.max(0, Math.round(x1 - PAD));
  const top = Math.max(0, Math.round(y1 - PAD));
  const right = Math.min(W, Math.round(x2 + PAD));
  const bottom = Math.min(H, Math.round(y2 + PAD));
  const cropW = Math.max(1, right - left);
  const cropH = Math.max(1, bottom - top);

  const holes = regions
    .map((r) => `M ${r.bbox.x - left} ${r.bbox.y - top} h ${r.bbox.width} v ${r.bbox.height} h ${-r.bbox.width} Z`)
    .join(" ");
  const dimPath = `M 0 0 H ${cropW} V ${cropH} H 0 Z ${holes}`;

  const cards = regions.map((r, i) => renderPinCard(r.bbox, layouts[i], r.caption, i, left, top)).join("");

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${cropW}" height="${cropH}">
    ${shadowFilterDef()}
    <path d="${dimPath}" fill="black" fill-opacity="${SPOTLIGHT_DIM_OPACITY}" fill-rule="evenodd"/>
    ${cards}
  </svg>`;
  await sharp(rawPath)
    .extract({ left, top, width: cropW, height: cropH })
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .toFile(outPath);
}
