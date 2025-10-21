import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { connectWS, type WSEvent } from "../lib/ws";
import Tabletop from "../tabletop/Tabletop";
import type { HiddenCardState, TabletopRoom } from "../tabletop/types";

type HostState = {
  roomCode: string;
  hostId: string;
  room: TabletopRoom | null;
  hiddenCard: HiddenCardState | null;
  statusMessage: string;
  wsConnected: boolean;
  debug: boolean;
};

type HostAction =
  | { type: "SET_ROOM_CODE"; code: string }
  | { type: "SET_HOST_ID"; hostId: string }
  | { type: "ROOM_INIT"; payload: TabletopRoom }
  | { type: "TURN_BEGIN"; payload: { turnId: string; currentPlayerId: string } }
  | { type: "TURN_PLAY"; payload: { turnId: string; playerId: string; song: any } }
  | { type: "TURN_PLACING"; payload: { turnId: string } }
  | { type: "TURN_RESULT"; payload: { turnId: string; playerId: string; correct: boolean; newScore?: number; finalIndex?: number; placedTrack?: any } }
  | { type: "GAME_FINISH"; payload: { winnerId: string } }
  | { type: "SET_STATUS"; status: string }
  | { type: "SET_WS_CONNECTED"; connected: boolean }
  | { type: "SET_DEBUG"; debug: boolean };

const createInitialHostState = (): HostState => ({
  roomCode: "",
  hostId: "",
  room: null,
  hiddenCard: null,
  statusMessage: "Connecting...",
  wsConnected: false,
  debug: false,
});

const hostReducer = (state: HostState, action: HostAction): HostState => {
  switch (action.type) {
    case "SET_ROOM_CODE":
      return { ...state, roomCode: action.code };
    case "SET_HOST_ID":
      return { ...state, hostId: action.hostId };
    case "ROOM_INIT": {
      const room = action.payload;
      return {
        ...state,
        room,
        statusMessage: `Room ${room.code} - ${room.players.length} players`,
      };
    }
    case "TURN_BEGIN": {
      const currentPlayer = state.room?.players.find(p => p.id === action.payload.currentPlayerId);
      return {
        ...state,
        statusMessage: currentPlayer ? `${currentPlayer.name}'s turn` : "New turn",
      };
    }
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
      return {
        ...state,
        hiddenCard,
        statusMessage: "Hidden card ready",
      };
    }
    case "TURN_PLACING": {
      return {
        ...state,
        hiddenCard: state.hiddenCard ? { ...state.hiddenCard, stage: "active" } : null,
        statusMessage: "Player is placing card",
      };
    }
    case "TURN_RESULT": {
      const player = state.room?.players.find(p => p.id === action.payload.playerId);
      const message = action.payload.correct 
        ? `${player?.name || "Player"} placed correctly!` 
        : `${player?.name || "Player"} placed incorrectly.`;
      
      return {
        ...state,
        hiddenCard: state.hiddenCard ? { ...state.hiddenCard, stage: action.payload.correct ? "revealing" : "failed" } : null,
        statusMessage: message,
      };
    }
    case "GAME_FINISH": {
      const winner = state.room?.players.find(p => p.id === action.payload.winnerId);
      return {
        ...state,
        statusMessage: winner ? `Game Over! ${winner.name} wins!` : "Game Over!",
      };
    }
    case "SET_STATUS":
      return { ...state, statusMessage: action.status };
    case "SET_WS_CONNECTED":
      return { ...state, wsConnected: action.connected };
    case "SET_DEBUG":
      return { ...state, debug: action.debug };
    default:
      return state;
  }
};

const API_BASE = ((import.meta as any).env?.VITE_BACKEND_URL || `${window.location.protocol}//${window.location.host}`)
  .replace(/\/+$/, "")
  .replace(/\/api$/, "");

export default function Host() {
  const [params] = useSearchParams();
  const roomCode = params.get("code") || "";
  const hostId = params.get("hostId") || "";
  const [state, dispatch] = useReducer(hostReducer, createInitialHostState());
  const connRef = useRef<ReturnType<typeof connectWS> | null>(null);

  const handleWsEvent = useCallback((evt: WSEvent) => {
    console.log("[WS Host]", evt.event, evt.data);
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
      case "game:error":
        dispatch({ type: "SET_STATUS", status: `Error: ${evt.data.message}` });
        break;
      default:
        break;
    }
  }, []);

  // Initialize WebSocket connection
  useEffect(() => {
    if (!roomCode || !hostId) return;

    dispatch({ type: "SET_ROOM_CODE", code: roomCode });
    dispatch({ type: "SET_HOST_ID", hostId });

    const conn = connectWS(roomCode, handleWsEvent);
    connRef.current = conn;
    
    conn.ws.addEventListener("open", () => {
      dispatch({ type: "SET_WS_CONNECTED", connected: true });
      dispatch({ type: "SET_STATUS", status: "Connected to room" });
      // Join as host
      conn.send("join", { id: hostId, name: "Host", is_host: true });
    });
    
    conn.ws.addEventListener("close", () => {
      dispatch({ type: "SET_WS_CONNECTED", connected: false });
      dispatch({ type: "SET_STATUS", status: "Disconnected from room" });
    });

    return () => {
      if (connRef.current?.ws) {
        connRef.current.ws.close();
      }
    };
  }, [roomCode, hostId, handleWsEvent]);

  const handleNextTurn = useCallback(async () => {
    if (!state.roomCode) return;
    
    try {
      const resp = await fetch(`${API_BASE}/api/turn/next`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ roomCode: state.roomCode }),
      });
      
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        dispatch({ type: "SET_STATUS", status: `Next turn failed: ${resp.status} ${text}` });
      } else {
        dispatch({ type: "SET_STATUS", status: "Next turn requested" });
      }
    } catch (err: any) {
      dispatch({ type: "SET_STATUS", status: `Next turn error: ${err.message}` });
    }
  }, [state.roomCode]);

  const toggleDebug = useCallback(() => {
    dispatch({ type: "SET_DEBUG", debug: !state.debug });
  }, [state.debug]);

  const canStartNextTurn = useMemo(() => {
    return state.room?.status === "result" && state.room?.turn?.phase === "result";
  }, [state.room]);

  if (!roomCode || !hostId) {
    return (
      <div className="min-h-screen bg-zinc-950 text-white flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-red-400 mb-4">Invalid Host Access</h1>
          <p className="text-zinc-400">Missing room code or host ID</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen bg-zinc-950 text-white flex flex-col">
      {/* Header */}
      <div className="bg-zinc-900/70 border-b border-zinc-800 p-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-emerald-400">HITSTER Tabletop</h1>
            <div className="text-sm text-zinc-400">
              Room: {state.roomCode} | Host: {state.hostId}
            </div>
          </div>
          <div className="flex items-center gap-4">
            <div className={`px-3 py-1 rounded-full text-sm font-medium ${
              state.wsConnected ? 'bg-emerald-500/20 text-emerald-400' : 'bg-yellow-500/20 text-yellow-400'
            }`}>
              {state.wsConnected ? 'Connected' : 'Disconnected'}
            </div>
            <button
              onClick={toggleDebug}
              className={`px-3 py-1 rounded text-sm font-medium transition-colors ${
                state.debug ? 'bg-blue-500/20 text-blue-400' : 'bg-zinc-700 text-zinc-400'
              }`}
            >
              Debug
            </button>
            {canStartNextTurn && (
              <button
                onClick={handleNextTurn}
                className="px-4 py-2 bg-emerald-500 hover:bg-emerald-600 text-black font-semibold rounded-lg transition-colors"
              >
                Next Turn
              </button>
            )}
            <a
              href={`/tabletop?code=${roomCode}&hostId=${hostId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white font-semibold rounded-lg transition-colors"
            >
              📺 Full Tabletop View
            </a>
          </div>
        </div>
        <div className="mt-2 text-sm text-zinc-300">
          {state.statusMessage}
        </div>
      </div>

      {/* Tabletop View */}
      <div className="flex-1 relative">
        <Tabletop
          room={state.room}
          hiddenCard={state.hiddenCard}
          statusMessage={state.statusMessage}
          debug={state.debug}
        />
      </div>

      {/* Footer Info */}
      <div className="bg-zinc-900/70 border-t border-zinc-800 p-3">
        <div className="flex items-center justify-between text-xs text-zinc-400">
          <div>
            Players: {state.room?.players.length || 0} | 
            Status: {state.room?.status || "unknown"} | 
            Turn: {state.room?.turn?.currentPlayerId ? "Active" : "None"}
          </div>
          <div>
            Deck: {state.room?.deck?.remaining || 0} remaining | 
            Discard: {state.room?.deck?.discard?.length || 0}
          </div>
        </div>
      </div>
    </div>
  );
}
