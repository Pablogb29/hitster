import { memo, useMemo } from "react";
import Card from "./Card";
import type {
  HiddenCardState,
  SeatSpec,
  TabletopPlayer,
  TurnPhase,
} from "./types";

type SeatProps = {
  player: TabletopPlayer;
  spec: SeatSpec;
  active: boolean;
  turnPhase: TurnPhase;
  hiddenCard: HiddenCardState | null;
};

const CARD_WIDTH = 140;
const CARD_HEIGHT = 190;
const CARD_GAP = 16;

const Seat = memo<SeatProps>(function Seat({ player, spec, active, turnPhase, hiddenCard }) {
  const timeline = player.timeline ?? [];
  const positions = useMemo(() => {
    if (!timeline.length) {
      return [];
    }
    const totalWidth = timeline.length * CARD_WIDTH + (timeline.length - 1) * CARD_GAP;
    const startX = -totalWidth / 2;
    return timeline.map((_, idx) => startX + idx * (CARD_WIDTH + CARD_GAP));
  }, [timeline]);

  const hiddenX = useMemo(() => {
    if (positions.length === 0) return -CARD_WIDTH / 2;
    const end = positions[positions.length - 1] + CARD_WIDTH + CARD_GAP;
    return end;
  }, [positions]);

  const hiddenStage = hiddenCard?.stage ?? null;

  return (
    <g transform={`translate(${spec.origin.x},${spec.origin.y})`}>
      <g transform={`rotate(${spec.rotation})`}>
        {active ? (
          <circle r={CARD_HEIGHT} fill="rgba(16,185,129,0.08)" />
        ) : null}
        <rect
          x={-500}
          y={-CARD_HEIGHT - 20}
          width={1000}
          height={CARD_HEIGHT + 40}
          rx={60}
          fill="rgba(15,23,42,0.35)"
          stroke="rgba(148,163,184,0.35)"
          strokeWidth={1}
        />
        {timeline.map((card, idx) => (
          <Card
            key={`${card.trackId}-${idx}`}
            variant="won"
            width={CARD_WIDTH}
            height={CARD_HEIGHT}
            x={positions[idx]}
            y={-CARD_HEIGHT / 2}
            release={card.release}
            coverUrl={card.coverUrl}
            name={card.name}
            glow={false}
          />
        ))}
        {hiddenCard && hiddenCard.playerId === player.id && hiddenStage ? (
          <Card
            key={hiddenCard.key}
            variant="hidden"
            width={CARD_WIDTH}
            height={CARD_HEIGHT}
            x={hiddenStage === "failed" ? hiddenX + spec.discardOffset.x : hiddenX}
            y={hiddenStage === "failed" ? -CARD_HEIGHT / 2 + spec.discardOffset.y : -CARD_HEIGHT / 2}
            stage={hiddenStage}
            glow={active && turnPhase !== "result"}
          />
        ) : null}
      </g>
      <g transform={`translate(${spec.labelOffset.x},${spec.labelOffset.y})`}>
        <text
          textAnchor="middle"
          fontSize={32}
          fontFamily="'Inter', sans-serif"
          fill={active ? "#34d399" : "#e2e8f0"}
        >
          {player.name}
        </text>
      </g>
      <g transform={`translate(${spec.scoreOffset.x},${spec.scoreOffset.y})`}>
        <rect x={-70} y={-28} width={140} height={56} rx={28} fill="rgba(15,23,42,0.8)" />
        <text
          x={0}
          y={8}
          textAnchor="middle"
          fontSize={28}
          fontFamily="'Inter', sans-serif"
          fill="#facc15"
        >
          ★ {player.score}
        </text>
      </g>
    </g>
  );
});

export default Seat;
