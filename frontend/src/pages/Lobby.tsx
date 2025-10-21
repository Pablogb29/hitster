import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
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

type LobbyState = {
  roomCode: string;
  hostId: string;
  players: PlayerState[];
  spotifyLinked: boolean;
  playlists: Array<{ id: string; name: string; tracks: { total: number } }>;
  selectedPlaylistId: string | null;
  tiePolicy: "strict" | "lenient";
  targetPoints: number;
  status: string;
  wsConnected: boolean;
};

type LobbyAction =
  | { type: "SET_ROOM_CODE"; code: string }
  | { type: "SET_HOST_ID"; hostId: string }
  | { type: "ROOM_INIT"; payload: RoomSnapshot }
  | { type: "SET_SPOTIFY_LINKED"; linked: boolean }
  | { type: "SET_PLAYLISTS"; playlists: Array<{ id: string; name: string; tracks: { total: number } }> }
  | { type: "SET_SELECTED_PLAYLIST"; playlistId: string | null }
  | { type: "SET_TIE_POLICY"; policy: "strict" | "lenient" }
  | { type: "SET_TARGET_POINTS"; targetPoints: number }
  | { type: "SET_STATUS"; status: string }
  | { type: "SET_WS_CONNECTED"; connected: boolean };

const createInitialLobbyState = (): LobbyState => ({
  roomCode: "",
  hostId: "",
  players: [],
  spotifyLinked: false,
  playlists: [],
  selectedPlaylistId: null,
  tiePolicy: "lenient",
  targetPoints: 10,
  status: "Initializing...",
  wsConnected: false,
});

const lobbyReducer = (state: LobbyState, action: LobbyAction): LobbyState => {
  switch (action.type) {
    case "SET_ROOM_CODE":
      return { ...state, roomCode: action.code };
    case "SET_HOST_ID":
      return { ...state, hostId: action.hostId };
    case "ROOM_INIT": {
      const players = action.payload.players.map((p) => ({
        id: p.id,
        name: p.name,
        score: p.score ?? p.timeline.length,
        timeline: p.timeline ?? [],
        seat: p.seat,
      }));
      return {
        ...state,
        roomCode: action.payload.code || state.roomCode,
        hostId: action.payload.hostId || state.hostId,
        players,
        status: `Room ${action.payload.code} ready. ${players.length} players connected.`,
      };
    }
    case "SET_SPOTIFY_LINKED":
      return { ...state, spotifyLinked: action.linked, status: action.linked ? "Spotify linked successfully" : "Spotify not linked" };
    case "SET_PLAYLISTS":
      return { ...state, playlists: action.playlists };
    case "SET_SELECTED_PLAYLIST":
      return { ...state, selectedPlaylistId: action.playlistId };
    case "SET_TIE_POLICY":
      return { ...state, tiePolicy: action.policy };
    case "SET_TARGET_POINTS":
      return { ...state, targetPoints: action.targetPoints };
    case "SET_STATUS":
      return { ...state, status: action.status };
    case "SET_WS_CONNECTED":
      return { ...state, wsConnected: action.connected };
    default:
      return state;
  }
};

const API_BASE = ((import.meta as any).env?.VITE_BACKEND_URL || `${window.location.protocol}//${window.location.host}`)
  .replace(/\/+$/, "")
  .replace(/\/api$/, "");

export default function Lobby() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [state, dispatch] = useReducer(lobbyReducer, createInitialLobbyState());
  const connRef = useRef<ReturnType<typeof connectWS> | null>(null);
  const [qrCode, setQrCode] = useState<string>("");

  const handleWsEvent = useCallback((evt: WSEvent) => {
    console.log("[WS Lobby]", evt.event, evt.data);
    switch (evt.event) {
      case "room:init":
        dispatch({ type: "ROOM_INIT", payload: evt.data as RoomSnapshot });
        break;
      case "game:error":
        dispatch({ type: "SET_STATUS", status: `Error: ${evt.data.message}` });
        break;
      default:
        break;
    }
  }, []);

  // Initialize room and WebSocket connection, reusing existing identifiers across OAuth redirects
  useEffect(() => {
    const initializeRoom = async () => {
      try {
        // Attempt to reuse persisted identifiers (across Spotify OAuth redirect)
        const storedCode = sessionStorage.getItem("hitster_roomCode") || "";
        const storedHostId = sessionStorage.getItem("hitster_hostId") || "";
        // Also consider URL params (hostId/code) if present
        const urlHostId = params.get("hostId") || "";
        const urlCode = params.get("code") || "";

        const reuseCode = urlCode || storedCode;
        const reuseHostId = urlHostId || storedHostId;

        // Helper to connect to an existing room with known identifiers
        const connectToRoom = async (code: string, hostId: string) => {
          dispatch({ type: "SET_STATUS", status: `Connecting to room ${code}...` });
          dispatch({ type: "SET_ROOM_CODE", code });
          dispatch({ type: "SET_HOST_ID", hostId });
          sessionStorage.setItem("hitster_roomCode", code);
          sessionStorage.setItem("hitster_hostId", hostId);

          const conn = connectWS(code, handleWsEvent);
          connRef.current = conn;
          conn.ws.addEventListener("open", () => {
            dispatch({ type: "SET_WS_CONNECTED", connected: true });
            dispatch({ type: "SET_STATUS", status: "Connected to room" });
            // Join as host (host is not added as a player on the server)
            conn.send("join", { id: hostId, name: "Host", is_host: true });
          });
          conn.ws.addEventListener("close", () => {
            dispatch({ type: "SET_WS_CONNECTED", connected: false });
          });

          // Generate QR code
          const QRCode = (await import("qrcode")).default;
          const qr = await QRCode.toDataURL(`${window.location.origin}/join?code=${code}`);
          setQrCode(qr);
        };

        if (reuseCode && reuseHostId) {
          await connectToRoom(reuseCode, reuseHostId);
          return;
        }

        // Generate hostId and create room immediately
        const newHostId = reuseHostId || `host-${Math.random().toString(36).slice(2, 6)}`;
        dispatch({ type: "SET_HOST_ID", hostId: newHostId });
        sessionStorage.setItem("hitster_hostId", newHostId);

        // Create room with default targetPoints (user can change before starting)
        dispatch({ type: "SET_STATUS", status: "Creating room..." });
        console.log("[Lobby] Creating room with targetPoints:", state.targetPoints);
        const resp = await fetch(`${API_BASE}/api/create-room?targetPoints=${state.targetPoints}`);
        if (!resp.ok) throw new Error(`Failed to create room: ${resp.status}`);
        const data = await resp.json();

        await connectToRoom(data.code, newHostId);
      } catch (err: any) {
        dispatch({ type: "SET_STATUS", status: `Error: ${err.message}` });
      }
    };

    initializeRoom();

    return () => {
      if (connRef.current?.ws) {
        connRef.current.ws.close();
      }
    };
  }, [handleWsEvent, params]);

  // Check Spotify status and handle OAuth callback
  useEffect(() => {
    if (!state.hostId) return;
    
    const checkSpotifyStatus = async () => {
      try {
        const resp = await fetch(`${API_BASE}/api/spotify/status?hostId=${encodeURIComponent(state.hostId)}`);
        if (resp.ok) {
          const data = await resp.json();
          dispatch({ type: "SET_SPOTIFY_LINKED", linked: data.linked });
        }
      } catch (err) {
        console.warn("Failed to check Spotify status:", err);
      }
    };

    // Check if this is a Spotify OAuth callback
    const spotifyOk = params.get("spotify");
    const callbackHostId = params.get("hostId");
    
    if (spotifyOk === "ok" && callbackHostId === state.hostId) {
      // Clear the URL parameters and refresh Spotify status
      window.history.replaceState({}, document.title, window.location.pathname);
      dispatch({ type: "SET_STATUS", status: "Spotify authentication completed, checking status..." });
      // Small delay to ensure backend has processed the token
      setTimeout(checkSpotifyStatus, 1000);
    } else {
      checkSpotifyStatus();
    }
  }, [state.hostId, params]);

  // Load playlists when Spotify is linked
  useEffect(() => {
    if (!state.spotifyLinked || !state.hostId) return;

    const loadPlaylists = async () => {
      try {
        const resp = await fetch(`${API_BASE}/api/spotify/playlists?hostId=${encodeURIComponent(state.hostId)}&limit=50`);
        if (resp.ok) {
          const data = await resp.json();
          const playlists = data.items?.map((p: any) => ({
            id: p.id,
            name: p.name,
            tracks: { total: p.tracks?.total || 0 }
          })) || [];
          dispatch({ type: "SET_PLAYLISTS", playlists });
        }
      } catch (err) {
        console.warn("Failed to load playlists:", err);
      }
    };

    loadPlaylists();
  }, [state.spotifyLinked, state.hostId]);

  const handleSpotifyLogin = useCallback(async () => {
    try {
      dispatch({ type: "SET_STATUS", status: "Redirecting to Spotify..." });
      // Persist identifiers so we can reconnect to the same room after OAuth redirect
      if (state.roomCode) sessionStorage.setItem("hitster_roomCode", state.roomCode);
      if (state.hostId) sessionStorage.setItem("hitster_hostId", state.hostId);
      const resp = await fetch(`${API_BASE}/api/spotify/login?hostId=${encodeURIComponent(state.hostId)}`);
      if (resp.ok) {
        const data = await resp.json();
        window.location.href = data.authorize_url;
      } else {
        dispatch({ type: "SET_STATUS", status: "Failed to get Spotify login URL" });
      }
    } catch (err: any) {
      dispatch({ type: "SET_STATUS", status: `Spotify login failed: ${err.message}` });
    }
  }, [state.hostId]);

  const handleStartGame = useCallback(async () => {
    if (!state.spotifyLinked) {
      dispatch({ type: "SET_STATUS", status: "Please link Spotify account first" });
      return;
    }
    if (!state.selectedPlaylistId) {
      dispatch({ type: "SET_STATUS", status: "Please select a playlist" });
      return;
    }
    if (state.players.length < 2) {
      dispatch({ type: "SET_STATUS", status: "Need at least 2 players to start" });
      return;
    }

    try {
      dispatch({ type: "SET_STATUS", status: "Starting game..." });
      
      const selectedPlaylist = state.playlists.find(p => p.id === state.selectedPlaylistId);
      const playlistName = selectedPlaylist?.name || "Hitster";

      console.log("[Lobby] Starting game with targetPoints:", state.targetPoints);

      if (connRef.current) {
        connRef.current.send("start", {
          hostId: state.hostId,
          playlistId: state.selectedPlaylistId,
          playlistName,
          tiePolicy: state.tiePolicy,
          targetPoints: state.targetPoints,
        });
      }
    } catch (err: any) {
      dispatch({ type: "SET_STATUS", status: `Failed to start game: ${err.message}` });
    }
  }, [state.spotifyLinked, state.selectedPlaylistId, state.players.length, state.hostId, state.playlists, state.tiePolicy, state.targetPoints, state.roomCode, handleWsEvent]);

  // Navigate to tabletop when game starts
  useEffect(() => {
    if (state.roomCode && (state.status.includes("Game started") || state.status.includes("playing"))) {
      navigate(`/tabletop?code=${state.roomCode}&hostId=${state.hostId}`);
    }
  }, [state.status, state.roomCode, state.hostId, navigate]);

  return (
    <div className="min-h-screen bg-zinc-950 text-white p-6">
      <div className="max-w-4xl mx-auto space-y-8">
        {/* Header */}
        <div className="text-center space-y-4">
          <h1 className="text-4xl font-bold text-emerald-400">HITSTER</h1>
          <h2 className="text-2xl font-semibold">Host Lobby</h2>
          <div className="text-lg text-zinc-400">
            Room Code: <span className="text-white font-mono text-2xl">{state.roomCode}</span>
          </div>
        </div>

        {/* Status */}
        <div className="bg-zinc-900/70 rounded-lg p-4">
          <div className="flex items-center justify-between">
            <span className="text-zinc-300">Status:</span>
            <span className={`font-semibold ${state.wsConnected ? 'text-emerald-400' : 'text-yellow-400'}`}>
              {state.status}
            </span>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          {/* Left Column - Setup */}
          <div className="space-y-6">
            {/* Spotify Connection */}
            <div className="bg-zinc-900/70 rounded-lg p-6">
              <h3 className="text-xl font-semibold mb-4">Spotify Connection</h3>
              {state.spotifyLinked ? (
                <div className="space-y-3">
                  <div className="flex items-center text-emerald-400">
                    <span className="mr-2">✓</span>
                    <span>Spotify Account Linked</span>
                  </div>
                  <div className="text-sm text-zinc-400">
                    {state.playlists.length} playlists available
                  </div>
                </div>
              ) : (
                <button
                  onClick={handleSpotifyLogin}
                  className="w-full bg-green-500 hover:bg-green-600 text-black font-semibold py-3 px-4 rounded-lg transition-colors"
                >
                  Link Spotify Account
                </button>
              )}
            </div>

            {/* Playlist Selection */}
            {state.spotifyLinked && (
              <div className="bg-zinc-900/70 rounded-lg p-6">
                <h3 className="text-xl font-semibold mb-4">Select Playlist</h3>
                <div className="space-y-2 max-h-60 overflow-y-auto">
                  {state.playlists.map((playlist) => (
                    <button
                      key={playlist.id}
                      onClick={() => dispatch({ type: "SET_SELECTED_PLAYLIST", playlistId: playlist.id })}
                      className={`w-full text-left p-3 rounded-lg transition-colors ${
                        state.selectedPlaylistId === playlist.id
                          ? "bg-emerald-500/20 border border-emerald-500"
                          : "bg-zinc-800 hover:bg-zinc-700"
                      }`}
                    >
                      <div className="font-medium">{playlist.name}</div>
                      <div className="text-sm text-zinc-400">{playlist.tracks.total} tracks</div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Game Settings */}
            <div className="bg-zinc-900/70 rounded-lg p-6">
              <h3 className="text-xl font-semibold mb-4">Game Settings</h3>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium mb-2">Tie Policy</label>
                  <div className="space-y-2">
                    <label className="flex items-center">
                      <input
                        type="radio"
                        name="tiePolicy"
                        value="lenient"
                        checked={state.tiePolicy === "lenient"}
                        onChange={(e) => dispatch({ type: "SET_TIE_POLICY", policy: e.target.value as "lenient" })}
                        className="mr-2"
                      />
                      <span>Lenient (allow ties)</span>
                    </label>
                    <label className="flex items-center">
                      <input
                        type="radio"
                        name="tiePolicy"
                        value="strict"
                        checked={state.tiePolicy === "strict"}
                        onChange={(e) => dispatch({ type: "SET_TIE_POLICY", policy: e.target.value as "strict" })}
                        className="mr-2"
                      />
                      <span>Strict (exact order required)</span>
                    </label>
                  </div>
                </div>
                
                <div>
                  <label className="block text-sm font-medium mb-2">Target Points to Win</label>
                  <input
                    type="number"
                    min="1"
                    max="100"
                    value={state.targetPoints}
                    onChange={(e) => {
                      const newValue = parseInt(e.target.value) || 10;
                      console.log("[Lobby] Setting targetPoints to:", newValue);
                      dispatch({ type: "SET_TARGET_POINTS", targetPoints: newValue });
                    }}
                    className="w-full px-3 py-2 bg-zinc-800 border border-zinc-600 rounded-lg text-white focus:outline-none focus:border-emerald-500"
                  />
                  <p className="text-xs text-zinc-400 mt-1">Game ends when a player reaches this score (1-100)</p>
                </div>
              </div>
            </div>

            {/* Start Game */}
            <button
              onClick={handleStartGame}
              disabled={!state.spotifyLinked || !state.selectedPlaylistId || state.players.length < 2}
              className="w-full bg-emerald-500 hover:bg-emerald-600 disabled:bg-zinc-700 disabled:text-zinc-400 text-black font-semibold py-4 px-6 rounded-lg transition-colors text-lg"
            >
              Start Game
            </button>
          </div>

          {/* Right Column - Players & QR */}
          <div className="space-y-6">
            {/* Connected Players */}
            <div className="bg-zinc-900/70 rounded-lg p-6">
              <h3 className="text-xl font-semibold mb-4">
                Connected Players ({state.players.length})
              </h3>
              {state.players.length === 0 ? (
                <div className="text-zinc-400 text-center py-8">
                  Waiting for players to join...
                </div>
              ) : (
                <div className="space-y-2">
                  {state.players.map((player) => (
                    <div key={player.id} className="flex items-center justify-between bg-zinc-800 rounded-lg p-3">
                      <span className="font-medium">{player.name}</span>
                      <span className="text-sm text-zinc-400">Seat {player.seat}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* QR Code */}
            {qrCode && (
              <div className="bg-zinc-900/70 rounded-lg p-6 text-center">
                <h3 className="text-xl font-semibold mb-4">Join Code</h3>
                <div className="space-y-4">
                  <img src={qrCode} alt="QR Code" className="mx-auto w-48 h-48" />
                  <div className="text-sm text-zinc-400">
                    Players can scan this QR code or visit:
                  </div>
                  <div className="text-emerald-400 font-mono text-sm break-all">
                    {window.location.origin}/join?code={state.roomCode}
                  </div>
                  <div className="pt-4 border-t border-zinc-700">
                    <a
                      href={`/tabletop?code=${state.roomCode}&hostId=${state.hostId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-block px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white font-semibold rounded-lg transition-colors"
                    >
                      📺 Open Tabletop View
                    </a>
                    <div className="text-xs text-zinc-500 mt-2">
                      Perfect for TV display
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
