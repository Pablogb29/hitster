import React, { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { connectWS } from '../lib/ws';
import type { WSEvent } from '../lib/ws';
import type { TabletopRoom, HiddenCardState } from '../tabletop/types';

type TabletopState = {
  room: TabletopRoom | null;
  hiddenCard: HiddenCardState | null;
  wsConnected: boolean;
};

type TabletopAction = 
  | { type: "ROOM_INIT"; payload: TabletopRoom }
  | { type: "TURN_BEGIN"; payload: { turnId: string; currentPlayerId: string } }
  | { type: "TURN_PLAY"; payload: { turnId: string; playerId: string; song: any } }
  | { type: "TURN_PLACING"; payload: { turnId: string } }
  | { type: "TURN_RESULT"; payload: any }
  | { type: "GAME_FINISH"; payload: { winnerId: string } }
  | { type: "SET_WS_CONNECTED"; connected: boolean };

const createInitialState = (): TabletopState => ({
  room: null,
  hiddenCard: null,
  wsConnected: false,
});

const tabletopReducer = (state: TabletopState, action: TabletopAction): TabletopState => {
  switch (action.type) {
    case "ROOM_INIT":
      return { ...state, room: action.payload };
    case "TURN_BEGIN":
      return { ...state };
    case "TURN_PLAY": {
      const hiddenCard: HiddenCardState = {
        key: `hidden-${action.payload.turnId}`,
        playerId: action.payload.playerId,
        track: {
          trackId: action.payload.song.trackId,
          uri: action.payload.song.uri,
          release: action.payload.song.release,
        },
        stage: "incoming",
      };
      return { ...state, hiddenCard };
    }
    case "TURN_PLACING":
      return {
        ...state,
        hiddenCard: state.hiddenCard ? { ...state.hiddenCard, stage: "active" } : null,
      };
    case "TURN_RESULT": {
      return {
        ...state,
        hiddenCard: state.hiddenCard ? { 
          ...state.hiddenCard, 
          stage: action.payload.correct ? "revealing" : "failed" 
        } : null,
      };
    }
    case "GAME_FINISH":
      return { ...state, hiddenCard: null };
    case "SET_WS_CONNECTED":
      return { ...state, wsConnected: action.connected };
    default:
      return state;
  }
};

export default function Tabletop() {
  const [params] = useSearchParams();
  const roomCode = params.get("code") || "";
  const hostId = params.get("hostId") || "";
  const [state, dispatch] = React.useReducer(tabletopReducer, createInitialState());

  const handleWsEvent = React.useCallback((evt: WSEvent) => {
    console.log("[WS Tabletop]", evt.event, evt.data);
    switch (evt.event) {
      case "room:init":
        dispatch({ type: "ROOM_INIT", payload: evt.data as TabletopRoom });
        break;
      case "turn:begin":
        dispatch({ type: "TURN_BEGIN", payload: evt.data });
        break;
      case "turn:play":
        dispatch({ type: "TURN_PLAY", payload: evt.data });
        break;
      case "turn:placing":
        dispatch({ type: "TURN_PLACING", payload: evt.data });
        break;
      case "turn:result":
        dispatch({ type: "TURN_RESULT", payload: evt.data });
        break;
      case "game:finish":
        dispatch({ type: "GAME_FINISH", payload: evt.data });
        break;
      default:
        break;
    }
  }, []);

  // Initialize WebSocket connection
  React.useEffect(() => {
    if (!roomCode || !hostId) return;

    const conn = connectWS(roomCode, handleWsEvent);
    
    conn.ws.addEventListener("open", () => {
      dispatch({ type: "SET_WS_CONNECTED", connected: true });
      // Join as host
      conn.send("join", { id: hostId, name: "Host", is_host: true });
    });
    
    conn.ws.addEventListener("close", () => {
      dispatch({ type: "SET_WS_CONNECTED", connected: false });
    });

    return () => {
      conn.ws.close();
    };
  }, [roomCode, hostId, handleWsEvent]);

  const currentPlayer = useMemo(() => {
    if (!state.room?.turn) return null;
    return state.room?.players.find(p => p.id === state.room?.turn?.currentPlayerId);
  }, [state.room]);

  const winner = useMemo(() => {
    if (!state.room?.winnerId) return null;
    return state.room.players.find(p => p.id === state.room?.winnerId);
  }, [state.room]);

  if (!state.room) {
    return (
      <div className="min-h-screen bg-zinc-950 text-white flex items-center justify-center">
        <div className="text-center">
          <div className="text-2xl font-bold mb-4">Loading Tabletop...</div>
          <div className="text-zinc-400">Room: {roomCode}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-amber-100 to-amber-200 text-zinc-900">
      {/* Header */}
      <div className="absolute top-4 left-4 z-20">
        <div className="bg-white/90 backdrop-blur-sm rounded-lg px-4 py-2 shadow-lg">
          <div className="flex items-center gap-2">
            <div className="text-2xl">🎵</div>
            <div>
              <div className="font-bold text-lg">Hitster Tabletop</div>
              <div className="text-sm text-zinc-600">Room: {state.room.code}</div>
            </div>
          </div>
        </div>
      </div>

      {/* Connection Status */}
      {state.wsConnected && (
        <div className="absolute top-4 right-4 z-20">
          <div className="bg-emerald-500 text-white px-3 py-1 rounded-full text-sm font-medium">
            ● Connected
          </div>
        </div>
      )}

      {/* Game Table */}
      <div className="flex items-center justify-center min-h-screen p-8">
        <div className="relative w-[800px] h-[600px]">
          {/* Wooden Table Surface */}
          <div 
            className="absolute inset-0 rounded-full shadow-2xl"
            style={{
              background: `
                radial-gradient(ellipse at center, #8B4513 0%, #654321 50%, #4A2C17 100%),
                repeating-linear-gradient(
                  45deg,
                  transparent,
                  transparent 2px,
                  rgba(0,0,0,0.1) 2px,
                  rgba(0,0,0,0.1) 4px
                )
              `,
              border: '8px solid #654321',
              boxShadow: 'inset 0 0 50px rgba(0,0,0,0.3), 0 20px 40px rgba(0,0,0,0.4)'
            }}
          />

          {/* Players around the table */}
          {state.room.players.map((player, index) => {
            const isCurrentPlayer = currentPlayer?.id === player.id;
            const isWinner = winner?.id === player.id;
            const angle = (index * 360) / (state.room?.players.length || 1);
            const radius = 180;
            const x = Math.cos((angle - 90) * Math.PI / 180) * radius;
            const y = Math.sin((angle - 90) * Math.PI / 180) * radius;

            return (
              <div
                key={player.id}
                className="absolute transform -translate-x-1/2 -translate-y-1/2"
                style={{
                  left: `calc(50% + ${x}px)`,
                  top: `calc(50% + ${y}px)`,
                }}
              >
                {/* Player Name */}
                <div className="text-center mb-2">
                  <div className={`
                    inline-block px-3 py-1 rounded-full text-sm font-bold
                    ${isCurrentPlayer ? 'bg-emerald-500 text-white' : 'bg-white/80 text-zinc-800'}
                    ${isWinner ? 'ring-2 ring-yellow-400' : ''}
                    shadow-lg
                  `}>
                    {player.name}
                    {isCurrentPlayer && <span className="ml-1">⚡</span>}
                    {isWinner && <span className="ml-1">👑</span>}
                  </div>
                </div>

                {/* Player's Timeline Cards */}
                <div className="flex flex-col items-center space-y-1">
                  {player.timeline.slice(0, 5).map((card, cardIndex) => (
                    <div
                      key={`${card.trackId}-${cardIndex}`}
                      className="w-16 h-24 bg-white rounded-lg shadow-lg border-2 border-zinc-300 flex flex-col items-center justify-center p-1 transform hover:scale-105 transition-transform"
                      style={{
                        background: 'linear-gradient(135deg, #ffffff 0%, #f8f9fa 100%)',
                        boxShadow: '0 4px 8px rgba(0,0,0,0.2), inset 0 1px 0 rgba(255,255,255,0.8)'
                      }}
                      title={`${card.name} - ${card.artist}`}
                    >
                      <div className="text-xs font-bold text-zinc-800 text-center leading-tight">
                        {card.name?.split(' ').slice(0, 2).join(' ') || 'Card'}
                      </div>
                      <div className="text-xs text-zinc-600 mt-1">
                        {card.release?.date?.split('-')[0] || 'Year'}
                      </div>
                    </div>
                  ))}
                  {player.timeline.length > 5 && (
                    <div className="w-16 h-24 bg-zinc-300 rounded-lg shadow-lg border-2 border-zinc-400 flex items-center justify-center">
                      <div className="text-xs font-bold text-zinc-600">
                        +{player.timeline.length - 5}
                      </div>
                    </div>
                  )}
                </div>

                {/* Player Score */}
                <div className="text-center mt-2">
                  <div className="text-sm font-bold text-zinc-800">Score: {player.score}</div>
                </div>
              </div>
            );
          })}

          {/* Center of table - Hidden Card Display */}
          <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2">
            {state.hiddenCard && (
              <div className="relative">
                {/* Hidden Card */}
                <div 
                  className="w-20 h-32 rounded-lg shadow-2xl border-4 border-purple-500 flex flex-col items-center justify-center p-2 transform hover:scale-110 transition-transform"
                  style={{
                    background: 'linear-gradient(135deg, #8B5CF6 0%, #7C3AED 50%, #6D28D9 100%)',
                    boxShadow: '0 8px 16px rgba(139, 92, 246, 0.4), inset 0 1px 0 rgba(255,255,255,0.3)'
                  }}
                >
                  <div className="text-white text-center">
                    <div className="text-lg mb-1">🎵</div>
                    <div className="text-xs font-bold leading-tight">Hidden</div>
                    <div className="text-xs font-bold leading-tight">Card</div>
                    <div className="text-xs mt-1 opacity-90">
                      {state.hiddenCard.stage === "incoming" && "Ready"}
                      {state.hiddenCard.stage === "active" && "Playing"}
                      {state.hiddenCard.stage === "revealing" && "Revealing"}
                      {state.hiddenCard.stage === "failed" && "Failed"}
                    </div>
                  </div>
                </div>

                {/* Turn Indicator Arrow */}
                {currentPlayer && (
                  <div 
                    className="absolute -top-8 left-1/2 transform -translate-x-1/2 text-4xl animate-bounce"
                    style={{
                      filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.3))'
                    }}
                  >
                    ⬇️
                  </div>
                )}
              </div>
            )}

            {/* Game Status when no hidden card */}
            {!state.hiddenCard && (
              <div className="text-center">
                <div className="w-20 h-32 bg-zinc-200 rounded-lg shadow-lg border-2 border-zinc-400 flex flex-col items-center justify-center">
                  <div className="text-2xl mb-2">🎮</div>
                  <div className="text-xs font-bold text-zinc-600 text-center">
                    {state.room.status === "lobby" && "Waiting..."}
                    {state.room.status === "playing" && "Game On"}
                    {state.room.status === "result" && "Complete"}
                    {state.room.status === "finished" && "Finished"}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Table Edge Details */}
          <div className="absolute inset-0 rounded-full pointer-events-none">
            <div 
              className="absolute inset-2 rounded-full border-4 border-amber-800/30"
              style={{
                boxShadow: 'inset 0 0 20px rgba(0,0,0,0.2)'
              }}
            />
          </div>
        </div>
      </div>

      {/* Game Status Bar */}
      <div className="absolute bottom-4 left-1/2 transform -translate-x-1/2 z-20">
        <div className="bg-white/90 backdrop-blur-sm rounded-lg px-6 py-3 shadow-lg">
          <div className="text-center">
            {state.room.status === "playing" && currentPlayer && (
              <div className="text-lg font-bold text-zinc-800">
                It's <span className="text-emerald-600">{currentPlayer.name}</span>'s turn
              </div>
            )}
            {state.room.status === "finished" && winner && (
              <div className="text-lg font-bold text-zinc-800">
                🎉 <span className="text-yellow-600">{winner.name}</span> wins!
              </div>
            )}
            {state.room.status === "lobby" && (
              <div className="text-lg font-bold text-zinc-800">
                Waiting for players to join...
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
