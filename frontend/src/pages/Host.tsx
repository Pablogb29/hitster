import { useCallback, useEffect, useState } from "react";
import { connectWS, type WSEvent } from "../lib/ws";
import Tabletop from "../tabletop/Tabletop";
import { useSearchParams } from "react-router-dom";

type Player = {
  id: string;
  name: string;
  score: number;
  timeline: any[];
  seat?: number;
  is_host?: boolean;
};

type Room = {
  code: string;
  hostId: string;
  status: "lobby" | "playing" | "placing" | "result" | "finished" | "setup";
  tiePolicy: "strict" | "lenient";
  winnerId: string | null;
  turnIndex: number;
  turn: {
    turnId: string;
    currentPlayerId: string;
    phase: "playing" | "placing" | "result";
    drawn: any | null;
  } | null;
  deck: {
    playlistId: string | null;
    used: string[];
    discard: string[];
    remaining: number;
  };
  players: Player[];
};

type HiddenCardState = {
  playerId: string;
  trackId: string;
  uri: string;
  release: {
    date: string;
    precision: "year" | "month" | "day";
  };
};

export default function Host() {
  const [params] = useSearchParams();
  const codeParam = params.get("code") || "";
  const [code, setCode] = useState(codeParam || "");
  const [room, setRoom] = useState<Room | null>(null);
  const [hiddenCard, setHiddenCard] = useState<HiddenCardState | null>(null);
  const [statusMessage, setStatusMessage] = useState<string>("");
  const [wsStatus, setWsStatus] = useState<"idle" | "connecting" | "open" | "closed">("idle");
  const [hostId, setHostId] = useState<string>("");
  const [playlistId, setPlaylistId] = useState<string>("");
  const [playlistName, setPlaylistName] = useState<string>("");
  const [tiePolicy, setTiePolicy] = useState<"strict" | "lenient">("lenient");
  const [spotifyConnected, setSpotifyConnected] = useState<boolean>(false);
  
  // Generate a host ID if not already set
  useEffect(() => {
    if (!hostId) {
      const newHostId = "h-" + Math.random().toString(36).slice(2, 8);
      setHostId(newHostId);
    }
  }, [hostId]);

  // Handle WebSocket events
  const handleWsEvent = useCallback((evt: WSEvent) => {
    console.log("[WS]", evt.event, evt.data);
    switch (evt.event) {
      case "room:init":
        setRoom(evt.data as Room);
        break;
      case "turn:begin":
        setStatusMessage(`Turn: ${evt.data.currentPlayerId}`);
        setHiddenCard(null);
        break;
      case "turn:play":
        setHiddenCard({
          playerId: evt.data.playerId,
          trackId: evt.data.song.trackId,
          uri: evt.data.song.uri,
          release: evt.data.song.release,
        });
        break;
      case "turn:result":
        setStatusMessage(
          evt.data.correct
            ? "✅ Correct placement!"
            : "❌ Incorrect placement."
        );
        break;
      case "game:finish":
        setStatusMessage(`Game finished! Winner: ${evt.data.winnerId || "None"}`);
        break;
      case "game:error":
        setStatusMessage(`Error: ${evt.data.message}`);
        break;
      default:
        break;
    }
  }, []);

  // Connect to WebSocket when code is available
  useEffect(() => {
    if (!code) return;
    
    setWsStatus("connecting");
    const conn = connectWS(code);
    
    conn.onOpen(() => {
      setWsStatus("open");
      conn.send("join", { id: hostId, name: "HOST", is_host: true });
    });
    
    conn.onClose(() => {
      setWsStatus("closed");
    });
    
    conn.onEvent(handleWsEvent);
    
    return () => {
      conn.close();
    };
  }, [code, handleWsEvent, hostId]);

  // Create a new room
  const createRoom = useCallback(async () => {
    try {
      const resp = await fetch(`/api/rooms`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostId }),
      });
      
      if (!resp.ok) {
        throw new Error(`Failed to create room: ${resp.status}`);
      }
      
      const data = await resp.json();
      setCode(data.code);
      setStatusMessage(`Room created: ${data.code}`);
    } catch (err: any) {
      setStatusMessage(`Error: ${err.message}`);
    }
  }, [hostId]);

  // Connect to Spotify
  const connectSpotify = useCallback(async () => {
    try {
      const resp = await fetch(`/api/spotify/auth?hostId=${encodeURIComponent(hostId)}`);
      if (!resp.ok) {
        throw new Error(`Failed to get auth URL: ${resp.status}`);
      }
      const data = await resp.json();
      window.open(data.url, "_blank");
      setStatusMessage("Spotify auth window opened");
      
      // Poll for connection status
      const checkStatus = async () => {
        try {
          const statusResp = await fetch(`/api/spotify/status?hostId=${encodeURIComponent(hostId)}`);
          if (statusResp.ok) {
            const statusData = await statusResp.json();
            if (statusData.connected) {
              setSpotifyConnected(true);
              setStatusMessage("Spotify connected");
              return true;
            }
          }
        } catch (err) {
          console.error("Error checking Spotify status:", err);
        }
        return false;
      };
      
      // Check status every 2 seconds for 60 seconds
      let attempts = 0;
      const interval = setInterval(async () => {
        const connected = await checkStatus();
        attempts++;
        if (connected || attempts >= 30) {
          clearInterval(interval);
        }
      }, 2000);
      
      return () => clearInterval(interval);
    } catch (err: any) {
      setStatusMessage(`Error: ${err.message}`);
    }
  }, [hostId]);

  // Start the game
  const startGame = useCallback(async () => {
    if (!code) {
      setStatusMessage("No room code");
      return;
    }
    
    try {
      const conn = connectWS(code);
      conn.send("start", {
        hostId,
        playlistId,
        playlistName,
        tiePolicy,
      });
    } catch (err: any) {
      setStatusMessage(`Error: ${err.message}`);
    }
  }, [code, hostId, playlistId, playlistName, tiePolicy]);

  // Check Spotify connection status on component mount
  useEffect(() => {
    if (hostId) {
      fetch(`/api/spotify/status?hostId=${encodeURIComponent(hostId)}`)
        .then(resp => resp.json())
        .then(data => {
          setSpotifyConnected(data.connected);
          if (data.connected) {
            setStatusMessage("Spotify connected");
          }
        })
        .catch(err => console.error("Error checking Spotify status:", err));
    }
  }, [hostId]);

  // Fetch playlists when Spotify is connected
  const fetchPlaylists = useCallback(async () => {
    if (!hostId || !spotifyConnected) return;
    
    try {
      const resp = await fetch(`/api/spotify/playlists?hostId=${encodeURIComponent(hostId)}`);
      if (!resp.ok) {
        throw new Error(`Failed to fetch playlists: ${resp.status}`);
      }
      const data = await resp.json();
      // Handle playlists data
      console.log("Playlists:", data);
    } catch (err: any) {
      setStatusMessage(`Error: ${err.message}`);
    }
  }, [hostId, spotifyConnected]);

  // Render Lobby view
  const renderLobby = () => (
    <div className="min-h-screen bg-zinc-900 text-white p-8">
      <h1 className="text-3xl font-bold mb-6">HITSTER - Host Lobby</h1>
      
      {!code ? (
        <div className="mb-6">
          <button 
            onClick={createRoom}
            className="bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-2 px-4 rounded"
          >
            Create Room
          </button>
        </div>
      ) : (
        <div className="mb-6">
          <h2 className="text-2xl font-bold mb-2">Room Code: {code}</h2>
          <p className="mb-4">Share this code with players to join</p>
          
          {/* QR Code would go here */}
          <div className="bg-white p-4 inline-block mb-4">
            <div className="text-black text-center">[QR Code for {code}]</div>
          </div>
        </div>
      )}
      
      <div className="mb-6">
        <h2 className="text-xl font-bold mb-2">Spotify Connection</h2>
        {spotifyConnected ? (
          <div className="text-green-400 mb-2">✓ Connected to Spotify</div>
        ) : (
          <button 
            onClick={connectSpotify}
            className="bg-green-600 hover:bg-green-700 text-white font-bold py-2 px-4 rounded"
          >
            Connect Spotify
          </button>
        )}
      </div>
      
      {spotifyConnected && (
        <div className="mb-6">
          <h2 className="text-xl font-bold mb-2">Game Settings</h2>
          
          <div className="mb-4">
            <label className="block text-sm font-bold mb-2">Playlist</label>
            <input 
              type="text" 
              value={playlistId} 
              onChange={(e) => setPlaylistId(e.target.value)}
              placeholder="Playlist ID"
              className="bg-zinc-800 text-white px-3 py-2 rounded w-full max-w-md"
            />
          </div>
          
          <div className="mb-4">
            <label className="block text-sm font-bold mb-2">Playlist Name (optional)</label>
            <input 
              type="text" 
              value={playlistName} 
              onChange={(e) => setPlaylistName(e.target.value)}
              placeholder="Playlist Name"
              className="bg-zinc-800 text-white px-3 py-2 rounded w-full max-w-md"
            />
          </div>
          
          <div className="mb-4">
            <label className="block text-sm font-bold mb-2">Tie Policy</label>
            <select 
              value={tiePolicy} 
              onChange={(e) => setTiePolicy(e.target.value as "strict" | "lenient")}
              className="bg-zinc-800 text-white px-3 py-2 rounded w-full max-w-md"
            >
              <option value="lenient">Lenient</option>
              <option value="strict">Strict</option>
            </select>
          </div>
        </div>
      )}
      
      {code && room?.players && (
        <div className="mb-6">
          <h2 className="text-xl font-bold mb-2">Players ({room.players.length})</h2>
          <ul className="bg-zinc-800 rounded p-4 max-w-md">
            {room.players.map(player => (
              <li key={player.id} className="mb-1">
                {player.name} (Seat: {player.seat})
              </li>
            ))}
            {room.players.length === 0 && (
              <li className="text-zinc-500">No players joined yet</li>
            )}
          </ul>
        </div>
      )}
      
      {code && spotifyConnected && room?.players && room.players.length >= 2 && (
        <div className="mt-6">
          <button 
            onClick={startGame}
            className="bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 px-6 rounded-lg text-lg"
          >
            Start Game
          </button>
        </div>
      )}
      
      {code && spotifyConnected && room?.players && room.players.length < 2 && (
        <div className="mt-6">
          <button 
            disabled
            className="bg-blue-800 text-gray-300 font-bold py-3 px-6 rounded-lg text-lg cursor-not-allowed"
          >
            Need at least 2 players to start
          </button>
        </div>
      )}
      
      <div className="mt-4 text-sm text-zinc-500">
        {statusMessage}
      </div>
    </div>
  );

  // Render Tabletop view
  const renderTabletop = () => (
    <div className="h-screen w-screen overflow-hidden bg-zinc-900">
      <Tabletop 
        room={room} 
        hiddenCard={hiddenCard} 
        statusMessage={statusMessage}
        debug={false}
      />
      <div className="absolute top-4 right-4 text-white bg-black bg-opacity-50 p-2 rounded text-sm">
        Want to play? Join from your phone via QR.
      </div>
    </div>
  );

  // Determine which view to render based on room status
  const shouldShowLobby = !room || room.status === "lobby" || room.status === "setup";
  
  return shouldShowLobby ? renderLobby() : renderTabletop();
}