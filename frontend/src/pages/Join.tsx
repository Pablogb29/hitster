import { type ReactNode, useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { connectWS, type WSEvent } from "../lib/ws";

type Release = {
  date: string;
  precision: "year" | "month" | "day";
};

type TrackCard = {
  trackId: string;
  uri: string;
  name?: string;
  artist?: string;
  album?: string;
  coverUrl?: string;
  release: Release;
};

type PlayerState = {
  id: string;
  name: string;
  score: number;
  timeline: TrackCard[];
  seat?: number;
};

type TurnPhase = "playing" | "placing" | "result" | null;

type RoomSnapshot = {
  code: string;
  hostId: string;
  status: "lobby" | "playing" | "placing" | "result" | "finished";
  tiePolicy: "strict" | "lenient";
  winnerId: string | null;
  turnIndex: number;
  turn: {
    turnId: string;
    currentPlayerId: string;
    phase: "playing" | "placing" | "result";
    drawn: TrackCard | null;
  } | null;
  deck: {
    playlistId: string | null;
    used: string[];
    discard: string[];
    remaining: number;
  };
  players: Array<{
    id: string;
    name: string;
    score: number;
    timeline: TrackCard[];
    seat?: number;
  }>;
};

type TurnPlayEvent = {
  turnId: string;
  playerId: string;
  song: {
    trackId: string;
    uri: string;
    release: Release;
  };
};

type TurnResultEvent = {
  turnId: string;
  playerId: string;
  correct: boolean;
  newScore?: number;
  finalIndex?: number;
  placedTrack?: TrackCard;
};

type JoinInternalState = {
  roomCode: string;
  hostId: string;
  meId: string;
  players: PlayerState[];
  turnId: string | null;
  currentPlayerId: string | null;
  turnPhase: TurnPhase;
  drawnCard: TrackCard | null;
  ghostIndex: number;
  playInFlight: boolean;
  confirmInFlight: boolean;
  playConfirmed: boolean;
  status: string;
  lastResult?: { turnId: string; message: string; correct: boolean };
  winnerId: string | null;
  device: { id: string; name?: string } | null;
};

type JoinAction =
  | { type: "SET_ROOM_CODE"; code: string }
  | { type: "ROOM_INIT"; payload: RoomSnapshot }
  | { type: "TURN_BEGIN"; payload: { turnId: string; currentPlayerId: string } }
  | { type: "TURN_PLAY"; payload: TurnPlayEvent }
  | { type: "TURN_PLACING"; payload: { turnId: string } }
  | { type: "TURN_RESULT"; payload: TurnResultEvent }
  | { type: "GAME_FINISH"; payload: { winnerId: string } }
  | { type: "PLAY_REQUEST" }
  | { type: "PLAY_FINISH"; payload: { status: string } }
  | { type: "PLAY_FAILURE"; payload: { status: string } }
  | { type: "CONFIRM_REQUEST"; payload: { status: string } }
  | { type: "CONFIRM_SUCCESS"; payload: { status: string } }
  | { type: "CONFIRM_FAILURE"; payload: { status: string } }
  | { type: "SET_STATUS"; payload: { status: string } }
  | { type: "SET_DEVICE"; payload: { id: string; name?: string } }
  | { type: "SET_DRAWN"; payload: TrackCard | null }
  | { type: "SET_GHOST_INDEX"; payload: number };

const createInitialState = (meId: string): JoinInternalState => ({
  roomCode: "",
  hostId: "",
  meId,
  players: [],
  turnId: null,
  currentPlayerId: null,
  turnPhase: null,
  drawnCard: null,
  ghostIndex: 0,
  playInFlight: false,
  confirmInFlight: false,
  playConfirmed: false,
  status: "",
  lastResult: undefined,
  winnerId: null,
  device: null,
});

const formatYear = (release?: Release) => {
  if (!release?.date) return "?";
  return release.date.slice(0, 4);
};

const normalizePlayers = (players: RoomSnapshot["players"]): PlayerState[] => {
  return [...players]
    .map((p) => ({
      id: p.id,
      name: p.name,
      score: p.score ?? p.timeline.length,
      timeline: p.timeline ?? [],
      seat: p.seat,
    }))
    .sort((a, b) => {
      if (a.seat !== undefined && b.seat !== undefined) {
        return a.seat - b.seat;
      }
      return a.name.localeCompare(b.name);
    });
};

const clampGhost = (index: number, length: number) => {
  if (Number.isNaN(index)) return 0;
  return Math.max(0, Math.min(index, length));
};

const joinReducer = (state: JoinInternalState, action: JoinAction): JoinInternalState => {
  switch (action.type) {
    case "SET_ROOM_CODE":
      return { ...state, roomCode: action.code };
    case "ROOM_INIT": {
      const players = normalizePlayers(action.payload.players);
      const turn = action.payload.turn;
      const me = players.find((p) => p.id === state.meId);
      const ghostIndex = me ? me.timeline.length : 0;
      return {
        ...state,
        roomCode: action.payload.code || state.roomCode,
        hostId: action.payload.hostId || state.hostId,
        players,
        turnId: turn?.turnId ?? null,
        currentPlayerId: turn?.currentPlayerId ?? null,
        turnPhase: turn?.phase ?? null,
        drawnCard: null,
        ghostIndex,
        playInFlight: false,
        confirmInFlight: false,
        playConfirmed: false,
        status: "Room synced",
        lastResult: undefined,
        winnerId: action.payload.winnerId ?? null,
      };
    }
    case "TURN_BEGIN": {
      const me = state.players.find((p) => p.id === state.meId);
      const ghostIndex = me ? me.timeline.length : 0;
      const isMine = action.payload.currentPlayerId === state.meId;
      return {
        ...state,
        turnId: action.payload.turnId,
        currentPlayerId: action.payload.currentPlayerId,
        turnPhase: "playing",
        drawnCard: null,
        playInFlight: false,
        confirmInFlight: false,
        playConfirmed: false,
        ghostIndex,
        status: isMine ? "Your turn – tap Play to begin." : "Waiting for other player...",
        lastResult: undefined,
      };
    }
    case "TURN_PLAY": {
      console.log("[TURN_PLAY] payload.playerId:", action.payload.playerId, "state.meId:", state.meId, "match:", action.payload.playerId === state.meId);
      if (action.payload.playerId !== state.meId) {
        console.log("[TURN_PLAY] Ignoring event - player ID mismatch");
        return state;
      }
      console.log("[TURN_PLAY] Processing event - setting drawnCard");
      return {
        ...state,
        drawnCard: {
          trackId: action.payload.song.trackId,
          uri: action.payload.song.uri,
          release: action.payload.song.release,
        },
        status: "Hidden card ready. Tap Play to listen and place.",
      };
    }
    case "TURN_PLACING": {
      if (!state.turnId || action.payload.turnId !== state.turnId) {
        return state;
      }
      return {
        ...state,
        turnPhase: "placing",
        playInFlight: false,
        status: state.currentPlayerId === state.meId ? "Choose the position using ↑ / ↓." : "Other player is placing...",
      };
    }
    case "PLAY_REQUEST":
      return { ...state, playInFlight: true, status: "Starting playback...", playConfirmed: false };
    case "PLAY_FINISH":
      return { ...state, playInFlight: false, playConfirmed: true, status: action.payload.status };
    case "PLAY_FAILURE":
      return { ...state, playInFlight: false, playConfirmed: false, status: action.payload.status };
    case "CONFIRM_REQUEST":
      return { ...state, confirmInFlight: true, status: action.payload.status };
    case "CONFIRM_SUCCESS":
      return { ...state, confirmInFlight: false, status: action.payload.status };
    case "CONFIRM_FAILURE":
      return { ...state, confirmInFlight: false, status: action.payload.status };
    case "TURN_RESULT": {
      if (!state.turnId || action.payload.turnId !== state.turnId) {
        return state;
      }
      const updatedPlayers = state.players.map((p) => {
        if (p.id !== action.payload.playerId) {
          return p;
        }
        if (action.payload.correct && action.payload.placedTrack && typeof action.payload.finalIndex === "number") {
          const timeline = [...p.timeline];
          const insertIndex = clampGhost(action.payload.finalIndex, timeline.length);
          timeline.splice(insertIndex, 0, action.payload.placedTrack);
          return {
            ...p,
            score: action.payload.newScore ?? timeline.length,
            timeline,
          };
        }
        return {
          ...p,
          score: action.payload.newScore ?? p.score,
        };
      });
      const me = updatedPlayers.find((p) => p.id === state.meId);
      const ghostIndex = me ? me.timeline.length : state.ghostIndex;
      const message = action.payload.correct
        ? "✅ Correct placement!"
        : "❌ Incorrect placement.";
      return {
        ...state,
        players: updatedPlayers,
        turnPhase: "result",
        drawnCard: null,
        playInFlight: false,
        confirmInFlight: false,
        playConfirmed: false,
        ghostIndex,
        status: message,
        lastResult: {
          turnId: action.payload.turnId,
          message,
          correct: action.payload.correct,
        },
      };
    }
    case "GAME_FINISH":
      return {
        ...state,
        winnerId: action.payload.winnerId,
        status: action.payload.winnerId
          ? `Game finished! Winner: ${action.payload.winnerId}`
          : "Game finished",
      };
    case "SET_STATUS":
      return { ...state, status: action.payload.status };
    case "SET_DEVICE":
      return { ...state, device: { id: action.payload.id, name: action.payload.name } };
    case "SET_DRAWN":
      return { ...state, drawnCard: action.payload };
    case "SET_GHOST_INDEX": {
      const me = state.players.find((p) => p.id === state.meId);
      const len = me ? me.timeline.length : 0;
      return { ...state, ghostIndex: clampGhost(action.payload, len) };
    }
    default:
      return state;
  }
};

const API_BASE = ((import.meta as any).env?.VITE_BACKEND_URL || `${window.location.protocol}//${window.location.host}`)
  .replace(/\/+$/, "")
  .replace(/\/api$/, "");

export default function Join() {
  const [params] = useSearchParams();
  const codeParam = params.get("code") ?? "";
  const [code, setCode] = useState(codeParam);
  const [name, setName] = useState("");
  const [joined, setJoined] = useState(false);
  const [wsStatus, setWsStatus] = useState<"idle" | "connecting" | "open" | "closed">("idle");
  const playerId = useMemo(() => "p-" + Math.random().toString(36).slice(2, 8), []);
  const [state, dispatch] = useReducer(joinReducer, playerId, createInitialState);
  const connRef = useRef<ReturnType<typeof connectWS> | null>(null);
  const playerRef = useRef<any>(null);
  const [deviceId, setDeviceId] = useState<string | null>(null);

  const mePlayer = useMemo<PlayerState>(() => {
    const existing = state.players.find((p) => p.id === state.meId);
    if (existing) return existing;
    return {
      id: state.meId,
      name,
      score: 0,
      timeline: [],
    };
  }, [state.players, state.meId, name]);

  const isMyTurn = state.currentPlayerId === mePlayer.id;
  const phaseLabel = useMemo(() => {
    if (state.winnerId) return "finished";
    if (!state.turnId) return state.roomCode ? "waiting" : "lobby";
    if (!isMyTurn) return "waiting";
    if (state.turnPhase === "placing") return state.confirmInFlight ? "placing…" : "placing";
    if (state.turnPhase === "result") return "result";
    return state.playInFlight ? "playing…" : "playing";
  }, [state.turnId, state.turnPhase, state.playInFlight, state.confirmInFlight, isMyTurn, state.roomCode, state.winnerId]);

  const handleWsEvent = useCallback((evt: WSEvent) => {
    console.log("[WS]", evt.event, evt.data);
    switch (evt.event) {
      case "room:init":
        dispatch({ type: "ROOM_INIT", payload: evt.data as RoomSnapshot });
        break;
      case "turn:begin":
        console.log("[WS turn:begin] dispatching TURN_BEGIN");
        dispatch({ type: "TURN_BEGIN", payload: evt.data });
        break;
      case "turn:play":
        console.log("[WS turn:play] dispatching TURN_PLAY for player:", evt.data.playerId);
        dispatch({ type: "TURN_PLAY", payload: evt.data as TurnPlayEvent });
        break;
      case "turn:placing":
        console.log("[WS turn:placing] dispatching TURN_PLACING");
        dispatch({ type: "TURN_PLACING", payload: evt.data });
        break;
      case "turn:result":
        dispatch({ type: "TURN_RESULT", payload: evt.data as TurnResultEvent });
        break;
      case "game:finish":
        dispatch({ type: "GAME_FINISH", payload: evt.data });
        break;
      default:
        break;
    }
  }, []);

  useEffect(() => {
    return () => {
      if (connRef.current?.ws) {
        connRef.current.ws.close();
      }
      if (playerRef.current) {
        try {
          playerRef.current.disconnect();
        } catch (err) {
          console.warn("[spotify] disconnect error", err);
        }
      }
    };
  }, []);

  const ensureActivation = useCallback(async () => {
    try {
      const player: any = playerRef.current;
      if (player && typeof player.activateElement === "function") {
        await player.activateElement();
        dispatch({ type: "SET_STATUS", payload: { status: "Device activated" } });
      }
    } catch (err: any) {
      dispatch({ type: "SET_STATUS", payload: { status: `Activation failed: ${err?.message || err}` } });
    }
  }, []);

  useEffect(() => {
    if (!joined || !state.hostId) return;
    if (playerRef.current) return;

    const initPlayer = () => {
      const Spotify = (window as any).Spotify;
      if (!Spotify) return;
      const player = new Spotify.Player({
        name: "HITSTER Tabletop",
        getOAuthToken: async (cb: (token: string) => void) => {
          try {
            const resp = await fetch(`${API_BASE}/api/spotify/token?hostId=${encodeURIComponent(state.hostId)}`);
            if (!resp.ok) return;
            const data = await resp.json();
            cb(data.access_token);
          } catch (err) {
            console.warn("[spotify] token error", err);
          }
        },
        volume: 0.7,
      });
      player.addListener("ready", ({ device_id }: any) => {
        setDeviceId(device_id);
        dispatch({ type: "SET_DEVICE", payload: { id: device_id, name: "Web Playback" } });
        dispatch({ type: "SET_STATUS", payload: { status: `Spotify device ready (${device_id})` } });
      });
      player.addListener("not_ready", ({ device_id }: any) => {
        if (deviceId === device_id) {
          setDeviceId(null);
        }
        dispatch({ type: "SET_STATUS", payload: { status: `Spotify device ${device_id} not ready` } });
      });
      player.addListener("initialization_error", ({ message }: any) => {
        dispatch({ type: "SET_STATUS", payload: { status: `Spotify init error: ${message}` } });
      });
      playerRef.current = player;
      player.connect();
    };

    if (!(window as any).Spotify) {
      const existing = document.getElementById("spotify-sdk");
      if (!existing) {
        const script = document.createElement("script");
        script.id = "spotify-sdk";
        script.src = "https://sdk.scdn.co/spotify-player.js";
        script.async = true;
        document.body.appendChild(script);
      }
      (window as any).onSpotifyWebPlaybackSDKReady = initPlayer;
    } else {
      initPlayer();
    }
  }, [joined, state.hostId, deviceId]);

  const joinRoom = useCallback(() => {
    if (!code.trim() || !name.trim()) return;
    const roomCode = code.trim().toUpperCase();
    dispatch({ type: "SET_ROOM_CODE", code: roomCode });
    setWsStatus("connecting");
    const conn = connectWS(roomCode, handleWsEvent);
    connRef.current = conn;
    conn.ws.addEventListener("open", () => setWsStatus("open"));
    conn.ws.addEventListener("close", () => setWsStatus("closed"));
    conn.send("join", { id: playerId, name: name.trim(), is_host: false });
    setJoined(true);
    dispatch({ type: "SET_STATUS", payload: { status: "Connected to room." } });
  }, [code, name, playerId, handleWsEvent]);

  const handlePlay = useCallback(async () => {
    if (!state.turnId || !state.drawnCard) {
      dispatch({ type: "SET_STATUS", payload: { status: "No hidden card available yet." } });
      return;
    }
    if (!state.hostId) {
      dispatch({ type: "SET_STATUS", payload: { status: "Host not linked to Spotify." } });
      return;
    }
    if (!deviceId) {
      dispatch({ type: "SET_STATUS", payload: { status: "Spotify device not ready." } });
      return;
    }
    dispatch({ type: "PLAY_REQUEST" });
    try {
      await ensureActivation();
      const body = {
        hostId: state.hostId,
        device_id: deviceId,
        turnId: state.turnId,
        uri: state.drawnCard.uri,
        id: state.drawnCard.trackId,
      };
      const resp = await fetch(`${API_BASE}/api/spotify/queue_next`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        dispatch({ type: "PLAY_FAILURE", payload: { status: `queue_next ${resp.status} ${text}` } });
        return;
      }
      const data = await resp.json().catch(() => ({}));
      const msg = data?.path ? `queue_next path=${data.path} playing=${data.is_playing}` : "queue_next OK";
      dispatch({ type: "PLAY_FINISH", payload: { status: msg } });
    } catch (err: any) {
      dispatch({ type: "PLAY_FAILURE", payload: { status: `queue_next error: ${err?.message || err}` } });
    }
  }, [state.turnId, state.drawnCard, state.hostId, deviceId, ensureActivation]);

  const handleConfirm = useCallback(async () => {
    if (!state.turnId) {
      dispatch({ type: "SET_STATUS", payload: { status: "No active turn." } });
      return;
    }
    if (!state.playConfirmed) {
      dispatch({ type: "SET_STATUS", payload: { status: "Play the card before confirming." } });
      return;
    }
    dispatch({ type: "CONFIRM_REQUEST", payload: { status: "Submitting placement..." } });
    try {
      const resp = await fetch(`${API_BASE}/api/turn/confirm_position`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          roomCode: state.roomCode,
          playerId,
          turnId: state.turnId,
          targetIndex: state.ghostIndex,
        }),
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        dispatch({ type: "CONFIRM_FAILURE", payload: { status: `confirm ${resp.status} ${text}` } });
        return;
      }
      dispatch({ type: "CONFIRM_SUCCESS", payload: { status: "Placement submitted." } });
    } catch (err: any) {
      dispatch({ type: "CONFIRM_FAILURE", payload: { status: `confirm error: ${err?.message || err}` } });
    }
  }, [state.turnId, state.roomCode, state.ghostIndex, playerId]);

  const moveGhost = useCallback(
    (delta: number) => {
      if (!isMyTurn || state.turnPhase !== "placing" || state.confirmInFlight) return;
      const next = state.ghostIndex + delta;
      dispatch({ type: "SET_GHOST_INDEX", payload: next });
    },
    [state.ghostIndex, state.turnPhase, state.confirmInFlight, isMyTurn]
  );

  useEffect(() => {
    if (!isMyTurn || state.turnPhase !== "placing") return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "ArrowUp") {
        event.preventDefault();
        moveGhost(-1);
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        moveGhost(1);
      } else if (event.key === "Enter") {
        event.preventDefault();
        handleConfirm();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isMyTurn, state.turnPhase, moveGhost, handleConfirm]);

  const ghostElements = useMemo(() => {
    const items: ReactNode[] = [];
    const length = mePlayer.timeline.length;
    for (let i = 0; i <= length; i += 1) {
      if (isMyTurn && state.turnPhase === "placing" && state.ghostIndex === i) {
        items.push(
          <div
            key={`ghost-${i}`}
            className="rounded border border-emerald-400/70 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200"
          >
            Hidden card position
          </div>
        );
      }
      if (i < length) {
        const card = mePlayer.timeline[i];
        items.push(
          <div key={`card-${card.trackId}-${i}`} className="rounded bg-zinc-800 px-3 py-2 text-sm">
            <div className="text-emerald-300 font-semibold">{formatYear(card.release)}</div>
            <div className="text-white/90">{card.name ?? "Revealed card"}</div>
            <div className="text-white/60">{card.artist ?? ""}</div>
          </div>
        );
      }
    }
    return items;
  }, [mePlayer.timeline, isMyTurn, state.turnPhase, state.ghostIndex]);

  const playDisabled = !isMyTurn || state.turnPhase !== "playing" || state.playInFlight || !state.drawnCard;
  const placementDisabled = !isMyTurn || state.turnPhase !== "placing" || state.confirmInFlight || !state.playConfirmed;
  
  // Debug logging for button state
  console.log("[DEBUG] Button state:", {
    isMyTurn,
    turnPhase: state.turnPhase,
    playInFlight: state.playInFlight,
    drawnCard: state.drawnCard,
    playDisabled,
    meId: state.meId,
    currentPlayerId: state.currentPlayerId
  });

  const otherPlayers = useMemo(() => state.players.filter((p) => p.id !== mePlayer.id), [state.players, mePlayer.id]);

  const winner = state.winnerId ? state.players.find((p) => p.id === state.winnerId)?.name ?? state.winnerId : null;

  if (!joined) {
    return (
      <div className="min-h-screen bg-zinc-950 text-white px-6 py-10">
        <div className="mx-auto max-w-md space-y-6">
          <h1 className="text-3xl font-bold">Join Table</h1>
          <div className="space-y-4">
            <div>
              <label className="text-sm text-zinc-400">Room code</label>
              <input
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                className="mt-1 w-full rounded bg-zinc-900 px-3 py-2 text-lg focus:outline-none focus:ring-2 focus:ring-emerald-500"
                placeholder="ABCD"
              />
            </div>
            <div>
              <label className="text-sm text-zinc-400">Your name</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="mt-1 w-full rounded bg-zinc-900 px-3 py-2 text-lg focus:outline-none focus:ring-2 focus:ring-emerald-500"
                placeholder="Player"
              />
            </div>
            <button
              onClick={joinRoom}
              disabled={!code.trim() || !name.trim()}
              className="w-full rounded bg-emerald-500 py-3 text-lg font-semibold text-black disabled:opacity-40"
            >
              Join Game
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-white px-4 py-6">
      <header className="mb-6 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-2xl font-semibold">{mePlayer.name}</h2>
            <p className="text-sm text-zinc-400">Player ID: {mePlayer.id}</p>
          </div>
          <div className="text-right text-sm text-zinc-400">
            <div>Score: <span className="text-white font-semibold">{mePlayer.score}</span></div>
            <div>Cards: <span className="text-white font-semibold">{mePlayer.timeline.length}</span></div>
          </div>
        </div>
        <div className="rounded bg-zinc-900/60 px-4 py-3 text-sm text-zinc-300">
          <div>Phase: <span className="text-white font-semibold capitalize">{phaseLabel}</span></div>
          <div>Status: <span className="text-white/90">{state.status || ""}</span></div>
          <div className="mt-1 text-xs text-zinc-500">
            ws:{" "}
            <span className={wsStatus === "open" ? "text-emerald-400" : "text-yellow-400"}>{wsStatus}</span>{" "}
            | turnId: {state.turnId ?? "-"} | current: {state.currentPlayerId ?? "-"} | ghostIndex: {state.ghostIndex}
            {state.device ? ` | device: ${state.device.id}` : " | device: n/a"}
          </div>
        </div>
      </header>

      {winner ? (
        <div className="mb-4 rounded border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-emerald-200">
          🎉 Game finished! Winner: <span className="font-semibold">{winner}</span>
        </div>
      ) : null}

      {!isMyTurn ? (
        <div className="mb-6 rounded bg-zinc-900/70 px-4 py-8 text-center text-lg text-zinc-200">
          Waiting… It’s {state.currentPlayerId ? state.players.find((p) => p.id === state.currentPlayerId)?.name ?? "another player" : "someone"}'s turn.
        </div>
      ) : state.turnPhase === "playing" ? (
        <div className="mb-6 space-y-4 rounded bg-zinc-900/70 px-4 py-6">
          <div className="text-sm text-zinc-400">Hidden card ready. Audio plays once you press Play.</div>
          <button
            onClick={handlePlay}
            disabled={playDisabled}
            className="w-full rounded bg-emerald-500 py-4 text-lg font-semibold text-black disabled:opacity-40"
          >
            {state.playInFlight ? "Loading…" : "Play Hidden Card"}
          </button>
          <div className="flex items-center justify-between text-xs text-zinc-500">
            <span>Device: {deviceId ? deviceId : "not ready"}</span>
            <button onClick={ensureActivation} className="rounded bg-zinc-800 px-2 py-1">Activate</button>
          </div>
        </div>
      ) : state.turnPhase === "placing" ? (
        <div className="mb-6 space-y-4 rounded bg-zinc-900/70 px-4 py-6">
          <div className="text-sm text-zinc-400">Use ↑ / ↓ to position the hidden card, then confirm.</div>
          <div className="flex items-center justify-center gap-3">
            <button
              onClick={() => moveGhost(-1)}
              disabled={placementDisabled}
              className="h-14 w-20 rounded-full bg-zinc-800 text-2xl disabled:opacity-40"
            >
              ↑
            </button>
            <button
              onClick={() => moveGhost(1)}
              disabled={placementDisabled}
              className="h-14 w-20 rounded-full bg-zinc-800 text-2xl disabled:opacity-40"
            >
              ↓
            </button>
            <button
              onClick={handleConfirm}
              disabled={placementDisabled}
              className="h-14 flex-1 rounded bg-emerald-500 text-lg font-semibold text-black disabled:opacity-40"
            >
              {state.confirmInFlight ? "Checking…" : "Confirm"}
            </button>
          </div>
        </div>
      ) : null}

      <section className="mb-6 space-y-3">
        <div className="text-sm text-zinc-400">Your timeline (chronological)</div>
        <div className="grid gap-2">
          {ghostElements.length > 0 ? ghostElements : (
            <div className="rounded bg-zinc-900/60 px-3 py-4 text-center text-zinc-400">No cards yet. Place the hidden card to start your timeline.</div>
          )}
        </div>
      </section>

      <section className="space-y-2">
        <div className="text-sm text-zinc-400">Players</div>
        <div className="grid gap-2">
          <div className="flex items-center justify-between rounded bg-zinc-900/70 px-3 py-2">
            <div className="font-semibold text-white">{mePlayer.name} (you)</div>
            <div className="text-sm text-zinc-400">Score {mePlayer.score} • Cards {mePlayer.timeline.length}</div>
          </div>
          {otherPlayers.map((p) => (
            <div key={p.id} className="flex items-center justify-between rounded bg-zinc-900/40 px-3 py-2 text-sm">
              <div className="text-white/90">{p.name}</div>
              <div className="text-zinc-500">Score {p.score} • Cards {p.timeline.length}</div>
            </div>
          ))}
        </div>
      </section>

      <footer className="mt-8 space-y-3 text-xs text-zinc-500">
        <div>Room: {state.roomCode || code}</div>
        <div>Host: {state.hostId || "n/a"}</div>
        <div>Last result: {state.lastResult ? `${state.lastResult.message} (${state.lastResult.turnId})` : "-"}</div>
        <div className="pt-2">
          <button
            className="rounded bg-zinc-800 px-2 py-1"
            onClick={async () => {
              try {
                await fetch(`${API_BASE}/api/turn/next`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  credentials: "include",
                  body: JSON.stringify({ roomCode: state.roomCode }),
                });
                dispatch({ type: "SET_STATUS", payload: { status: "Requested next turn (dev)." } });
              } catch (err: any) {
                dispatch({ type: "SET_STATUS", payload: { status: `next turn error: ${err?.message || err}` } });
              }
            }}
          >
            Dev: Next turn
          </button>
        </div>
      </footer>
    </div>
  );
}
