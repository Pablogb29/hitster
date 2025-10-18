export type WSEvent = { event: string; data: any };

function buildWsUrl(code: string) {
  const cfg = (import.meta as any).env?.VITE_BACKEND_URL as string | undefined;
  let httpBase = (cfg && cfg.trim().length > 0 ? cfg : "http://localhost:8000").replace(/\/+$/,'');
  try {
    const u = new URL(httpBase);
    const wsProto = u.protocol === "https:" ? "wss:" : "ws:";
    return `${wsProto}//${u.host}/ws/${code}`;
  } catch {
    // Fallback to current origin
    const proto = location.protocol === "https:" ? "wss" : "ws";
    return `${proto}://${location.host}/ws/${code}`;
  }
}

export function connectWS(code: string, onMsg: (e: WSEvent) => void) {
  const url = buildWsUrl(code);
  const ws = new WebSocket(url);

  let isOpen = false;
  const queue: string[] = [];

  ws.addEventListener("open", () => {
    isOpen = true;
    for (const m of queue) ws.send(m);
    queue.length = 0;
  });

  ws.onmessage = (m) => onMsg(JSON.parse(m.data));

  return {
    send(event: string, data: any) {
      const payload = JSON.stringify({ event, data });
      if (isOpen && ws.readyState === WebSocket.OPEN) ws.send(payload);
      else queue.push(payload);
    },
    ws,
  };
}
