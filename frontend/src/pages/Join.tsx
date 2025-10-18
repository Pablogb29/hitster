import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { connectWS } from "../lib/ws";

export default function Join() {
  const [params] = useSearchParams();
  const codeParam = params.get("code") ?? "";
  const [code, setCode] = useState(codeParam);
  const [name, setName] = useState("");
  const [joined, setJoined] = useState(false);
  const [, setConn] = useState<any>(null);
  const playerId = useMemo(() => "p-" + Math.random().toString(36).slice(2, 8), []);

  const join = () => {
    const ws = connectWS(code, () => {
      // puedes manejar room:state aquí si quieres ver info
    });
    ws.send("join", { id: playerId, name, isHost: false });
    setConn(ws);
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

  return (
    <div className="min-h-screen bg-zinc-900 text-white p-6">
      <h2 className="text-xl font-semibold">Conectado a {code}</h2>
      <p className="opacity-80 mt-2">Hola, {name}. Espera a que el host empiece.</p>
    </div>
  );
}
