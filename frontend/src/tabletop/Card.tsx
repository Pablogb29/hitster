import { memo, useEffect, useState } from "react";
import type { Release } from "./types";

type CardStage = "incoming" | "active" | "revealing" | "failed";

type CardProps = {
  width: number;
  height: number;
  x: number;
  y: number;
  variant: "won" | "hidden";
  release?: Release;
  coverUrl?: string;
  name?: string;
  stage?: CardStage;
  glow?: boolean;
};

const formatYear = (release?: Release) => {
  if (!release?.date) return "";
  return release.date.slice(0, 4);
};

const Card = memo<CardProps>(function Card({
  width,
  height,
  x,
  y,
  variant,
  release,
  coverUrl,
  name,
  stage = "active",
  glow,
}) {
  const [displayStage, setDisplayStage] = useState<CardStage>(stage);
  useEffect(() => {
    setDisplayStage(stage);
  }, [stage]);

  const year = formatYear(release);
  const scale = displayStage === "incoming" ? 0.6 : displayStage === "revealing" ? 0.2 : 1;
  const opacity = displayStage === "failed" || displayStage === "revealing" ? 0.0 : 1;
  const tx = x;
  const ty = y;

  return (
    <g
      style={{
        transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
        transformOrigin: "center",
        opacity,
        transition: "transform 400ms ease, opacity 400ms ease",
      }}
    >
      <rect
        width={width}
        height={height}
        rx={16}
        ry={16}
        fill={variant === "won" ? "#1f2937" : "url(#card-back-pattern)"}
        stroke={glow ? "#a7f3d0" : "#475569"}
        strokeWidth={glow ? 4 : 2}
        opacity={variant === "hidden" ? 0.85 : 1}
      />
      {variant === "won" ? (
        <>
          {coverUrl ? (
            <image
              href={coverUrl}
              width={width}
              height={height}
              clipPath="url(#card-round-clip)"
              preserveAspectRatio="xMidYMid slice"
            />
          ) : (
            <rect
              width={width}
              height={height}
              rx={16}
              ry={16}
              fill="url(#card-generic-fill)"
              opacity={0.8}
            />
          )}
          <rect
            x={8}
            y={8}
            width={48}
            height={28}
            rx={6}
            fill="rgba(15,23,42,0.85)"
          />
          <text x={32} y={28} textAnchor="middle" fontSize={14} fill="#f8fafc" fontFamily="'Inter', sans-serif">
            {year}
          </text>
        </>
      ) : (
        <>
          <rect
            x={width / 2 - 28}
            y={height / 2 - 28}
            width={56}
            height={56}
            rx={12}
            fill="rgba(148,163,184,0.15)"
            stroke="rgba(148,163,184,0.45)"
            strokeWidth={2}
          />
          <text
            x={width / 2}
            y={height / 2 + 6}
            textAnchor="middle"
            fontSize={28}
            fill="rgba(226,232,240,0.8)"
            fontFamily="'Inter', sans-serif"
          >
            ?
          </text>
        </>
      )}
      {variant === "won" && name ? (
        <text
          x={width / 2}
          y={height - 16}
          textAnchor="middle"
          fontSize={14}
          fill="rgba(15,23,42,0.95)"
          fontFamily="'Inter', sans-serif"
          fontWeight={600}
        >
          {name}
        </text>
      ) : null}
    </g>
  );
});

export default Card;
