import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { connectWS } from "../lib/ws";

export default function Join() {
  const [params] = useSearchParams();
  const codeParam = params.get("code") ?? "";
  const [code, setCode] = useState(codeParam);
  const [name, setName] = useState("");
  const [joined, setJoined] = useState(false);
  const [room, setRoom] = useState<any>(null);
  const [playerCard, setPlayerCard] = useState<any>(null);
  const [wins, setWins] = useState<Record<string, number>>({});
  const [myTurn, setMyTurn] = useState(false);
  const [currentSong, setCurrentSong] = useState<any>(null);
  const connRef = useRef<any>(null);
  const [hostId, setHostId] = useState<string>("");
  const [deviceId, setDeviceId] = useState<string>("");
  const [playerReady, setPlayerReady] = useState(false);

  const API_BASE = ((import.meta as any).env?.VITE_BACKEND_URL || (location.protocol + '//' + location.host))
    .replace(/\/+$/, '')
    .replace(/\/api$/, '');
  const playerId = useMemo(() => "p-" + Math.random().toString(36).slice(2, 8), []);

  const join = () => {
    const ws = connectWS(code, (e) => {
      if (e.event === "room:state") { setRoom(e.data); setHostId(e.data.hostId); }
      if (e.event === "game:init") {
        setRoom({ code, players: e.data.players, state: "playing" });
        setPlayerCard(e.data.playerCards[playerId]);
        setWins(e.data.wins || {});
      }
      if (e.event === "turn:begin") {
        setMyTurn(e.data.playerId === playerId);
        setCurrentSong(null);
      }
      if (e.event === "turn:play") {
        if (e.data.playerId === playerId) {
          setCurrentSong(e.data.song);
          // Trigger playback via Web Playback SDK (host's token)
          if (deviceId && e.data.song?.uri) {
            fetch(`${API_BASE}/api/spotify/play`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ hostId, device_id: deviceId, uri: e.data.song.uri })
            }).catch(()=>{});
          }
        } else {
          setCurrentSong(null);
        }
      }
      if (e.event === "turn:result") {
        setWins(e.data.wins || {});
        setCurrentSong(e.data.song); // revealed, show details if desired
      }
      if (e.event === "game:finished") {
        alert(e.data.winner ? `Winner: ${e.data.winner}` : (e.data.reason || "Game finished"));
      }
    });
    ws.send("join", { id: playerId, name, is_host: false });
    connRef.current = ws;
    setJoined(true);
  };

  if (!joined)
    return (
      <div className="min-h-screen bg-zinc-900 text-white p-6">
        <h1 className="text-2xl font-bold">Unirse a sala</h1>
        <input value={code} onChange={e=>setCode(e.target.value)} placeholder="Código"
               className="mt-4 px-3 py-2 rounded bg-zinc-800 w-full"/>
        <input value={name} onChange={e=>setName(e.target.value)} placeholder="Tu nombre"
               className="mt-3 px-3 py-2 rounded bg-zinc-800 w-full"/>
        <button onClick={join} disabled={!code || !name}
                className="mt-4 px-4 py-2 bg-emerald-600 rounded disabled:opacity-50">Join</button>
      </div>
    );

  const draw = () => {
    if (!connRef.current) return;
    connRef.current.send("turn:draw", { playerId });
  };

  const guess = (choice: "before" | "after") => {
    if (!connRef.current) return;
    connRef.current.send("turn:guess", { playerId, choice });
  };

  return (
    <div className="min-h-screen bg-zinc-900 text-white p-6">
      <h2 className="text-xl font-semibold">Sala {code}</h2>
      <div className="mt-2">Jugador: <span className="font-semibold">{name}</span></div>
      <div className="mt-4 grid md:grid-cols-2 gap-6">
        <div className="p-4 bg-zinc-800 rounded">
          <div className="text-sm opacity-70">Tu carta</div>
          {playerCard ? (
            <div className="mt-2 border border-zinc-700 rounded p-3">
              <div className="text-lg font-semibold">{playerCard.name}</div>
              <div className="opacity-80">{playerCard.artists}</div>
              <div className="opacity-80">Año: {playerCard.year}</div>
            </div>
          ) : (
            <div className="mt-2 text-sm opacity-70">Esperando inicio...</div>
          )}
          <div className="mt-3 text-sm">Tus cartas ganadas: <span className="font-semibold">{wins[playerId] ?? 0}</span></div>
        </div>
        <div className="p-4 bg-zinc-800 rounded">
          <div className="text-sm opacity-70 mb-2">Mazo central</div>
          {myTurn ? (
            <div>
              {!currentSong ? (
                <button onClick={draw} className="px-4 py-2 bg-emerald-600 rounded">▶ Play</button>
              ) : (
                <div>
                  {currentSong.preview_url ? (
                    <audio src={currentSong.preview_url} autoPlay controls className="w-full"/>
                  ) : (
                    <div className="text-xs opacity-70">Sin preview disponible</div>
                  )}
                  <div className="mt-3 flex gap-2">
                    <button onClick={()=>guess("before")} className="px-3 py-2 bg-blue-600 rounded">Antes</button>
                    <button onClick={()=>guess("after")} className="px-3 py-2 bg-purple-600 rounded">Después</button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="text-sm opacity-70">Espera tu turno...</div>
          )}
        </div>
      </div>
    </div>
  );
}
  // Load Spotify Web Playback SDK and init Player
  useEffect(() => {
    if (!joined) return;
    // Inject SDK
    const existing = document.getElementById('spotify-sdk');
    if (!existing) {
      const s = document.createElement('script');
      s.id = 'spotify-sdk';
      s.src = 'https://sdk.scdn.co/spotify-player.js';
      s.async = true;
      document.body.appendChild(s);
    }
    (window as any).onSpotifyWebPlaybackSDKReady = () => {
      const player = new (window as any).Spotify.Player({
        name: 'HITSTER Player',
        getOAuthToken: async (cb: any) => {
          try {
            const r = await fetch(`${API_BASE}/api/spotify/token?hostId=${hostId}`);
            if (!r.ok) return;
            const data = await r.json();
            cb(data.access_token);
          } catch {}
        },
        volume: 0.8,
      });
      player.addListener('ready', ({ device_id }: any) => {
        setDeviceId(device_id);
        setPlayerReady(true);
      });
      player.addListener('not_ready', () => {
        setPlayerReady(false);
      });
      player.connect();
    };
  }, [joined, hostId]);
