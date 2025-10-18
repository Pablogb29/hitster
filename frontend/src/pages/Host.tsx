import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { connectWS } from "../lib/ws";

type Player = { id:string; name:string; seat:number; score:number; is_host:boolean };
type Room = {
  code:string;
  players:Player[];
  state?: "lobby"|"playing"|"finished";
  turnIndex?: number;
};

export default function Host() {
  const [room, setRoom] = useState<Room| null>(null);
  const [qr, setQr] = useState<string>("");
  const [ws, setWs] = useState<any>(null);
  const [hostId, setHostId] = useState<string>("");
  const [health, setHealth] = useState<string>("");
  const [spotifyLinked, setSpotifyLinked] = useState<boolean>(false);
  const [playlists, setPlaylists] = useState<any[]>([]);
  function resolveDefaultBackendBase() {
    if (typeof location !== "undefined" && location.host === "frontend-production-62902.up.railway.app") {
      return "https://backend-production-f463.up.railway.app";
    }
    return "http://localhost:8000";
  }
  const API_BASE = ((import.meta as any).env?.VITE_BACKEND_URL || resolveDefaultBackendBase())
    .replace(/\/+$/, '')
    .replace(/\/api$/, '');

  async function createRoom() {
    try {
      const url = hostId ? `${API_BASE}/api/create-room?hostId=${encodeURIComponent(hostId)}`
                         : `${API_BASE}/api/create-room`;
      const res = await fetch(url, { mode: 'cors' as RequestMode });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      const r = await res.json();
      setRoom({ code: r.code, players: [], state: "lobby", turnIndex: 0 });
      setHostId(r.hostId);
      const url = `${location.origin}/join?code=${r.code}`;
      setQr(await QRCode.toDataURL(url));

      const conn = connectWS(r.code, (e) => {
        if (e.event === "room:state" || e.event === "game:start") setRoom(e.data);
        if (e.event === "turn:begin") {
          setRoom(prev => {
            if (!prev) return prev;
            const idx = prev.players.findIndex(p => p.id === e.data.playerId);
            return { ...prev, turnIndex: idx };
          });
        }
      });
      setWs(conn);
      // Backend expects snake_case field name `is_host`
      conn.send("join", { id: r.hostId, name: "HOST", is_host: true });
      // check spotify status in case user just linked
      try {
        const st = await fetch(`${API_BASE}/api/spotify/status?hostId=${r.hostId}`).then(r=>r.json());
        setSpotifyLinked(!!st?.linked);
        if (st?.linked) {
          const pls = await fetch(`${API_BASE}/api/spotify/playlists?hostId=${r.hostId}`).then(r=>r.json());
          setPlaylists(pls?.items || []);
        }
      } catch {}
    } catch (err) {
      console.error("Failed to create room:", err);
      alert("Failed to create room. Check BACKEND URL configuration.");
    }
  }

  // On mount, pick up hostId from URL (after Spotify callback)
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const hid = params.get('hostId');
      const spok = params.get('spotify');
      if (hid) {
        setHostId(hid);
      }
      if (hid && spok === 'ok') {
        // Check linked status and preload playlists
        fetch(`${API_BASE}/api/spotify/status?hostId=${hid}`).then(r=>r.json()).then(st => {
          setSpotifyLinked(!!st?.linked);
          if (st?.linked) {
            fetch(`${API_BASE}/api/spotify/playlists?hostId=${hid}`).then(r=>r.json()).then(pls => {
              setPlaylists(pls?.items || []);
            }).catch(()=>{});
          }
        }).catch(()=>{});
      }
    } catch {}
  }, []);

  async function testBackend() {
    setHealth("testing...");
    try {
      const res = await fetch(`${API_BASE}/api/health`, { mode: 'cors' as RequestMode });
      const data = await res.json();
      setHealth(`ok: ${res.status} ${JSON.stringify(data)}`);
    } catch (e: any) {
      console.error("Health check failed", e);
      setHealth(`error: ${e?.message || e}`);
    }
  }

  function connectSpotify() {
    if (!hostId) return;
    // Step 1: ask backend for authorize URL (so we keep client_secret safe)
    fetch(`${API_BASE}/api/spotify/login?hostId=${hostId}`).then(r=>r.json()).then(data => {
      if (data?.authorize_url) {
        window.location.href = data.authorize_url as string;
      } else {
        alert("Spotify is not configured on backend.");
      }
    }).catch(() => alert("Failed to start Spotify login."));
  }

  function startGame() {
    if (!ws || !room) return;
    ws.send("start", { hostId });
  }

  useEffect(() => { /* crear sala manualmente con botón */ }, []);

  return (
    <div className="min-h-screen bg-zinc-900 text-white p-6 max-w-4xl mx-auto">
      <h1 className="text-3xl font-bold">HITSTER — Host</h1>

      {!room ? (
        <>
          <button onClick={createRoom} className="mt-6 px-6 py-3 bg-emerald-600 rounded">
            Create Room
          </button>
          <div className="mt-2 text-xs text-zinc-400">API: {API_BASE}</div>
          <div className="mt-2">
            <button onClick={testBackend} className="px-3 py-1 text-xs bg-zinc-700 rounded">Test Backend</button>
            {health && <div className="mt-1 text-xs">Health: {health}</div>}
          </div>
        </>
      ) : (
        <div className="mt-6 grid md:grid-cols-2 gap-6">
          <div className="p-4 rounded bg-zinc-800">
            <div className="text-sm opacity-80">Código</div>
            <div className="text-3xl font-mono">{room.code}</div>
            {qr && <img src={qr} alt="QR" className="mt-4 w-40 h-40 bg-white p-2 rounded" />}

            <button
              onClick={startGame}
              disabled={room.state === "playing" || (room.players?.length ?? 0) < 2}
              className="mt-4 px-4 py-2 bg-blue-600 rounded disabled:opacity-50"
            >
              Start Game
            </button>

            <div className="mt-4 border-t border-zinc-700 pt-3">
              <div className="flex items-center justify-between">
                <div className="font-semibold">Spotify</div>
                {!spotifyLinked && (
                  <button onClick={connectSpotify} className="px-3 py-1 text-xs bg-emerald-600 rounded">Connect</button>
                )}
              </div>
              {spotifyLinked ? (
                <div className="mt-2 text-sm">Linked. Your playlists:</div>
              ) : (
                <div className="mt-2 text-xs opacity-75">Connect to list your playlists.</div>
              )}
              {spotifyLinked && (
                <ul className="mt-2 space-y-1 max-h-48 overflow-auto">
                  {playlists.map((p:any) => (
                    <li key={p.id} className="flex items-center justify-between text-sm">
                      <span className="truncate">{p.name}</span>
                      <span className="opacity-60">{p.tracks?.total ?? 0} tracks</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {room?.state === "playing" && room?.turnIndex !== undefined && (
              <div className="mt-3 px-3 py-2 bg-emerald-700/40 rounded">
                Turno de: <span className="font-semibold">
                  {room.players[room.turnIndex]?.name}
                </span>
              </div>
            )}
          </div>

          <div className="p-4 rounded bg-zinc-800">
            <div className="font-semibold mb-2">Jugadores</div>
            <ul className="space-y-2">
              {room.players?.map(p => (
                <li key={p.id} className="flex justify-between border border-zinc-700 rounded px-3 py-2">
                  <span>{p.name}{p.is_host ? " (host)" : ""}</span>
                  <span>⭐ {p.score}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
