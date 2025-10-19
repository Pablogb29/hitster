import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import QRCode from "qrcode";
import { connectWS, type WSEvent } from "../lib/ws";
import Tabletop from "../tabletop/Tabletop";
import type { HiddenCardState, TabletopPlayer, TabletopRoom } from "../tabletop/types";

type RoomSnapshot = TabletopRoom & {
  deck?: (TabletopRoom["deck"] & {
    discard: string[];
  }) | undefined;
};

type HostState = {
  room: RoomSnapshot | null;
  status: string;
  wsStatus: "idle" | "connecting" | "open" | "closed";
};

type HostAction =
  | { type: "ROOM_INIT"; payload: RoomSnapshot }
  | { type: "TURN_BEGIN"; payload: { turnId: string; currentPlayerId: string } }
  | { type: "TURN_PLAY"; payload: { turnId: string; playerId: string; song: { trackId: string; uri: string; release: { date: string; precision: string } } } }
  | { type: "TURN_PLACING"; payload: { turnId: string } }
  | { type: "TURN_RESULT"; payload: { turnId: string; playerId: string; correct: boolean; placedTrack?: any; finalIndex?: number; newScore?: number } }
  | { type: "GAME_FINISH"; payload: { winnerId: string } }
  | { type: "SET_STATUS"; payload: string }
  | { type: "WS_STATUS"; payload: HostState["wsStatus"] };

const initialHostState: HostState = {
  room: null,
  status: "",
  wsStatus: "idle",
};

const normalizeTrack = (track: any) => ({
  trackId: track?.trackId ?? track?.id,
  uri: track?.uri,
  name: track?.name,
  artist: track?.artist,
  album: track?.album,
  coverUrl: track?.coverUrl,
  release: track?.release,
});

const normalizePlayer = (p: any): TabletopPlayer => ({
  id: p.id,
  name: p.name,
  score: p.score ?? (p.timeline?.length ?? 0),
  timeline: (p.timeline ?? []).map((card: any) => normalizeTrack(card)),
});

const normalizeRoom = (snapshot: RoomSnapshot): RoomSnapshot => {
  const discard = [...(snapshot.deck?.discard ?? [])].filter((id): id is string => Boolean(id));
  return {
    ...snapshot,
    players: snapshot.players.map(normalizePlayer),
    turn: snapshot.turn
      ? {
          turnId: snapshot.turn.turnId,
          currentPlayerId: snapshot.turn.currentPlayerId,
          phase: snapshot.turn.phase,
          drawn: snapshot.turn.drawn ? (normalizeTrack(snapshot.turn.drawn) as any) : null,
        }
      : null,
    deck: {
      playlistId: snapshot.deck?.playlistId ?? null,
      used: [...(snapshot.deck?.used ?? [])],
      discard,
      remaining: snapshot.deck?.remaining ?? 0,
    },
  };
};

const hostReducer = (state: HostState, action: HostAction): HostState => {
  switch (action.type) {
    case "ROOM_INIT":
      return {
        ...state,
        room: normalizeRoom(action.payload),
        status: "Room synchronised",
      };
    case "TURN_BEGIN": {
      if (!state.room) return state;
      const room: RoomSnapshot = {
        ...state.room,
        status: "playing",
        turn: {
          turnId: action.payload.turnId,
          currentPlayerId: action.payload.currentPlayerId,
          phase: "playing",
          drawn: null,
        },
      };
      return { ...state, room, status: `Turn started for ${action.payload.currentPlayerId}` };
    }
    case "TURN_PLAY": {
      if (!state.room || !state.room.turn) return state;
      if (state.room.turn.turnId !== action.payload.turnId) return state;
      const room: RoomSnapshot = {
        ...state.room,
        status: "placing",
        turn: {
          ...state.room.turn,
          phase: "placing",
          drawn: normalizeTrack(action.payload.song) as any,
        },
      };
      return { ...state, room };
    }
    case "TURN_PLACING": {
      if (!state.room || !state.room.turn || state.room.turn.turnId !== action.payload.turnId) return state;
      const room: RoomSnapshot = {
        ...state.room,
        status: "placing",
        turn: { ...state.room.turn, phase: "placing" },
      };
      return { ...state, room };
    }
    case "TURN_RESULT": {
      if (!state.room || !state.room.turn || state.room.turn.turnId !== action.payload.turnId) return state;
      const players = state.room.players.map((player) => {
        if (player.id !== action.payload.playerId) return player;
        if (action.payload.correct && action.payload.placedTrack && typeof action.payload.finalIndex === "number") {
          const timeline = [...player.timeline];
          const index = Math.max(0, Math.min(action.payload.finalIndex, timeline.length));
          timeline.splice(index, 0, normalizeTrack(action.payload.placedTrack));
          return {
            ...player,
            score: action.payload.newScore ?? timeline.length,
            timeline,
          };
        }
        return {
          ...player,
          score: action.payload.newScore ?? player.score,
        };
      });
      const drawnTrackId = state.room.turn.drawn?.trackId;
      const baseDiscard = [...(state.room.deck?.discard ?? [])];
      const discard = action.payload.correct
        ? baseDiscard
        : [...baseDiscard, drawnTrackId].filter((id): id is string => typeof id === "string" && id.length > 0);
      const room: RoomSnapshot = {
        ...state.room,
        status: "result",
        players,
        deck: { ...state.room.deck!, discard },
        turn: {
          ...state.room.turn,
          phase: "result",
          drawn: null,
        },
      };
      return {
        ...state,
        room,
        status: action.payload.correct ? "Correct placement" : "Incorrect placement",
      };
    }
    case "GAME_FINISH": {
      if (!state.room) return state;
      const room: RoomSnapshot = {
        ...state.room,
        status: "finished",
        winnerId: action.payload.winnerId,
      };
      return { ...state, room, status: `Winner: ${action.payload.winnerId}` };
    }
    case "SET_STATUS":
      return { ...state, status: action.payload };
    case "WS_STATUS":
      return { ...state, wsStatus: action.payload };
    default:
      return state;
  }
};

function resolveBackendBase() {
  if (typeof location !== "undefined" && location.host === "frontend-production-62902.up.railway.app") {
    return "https://backend-production-f463.up.railway.app";
  }
  return "http://localhost:8000";
}

const API_BASE = ((import.meta as any).env?.VITE_BACKEND_URL || resolveBackendBase())
  .replace(/\/+$/, "")
  .replace(/\/api$/, "");

type HiddenHook = [HiddenCardState | null, Dispatch<SetStateAction<HiddenCardState | null>>];

function useHiddenCard(): HiddenHook {
  const [value, setValue] = useState<HiddenCardState | null>(null);

  useEffect(() => {
    if (!value) return;
    if (value.stage === "incoming") {
      const id = window.setTimeout(() => {
        setValue((prev) => (prev ? { ...prev, stage: "active" } : prev));
      }, 60);
      return () => window.clearTimeout(id);
    }
  }, [value]);

  return [value, setValue];
}

export default function Host() {
  const [state, dispatch] = useReducer(hostReducer, initialHostState);
  const [hostId, setHostId] = useState<string>("");
  const [qr, setQr] = useState<string>("");
  const [playlistId, setPlaylistId] = useState<string>("");
  const [tiePolicy, setTiePolicy] = useState<"strict" | "lenient">("lenient");
  const [health, setHealth] = useState<string>("");
  const [spotifyLinked, setSpotifyLinked] = useState<boolean>(false);
  const [playlists, setPlaylists] = useState<any[]>([]);
  const [hiddenCard, setHiddenCard] = useHiddenCard();
  const connRef = useRef<ReturnType<typeof connectWS> | null>(null);



  const connectToRoom = useCallback((code: string, hid: string) => {
    dispatch({ type: "WS_STATUS", payload: "connecting" });
    const conn = connectWS(code, (evt: WSEvent) => {
      switch (evt.event) {
        case "room:init":
          dispatch({ type: "ROOM_INIT", payload: evt.data as RoomSnapshot });
          break;
        case "turn:begin":
          setHiddenCard(null);
          dispatch({ type: "TURN_BEGIN", payload: evt.data });
          break;
        case "turn:play":
          dispatch({ type: "TURN_PLAY", payload: evt.data });
          setHiddenCard({
            key: `${evt.data.turnId}-${evt.data.song.trackId}`,
            playerId: evt.data.playerId,
            track: {
              trackId: evt.data.song.trackId,
              uri: evt.data.song.uri,
              release: evt.data.song.release,
            },
            stage: "incoming",
          });
          break;
        case "turn:placing":
          dispatch({ type: "TURN_PLACING", payload: evt.data });
          break;
        case "turn:result":
          dispatch({ type: "TURN_RESULT", payload: evt.data });
          setHiddenCard((prev) => {
            if (!prev || prev.playerId !== evt.data.playerId) return null;
            return { ...prev, stage: evt.data.correct ? "revealing" : "failed" };
          });
          setTimeout(() => setHiddenCard(null), evt.data.correct ? 450 : 450);
          break;
        case "game:finish":
          dispatch({ type: "GAME_FINISH", payload: evt.data });
          break;
        default:
          break;
      }
    });
    conn.ws.addEventListener("open", () => dispatch({ type: "WS_STATUS", payload: "open" }));
    conn.ws.addEventListener("close", () => dispatch({ type: "WS_STATUS", payload: "closed" }));
    conn.send("join", { id: hid, name: "HOST", is_host: true });
    connRef.current = conn;
  }, [setHiddenCard]);
  const loadSpotifyState = useCallback(async (hid: string) => {
    try {
      const status = await fetch(`${API_BASE}/api/spotify/status?hostId=${hid}`).then((r) => r.json());
      setSpotifyLinked(!!status?.linked);
      if (status?.linked) {
        const pls = await fetch(`${API_BASE}/api/spotify/playlists?hostId=${hid}`).then((r) => r.json());
        setPlaylists(pls?.items || []);
      }
    } catch (err) {
      console.warn("spotify status", err);
    }
  }, []);
  const createRoom = useCallback(async () => {
    try {
      if (connRef.current?.ws) {
        connRef.current.ws.close();
      }
      const reqUrl = hostId ? `${API_BASE}/api/create-room?hostId=${encodeURIComponent(hostId)}` : `${API_BASE}/api/create-room`;
      const res = await fetch(reqUrl, { mode: "cors" as RequestMode });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setHostId(data.hostId);
      const joinUrl = `${window.location.origin}/join?code=${data.code}`;
      const qrData = await QRCode.toDataURL(joinUrl);
      setQr(qrData);
      connectToRoom(data.code, data.hostId);
      loadSpotifyState(data.hostId);
      dispatch({ type: "SET_STATUS", payload: `Room ${data.code} created` });
    } catch (err: any) {
      console.error("create room", err);
      dispatch({ type: "SET_STATUS", payload: `Create failed: ${err?.message || err}` });
    }
  }, [hostId, connectToRoom, loadSpotifyState]);


  const testBackend = useCallback(async () => {
    setHealth("Testing...");
    try {
      const res = await fetch(`${API_BASE}/api/health`, { mode: "cors" as RequestMode });
      const data = await res.json();
      setHealth(`ok: ${res.status} ${JSON.stringify(data)}`);
    } catch (err: any) {
      setHealth(`error: ${err?.message || err}`);
    }
  }, []);



  const connectSpotify = useCallback(async () => {
    if (!hostId) return;
    try {
      const resp = await fetch(`${API_BASE}/api/spotify/login?hostId=${hostId}`);
      const data = await resp.json();
      if (data?.authorize_url) {
        window.location.href = data.authorize_url;
      }
    } catch (err) {
      console.error("spotify login", err);
    }
  }, [hostId, connectToRoom, loadSpotifyState]);

  const startGame = useCallback(() => {
    if (!connRef.current || !state.room) return;
    connRef.current.send("start", {
      hostId,
      playlistId,
      playlistName: "",
      tiePolicy,
    });
    dispatch({ type: "SET_STATUS", payload: "Start requested" });
  }, [state.room, hostId, playlistId, tiePolicy]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const hid = params.get("hostId");
    const spotifyOk = params.get("spotify");
    if (hid) {
      setHostId(hid);
      loadSpotifyState(hid);
    }
    if (hid && spotifyOk === "ok") {
      loadSpotifyState(hid);
    }
  }, [loadSpotifyState]);

  useEffect(() => {
    return () => {
      if (connRef.current?.ws) {
        connRef.current.ws.close();
      }
    };
  }, []);

  const discardCount = state.room?.deck?.discard?.length ?? 0;
  const activePlayer = useMemo(() => {
    const id = state.room?.turn?.currentPlayerId;
    if (!id) return null;
    return state.room?.players.find((p) => p.id === id) ?? null;
  }, [state.room]);

  return (
    <div className="min-h-screen bg-slate-950 text-white">
      <header className="grid grid-cols-3 items-start gap-6 px-8 py-6">
        <div className="space-y-2">
          <h1 className="text-3xl font-bold">HITSTER Tabletop — Host</h1>
          <p className="text-sm text-slate-400">API: {API_BASE}</p>
          <p className="text-sm text-emerald-300">Status: {state.status}</p>
        </div>
        <div className="space-y-2">
          <button
            onClick={createRoom}
            className="w-full rounded bg-emerald-500 py-3 text-lg font-semibold text-black"
          >
            Create Room
          </button>
          <button
            onClick={testBackend}
            className="w-full rounded bg-slate-800 py-2 text-sm"
          >
            Test Backend
          </button>
          {health && <p className="text-xs text-slate-400">{health}</p>}
        </div>
        <div className="space-y-2 text-sm text-slate-300">
          <div>WS: <span className={state.wsStatus === "open" ? "text-emerald-300" : "text-yellow-300"}>{state.wsStatus}</span></div>
          <div>Room: {state.room?.code ?? "-"}</div>
          <div>Active: {activePlayer?.name ?? "-"}</div>
          <div>Winner: {state.room?.winnerId ?? "-"}</div>
        </div>
      </header>

      <main className="flex h-[65vh] items-stretch justify-center px-8">
        <div className="relative w-full overflow-hidden rounded-3xl border border-slate-800 bg-slate-900/80">
          <Tabletop
            room={state.room}
            hiddenCard={hiddenCard}
            statusMessage={activePlayer ? `${activePlayer.name}'s turn` : ""}
            discardCount={discardCount}
            debug={true}
          />
        </div>
      </main>

      <section className="mt-6 grid grid-cols-3 gap-6 px-8 pb-8 text-sm">
        <div className="space-y-4 rounded-2xl bg-slate-900/70 p-4">
          <h2 className="text-lg font-semibold">Room Sharing</h2>
          {state.room?.code ? (
            <>
              <div className="text-3xl font-mono text-emerald-400">{state.room.code}</div>
              {qr ? <img src={qr} alt="QR" className="h-32 w-32 rounded bg-white p-2" /> : null}
            </>
          ) : (
            <p className="text-slate-400">Create a room to generate a join QR.</p>
          )}
        </div>
        <div className="space-y-4 rounded-2xl bg-slate-900/70 p-4">
          <h2 className="text-lg font-semibold">Spotify</h2>
          <div className="flex items-center justify-between text-sm">
            <span>Linked</span>
            <span className={spotifyLinked ? "text-emerald-300" : "text-red-300"}>
              {spotifyLinked ? "yes" : "no"}
            </span>
          </div>
          {!spotifyLinked ? (
            <button
              onClick={connectSpotify}
              className="w-full rounded bg-emerald-500 py-2 text-black"
            >
              Connect Spotify
            </button>
          ) : null}
          {spotifyLinked ? (
            <div className="space-y-2">
              <label className="text-xs text-slate-400">Playlist</label>
              <select
                value={playlistId}
                onChange={(e) => setPlaylistId(e.target.value)}
                className="w-full rounded bg-slate-800 px-3 py-2"
              >
                <option value="">Default (Hitster)</option>
                {playlists.map((p: any) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.tracks?.total ?? 0})
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <div className="space-y-2">
            <label className="text-xs text-slate-400">Tie Policy</label>
            <div className="flex gap-2">
              <button
                onClick={() => setTiePolicy("strict")}
                className={`flex-1 rounded px-3 py-2 ${tiePolicy === "strict" ? "bg-emerald-500 text-black" : "bg-slate-800"}`}
              >
                Strict
              </button>
              <button
                onClick={() => setTiePolicy("lenient")}
                className={`flex-1 rounded px-3 py-2 ${tiePolicy === "lenient" ? "bg-emerald-500 text-black" : "bg-slate-800"}`}
              >
                Lenient
              </button>
            </div>
          </div>
          <button
            onClick={startGame}
            className="w-full rounded bg-blue-500 py-2 text-black disabled:opacity-40"
            disabled={!state.room || state.room.players.length < 2}
          >
            Start Game
          </button>
        </div>
        <div className="space-y-4 rounded-2xl bg-slate-900/70 p-4">
          <h2 className="text-lg font-semibold">Players</h2>
          <div className="space-y-2">
            {state.room?.players.map((p) => (
              <div key={p.id} className="flex items-center justify-between rounded bg-slate-800/60 px-3 py-2">
                <div>
                  <div className="font-semibold text-slate-100">{p.name}</div>
                  <div className="text-xs text-slate-400">Cards {p.timeline.length}</div>
                </div>
                <div className="text-sm text-emerald-300">★ {p.score}</div>
              </div>
            ))}
            {!state.room?.players?.length ? <div className="text-slate-500">Waiting for players…</div> : null}
          </div>
        </div>
      </section>
    </div>
  );
}
