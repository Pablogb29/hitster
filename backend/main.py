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
def create_room():
    host_id = f"host-{random.randint(1000,9999)}"
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
            msg = json.loads(raw)
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
                await broadcast(code, "room:state", room.model_dump())

            elif event == "start":
                # Solo host, estado lobby y al menos 2 jugadores
                if data.get("hostId") != room.hostId:
                    continue
                if room.state != "lobby":
                    continue
                if len(room.players) < 2:
                    continue
                room.state = "playing"
                room.turnIndex = first_player_index(room)
                await broadcast(code, "game:start", room.model_dump())
                first_id = room.players[room.turnIndex].id
                await broadcast(code, "turn:begin", {"playerId": first_id})

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
SPOTIFY_SCOPES = "playlist-read-private playlist-read-collaborative"

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
    loc = f"{frontend}/host?spotify=ok"
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
