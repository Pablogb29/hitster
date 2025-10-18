import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { connectWS } from "../lib/ws";

export default function Join() {
  const [params] = useSearchParams();
  const codeParam = params.get("code") ?? "";
  const safeMode = (params.get("safe") || "").trim() === "1";
  const [code, setCode] = useState(codeParam);
  const [name, setName] = useState("");
  const [joined, setJoined] = useState(false);
  const [, setRoom] = useState<any>(null);
  const [playerCard, setPlayerCard] = useState<any>(null);
  const [wins, setWins] = useState<Record<string, number>>({});
  const [myTurn, setMyTurn] = useState(false);
  const [currentSong, setCurrentSong] = useState<any>(null);
  const connRef = useRef<any>(null);
  const playerRef = useRef<any>(null);
  const [hostId, setHostId] = useState<string>("");
  const [deviceId, setDeviceId] = useState<string>("");
  const [, setPlayerReady] = useState(false);
  const [status, setStatus] = useState<string>("idle");

  const API_BASE = ((import.meta as any).env?.VITE_BACKEND_URL || (location.protocol + '//' + location.host))
    .replace(/\/+$/, '')
    .replace(/\/api$/, '');
  let WS_DEBUG_URL = "";
  try {
    const u = new URL(API_BASE);
    const wsProto = u.protocol === "https:" ? "wss:" : "ws:";
    WS_DEBUG_URL = `${wsProto}//${u.host}/ws/${encodeURIComponent(code)}`;
  } catch {
    const wsProto = location.protocol === "https:" ? "wss:" : "ws:";
    WS_DEBUG_URL = `${wsProto}//${location.host}/ws/${encodeURIComponent(code)}`;
  }
  const playerId = useMemo(() => "p-" + Math.random().toString(36).slice(2, 8), []);

  const join = () => {
    setStatus("connecting ws...");
    const ws = connectWS(code, (e) => {
      try {
        setStatus(`event: ${e.event}`);
        if (e.event === "room:state") { setRoom(e.data); setHostId(e.data?.hostId || ""); }
        else if (e.event === "game:init") {
          const data = e.data || {};
          setRoom({ code, players: data.players || [], state: "playing" });
          setPlayerCard((data.playerCards || {})[playerId] || null);
          setWins(data.wins || {});
        }
        else if (e.event === "turn:begin") {
          const data = e.data || {};
          setMyTurn(data.playerId === playerId);
          setCurrentSong(null);
        }
        else if (e.event === "turn:play") {
          const data = e.data || {};
          if (data.playerId === playerId) {
            setCurrentSong(data.song || null);
            // Trigger playback via Web Playback SDK (host's token)
            const uri = data.song?.uri;
            if (deviceId && uri && hostId) {
              // Try transfer + play with a light retry if not yet active
              fetch(`${API_BASE}/api/spotify/transfer`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ hostId, device_id: deviceId, play: true })
              }).catch(()=>{}).finally(() => {
                fetch(`${API_BASE}/api/spotify/play`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ hostId, device_id: deviceId, uri })
                }).then(async (r)=>{
                  if (!r.ok) {
                    const t = await r.text().catch(()=>"(no body)");
                    setStatus(prev=>`play ${r.status}: ${t} • `+prev);
                  } else {
                    setStatus(prev=>`play OK • `+prev);
                  }
                }).catch((err)=>{
                  setStatus(prev=>`play fetch err: ${err?.message||err} • `+prev);
                });
              });
              // After 700ms, check state; if still not playing, retry play once
              setTimeout(async () => {
                try {
                  const s = await fetch(`${API_BASE}/api/spotify/state?hostId=${hostId}`).then(r=>r.json());
                  if (!s?.is_playing) {
                    await fetch(`${API_BASE}/api/spotify/play`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ hostId, device_id: deviceId, uri }) });
                    setStatus(prev=>`retry play • `+prev);
                  }
                } catch {}
              }, 700);
            }
          } else {
            setCurrentSong(null);
          }
        }
        else if (e.event === "turn:result") {
          const data = e.data || {};
          setWins(data.wins || {});
          setCurrentSong(data.song || null);
          // Ensure playback is stopped when result is shown
          if (hostId) {
            fetch(`${API_BASE}/api/spotify/pause`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ hostId, device_id: deviceId })}).catch(()=>{});
          }
        }
        else if (e.event === "game:finished") {
          const data = e.data || {};
          alert(data.winner ? `Winner: ${data.winner}` : (data.reason || "Game finished"));
        }
      } catch (err: any) {
        console.error('WS handler error', err);
        setStatus(`handler error: ${err?.message || err}`);
      }
    });
    ws.send("join", { id: playerId, name, is_host: false });
    connRef.current = ws;
    setJoined(true);
    setStatus("joined");
  };

  // Load Spotify Web Playback SDK and init Player (must not be behind conditional returns)
  useEffect(() => {
    const init = async () => {
      if (!joined || !hostId) return; // wait until hostId is known
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
        playerRef.current = player;
        player.addListener('ready', async ({ device_id }: any) => {
          setDeviceId(device_id);
          setPlayerReady(true);
          setStatus(prev => `sdk-ready (${device_id}); ` + prev);
          // Try to activate device immediately
          try {
            const r = await fetch(`${API_BASE}/api/spotify/transfer`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ hostId, device_id: device_id, play: false })
            });
            setStatus(prev => `transfer ${r.status} • ` + prev);
          } catch {}
        });
        player.addListener('not_ready', () => {
          setPlayerReady(false);
          setStatus(prev => `sdk-not-ready; ` + prev);
        });
        player.connect();
      };
    };
    init();
  }, [joined, hostId]);

  async function ensureActivation() {
    try {
      const p: any = playerRef.current;
      if (p && typeof p.activateElement === 'function') {
        await p.activateElement();
        setStatus(prev => `activated • ` + prev);
      }
    } catch (e:any) {
      setStatus(prev => `activate err: ${e?.message||e} • ` + prev);
    }
  }

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

  const draw = async () => {
    await ensureActivation();
    if (!connRef.current) return;
    connRef.current.send("turn:draw", { playerId });
  };

  async function activateDevice() {
    if (!deviceId || !hostId) return;
    try {
      const r = await fetch(`${API_BASE}/api/spotify/transfer`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hostId, device_id: deviceId, play: true })
      });
      setStatus(prev => `manual transfer ${r.status} • ` + prev);
    } catch (e:any) {
      setStatus(prev => `transfer err: ${e?.message||e} • ` + prev);
    }
  }

  const guess = async (choice: "before" | "after") => {
    if (!connRef.current) return;
    try {
      if (hostId) {
        await fetch(`${API_BASE}/api/spotify/pause`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ hostId, device_id: deviceId })});
      }
    } catch {}
    connRef.current.send("turn:guess", { playerId, choice });
  };

  

  if (safeMode && joined) {
    return (
      <div className="min-h-screen bg-zinc-900 text-white p-6">
        <h2 className="text-xl font-semibold">Sala {code} (safe mode)</h2>
        <div className="text-xs opacity-70">Estado UI: {status} • hostId: {hostId || 'n/a'} • device: {deviceId || 'n/a'}</div>
        <div className="mt-2">Jugador: <span className="font-semibold">{name}</span></div>
        <div className="mt-4 flex gap-2">
          <button onClick={draw} className="px-3 py-2 bg-emerald-600 rounded">Play (draw)</button>
          <button onClick={()=>guess('before')} className="px-3 py-2 bg-blue-600 rounded">Before</button>
          <button onClick={()=>guess('after')} className="px-3 py-2 bg-purple-600 rounded">After</button>
        </div>
        <pre className="mt-4 text-xs bg-zinc-800 p-3 rounded overflow-auto max-h-64">{JSON.stringify({ myTurn, playerCard, currentSong, wins }, null, 2)}</pre>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-900 text-white p-6">
      <h2 className="text-xl font-semibold">Sala {code}</h2>
      <div className="mt-1 text-xs opacity-70">Estado: {status} • hostId: {hostId || 'n/a'} • device: {deviceId || 'n/a'}</div>
      <div className="text-xs opacity-70">WS: {WS_DEBUG_URL}</div>
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
                <>
                  <div className="mb-2 text-xs opacity-70">Device: {deviceId || 'n/a'} <button onClick={activateDevice} className="ml-2 px-2 py-1 bg-zinc-700 rounded">Activate</button></div>
                  <button onClick={draw} className="px-4 py-2 bg-emerald-600 rounded">▶ Play</button>
                </>
              ) : (
                <div>
                  <div className="text-xs opacity-70">Reproduciendo vía Spotify: {currentSong?.name} — {currentSong?.artists}</div>
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
