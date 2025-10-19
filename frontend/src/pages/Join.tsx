import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { connectWS, type WSEvent } from "../lib/ws";

const FORCE_PLAY_URI = "spotify:track:4uLU6hMCjMI75M1A2tKUQC"; // Known playable track

type SongLike = {
  uri?: string | null;
  id?: string | null;
  name?: string;
  artists?: string;
};

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
  const [currentSong, setCurrentSong] = useState<SongLike | null>(null);
  const connRef = useRef<any>(null);
  const playerRef = useRef<any>(null);
  const playLockRef = useRef<boolean>(false);
  const lastTurnIdRef = useRef<string | null>(null);
  const [playDisabled, setPlayDisabled] = useState(false);
  const [hostId, setHostId] = useState<string>("");
  const [deviceId, setDeviceId] = useState<string>("");
  const [, setPlayerReady] = useState(false);
  const [status, setStatus] = useState<string>("idle");
  const [phase, setPhase] = useState<'playing' | 'guess' | 'result' | 'idle'>("idle");
  const phaseRef = useRef<'playing' | 'guess' | 'result' | 'idle'>("idle");
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  const [lastEventType, setLastEventType] = useState<string>("");
  const [lastEventTs, setLastEventTs] = useState<number | null>(null);
  const [lastEventTurnId, setLastEventTurnId] = useState<string | null>(null);
  const [playLock, setPlayLock] = useState(false);
  const [lastQueueNextStatus, setLastQueueNextStatus] = useState<string>("");
  const [lastPlayTrackStatus, setLastPlayTrackStatus] = useState<string>("");
  const lastPlayClickTsRef = useRef<number | null>(null);
  const [lastPlayClickTs, setLastPlayClickTs] = useState<number | null>(null);
  const hasPlayedThisTurnRef = useRef(false);
  const [hasPlayedThisTurn, setHasPlayedThisTurn] = useState(false);
  const [duplicateTurnDetected, setDuplicateTurnDetected] = useState(false);
  const [backendStats, setBackendStats] = useState<any>(null);
  const [backendStatsTs, setBackendStatsTs] = useState<number | null>(null);
  const [lastPlayPath, setLastPlayPath] = useState<string | null>(null);
  const [lastTargetUri, setLastTargetUri] = useState<string | null>(null);
  const [lastObservedUri, setLastObservedUri] = useState<string | null>(null);
  const [lastIsPlaying, setLastIsPlaying] = useState<boolean | null>(null);
  const [guessLockUntil, setGuessLockUntil] = useState<number>(0);
  const guessLockUntilRef = useRef<number>(0);

  const LISTENING_WINDOW_MS = 700;
  const normalizeUri = (input?: string | null) => {
    if (!input) return null;
    return input.startsWith("spotify:track:") ? input : `spotify:track:${input}`;
  };

  const API_BASE = ((import.meta as any).env?.VITE_BACKEND_URL || (location.protocol + "//" + location.host))
    .replace(/\/+$/, "")
    .replace(/\/api$/, "");

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

  const handleWsEvent = (evt: WSEvent) => {
    const eventType = evt?.event || "unknown";
    const data = evt?.data ?? {};
    const ts = Date.now();

    setLastEventType(eventType);
    setLastEventTs(ts);
    setLastEventTurnId(data.turnId ?? null);
    setStatus(`event: ${eventType} (phase=${phaseRef.current})`);

    console.log("[EVT]", eventType, data.turnId, "phase=", phaseRef.current);

    if (eventType === "room:state") {
      setRoom(data);
      setHostId(data?.hostId || "");
      return;
    }

    if (eventType === "game:init") {
      setRoom({ code, players: data.players || [], state: "playing" });
      setPlayerCard((data.playerCards || {})[playerId] || null);
      setWins(data.wins || {});
      hasPlayedThisTurnRef.current = false;
      setHasPlayedThisTurn(false);
      setPhase("idle");
      setDuplicateTurnDetected(false);
      setLastPlayPath(null);
      setLastTargetUri(null);
      setLastObservedUri(null);
      setLastIsPlaying(null);
      setGuessLockUntil(0);
      guessLockUntilRef.current = 0;
      return;
    }

    if (eventType === "turn:begin") {
      const isMine = data.playerId === playerId;
      setMyTurn(isMine);
      setCurrentSong(null);
      setPhase("idle");
      hasPlayedThisTurnRef.current = false;
      setHasPlayedThisTurn(false);
      setDuplicateTurnDetected(false);
      setLastPlayPath(null);
      setLastTargetUri(null);
      setLastObservedUri(null);
      setLastIsPlaying(null);
      setGuessLockUntil(0);
      guessLockUntilRef.current = 0;
      if (!isMine) {
        console.log("[EVT:SKIP]", "turn:begin for other player", { playerId: data.playerId });
      }
      return;
    }

    if (eventType === "turn:play") {
      const incomingTurnId = typeof data.turnId === "string" ? data.turnId : (data.turnId ?? "").toString();
      console.log("[EVT] turn:play detail", { incomingTurnId, lastTurnId: lastTurnIdRef.current, playerId: data.playerId });
      if (incomingTurnId) {
        if (lastTurnIdRef.current === incomingTurnId) {
          console.log("[EVT:SKIP]", "same turnId (debug: allowing replay)");
          setDuplicateTurnDetected(true);
        } else {
          lastTurnIdRef.current = incomingTurnId;
          setDuplicateTurnDetected(false);
        }
      }
      const isMine = data.playerId === playerId;
      if (!isMine) {
        console.log("[EVT:SKIP]", "not current player", { playerId: data.playerId });
        setMyTurn(false);
        setCurrentSong(null);
        setPhase("idle");
        setLastPlayPath(null);
        return;
      }
      setMyTurn(true);
      setCurrentSong(data.song || null);
      setPhase("playing");
      setLastPlayPath("pending");
      setLastTargetUri(null);
      setLastObservedUri(null);
      setLastIsPlaying(null);
      if (!data.song) {
        console.log("[EVT:SKIP]", "no song payload provided");
        return;
      }
      handleTurnPlay({ turnId: incomingTurnId, data: { song: data.song } });
      return;
    }

    if (eventType === "turn:result") {
      setWins(data.wins || {});
      setCurrentSong(data.song || null);
      setPhase("result");
      if (hostId && hasPlayedThisTurnRef.current) {
        fetch(`${API_BASE}/api/spotify/pause`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ hostId, device_id: deviceId, reason: "result" }),
        }).catch(() => {});
      } else {
        console.log("[EVT:SKIP]", "pause skipped until playback confirmed", { hasPlayedThisTurn: hasPlayedThisTurnRef.current });
      }
      return;
    }

    if (eventType === "game:error") {
      setStatus((prev) => `game error: ${data?.message || "unknown"} | ` + prev);
      console.warn("[EVT] game:error", data);
      return;
    }

    if (eventType === "game:finished") {
      alert(data.winner ? `Winner: ${data.winner}` : (data.reason || "Game finished"));
      return;
    }
  };

  const join = () => {
    setStatus("connecting ws...");
    const ws = connectWS(code, (evt) => {
      const ts = Date.now();
      const turnId = evt?.data?.turnId;
      console.log("[WS]", evt?.event, { turnId, phase: phaseRef.current, ts });
      try {
        handleWsEvent(evt);
      } catch (err: any) {
        console.error("[EVT:ERROR]", err);
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
      const existing = document.getElementById("spotify-sdk");
      if (!existing) {
        const s = document.createElement("script");
        s.id = "spotify-sdk";
        s.src = "https://sdk.scdn.co/spotify-player.js";
        s.async = true;
        document.body.appendChild(s);
      }
      (window as any).onSpotifyWebPlaybackSDKReady = () => {
        const player = new (window as any).Spotify.Player({
          name: "HITSTER Player",
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
        player.addListener("ready", async ({ device_id }: any) => {
          setDeviceId(device_id);
          setPlayerReady(true);
          setStatus((prev) => `sdk-ready (${device_id}); ` + prev);
          try {
            const r = await fetch(`${API_BASE}/api/spotify/transfer`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ hostId, device_id, play: false }),
            });
            setStatus((prev) => `transfer ${r.status} | ` + prev);
          } catch {}
        });
        player.addListener("not_ready", () => {
          setPlayerReady(false);
          setStatus((prev) => `sdk-not-ready | ` + prev);
        });
        player.connect();
      };
    };
    init();
  }, [joined, hostId, API_BASE]);

  async function ensureActivation() {
    try {
      const p: any = playerRef.current;
      if (p && typeof p.activateElement === "function") {
        await p.activateElement();
        setStatus((prev) => `activated | ` + prev);
      }
    } catch (e: any) {
      setStatus((prev) => `activate err: ${e?.message || e} | ` + prev);
    }
  }

  const draw = async () => {
    if (playLockRef.current) {
      console.log("[DRAW:SKIP]", "playLock active");
      return;
    }
    playLockRef.current = true;
    setPlayLock(true);
    setPlayDisabled(true);
    try {
      await ensureActivation();
      if (!connRef.current) return;
      connRef.current.send("turn:draw", { playerId, deviceId });
      setStatus((prev) => `draw sent | ` + prev);
    } finally {
      playLockRef.current = false;
      setPlayLock(false);
      setPlayDisabled(false);
    }
  };

  async function activateDevice() {
    if (!deviceId || !hostId) return;
    try {
      const r = await fetch(`${API_BASE}/api/spotify/transfer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostId, device_id: deviceId, play: true }),
      });
      setStatus((prev) => `manual transfer ${r.status} | ` + prev);
    } catch (e: any) {
      setStatus((prev) => `transfer err: ${e?.message || e} | ` + prev);
    }
  }

  const guess = async (choice: "before" | "after") => {
    if (!connRef.current) return;
    const now = Date.now();
    if (now < guessLockUntilRef.current) {
      console.log("[GUESS:SKIP]", "listening window active", {
        remaining: guessLockUntilRef.current - now,
      });
      setStatus(`guess locked ${guessLockUntilRef.current - now}ms`);
      return;
    }
    guessLockUntilRef.current = 0;
    setGuessLockUntil(0);
    try {
      setPhase("guess");
      if (hostId && hasPlayedThisTurnRef.current) {
        await fetch(`${API_BASE}/api/spotify/pause`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ hostId, device_id: deviceId, reason: "guess" }),
        });
      } else {
        console.log("[PAUSE:SKIP]", "guess pause skipped", { hasPlayedThisTurn: hasPlayedThisTurnRef.current });
      }
    } catch {}
    connRef.current.send("turn:guess", { playerId, choice });
  };

  async function handleTurnPlay(evt: { turnId: string; data: { song: SongLike } }) {
    console.log("[HANDLE TURN PLAY]", { turnId: evt.turnId, lastTurnId: lastTurnIdRef.current });
    if (evt.turnId && lastTurnIdRef.current !== evt.turnId) {
      lastTurnIdRef.current = evt.turnId;
    }
    return onPlayOnce(evt.data.song, evt.turnId);
  }

  async function onPlayOnce(song: SongLike, turnId?: string) {
    if (playLockRef.current) {
      console.log("[PLAY:SKIP]", "lock active");
      return;
    }
    if (!deviceId || !hostId) {
      console.log("[PLAY:SKIP]", "missing device or host", { deviceId, hostId });
      return;
    }
    playLockRef.current = true;
    setPlayLock(true);
    setPlayDisabled(true);
    setLastPlayPath("pending");
    setLastObservedUri(null);
    setLastIsPlaying(null);
    setLastPlayTrackStatus("");
    const now = Date.now();
    lastPlayClickTsRef.current = now;
    setLastPlayClickTs(now);

    const uri = song?.uri ?? null;
    const id = song?.id ?? null;
    const targetUri = normalizeUri(uri || (id ? `spotify:track:${id}` : null));
    setLastTargetUri(targetUri);

    const body = { hostId, device_id: deviceId, uri, id, turn_id: turnId ?? null };
    console.log("[PLAY] queue_next", `${API_BASE}/api/spotify/queue_next`, body);
    setLastQueueNextStatus("pending");
    try {
      const queueResp = await fetch(`${API_BASE}/api/spotify/queue_next`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });

      if (queueResp.status === 202) {
        const payload = await queueResp.json().catch(() => ({}));
        const label = payload?.status ? `202 ${payload.status}` : "202 in-flight";
        setLastQueueNextStatus(label);
        setStatus(label);
        setLastPlayPath("pending");
        setLastPlayTrackStatus(label);
        setLastObservedUri(null);
        setLastIsPlaying(null);
        return;
      }

      if (!queueResp.ok) {
        const text = await queueResp.text().catch(() => "");
        const label = `error ${queueResp.status} ${text}`.trim();
        setLastQueueNextStatus(label);
        setStatus(label);
        setLastPlayPath("error");
        setLastPlayTrackStatus(label);
        setLastObservedUri(null);
        setLastIsPlaying(null);
        return;
      }

      const data = await queueResp.json().catch(() => ({}));
      const observed = normalizeUri(data?.observed_uri ?? data?.observedUri ?? null);
      const playing = typeof data?.is_playing === "boolean" ? data.is_playing : null;
      const path = data?.path || "queue";

      setLastQueueNextStatus(`ok ${queueResp.status}`);
      setStatus(`queue_next path=${path} playing=${playing}`);
      setLastPlayPath(path);
      setLastObservedUri(observed);
      setLastIsPlaying(playing);
      setLastPlayTrackStatus(`server path ${path}`);

      if (playing === true || observed === targetUri) {
        hasPlayedThisTurnRef.current = true;
        setHasPlayedThisTurn(true);
        const unlockAt = Date.now() + LISTENING_WINDOW_MS;
        setGuessLockUntil(unlockAt);
        guessLockUntilRef.current = unlockAt;
      }
    } catch (err: any) {
      setLastQueueNextStatus(`exception ${err?.message || err}`);
      console.error("[PLAY] exception", err);
    } finally {
      playLockRef.current = false;
      setPlayLock(false);
      setPlayDisabled(false);
    }
  }

  async function forcePlayTest() {
    if (!hostId || !deviceId) {
      console.warn("[FORCE PLAY] missing host/device", { hostId, deviceId });
      return;
    }
    try {
      console.log("[FORCE PLAY]", { uri: FORCE_PLAY_URI });
      const r = await fetch(`${API_BASE}/api/spotify/play_track`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ hostId, device_id: deviceId, uri: FORCE_PLAY_URI }),
      });
      setLastPlayTrackStatus(`force ${r.status}`);
    } catch (err: any) {
      setLastPlayTrackStatus(`force error ${err?.message || err}`);
    }
  }

  async function refreshDebugStats() {
    if (!hostId) {
      console.log("[DEBUG STATS]", "skip (no hostId)");
      return;
    }
    try {
      const r = await fetch(`${API_BASE}/api/debug/stats?hostId=${encodeURIComponent(hostId)}`);
      if (!r.ok) {
        const text = await r.text().catch(() => "");
        console.warn("[DEBUG STATS] HTTP", r.status, text);
        setBackendStats({ error: r.status, text });
        setBackendStatsTs(Date.now());
        return;
      }
      const data = await r.json();
      setBackendStats(data);
      setBackendStatsTs(Date.now());
      console.log("[DEBUG STATS]", data);
    } catch (err) {
      setBackendStats({ error: err instanceof Error ? err.message : String(err) });
      setBackendStatsTs(Date.now());
    }
  }

  const guessLocked = Date.now() < guessLockUntil;

  const playButtonDisabled =
    playDisabled || !myTurn || phase !== "playing" || !currentSong || !deviceId || !hostId;
  const playDisabledReasons: string[] = [];
  if (playDisabled) playDisabledReasons.push("playDisabled state");
  if (!myTurn) playDisabledReasons.push("not my turn");
  if (phase !== "playing") playDisabledReasons.push(`phase ${phase}`);
  if (!currentSong) playDisabledReasons.push("no current song");
  if (!deviceId) playDisabledReasons.push("no deviceId");
  if (!hostId) playDisabledReasons.push("no hostId");

  const hudLines = [
    `phase: ${phase}`,
    `isCurrentPlayer: ${myTurn}`,
    `lastTurnId: ${lastTurnIdRef.current || "-"}`,
    `lastEventType: ${lastEventType || "-"}`,
    `lastEventTurnId: ${lastEventTurnId || "-"}`,
    `lastEventTs: ${lastEventTs ? new Date(lastEventTs).toLocaleTimeString() : "-"}`,
    `playDisabled: ${playButtonDisabled}`,
    `playDisabledReasons: ${playDisabledReasons.join(", ") || "none"}`,
    `playLock: ${playLock}`,
    `lastPlayClickTs: ${lastPlayClickTs ? new Date(lastPlayClickTs).toLocaleTimeString() : "-"}`,
    `deviceId: ${deviceId || "n/a"}`,
    `hostId: ${hostId || "n/a"}`,
    `lastQueueNextStatus: ${lastQueueNextStatus || "n/a"}`,
    `lastPlayTrackStatus: ${lastPlayTrackStatus || "n/a"}`,
    `lastPlayPath: ${lastPlayPath || "-"}`,
    `lastTargetUri: ${lastTargetUri || "-"}`,
    `lastObservedUri: ${lastObservedUri || "-"}`,
    `lastIsPlaying: ${lastIsPlaying === null ? "n/a" : lastIsPlaying}`,
    `hasPlayedThisTurn: ${hasPlayedThisTurn}`,
    `duplicateTurnDetected: ${duplicateTurnDetected}`,
    `guessLockActive: ${guessLocked}`,
    `guessLockUntil: ${guessLockUntil ? new Date(guessLockUntil).toLocaleTimeString() : "-"}`,
    `backendStatsTs: ${backendStatsTs ? new Date(backendStatsTs).toLocaleTimeString() : "-"}`,
  ];

  const hud = (
    <div className="fixed top-2 left-2 z-50 max-w-sm space-y-1 rounded bg-black/80 p-3 text-xs text-white">
      <div className="font-semibold">Debug HUD</div>
      {hudLines.map((line) => (
        <div key={line}>{line}</div>
      ))}
      {backendStats && (
        <pre className="max-h-40 overflow-auto rounded bg-black/40 p-2">
{JSON.stringify(backendStats, null, 2)}
        </pre>
      )}
    </div>
  );

  if (!joined)
    return (
      <div className="min-h-screen bg-zinc-900 p-6 text-white">
        {hud}
        <h1 className="text-2xl font-bold">Join Room</h1>
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="Code"
          className="mt-4 w-full rounded bg-zinc-800 px-3 py-2"
        />
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Your name"
          className="mt-3 w-full rounded bg-zinc-800 px-3 py-2"
        />
        <button
          onClick={join}
          disabled={!code || !name}
          className="mt-4 rounded bg-emerald-600 px-4 py-2 disabled:opacity-50"
        >
          Join
        </button>
      </div>
    );

  const safeTools = (
    <div className="mt-2 flex flex-wrap gap-2 text-xs">
      <span>WS: {WS_DEBUG_URL}</span>
      <span>Status: {status}</span>
    </div>
  );

  if (safeMode)
    return (
      <div className="min-h-screen bg-zinc-900 p-6 text-white">
        {hud}
        <h2 className="text-xl font-semibold">Room {code} (safe mode)</h2>
        {safeTools}
        <div className="mt-2">Player: <span className="font-semibold">{name}</span></div>
        <div className="mt-4 flex gap-2">
          <button onClick={draw} disabled={playDisabled} className="rounded bg-emerald-600 px-3 py-2 disabled:opacity-50">
            {playDisabled ? "..." : "Play (draw)"}
          </button>
          <button
            onClick={() => guess("before")}
            disabled={guessLocked}
            className="rounded bg-blue-600 px-3 py-2 disabled:opacity-50"
          >
            Before
          </button>
          <button
            onClick={() => guess("after")}
            disabled={guessLocked}
            className="rounded bg-purple-600 px-3 py-2 disabled:opacity-50"
          >
            After
          </button>
          <button onClick={forcePlayTest} className="rounded bg-amber-600 px-3 py-2">Force Play Test</button>
          <button onClick={refreshDebugStats} className="rounded bg-slate-600 px-3 py-2">Fetch Stats</button>
        </div>
        <pre className="mt-4 max-h-64 overflow-auto rounded bg-zinc-800 p-3 text-xs">
{JSON.stringify({ myTurn, playerCard, currentSong, wins }, null, 2)}
        </pre>
      </div>
    );

  return (
    <div className="min-h-screen bg-zinc-900 p-6 text-white">
      {hud}
      <h2 className="text-xl font-semibold">Room {code}</h2>
      <div className="mt-1 text-xs opacity-70">Status: {status}</div>
      <div className="text-xs opacity-70">WS: {WS_DEBUG_URL}</div>
      <div className="mt-2">Player: <span className="font-semibold">{name}</span></div>
      <div className="mt-2 flex flex-wrap gap-2 text-xs">
        <span>Host: {hostId || "n/a"}</span>
        <span>Device: {deviceId || "n/a"}</span>
        <button onClick={forcePlayTest} className="rounded bg-amber-600 px-2 py-1 text-xs">Force Play Test</button>
        <button onClick={refreshDebugStats} className="rounded bg-slate-600 px-2 py-1 text-xs">Fetch Stats</button>
      </div>
      <div className="mt-4 grid gap-6 md:grid-cols-2">
        <div className="rounded bg-zinc-800 p-4">
          <div className="text-sm opacity-70">Your card</div>
          {playerCard ? (
            <div className="mt-2 rounded border border-zinc-700 p-3">
              <div className="text-lg font-semibold">{playerCard.name}</div>
              <div className="opacity-80">{playerCard.artists}</div>
              <div className="opacity-80">Year: {playerCard.year}</div>
            </div>
          ) : (
            <div className="mt-2 text-sm opacity-70">Waiting for start...</div>
          )}
          <div className="mt-3 text-sm">Cards won: <span className="font-semibold">{wins[playerId] ?? 0}</span></div>
        </div>
        <div className="rounded bg-zinc-800 p-4">
          <div className="mb-2 text-sm opacity-70">Central deck</div>
          {myTurn ? (
            <div>
              {!currentSong ? (
                <>
                  <div className="mb-2 text-xs opacity-70">
                    Device: {deviceId || "n/a"}
                    <button onClick={activateDevice} className="ml-2 rounded bg-zinc-700 px-2 py-1">Activate</button>
                  </div>
                  <button onClick={draw} disabled={playDisabled} className="rounded bg-emerald-600 px-4 py-2 disabled:opacity-50">
                    {playDisabled ? "..." : "Draw / Play"}
                  </button>
                </>
              ) : (
                <div>
                  <div className="text-xs opacity-70">Playing via Spotify: {currentSong?.name} - {currentSong?.artists}</div>
                  <div className="mt-3 flex gap-2">
                    <button
                      onClick={() => guess("before")}
                      disabled={guessLocked}
                      className="rounded bg-blue-600 px-3 py-2 disabled:opacity-50"
                    >
                      Before
                    </button>
                    <button
                      onClick={() => guess("after")}
                      disabled={guessLocked}
                      className="rounded bg-purple-600 px-3 py-2 disabled:opacity-50"
                    >
                      After
                    </button>
                  </div>
                  <div className="mt-3">
                    <button
                      onClick={() => handleTurnPlay({ turnId: lastTurnIdRef.current || "", data: { song: currentSong } })}
                      disabled={playButtonDisabled}
                      className="rounded bg-emerald-700 px-3 py-2 text-sm disabled:opacity-50"
                    >
                      {playButtonDisabled ? "Play Locked" : "Play / queue_next"}
                    </button>
                    <div className="mt-1 text-xs text-amber-400">
                      {playDisabledReasons.join(" | ") || "ready"}
                    </div>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="text-sm opacity-70">Wait for your turn...</div>
          )}
        </div>
      </div>
    </div>
  );
}
