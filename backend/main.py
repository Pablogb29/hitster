from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
import random, string, json, os, re, time
from urllib.parse import urlencode
import httpx

app = FastAPI()

# CORS configuration: allow frontend origin(s) from env for Railway
# FRONTEND_ORIGINS may be:
#   - '*' to allow all (credentials disabled)
#   - comma or whitespace separated list of origins
origins_env = os.getenv("FRONTEND_ORIGINS") or os.getenv("FRONTEND_ORIGIN")
if origins_env:
    if origins_env.strip() == "*":
        allow_origins = ["*"]
        allow_credentials = False
    else:
        parts = re.split(r"[\s,]+", origins_env.strip())
        allow_origins = [p.rstrip("/") for p in parts if p]
        allow_credentials = True
else:
    # Default allow localhost dev and the deployed frontend domain
    allow_origins = [
        "http://localhost:5173",
        "https://frontend-production-62902.up.railway.app",
    ]
    allow_credentials = True

app.add_middleware(
    CORSMiddleware,
    allow_origins=allow_origins,
    allow_credentials=allow_credentials,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Health endpoint for connectivity checks
@app.get("/api/health")
def health():
    return {"ok": True}

# -------------------------------
# Estado en memoria / Modelos
# -------------------------------
class Player(BaseModel):
    id: str
    name: str
    seat: int = 0
    score: int = 0
    is_host: bool = False

class Room(BaseModel):
    code: str
    hostId: str
    players: list[Player] = Field(default_factory=list)
    state: str = "lobby"      # lobby | playing | finished
    turnIndex: int = 0
    # Game state
    deck: list[dict] = Field(default_factory=list)  # list of SongCard dicts
    used_track_ids: set[str] = Field(default_factory=set)
    player_cards: dict[str, dict] = Field(default_factory=dict)  # playerId -> SongCard
    wins: dict[str, int] = Field(default_factory=dict)  # playerId -> won cards count
    current_song: dict | None = None  # current SongCard in play
    selectedPlaylistId: str | None = None
    selectedPlaylistName: str | None = None

rooms: dict[str, Room] = {}
clients: dict[str, list[WebSocket]] = {}

def code4() -> str:
    return ''.join(random.choices(string.ascii_uppercase + string.digits, k=4))

def first_player_index(room: Room) -> int:
    # Primer jugador no-host
    for i, p in enumerate(room.players):
        if not p.is_host:
            return i
    return 0

# -------------------------------
# REST
# -------------------------------
@app.get("/api/create-room")
def create_room(hostId: str | None = None):
    host_id = hostId or f"host-{random.randint(1000,9999)}"
    code = code4()
    room = Room(code=code, hostId=host_id, players=[])
    rooms[code] = room
    clients[code] = []
    return {"code": code, "hostId": host_id}

# -------------------------------
# WebSocket sala
# -------------------------------
@app.websocket("/ws/{code}")
async def ws_room(ws: WebSocket, code: str):
    await ws.accept()
    clients.setdefault(code, []).append(ws)
    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except Exception:
                continue
            event, data = msg.get("event"), msg.get("data", {})
            room = rooms.get(code)
            if not room:
                continue

            if event == "join":
                p = Player(**data)
                # asigna asiento libre
                used = {pl.seat for pl in room.players}
                seat = 0
                while seat in used:
                    seat += 1
                p.seat = seat
                room.players.append(p)
                await broadcast(code, "room:state", room.model_dump(mode="json"))

            elif event == "start":
                # Solo host, estado lobby y al menos 2 jugadores
                print(f"[start] room={code} hostId_in={data.get('hostId')} hostId_expected={room.hostId} state={room.state} players={len(room.players)}")
                if data.get("hostId") != room.hostId:
                    await broadcast(code, "game:error", {"message": "Only the host can start the game."})
                    continue
                if room.state != "lobby":
                    await broadcast(code, "game:error", {"message": "Game already started or finished."})
                    continue
                if len(room.players) < 2:
                    await broadcast(code, "game:error", {"message": "Need at least 2 players to start."})
                    continue
                try:
                    # Load playlist deck (selected or default to 'Hitster')
                    pl_id = data.get("playlistId")
                    pl_name = data.get("playlistName") or (room.selectedPlaylistName or "Hitster")
                    all_cards, play_cards = await _load_playlist(room.hostId, playlist_id=pl_id, name=pl_name)
                    # Require enough tracks to assign one per non-host player plus at least one to draw
                    non_host = [p for p in room.players if not p.is_host]
                    needed = len(non_host) + 1
                    if len(all_cards) < needed:
                        await broadcast(code, "game:error", {"message": f"Playlist not playable (need >= {needed} tracks with year)"})
                        continue
                except Exception as e:
                    await broadcast(code, "game:error", {"message": f"Failed to load playlist: {e}"})
                    continue
                room.deck = []
                room.used_track_ids = set()
                room.player_cards = {}
                room.wins = {}
                room.selectedPlaylistId = pl_id
                room.selectedPlaylistName = pl_name
                # Give each non-host player an initial card
                for p in room.players:
                    if p.is_host:
                        continue
                    # draw a unique card for player
                    card = None
                    # Take from all_cards (not necessarily preview) for reference
                    while all_cards and not card:
                        c = all_cards.pop()
                        if c["id"] not in room.used_track_ids:
                            room.used_track_ids.add(c["id"])
                            card = c
                    if not card:
                        continue
                    room.player_cards[p.id] = card
                    room.wins[p.id] = 0
                # start game
                room.state = "playing"
                room.turnIndex = first_player_index(room)
                # Build draw deck from ALL remaining tracks now (Web Playback SDK handles playback)
                room.deck = [c for c in all_cards if c["id"] not in room.used_track_ids]
                random.shuffle(room.deck)
                await broadcast(code, "game:init", {
                    "players": [pl.model_dump() for pl in room.players],
                    "playerCards": room.player_cards,
                    "wins": room.wins,
                    "remaining": len(room.deck),
                })
                first_id = room.players[room.turnIndex].id
                await broadcast(code, "turn:begin", {"playerId": first_id})

            elif event == "turn:draw":
                # Only current player can draw
                pid = data.get("playerId")
                if not room or room.state != "playing":
                    continue
                current_id = room.players[room.turnIndex].id
                if pid != current_id:
                    continue
                # draw next unused card from remaining deck (now any track; preview optional)
                card = None
                try:
                    # try up to len(deck) times
                    for _ in range(max(1, len(room.deck))):
                        if not room.deck:
                            break
                        c = room.deck.pop()
                        if c["id"] not in room.used_track_ids:
                            card = c
                            break
                except Exception as e:
                    await broadcast(code, "game:error", {"message": f"Draw failed: {e}"})
                    continue
                if not card:
                    await broadcast(code, "game:finished", {"reason": "No more songs"})
                    room.state = "finished"
                    continue
                room.current_song = card
                room.used_track_ids.add(card["id"])
                # Send play event (hide year initially)
                payload = {k: v for k, v in card.items() if k != "year"}
                await broadcast(code, "turn:play", {"playerId": pid, "song": payload})

            elif event == "turn:guess":
                # Validate and score
                pid = data.get("playerId")
                choice = (data.get("choice") or "").lower()  # 'before' | 'after'
                if not room or room.state != "playing" or not room.current_song:
                    continue
                current_id = room.players[room.turnIndex].id
                if pid != current_id:
                    continue
                ref = room.player_cards.get(pid)
                song = room.current_song
                correct = False
                if ref and song:
                    if choice == "before":
                        correct = song["year"] < ref["year"]
                    elif choice == "after":
                        correct = song["year"] > ref["year"]
                if correct:
                    room.wins[pid] = int(room.wins.get(pid, 0)) + 1
                # Reveal result
                await broadcast(code, "turn:result", {
                    "playerId": pid,
                    "correct": correct,
                    "song": song,
                    "wins": room.wins,
                })
                # Check win condition
                if room.wins.get(pid, 0) >= 10:
                    room.state = "finished"
                    await broadcast(code, "game:finished", {"winner": pid})
                    continue
                # advance turn
                room.current_song = None
                room.turnIndex = (room.turnIndex + 1) % len(room.players)
                # ensure next turn is a non-host player
                # loop safeguard
                for _ in range(len(room.players)):
                    if not room.players[room.turnIndex].is_host:
                        break
                    room.turnIndex = (room.turnIndex + 1) % len(room.players)
                next_id = room.players[room.turnIndex].id
                await broadcast(code, "turn:begin", {"playerId": next_id})

    except WebSocketDisconnect:
        if code in clients and ws in clients[code]:
            clients[code].remove(ws)

async def broadcast(code: str, event: str, data: dict):
    dead = []
    for sock in clients.get(code, []):
        try:
            await sock.send_text(json.dumps({"event": event, "data": data}))
        except:
            dead.append(sock)
    for sock in dead:
        if sock in clients.get(code, []):
            clients[code].remove(sock)

# -------------------------------
# Spotify OAuth + Playlists
# -------------------------------

SPOTIFY_CLIENT_ID = os.getenv("SPOTIFY_CLIENT_ID", "")
SPOTIFY_CLIENT_SECRET = os.getenv("SPOTIFY_CLIENT_SECRET", "")
# If not set, will try to infer from first allowed origin by swapping host to backend
SPOTIFY_REDIRECT_URI = os.getenv("SPOTIFY_REDIRECT_URI")  # e.g., https://backend..up.railway.app/api/spotify/callback
# Include streaming and playback control for Web Playback SDK
SPOTIFY_SCOPES = "playlist-read-private playlist-read-collaborative streaming user-read-playback-state user-modify-playback-state"

# state -> hostId (short-lived)
spotify_states: dict[str, dict] = {}
# hostId -> token info
spotify_tokens: dict[str, dict] = {}

def _now() -> int:
    return int(time.time())

def _infer_redirect_uri() -> str | None:
    # Fallback only if explicit env not provided
    return SPOTIFY_REDIRECT_URI

def _build_auth_url(state: str) -> str:
    redirect_uri = _infer_redirect_uri()
    q = {
        "response_type": "code",
        "client_id": SPOTIFY_CLIENT_ID,
        "scope": SPOTIFY_SCOPES,
        "redirect_uri": redirect_uri,
        "state": state,
        "show_dialog": "false",
    }
    return f"https://accounts.spotify.com/authorize?{urlencode(q)}"

async def _exchange_code_for_token(code: str) -> dict:
    redirect_uri = _infer_redirect_uri()
    data = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": redirect_uri,
        "client_id": SPOTIFY_CLIENT_ID,
        "client_secret": SPOTIFY_CLIENT_SECRET,
    }
    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.post("https://accounts.spotify.com/api/token", data=data)
    r.raise_for_status()
    token = r.json()
    # compute expiry
    token["expires_at"] = _now() + int(token.get("expires_in", 3600)) - 30
    return token

async def _refresh_token(host_id: str) -> dict | None:
    info = spotify_tokens.get(host_id)
    if not info or not info.get("refresh_token"):
        return None
    data = {
        "grant_type": "refresh_token",
        "refresh_token": info["refresh_token"],
        "client_id": SPOTIFY_CLIENT_ID,
        "client_secret": SPOTIFY_CLIENT_SECRET,
    }
    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.post("https://accounts.spotify.com/api/token", data=data)
    r.raise_for_status()
    t = r.json()
    info["access_token"] = t["access_token"]
    if "refresh_token" in t:  # sometimes not returned
        info["refresh_token"] = t["refresh_token"]
    info["expires_at"] = _now() + int(t.get("expires_in", 3600)) - 30
    spotify_tokens[host_id] = info
    return info

async def _get_valid_token(host_id: str) -> str | None:
    info = spotify_tokens.get(host_id)
    if not info:
        return None
    if _now() >= int(info.get("expires_at", 0)):
        await _refresh_token(host_id)
        info = spotify_tokens.get(host_id)
    return info.get("access_token") if info else None

def _map_track_to_card(item: dict) -> dict | None:
    try:
        t = item.get("track") or item
        if not t:
            return None
        name = t.get("name")
        artists = ", ".join([a.get("name") for a in t.get("artists", []) if a.get("name")])
        album = t.get("album", {})
        rd = (album.get("release_date") or "").strip()
        year = int(rd.split("-")[0]) if rd else None
        preview = t.get("preview_url")
        track_id = t.get("id") or t.get("uri") or t.get("href")
        uri = t.get("uri") or (f"spotify:track:{track_id}" if track_id else None)
        if not (name and artists and year and track_id):
            return None
        return {"id": track_id, "uri": uri, "name": name, "artists": artists, "year": year, "preview_url": preview}
    except:
        return None

async def _load_playlist(host_id: str, playlist_id: str | None = None, name: str | None = None, min_tracks: int = 30) -> tuple[list[dict], list[dict]]:
    token = await _get_valid_token(host_id)
    if not token:
        return []
    headers = {"Authorization": f"Bearer {token}"}
    async with httpx.AsyncClient(timeout=30) as client:
        target_playlist = None
        if playlist_id:
            # Fetch specific playlist
            pr = await client.get(f"https://api.spotify.com/v1/playlists/{playlist_id}", headers=headers)
            if pr.status_code >= 400:
                return ([], [])
            target_playlist = pr.json()
        else:
            # Find by name (default to "Hitster")
            search_name = (name or "Hitster").strip().lower()
            r = await client.get("https://api.spotify.com/v1/me/playlists", headers=headers, params={"limit": 50})
            r.raise_for_status()
            pls = r.json().get("items", [])
            target_playlist = next((p for p in pls if (p.get("name") or "").strip().lower() == search_name), None)
            if not target_playlist:
                return ([], [])
        # Pull tracks pages
        tracks: list[dict] = []
        href = target_playlist.get("tracks", {}).get("href")
        next_url = href
        while next_url and len(tracks) < 500:
            tr = await client.get(next_url, headers=headers)
            tr.raise_for_status()
            data = tr.json()
            tracks.extend(data.get("items", []))
            next_url = data.get("next")
    cards = []
    for it in tracks:
        c = _map_track_to_card(it)
        if c:
            cards.append(c)
    random.shuffle(cards)
    # Build two lists: all valid cards (for player reference) and preview-only (for draws)
    with_preview = [c for c in cards if c.get("preview_url")]
    return (cards, with_preview)

@app.get("/api/spotify/token")
async def spotify_token(hostId: str):
    token = await _get_valid_token(hostId)
    if not token:
        return Response("Not linked", status_code=401)
    # Return access token with a short TTL hint
    info = spotify_tokens.get(hostId) or {}
    ttl = max(0, int(info.get("expires_at", 0)) - _now())
    return {"access_token": token, "expires_in": ttl}

@app.post("/api/spotify/play")
async def spotify_play(payload: dict):
    host_id = payload.get("hostId")
    device_id = payload.get("device_id")
    uri = payload.get("uri")
    if not host_id or not device_id or not uri:
        return Response("Missing params", status_code=400)
    token = await _get_valid_token(host_id)
    if not token:
        return Response("Not linked", status_code=401)
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    async with httpx.AsyncClient(timeout=20) as client:
        # Transfer playback to the Web Playback SDK device and start
        try:
            await client.put(
                "https://api.spotify.com/v1/me/player",
                headers=headers,
                json={"device_ids": [device_id], "play": True},
            )
        except Exception:
            pass
        # Set a reasonable volume (optional, best-effort)
        try:
            await client.put(
                f"https://api.spotify.com/v1/me/player/volume?volume_percent=80&device_id={device_id}",
                headers=headers,
            )
        except Exception:
            pass
        r = await client.put(
            f"https://api.spotify.com/v1/me/player/play?device_id={device_id}",
            headers=headers,
            json={"uris": [uri]},
        )
    if r.status_code >= 400:
        return Response(r.text, status_code=r.status_code)
    return {"ok": True}

@app.post("/api/spotify/transfer")
async def spotify_transfer(payload: dict):
    host_id = payload.get("hostId")
    device_id = payload.get("device_id")
    play = bool(payload.get("play", False))
    if not host_id or not device_id:
        return Response("Missing params", status_code=400)
    token = await _get_valid_token(host_id)
    if not token:
        return Response("Not linked", status_code=401)
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.put(
            "https://api.spotify.com/v1/me/player",
            headers=headers,
            json={"device_ids": [device_id], "play": play},
        )
    return Response(r.text, status_code=r.status_code)

@app.post("/api/spotify/pause")
async def spotify_pause(payload: dict):
    host_id = payload.get("hostId")
    device_id = payload.get("device_id")
    if not host_id:
        return Response("Missing hostId", status_code=400)
    token = await _get_valid_token(host_id)
    if not token:
        return Response("Not linked", status_code=401)
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.put(
            f"https://api.spotify.com/v1/me/player/pause" + (f"?device_id={device_id}" if device_id else ""),
            headers=headers,
        )
    return Response(r.text, status_code=r.status_code)

@app.get("/api/spotify/login")
def spotify_login(hostId: str):
    if not SPOTIFY_CLIENT_ID or not _infer_redirect_uri():
        return {"error": "Spotify not configured on server"}
    state = code4() + code4()
    spotify_states[state] = {"hostId": hostId, "ts": _now()}
    return {"authorize_url": _build_auth_url(state), "state": state}

def _choose_frontend_origin() -> str:
    # Highest priority: explicit single-origin env vars
    for key in ("FRONTEND_PUBLIC_URL", "FRONTEND_ORIGIN"):
        val = os.getenv(key)
        if val:
            return val.rstrip('/')
    # Next: from allow_origins, prefer https and non-localhost
    origins = allow_origins or []
    for prefer_https in (True, False):
        for o in origins:
            o2 = o.rstrip('/')
            if "localhost" in o2:
                continue
            if prefer_https and not o2.startswith("https://"):
                continue
            return o2
    # Fallback: first origin or localhost
    return (origins[0].rstrip('/') if origins else "http://localhost:5173")

@app.get("/api/spotify/callback")
async def spotify_callback(code: str | None = None, state: str | None = None):
    if not code or not state or state not in spotify_states:
        return Response("Invalid state", status_code=400)
    host_id = spotify_states[state]["hostId"]
    # cleanup state
    spotify_states.pop(state, None)
    try:
        token = await _exchange_code_for_token(code)
        spotify_tokens[host_id] = token
    except httpx.HTTPError as e:
        return Response(f"Token exchange failed: {e}", status_code=400)
    # Redirect user back to frontend host page (best-effort)
    frontend = _choose_frontend_origin()
    loc = f"{frontend}/host?spotify=ok&hostId={host_id}"
    return Response(status_code=302, headers={"Location": loc})

@app.get("/api/spotify/status")
def spotify_status(hostId: str):
    return {"linked": hostId in spotify_tokens}

@app.get("/api/spotify/playlists")
async def spotify_playlists(hostId: str, limit: int = 20):
    token = await _get_valid_token(hostId)
    if not token:
        return Response("Not linked", status_code=401)
    headers = {"Authorization": f"Bearer {token}"}
    params = {"limit": min(max(limit, 1), 50)}
    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.get("https://api.spotify.com/v1/me/playlists", headers=headers, params=params)
    return r.json()
