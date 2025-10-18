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
  const API_BASE = ((import.meta as any).env?.VITE_BACKEND_URL || "http://localhost:8000").replace(/\/+$/,'');

  async function createRoom() {
    const r = await fetch(`${API_BASE}/api/create-room`).then(r=>r.json());
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
    conn.send("join", { id: r.hostId, name: "HOST", isHost: true });
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
        <button onClick={createRoom} className="mt-6 px-6 py-3 bg-emerald-600 rounded">
          Create Room
        </button>
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
