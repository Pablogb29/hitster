import { memo } from "react";
import type { HiddenCardState, TabletopProps } from "./types";
import { computeSeats, VIEWBOX } from "./layout";
import Seat from "./Seat";
import DebugHUD from "./DebugHUD";

const Tabletop = memo<TabletopProps>(function Tabletop({ room, hiddenCard, statusMessage, discardCount, debug }) {
  const players = room?.players ?? [];
  const seats = computeSeats(players);
  const activeId = room?.turn?.currentPlayerId ?? null;
  const turnPhase = room?.turn?.phase ?? null;
  const discardTotal = discardCount ?? room?.deck?.discard?.length ?? 0;

  const hiddenForSeat = (playerId: string): HiddenCardState | null => {
    if (!hiddenCard || hiddenCard.playerId !== playerId) return null;
    return hiddenCard;
  };

  return (
    <div className="relative h-full w-full">
      <svg
        className="h-full w-full"
        viewBox={`0 0 ${VIEWBOX.width} ${VIEWBOX.height}`}
        preserveAspectRatio="xMidYMid meet"
      >
        <defs>
          <clipPath id="card-round-clip">
            <rect x={0} y={0} width={140} height={190} rx={16} ry={16} />
          </clipPath>
          <linearGradient id="card-generic-fill" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#22d3ee" stopOpacity={0.45} />
            <stop offset="100%" stopColor="#6366f1" stopOpacity={0.45} />
          </linearGradient>
          <pattern id="card-back-pattern" width="12" height="12" patternUnits="userSpaceOnUse">
            <rect width="12" height="12" fill="#1e293b" />
            <path d="M0 12 L12 0" stroke="#64748b" strokeWidth="2" strokeOpacity="0.4" />
            <path d="M-3 9 L3 15" stroke="#334155" strokeWidth="2" strokeOpacity="0.5" />
          </pattern>
        </defs>

        <rect width="100%" height="100%" fill="url(#table-background)" opacity={0.0} />
        <radialGradient id="table-center-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="rgba(15,118,110,0.35)" />
          <stop offset="100%" stopColor="rgba(15,118,110,0)" />
        </radialGradient>
        <circle
          cx={VIEWBOX.width / 2}
          cy={VIEWBOX.height / 2}
          r={340}
          fill="url(#table-center-glow)"
        />

        <rect
          x={360}
          y={240}
          width={VIEWBOX.width - 720}
          height={VIEWBOX.height - 480}
          rx={220}
          ry={220}
          fill="rgba(15,23,42,0.65)"
          stroke="rgba(148,163,184,0.18)"
          strokeWidth={4}
        />

        <text
          x={VIEWBOX.width / 2}
          y={140}
          textAnchor="middle"
          fontFamily="'Inter', sans-serif"
          fontSize={48}
          fill="#e2e8f0"
        >
          Room {room?.code ?? "----"}
        </text>
        <text
          x={VIEWBOX.width / 2}
          y={200}
          textAnchor="middle"
          fontFamily="'Inter', sans-serif"
          fontSize={24}
          fill="rgba(226,232,240,0.6)"
        >
          {statusMessage ?? ""}
        </text>

        {seats.map((spec) => {
          const player = players.find((p) => p.id === spec.playerId);
          if (!player) return null;
          return (
            <Seat
              key={player.id}
              player={player}
              spec={spec}
              active={activeId === player.id}
              turnPhase={turnPhase}
              hiddenCard={hiddenForSeat(player.id)}
            />
          );
        })}

        <g transform={`translate(${VIEWBOX.width - 200}, ${VIEWBOX.height - 160})`}>
          <rect width={160} height={120} rx={24} fill="rgba(30,41,59,0.7)" />
          <text x={80} y={42} textAnchor="middle" fontSize={20} fill="#94a3b8" fontFamily="'Inter', sans-serif">
            Discard
          </text>
          <text x={80} y={78} textAnchor="middle" fontSize={36} fill="#f87171" fontFamily="'Inter', sans-serif">
            {discardTotal}
          </text>
        </g>
      </svg>
      {debug ? <DebugHUD room={room} hiddenCard={hiddenCard} /> : null}
    </div>
  );
});

export default Tabletop;
