import type { HiddenCardState, TabletopRoom } from "./types";

type Props = {
  room: TabletopRoom | null;
  hiddenCard: HiddenCardState | null;
};

const DebugHUD = ({ room, hiddenCard }: Props) => {
  return (
    <div className="pointer-events-none absolute bottom-4 left-4 rounded bg-zinc-900/80 px-4 py-3 text-xs text-zinc-300">
      <div>turnId: {room?.turn?.turnId ?? "-"}</div>
      <div>phase: {room?.turn?.phase ?? room?.status ?? "-"}</div>
      <div>active: {room?.turn?.currentPlayerId ?? "-"}</div>
      <div>
        hidden: {hiddenCard ? `${hiddenCard.playerId} (${hiddenCard.stage})` : "none"}
      </div>
    </div>
  );
};

export default DebugHUD;
