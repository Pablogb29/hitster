export type Release = {
  date: string;
  precision: "year" | "month" | "day";
};

export type TrackCard = {
  trackId: string;
  uri: string;
  name?: string;
  artist?: string;
  album?: string;
  coverUrl?: string;
  release: Release;
};

export type TabletopPlayer = {
  id: string;
  name: string;
  score: number;
  timeline: TrackCard[];
};

export type TurnPhase = "playing" | "placing" | "result" | "finished" | null;

export type TabletopTurn = {
  turnId: string;
  currentPlayerId: string;
  phase: "playing" | "placing" | "result";
  drawn: TrackCard | null;
} | null;

export type TabletopRoom = {
  code: string;
  status: "lobby" | "playing" | "placing" | "result" | "finished";
  tiePolicy: "strict" | "lenient";
  winnerId: string | null;
  players: TabletopPlayer[];
  turn: TabletopTurn;
  deck?: {
    playlistId: string | null;
    used: string[];
    discard: string[];
    remaining: number;
  };
};

export type SeatAnchor =
  | "top"
  | "bottom"
  | "left"
  | "right"
  | "topLeft"
  | "topRight"
  | "bottomLeft"
  | "bottomRight";

export type SeatSpec = {
  playerId: string;
  anchor: SeatAnchor;
  origin: { x: number; y: number };
  rotation: number;
  labelOffset: { x: number; y: number };
  scoreOffset: { x: number; y: number };
  discardOffset: { x: number; y: number };
};

export type HiddenCardStage = "incoming" | "active" | "revealing" | "failed";

export type HiddenCardState = {
  key: string;
  playerId: string;
  track: TrackCard;
  stage: HiddenCardStage;
};

export type TabletopProps = {
  room: TabletopRoom | null;
  hiddenCard: HiddenCardState | null;
  statusMessage?: string;
  discardCount?: number;
  debug?: boolean;
};
