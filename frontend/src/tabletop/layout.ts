import type { SeatAnchor, SeatSpec, TabletopPlayer } from "./types";

const VIEW_W = 1920;
const VIEW_H = 1080;

const anchorOrders: Record<number, SeatAnchor[]> = {
  1: ["bottom"],
  2: ["bottom", "top"],
  3: ["bottom", "left", "right"],
  4: ["bottom", "right", "top", "left"],
  5: ["bottom", "bottomRight", "top", "bottomLeft", "right"],
  6: ["bottom", "bottomRight", "topRight", "top", "topLeft", "bottomLeft"],
};

const anchorConfig: Record<SeatAnchor, Omit<SeatSpec, "playerId">> = {
  bottom: {
    anchor: "bottom",
    origin: { x: VIEW_W / 2, y: VIEW_H - 180 },
    rotation: 0,
    labelOffset: { x: 0, y: 120 },
    scoreOffset: { x: 0, y: 160 },
    discardOffset: { x: -320, y: -240 },
  },
  top: {
    anchor: "top",
    origin: { x: VIEW_W / 2, y: 180 },
    rotation: 180,
    labelOffset: { x: 0, y: 120 },
    scoreOffset: { x: 0, y: 160 },
    discardOffset: { x: 320, y: -240 },
  },
  left: {
    anchor: "left",
    origin: { x: 240, y: VIEW_H / 2 },
    rotation: 90,
    labelOffset: { x: 0, y: 120 },
    scoreOffset: { x: 0, y: 160 },
    discardOffset: { x: -200, y: -240 },
  },
  right: {
    anchor: "right",
    origin: { x: VIEW_W - 240, y: VIEW_H / 2 },
    rotation: -90,
    labelOffset: { x: 0, y: 120 },
    scoreOffset: { x: 0, y: 160 },
    discardOffset: { x: 200, y: -240 },
  },
  topLeft: {
    anchor: "topLeft",
    origin: { x: 420, y: 260 },
    rotation: 135,
    labelOffset: { x: 0, y: 120 },
    scoreOffset: { x: 0, y: 160 },
    discardOffset: { x: 180, y: -180 },
  },
  topRight: {
    anchor: "topRight",
    origin: { x: VIEW_W - 420, y: 260 },
    rotation: -135,
    labelOffset: { x: 0, y: 120 },
    scoreOffset: { x: 0, y: 160 },
    discardOffset: { x: -180, y: -180 },
  },
  bottomLeft: {
    anchor: "bottomLeft",
    origin: { x: 420, y: VIEW_H - 260 },
    rotation: 45,
    labelOffset: { x: 0, y: 120 },
    scoreOffset: { x: 0, y: 160 },
    discardOffset: { x: -220, y: -200 },
  },
  bottomRight: {
    anchor: "bottomRight",
    origin: { x: VIEW_W - 420, y: VIEW_H - 260 },
    rotation: -45,
    labelOffset: { x: 0, y: 120 },
    scoreOffset: { x: 0, y: 160 },
    discardOffset: { x: 220, y: -200 },
  },
};

export const VIEWBOX = { width: VIEW_W, height: VIEW_H };

export function computeSeats(players: TabletopPlayer[]): SeatSpec[] {
  if (!players.length) return [];
  const order = anchorOrders[Math.min(players.length, 6)] ?? anchorOrders[6];
  const seatSpecs: SeatSpec[] = [];
  const sorted = [...players].sort((a, b) => {
    const seatA = (a as any).seat ?? 0;
    const seatB = (b as any).seat ?? 0;
    if (seatA !== seatB) return seatA - seatB;
    return a.name.localeCompare(b.name);
  });
  sorted.forEach((player, idx) => {
    const anchor = order[idx % order.length];
    const cfg = anchorConfig[anchor];
    seatSpecs.push({
      playerId: player.id,
      anchor: cfg.anchor,
      origin: { ...cfg.origin },
      rotation: cfg.rotation,
      labelOffset: { ...cfg.labelOffset },
      scoreOffset: { ...cfg.scoreOffset },
      discardOffset: { ...cfg.discardOffset },
    });
  });
  return seatSpecs;
}
