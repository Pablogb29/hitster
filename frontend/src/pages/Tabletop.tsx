import React, { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { connectWS, WSEvent } from '../lib/ws';
import { TabletopRoom, PlayerState, HiddenCardState } from '../tabletop/types';

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
      const player = state.room?.players.find(p => p.id === action.payload.playerId);
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
    return state.room.players.find(p => p.id === state.room.turn.currentPlayerId);
  }, [state.room]);

  const winner = useMemo(() => {
    if (!state.room?.winnerId) return null;
    return state.room.players.find(p => p.id === state.room.winnerId);
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
    <div className="min-h-screen bg-gradient-to-br from-zinc-900 to-zinc-950 text-white p-4">
      {/* Header */}
      <div className="text-center mb-6">
        <h1 className="text-4xl font-bold mb-2">🎵 Hitster Tabletop</h1>
        <div className="text-lg text-zinc-400">Room: {state.room.code}</div>
        {state.wsConnected && (
          <div className="text-sm text-emerald-400 mt-1">● Connected</div>
        )}
      </div>

      {/* Game Table */}
      <div className="max-w-6xl mx-auto">
        <div className="relative bg-gradient-to-br from-amber-900/20 to-amber-800/30 rounded-3xl p-8 border-2 border-amber-600/30 shadow-2xl">
          {/* Table Surface Pattern */}
          <div className="absolute inset-0 rounded-3xl opacity-10">
            <div className="w-full h-full bg-gradient-to-br from-amber-200/20 to-amber-300/20 rounded-3xl" 
                 style={{
                   backgroundImage: 'radial-gradient(circle at 20% 20%, rgba(255,255,255,0.1) 1px, transparent 1px)',
                   backgroundSize: '30px 30px'
                 }} />
          </div>

          {/* Players around the table */}
          <div className="relative z-10">
            {state.room.players.map((player, index) => {
              const isCurrentPlayer = currentPlayer?.id === player.id;
              const isWinner = winner?.id === player.id;
              const angle = (index * 360) / state.room.players.length;
              const radius = 200;
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
                  {/* Player Seat */}
                  <div className={`
                    relative bg-gradient-to-br from-zinc-800 to-zinc-900 rounded-2xl p-4 border-2 shadow-lg
                    ${isCurrentPlayer ? 'border-emerald-400 shadow-emerald-400/20' : 'border-zinc-600'}
                    ${isWinner ? 'ring-4 ring-yellow-400/50' : ''}
                    transition-all duration-300
                  `}>
                    {/* Turn Indicator */}
                    {isCurrentPlayer && (
                      <div className="absolute -top-2 -right-2 w-6 h-6 bg-emerald-500 rounded-full flex items-center justify-center text-black font-bold text-sm animate-pulse">
                        ⚡
                      </div>
                    )}

                    {/* Winner Crown */}
                    {isWinner && (
                      <div className="absolute -top-4 left-1/2 transform -translate-x-1/2 text-2xl">
                        👑
                      </div>
                    )}

                    {/* Player Info */}
                    <div className="text-center">
                      <div className="font-bold text-lg mb-1">{player.name}</div>
                      <div className="text-sm text-zinc-400">Score: {player.score}</div>
                      <div className="text-xs text-zinc-500">Cards: {player.timeline.length}</div>
                    </div>

                    {/* Player's Timeline Cards */}
                    <div className="mt-3 space-y-1">
                      {player.timeline.slice(0, 3).map((card, cardIndex) => (
                        <div
                          key={`${card.trackId}-${cardIndex}`}
                          className="bg-zinc-700 rounded px-2 py-1 text-xs text-center truncate"
                          title={`${card.name} - ${card.artist}`}
                        >
                          {card.name}
                        </div>
                      ))}
                      {player.timeline.length > 3 && (
                        <div className="text-xs text-zinc-500 text-center">
                          +{player.timeline.length - 3} more
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}

            {/* Center of table - Hidden Card Display */}
            <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2">
              {state.hiddenCard && (
                <div className="bg-gradient-to-br from-purple-800 to-purple-900 rounded-2xl p-6 border-2 border-purple-400 shadow-lg">
                  <div className="text-center">
                    <div className="text-lg font-bold mb-2">🎵 Hidden Card</div>
                    <div className="text-sm text-purple-200">
                      {state.hiddenCard.stage === "incoming" && "Ready to play..."}
                      {state.hiddenCard.stage === "active" && "Currently playing..."}
                      {state.hiddenCard.stage === "revealing" && "Revealing..."}
                      {state.hiddenCard.stage === "failed" && "Incorrect placement"}
                    </div>
                    {state.hiddenCard.track && (
                      <div className="mt-2 text-xs text-purple-300">
                        {state.hiddenCard.track.release?.year || 'Unknown Year'}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Game Status */}
              {!state.hiddenCard && (
                <div className="text-center text-zinc-400">
                  <div className="text-lg">🎮</div>
                  <div className="text-sm">
                    {state.room.status === "lobby" && "Waiting for players..."}
                    {state.room.status === "playing" && "Game in progress"}
                    {state.room.status === "result" && "Turn complete"}
                    {state.room.status === "finished" && "Game finished"}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Game Info */}
        <div className="mt-6 text-center text-zinc-400">
          <div className="text-sm">
            {state.room.status === "playing" && currentPlayer && (
              <>It's <span className="text-emerald-400 font-semibold">{currentPlayer.name}</span>'s turn</>
            )}
            {state.room.status === "finished" && winner && (
              <>🎉 <span className="text-yellow-400 font-semibold">{winner.name}</span> wins!</>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
