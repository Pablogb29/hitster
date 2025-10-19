from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Response
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
import asyncio
import random, string, json, os, re, time
from collections import defaultdict
from urllib.parse import urlencode
import httpx
import logging

app = FastAPI()
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("hitster")

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
    currentTurnId: str | None = None

rooms: dict[str, Room] = {}
clients: dict[str, list[WebSocket]] = {}

# Debug stats per host
debug_stats: dict[str, dict] = {}
queue_locks: dict[str, asyncio.Lock] = {}
queue_recent: dict[str, float] = {}
QUEUE_RECENT_WINDOW = 2.0

def _stats_for_host(host_id: str) -> dict:
    entry = debug_stats.get(host_id)
    if not entry:
        entry = {
            "queue_next_count": 0,
            "pause_by_reason": defaultdict(int),
            "last_phase": None,
            "last_queue_next_ts": 0.0,
            "last_turn_id": None,
            "last_turn_play_ts": 0.0,
            "last_target_uri": None,
            "last_observed_uri": None,
            "last_path": None,
            "last_result_ts": 0.0,
            "last_duration_ms": 0.0,
        }
        debug_stats[host_id] = entry
    return entry

def _set_phase(host_id: str | None, phase: str):
    if not host_id:
        return
    entry = _stats_for_host(host_id)
    entry["last_phase"] = phase

def _record_turn_play(host_id: str | None, turn_id: str | None):
    if not host_id:
        return
    entry = _stats_for_host(host_id)
    if turn_id:
        entry["last_turn_id"] = turn_id
    entry["last_turn_play_ts"] = time.time()

async def _fetch_currently_playing(client: httpx.AsyncClient, headers: dict) -> tuple[str | None, bool | None, dict | None]:
    try:
        resp = await client.get("https://api.spotify.com/v1/me/player/currently-playing", headers=headers)
    except httpx.HTTPError:
        return (None, None, None)
    if resp.status_code == 204:
        return (None, None, None)
    if resp.status_code >= 400:
        return (None, None, None)
    try:
        data = resp.json()
    except json.JSONDecodeError:
        return (None, None, None)
    item = data.get("item") or {}
    raw_uri = item.get("uri") or item.get("id")
    if raw_uri:
        observed_uri = raw_uri if str(raw_uri).startswith("spotify:") else f"spotify:track:{raw_uri}"
    else:
        observed_uri = None
    is_playing = data.get("is_playing")
    return (observed_uri, is_playing, data)

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
                _set_phase(room.hostId, "idle")
                await broadcast(code, "turn:begin", {"playerId": first_id})

            elif event == "turn:draw":
                # Only current player can draw
                pid = data.get("playerId")
                device_id = data.get("deviceId")
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
                turn_id = code4() + code4()
                room.currentTurnId = turn_id
                _set_phase(room.hostId, "playing")
                _record_turn_play(room.hostId, turn_id)
                logger.info(f"[emit turn:play] host={room.hostId} player={pid} turnId={turn_id} song={card.get('id')}")
                await broadcast(code, "turn:play", {"playerId": pid, "song": payload, "turnId": turn_id})
                # Playback is now initiated client-side on turn:play with queue_next

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
                _set_phase(room.hostId, "result")
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
                _set_phase(room.hostId, "idle")
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
    reason = payload.get("reason", "unspecified")
    logger.info(f"[pause] host={host_id} device={device_id} reason={reason}")
    if host_id:
        entry = _stats_for_host(host_id)
        entry["pause_by_reason"][reason] += 1
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

@app.post("/api/spotify/resume")
async def spotify_resume(payload: dict):
    host_id = payload.get("hostId")
    device_id = payload.get("device_id")
    if not host_id or not device_id:
        return Response("Missing params", status_code=400)
    token = await _get_valid_token(host_id)
    if not token:
        return Response("Not linked", status_code=401)
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    async with httpx.AsyncClient(timeout=20) as client:
        # Ensure device is the active player without auto-playing prior context
        try:
            tr = await client.put(
                "https://api.spotify.com/v1/me/player",
                headers=headers,
                json={"device_ids": [device_id], "play": False},
            )
            logger.info(f"[resume] transfer code={tr.status_code}")
        except Exception:
            pass
        # Resume current playback context (no URIs)
        r = await client.put(
            f"https://api.spotify.com/v1/me/player/play?device_id={device_id}",
            headers=headers,
        )
    return Response(r.text, status_code=204 if r.status_code < 400 else r.status_code)

async def _queue_next_core(client: httpx.AsyncClient, headers: dict, host_id: str, device_id: str, uri: str) -> dict:
    logger.info(f"[queue_next] host={host_id} device={device_id} uri={uri}")
    pause_code = transfer_code = queue_code = next_code = None
    pause_text = transfer_text = queue_text = next_text = ""
    try:
        pr = await client.put(
            f"https://api.spotify.com/v1/me/player/pause?device_id={device_id}",
            headers=headers,
        )
        pause_code = pr.status_code
        pause_text = pr.text
    except Exception as exc:
        pause_code = -1
        pause_text = str(exc)
    try:
        tr = await client.put(
            "https://api.spotify.com/v1/me/player",
            headers=headers,
            json={"device_ids": [device_id], "play": False},
        )
        transfer_code = tr.status_code
        transfer_text = tr.text
    except Exception as exc:
        transfer_code = -1
        transfer_text = str(exc)
    try:
        qr = await client.post(
            f"https://api.spotify.com/v1/me/player/queue?uri={uri}&device_id={device_id}",
            headers=headers,
        )
        queue_code = qr.status_code
        queue_text = qr.text
    except Exception as exc:
        queue_code = -1
        queue_text = str(exc)
    try:
        nr = await client.post(
            f"https://api.spotify.com/v1/me/player/next?device_id={device_id}",
            headers=headers,
        )
        next_code = nr.status_code
        next_text = nr.text
    except Exception as exc:
        next_code = -1
        next_text = str(exc)

    logger.info(
        f"[queue_next] steps pause={pause_code} transfer={transfer_code} queue={queue_code} next={next_code}"
    )

    return {
        "pause_code": pause_code,
        "transfer_code": transfer_code,
        "queue_code": queue_code,
        "next_code": next_code,
        "queue_text": queue_text,
        "next_text": next_text,
    }

async def _reconcile_playback(
    client: httpx.AsyncClient,
    headers: dict,
    host_id: str,
    device_id: str,
    target_uri: str,
) -> dict:
    delays = [0.2, 0.4, 0.7, 1.0]
    fallback_delays = [0.3, 0.6, 0.9]
    observed_uri: str | None = None
    is_playing: bool | None = None
    path = "queue"

    for idx, delay in enumerate(delays, start=1):
        await asyncio.sleep(delay)
        observed_uri, is_playing, _ = await _fetch_currently_playing(client, headers)
        logger.info(
            f"[queue_next] reconcile host={host_id} try={idx}/{len(delays)} observed={observed_uri} playing={is_playing}"
        )
        if observed_uri == target_uri and is_playing is True:
            logger.info(
                f"[queue_next] reconcile result: host={host_id} path={path} observed={observed_uri} playing={is_playing}"
            )
            return {"observed_uri": observed_uri, "is_playing": is_playing, "path": path}
        if observed_uri == target_uri and is_playing is False:
            # Give Spotify a moment to flip to playing before forcing resume
            continue

    # Fallback: play track directly
    path = "fallback_play"
    try:
        await client.put(
            f"https://api.spotify.com/v1/me/player/play?device_id={device_id}",
            headers=headers,
            json={"uris": [target_uri]},
        )
    except httpx.HTTPError as exc:
        logger.warning(f"[queue_next] fallback_play host={host_id} error: {exc}")

    for idx, delay in enumerate(fallback_delays, start=1):
        await asyncio.sleep(delay)
        observed_uri, is_playing, _ = await _fetch_currently_playing(client, headers)
        logger.info(
            f"[queue_next] fallback host={host_id} try={idx}/{len(fallback_delays)} observed={observed_uri} playing={is_playing}"
        )
        if observed_uri == target_uri and is_playing is True:
            logger.info(
                f"[queue_next] reconcile result: host={host_id} path={path} observed={observed_uri} playing={is_playing}"
            )
            return {"observed_uri": observed_uri, "is_playing": is_playing, "path": path}
        if observed_uri == target_uri and is_playing is False:
            break

    # Final fallback: resume without URIs
    path = "fallback_resume"
    try:
        await client.put(
            f"https://api.spotify.com/v1/me/player/play?device_id={device_id}",
            headers=headers,
        )
    except httpx.HTTPError as exc:
        logger.warning(f"[queue_next] fallback_resume host={host_id} error: {exc}")

    await asyncio.sleep(0.4)
    observed_uri, is_playing, _ = await _fetch_currently_playing(client, headers)
    logger.info(
        f"[queue_next] reconcile result: host={host_id} path={path} observed={observed_uri} playing={is_playing}"
    )
    return {"observed_uri": observed_uri, "is_playing": is_playing, "path": path}

@app.post("/api/spotify/queue_next")
async def spotify_queue_next(payload: dict):
    host_id = payload.get("hostId")
    device_id = payload.get("device_id")
    uri = payload.get("uri") or (f"spotify:track:{payload.get('id')}" if payload.get('id') else None)
    turn_id = payload.get("turn_id") or payload.get("turnId")
    if not host_id or not device_id or not uri:
        return Response("Missing params", status_code=400)
    target_uri = uri if uri.startswith("spotify:") else f"spotify:track:{uri.split(':')[-1]}"
    lock_key = f"{host_id}::{turn_id or target_uri}"
    lock = queue_locks.setdefault(lock_key, asyncio.Lock())
    if lock.locked():
        return JSONResponse(status_code=202, content={"status": "in-flight", "turnId": turn_id})

    recent_key = f"{host_id}::{target_uri}"
    now = time.time()
    if now - queue_recent.get(recent_key, 0) < QUEUE_RECENT_WINDOW:
        logger.info(f"[queue_next] dedup host={host_id} turn={turn_id or 'n/a'} uri={target_uri}")
        return JSONResponse(status_code=202, content={"status": "duplicate", "turnId": turn_id})

    token = await _get_valid_token(host_id)
    if not token:
        return Response("Not linked", status_code=401)

    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    start = time.perf_counter()
    result_payload: dict | None = None

    async with lock:
        try:
            async with httpx.AsyncClient(timeout=20) as client:
                steps = await _queue_next_core(client, headers, host_id, device_id, target_uri)
                queue_code = steps.get("queue_code") or 0
                next_code = steps.get("next_code") or 0
                if queue_code >= 400:
                    return Response(steps.get("queue_text", "queue failed"), status_code=queue_code)
                if next_code >= 400:
                    return Response(steps.get("next_text", "next failed"), status_code=next_code)

                reconcile = await _reconcile_playback(client, headers, host_id, device_id, target_uri)
                duration_ms = int((time.perf_counter() - start) * 1000)

                entry = _stats_for_host(host_id)
                entry["queue_next_count"] += 1
                entry["last_queue_next_ts"] = now
                if turn_id:
                    entry["last_turn_id"] = turn_id
                entry["last_target_uri"] = target_uri
                entry["last_observed_uri"] = reconcile.get("observed_uri")
                entry["last_path"] = reconcile.get("path")
                entry["last_result_ts"] = time.time()
                entry["last_duration_ms"] = duration_ms

                queue_recent[recent_key] = time.time()

                result_payload = {
                    "target_uri": target_uri,
                    "observed_uri": reconcile.get("observed_uri"),
                    "is_playing": reconcile.get("is_playing"),
                    "path": reconcile.get("path"),
                    "dur_ms": duration_ms,
                    "turnId": turn_id,
                }
        finally:
            queue_locks.pop(lock_key, None)

    return JSONResponse(status_code=200, content=result_payload or {})

@app.post("/api/spotify/next")
async def spotify_next(payload: dict):
    host_id = payload.get("hostId")
    device_id = payload.get("device_id")
    if not host_id:
        return Response("Missing hostId", status_code=400)
    token = await _get_valid_token(host_id)
    if not token:
        return Response("Not linked", status_code=401)
    headers = {"Authorization": f"Bearer {token}"}
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.post(
            "https://api.spotify.com/v1/me/player/next" + (f"?device_id={device_id}" if device_id else ""),
            headers=headers,
        )
    return Response(r.text, status_code=r.status_code)

@app.post("/api/spotify/play_track")
async def spotify_play_track(payload: dict):
    host_id = payload.get("hostId")
    device_id = payload.get("device_id")
    uri = payload.get("uri") or (f"spotify:track:{payload.get('id')}" if payload.get("id") else None)
    if not host_id or not device_id or not uri:
        return Response("Missing params", status_code=400)
    token = await _get_valid_token(host_id)
    if not token:
        return Response("Not linked", status_code=401)
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    print(f"[play_track] host={host_id} device={device_id} uri={uri}")
    async with httpx.AsyncClient(timeout=20) as client:
        # Ensure device is active, do not autoplay previous context
        try:
            await client.put(
                "https://api.spotify.com/v1/me/player",
                headers=headers,
                json={"device_ids": [device_id], "play": False},
            )
        except Exception:
            pass
        r = await client.put(
            f"https://api.spotify.com/v1/me/player/play?device_id={device_id}",
            headers=headers,
            json={"uris": [uri]},
        )
    return Response(r.text, status_code=r.status_code)

@app.get("/api/spotify/state")
async def spotify_state(hostId: str):
    token = await _get_valid_token(hostId)
    if not token:
        return Response("Not linked", status_code=401)
    headers = {"Authorization": f"Bearer {token}"}
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.get("https://api.spotify.com/v1/me/player", headers=headers)
    return Response(r.text, status_code=r.status_code, media_type="application/json")

@app.get("/api/debug/stats")
def debug_stats_endpoint(hostId: str):
    if not hostId:
        return Response("Missing hostId", status_code=400)
    entry = _stats_for_host(hostId)
    return {
        "queue_next_count": entry["queue_next_count"],
        "pause_by_reason": dict(entry["pause_by_reason"]),
        "last_phase": entry["last_phase"],
        "last_queue_next_ts": entry["last_queue_next_ts"],
        "last_turn_id": entry["last_turn_id"],
        "last_turn_play_ts": entry["last_turn_play_ts"],
        "last_target_uri": entry["last_target_uri"],
        "last_observed_uri": entry["last_observed_uri"],
        "last_path": entry["last_path"],
        "last_result_ts": entry["last_result_ts"],
        "last_duration_ms": entry["last_duration_ms"],
    }

@app.post("/api/spotify/volume")
async def spotify_volume(payload: dict):
    host_id = payload.get("hostId")
    device_id = payload.get("device_id")
    volume = int(payload.get("volume", 80))
    if not host_id:
        return Response("Missing hostId", status_code=400)
    token = await _get_valid_token(host_id)
    if not token:
        return Response("Not linked", status_code=401)
    headers = {"Authorization": f"Bearer {token}"}
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.put(
            f"https://api.spotify.com/v1/me/player/volume?volume_percent={max(0,min(100,volume))}" + (f"&device_id={device_id}" if device_id else ""),
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
