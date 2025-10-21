from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Response
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
import asyncio
import random, string, json, os, re, time
from collections import defaultdict
from typing import Literal, Optional
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
    timeline: list[dict] = Field(default_factory=list)

class TurnState(BaseModel):
    turnId: str
    currentPlayerId: str
    drawn: Optional[dict] = None
    phase: Literal["playing", "placing", "result"] = "playing"
    play_started: bool = False
    last_play_uri: Optional[str] = None


class Room(BaseModel):
    code: str
    hostId: str
    players: list[Player] = Field(default_factory=list)
    status: Literal["lobby", "playing", "placing", "result", "finished", "postGame"] = "lobby"
    turnIndex: int = 0
    turn: Optional[TurnState] = None
    deck: dict = Field(default_factory=lambda: {
        "playlistId": None,
        "cards": [],
        "used": set(),
        "discard": set(),
    })
    winnerId: Optional[str] = None
    tiePolicy: Literal["strict", "lenient"] = "lenient"
    targetPoints: int = 10  # NEW: Configurable win condition
    votes: dict = Field(default_factory=lambda: {"yes": 0, "no": 0, "voters": set()})  # NEW: Voting system

rooms: dict[str, Room] = {}
clients: dict[str, list[WebSocket]] = {}

# Debug stats per host
debug_stats: dict[str, dict] = {}
queue_locks: dict[str, asyncio.Lock] = {}
queue_recent: dict[str, float] = {}
QUEUE_RECENT_WINDOW = 2.0

def isPlacementCorrect(placedYear: int, leftYear: Optional[int], rightYear: Optional[int]) -> bool:
    """
    Year-only validation: a placement is correct if the placed card's year fits 
    between the neighbor years when the timeline is read chronologically.
    Equal years are treated as the same position (order within the same year is free).
    """
    # Missing neighbors are unbounded on that side
    leftOK = (leftYear is None) or (placedYear >= leftYear)
    rightOK = (rightYear is None) or (placedYear <= rightYear)
    return leftOK and rightOK

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

def _normalize_release_date(raw: str | None, precision: str | None) -> tuple[str, str]:
    precision = (precision or "day").lower()
    raw = (raw or "").strip()
    if not raw:
        precision = "day"
        return ("1970-01-01", precision)
    if precision == "year":
        year = raw[:4]
        return (f"{year}-01-01", "year")
    if precision == "month":
        parts = raw.split("-")
        year = parts[0]
        month = parts[1] if len(parts) > 1 else "01"
        return (f"{year}-{month}-01", "month")
    # default day precision; ensure full ISO
    if len(raw) == 4:
        raw = f"{raw}-01-01"
    elif len(raw) == 7:
        raw = f"{raw}-01"
    return (raw, "day")

def _serialize_room(room: Room, mask_drawn: bool = True) -> dict:
    turn_payload = None
    if room.turn:
        turn_payload = {
            "turnId": room.turn.turnId,
            "currentPlayerId": room.turn.currentPlayerId,
            "phase": room.turn.phase,
            "drawn": None if mask_drawn else room.turn.drawn,
        }
    deck_used = list(room.deck.get("used", set()))
    deck_discard = list(room.deck.get("discard", set()))
    remaining = len(
        [
            card
            for card in room.deck.get("cards", [])
            if card["trackId"] not in room.deck.get("used", set())
            and card["trackId"] not in room.deck.get("discard", set())
        ]
    )
    return {
        "code": room.code,
        "hostId": room.hostId,
        "status": room.status,
        "tiePolicy": room.tiePolicy,
        "winnerId": room.winnerId,
        "turn": turn_payload,
        "turnIndex": room.turnIndex,
        "deck": {
            "playlistId": room.deck.get("playlistId"),
            "used": deck_used,
            "discard": deck_discard,
            "remaining": remaining,
        },
        "players": [
            {
                "id": p.id,
                "name": p.name,
                "seat": p.seat,
                "score": p.score,
                "is_host": p.is_host,
                "timeline": p.timeline,
            }
            for p in room.players
        ],
    }

async def _pause_playback(host_id: str, reason: str = "result", device_id: Optional[str] = None) -> None:
    """Pause playback on the host's active device. Device is optional; Spotify will pause active device."""
    if host_id:
        entry = _stats_for_host(host_id)
        entry["pause_by_reason"][reason] += 1
    token = await _get_valid_token(host_id)
    if not token:
        logger.warning(f"[pause] host={host_id} reason={reason} skipped: no token")
        return
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    url = f"https://api.spotify.com/v1/me/player/pause"
    if device_id:
        url += f"?device_id={device_id}"
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            r = await client.put(url, headers=headers)
        logger.info(f"[pause] host={host_id} device={device_id or 'active'} reason={reason} code={r.status_code}")
    except Exception as exc:
        logger.warning(f"[pause] host={host_id} reason={reason} exception={exc}")

def _available_deck_cards(room: Room) -> list[dict]:
    used = room.deck.get("used", set())
    discard = room.deck.get("discard", set())
    return [
        card
        for card in room.deck.get("cards", [])
        if card["trackId"] not in used and card["trackId"] not in discard
    ]

def _draw_track_card(room: Room) -> Optional[dict]:
    available = _available_deck_cards(room)
    if not available:
        return None
    card = random.choice(available)
    room.deck.setdefault("used", set()).add(card["trackId"])
    return card

def _steps_need_refresh(steps: dict) -> bool:
    codes = [steps.get("pause_code"), steps.get("transfer_code"), steps.get("queue_code"), steps.get("next_code")]
    return any(code == 401 for code in codes if isinstance(code, int))

async def _broadcast_room_snapshot(code: str, room: Room):
    await broadcast(code, "room:init", _serialize_room(room))

def _get_player(room: Room, player_id: str) -> Optional[Player]:
    for p in room.players:
        if p.id == player_id:
            return p
    return None

def _cleanup_host_entries(room: Room):
    """Remove any host entries from the players list - Host should not be a player"""
    filtered = [
        p for p in room.players
        if not p.is_host and p.id != room.hostId and p.id.upper() != "HOST"
    ]
    if len(filtered) != len(room.players):
        logger.info(f"[cleanup] removed host placeholders from room={room.code}")
    room.players = filtered

def _find_room_for_turn(host_id: str, turn_id: str | None) -> Optional[tuple[str, Room]]:
    if not turn_id:
        return None
    for code, room in rooms.items():
        if room.hostId != host_id:
            continue
        if room.turn and room.turn.turnId == turn_id:
            return (code, room)
    return None

def _compute_insert_position(timeline: list[dict], track: dict, tie_policy: str) -> tuple[int, Optional[tuple[int, int]]]:
    """
    Year-only validation: Find the correct insertion position based on year only.
    Equal years are treated as the same position (order within the same year is free).
    """
    # Extract years from timeline
    years = []
    for card in timeline:
        date = card.get("release", {}).get("date", "")
        year = int(date.split("-")[0]) if date and date.split("-")[0].isdigit() else 0
        years.append(year)
    
    # Extract target year
    target_date = track.get("release", {}).get("date", "")
    target_year = int(target_date.split("-")[0]) if target_date and target_date.split("-")[0].isdigit() else 0
    
    if not years:
        return (0, (0, 0) if tie_policy == "lenient" else None)
    
    # Find insertion point using year-only comparison
    lo = 0
    hi = len(years)
    while lo < hi:
        mid = (lo + hi) // 2
        if years[mid] < target_year:
            lo = mid + 1
        else:
            hi = mid
    
    if tie_policy == "strict":
        return (lo, None)
    
    # For lenient policy, find the range of positions with the same year
    left = lo
    right = lo
    while left - 1 >= 0 and years[left - 1] == target_year:
        left -= 1
    while right < len(years) and years[right] == target_year:
        right += 1
    
    return (lo, (left, right))

def _deal_opening_cards(code: str, room: Room):
    """Deal opening cards to actual players only - Host is excluded from gameplay"""
    _cleanup_host_entries(room)
    if not room.players:
        raise ValueError("No players to deal")
    if any(p.timeline for p in room.players):
        logger.info(f"[deal] room={code} skipped (timelines already populated)")
        return
    available = _available_deck_cards(room)
    if len(available) < len(room.players):
        raise ValueError("Not enough tracks to deal opening cards")
    dealt_ids: list[str] = []
    for player in room.players:
        # Skip any host entries that might have slipped through
        if player.is_host or player.id == room.hostId or player.id.upper() == "HOST":
            logger.info(f"[deal] skipping host player {player.id}")
            continue
        card = _draw_track_card(room)
        if not card:
            raise ValueError("Deck exhausted during deal")
        dealt_ids.append(card["trackId"])
        player.timeline = [card.copy()]
        player.score = len(player.timeline)
    logger.info(f"[deal] room={code} players={len(room.players)} dealt_ids={dealt_ids}")

async def _begin_turn(code: str, room: Room):
    """Begin a new turn for the next actual player - Host is excluded from turn rotation"""
    _cleanup_host_entries(room)
    if room.status == "finished" or not room.players:
        return
    
    # Filter out any host entries from turn rotation
    actual_players = [p for p in room.players if not p.is_host and p.id != room.hostId and p.id.upper() != "HOST"]
    if not actual_players:
        logger.warning(f"[begin_turn] no actual players found in room={code}")
        return
    
    if room.turnIndex >= len(actual_players):
        room.turnIndex = 0
    player = actual_players[room.turnIndex]
    card = _draw_track_card(room)
    if not card:
        room.status = "finished"
        await broadcast(code, "game:finish", {"winnerId": room.winnerId})
        return
    turn_id = code4() + code4()
    room.turn = TurnState(turnId=turn_id, currentPlayerId=player.id, drawn=card, phase="playing", play_started=False, last_play_uri=None)
    room.status = "playing"
    _set_phase(room.hostId, "playing")
    _record_turn_play(room.hostId, turn_id)
    await broadcast(code, "turn:begin", {"turnId": turn_id, "currentPlayerId": player.id})
    await broadcast(
        code,
        "turn:play",
        {
            "turnId": turn_id,
            "playerId": player.id,
            "song": {
                "trackId": card.get("trackId"),
                "uri": card.get("uri"),
                "release": card.get("release"),
            },
        },
    )
    logger.info(f"[emit turn:play] room={code} player={player.id} turnId={turn_id} song={card.get('trackId')}")

async def _advance_turn(code: str, room: Room):
    """Advance to the next actual player's turn - Host is excluded from turn rotation"""
    if room.status == "finished":
        return
    _cleanup_host_entries(room)
    
    # Filter out any host entries from turn rotation
    actual_players = [p for p in room.players if not p.is_host and p.id != room.hostId and p.id.upper() != "HOST"]
    if not actual_players:
        room.status = "finished"
        await broadcast(code, "game:finish", {"winnerId": room.winnerId})
        return
    
    room.turnIndex = (room.turnIndex + 1) % len(actual_players)
    room.turn = None
    room.status = "playing"
    await _begin_turn(code, room)

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

# -------------------------------
# REST
# -------------------------------
@app.get("/api/create-room")
def create_room(hostId: str | None = None, targetPoints: int = 10):
    logger.info(f"[create-room] targetPoints={targetPoints} hostId={hostId}")
    # Validate targetPoints
    if not (1 <= targetPoints <= 100):
        return JSONResponse(
            status_code=400,
            content={"error": "targetPoints must be between 1 and 100"}
        )
    
    host_id = hostId or f"host-{random.randint(1000,9999)}"
    code = code4()
    room = Room(code=code, hostId=host_id, players=[], targetPoints=targetPoints)
    rooms[code] = room
    clients[code] = []
    logger.info(f"[create-room] created room={code} with targetPoints={targetPoints}")
    return {"code": code, "hostId": host_id, "targetPoints": targetPoints}


class ConfirmPositionPayload(BaseModel):
    roomCode: str
    playerId: str
    turnId: str
    targetIndex: int


class NextTurnPayload(BaseModel):
    roomCode: str

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
                p.is_host = bool(data.get("is_host", False))
                # Host joins but is not added to players list - they just get room updates
                if p.is_host or p.id == room.hostId or p.id.upper() == "HOST":
                    logger.info(f"[join] host {p.id} connected to room {code}")
                    _cleanup_host_entries(room)
                    await _broadcast_room_snapshot(code, room)
                    continue
                # Regular players get added to the game
                used = {pl.seat for pl in room.players}
                seat = 0
                while seat in used:
                    seat += 1
                p.seat = seat
                room.players.append(p)
                _cleanup_host_entries(room)
                await _broadcast_room_snapshot(code, room)

            elif event == "start":
                host_in = data.get("hostId")
                print(f"[start] room={code} hostId_in={host_in} hostId_expected={room.hostId} status={room.status} players={len(room.players)}")
                if host_in != room.hostId:
                    await broadcast(code, "game:error", {"message": "Only the host can start the game."})
                    continue
                if room.status != "lobby":
                    await broadcast(code, "game:error", {"message": "Game already started or finished."})
                    continue
                _cleanup_host_entries(room)
                # Count only actual players (exclude any host entries)
                actual_players = [p for p in room.players if not p.is_host and p.id != room.hostId and p.id.upper() != "HOST"]
                if len(actual_players) < 2:
                    await broadcast(code, "game:error", {"message": "Need at least 2 players to start."})
                    continue
                tie_policy = data.get("tiePolicy")
                if tie_policy in ("strict", "lenient"):
                    room.tiePolicy = tie_policy
                playlist_id = data.get("playlistId")
                playlist_name = data.get("playlistName") or "Hitster"
                try:
                    cards = await _load_playlist(room.hostId, playlist_id=playlist_id, name=playlist_name)
                except Exception as exc:
                    await broadcast(code, "game:error", {"message": f"Failed to load playlist: {exc}"})
                    continue
                if not cards:
                    await broadcast(code, "game:error", {"message": "Playlist not playable or empty."})
                    continue
                room.deck = {
                    "playlistId": playlist_id,
                    "cards": cards,
                    "used": set(),
                    "discard": set(),
                }
                # Reset only actual players (exclude host)
                for p in room.players:
                    if not p.is_host and p.id != room.hostId and p.id.upper() != "HOST":
                        p.timeline = []
                        p.score = 0
                room.turnIndex = 0
                room.turn = None
                room.status = "setup"
                room.winnerId = None
                try:
                    _deal_opening_cards(code, room)
                except ValueError as exc:
                    await broadcast(code, "game:error", {"message": str(exc)})
                    room.status = "lobby"
                    continue
                room.status = "playing"
                _set_phase(room.hostId, "playing")
                await _broadcast_room_snapshot(code, room)
                await _begin_turn(code, room)

            elif event == "newGameRequest":
                # Only winner can request new game
                if data.get("playerId") != room.winnerId:
                    await broadcast(code, "game:error", {"message": "Only the winner can start a new game."})
                    continue
                
                # Start new game with optional new playlist and target points
                new_playlist_id = data.get("playlistId")
                new_target_points = data.get("targetPoints", room.targetPoints)
                
                # Validate target points
                if not (1 <= new_target_points <= 100):
                    await broadcast(code, "game:error", {"message": "Target points must be between 1 and 100."})
                    continue
                
                # Update room config
                room.targetPoints = new_target_points
                if new_playlist_id:
                    try:
                        cards = await _load_playlist(room.hostId, playlist_id=new_playlist_id, name="New Game")
                        if cards:
                            room.deck = {
                                "playlistId": new_playlist_id,
                                "cards": cards,
                                "used": set(),
                                "discard": set(),
                            }
                    except Exception as exc:
                        await broadcast(code, "game:error", {"message": f"Failed to load new playlist: {exc}"})
                        continue
                
                # Reset game state
                for p in room.players:
                    if not p.is_host and p.id != room.hostId and p.id.upper() != "HOST":
                        p.timeline = []
                        p.score = 0
                room.turnIndex = 0
                room.turn = None
                room.status = "lobby"
                room.winnerId = None
                room.votes = {"yes": 0, "no": 0, "voters": set()}
                
                # Deal new cards and start
                try:
                    _deal_opening_cards(code, room)
                except ValueError as exc:
                    await broadcast(code, "game:error", {"message": str(exc)})
                    room.status = "lobby"
                    continue
                
                room.status = "playing"
                _set_phase(room.hostId, "playing")
                await _broadcast_room_snapshot(code, room)
                await _begin_turn(code, room)
                
                # Broadcast new game started
                await broadcast(code, "newGameStarted", {
                    "config": {
                        "playlistId": room.deck["playlistId"],
                        "targetPoints": room.targetPoints
                    }
                })

            elif event == "voteReplay":
                # Non-winners can vote for replay
                player_id = data.get("playerId")
                vote = data.get("vote")
                
                if player_id == room.winnerId:
                    await broadcast(code, "game:error", {"message": "Winner cannot vote for replay."})
                    continue
                
                if vote not in ("YES", "NO"):
                    await broadcast(code, "game:error", {"message": "Invalid vote. Must be YES or NO."})
                    continue
                
                # Update vote
                if player_id in room.votes["voters"]:
                    # Player already voted, update their vote
                    old_vote = room.votes.get(player_id, "NO")
                    if old_vote == "YES":
                        room.votes["yes"] -= 1
                    else:
                        room.votes["no"] -= 1
                
                room.votes["voters"].add(player_id)
                room.votes[player_id] = vote
                
                if vote == "YES":
                    room.votes["yes"] += 1
                else:
                    room.votes["no"] += 1
                
                # Check if majority reached
                non_winners = [p for p in room.players if p.id != room.winnerId and not p.is_host and p.id != room.hostId and p.id.upper() != "HOST"]
                needed = len(non_winners) // 2 + 1
                
                await broadcast(code, "voteStatus", {
                    "yes": room.votes["yes"],
                    "no": room.votes["no"],
                    "needed": needed
                })
                
                # If majority YES, auto-start new game
                if room.votes["yes"] >= needed:
                    # Start new game with same config
                    for p in room.players:
                        if not p.is_host and p.id != room.hostId and p.id.upper() != "HOST":
                            p.timeline = []
                            p.score = 0
                    room.turnIndex = 0
                    room.turn = None
                    room.status = "lobby"
                    room.winnerId = None
                    room.votes = {"yes": 0, "no": 0, "voters": set()}
                    
                    try:
                        _deal_opening_cards(code, room)
                    except ValueError as exc:
                        await broadcast(code, "game:error", {"message": str(exc)})
                        room.status = "lobby"
                        continue
                    
                    room.status = "playing"
                    _set_phase(room.hostId, "playing")
                    await _broadcast_room_snapshot(code, room)
                    await _begin_turn(code, room)
                    
                    # Broadcast new game started
                    await broadcast(code, "newGameStarted", {
                        "config": {
                            "playlistId": room.deck["playlistId"],
                            "targetPoints": room.targetPoints
                        }
                    })

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

async def _attempt_refresh_token(host_id: str, reason: str) -> str | None:
    logger.info(f"[spotify] token refresh host={host_id} reason={reason}")
    try:
        info = await _refresh_token(host_id)
    except Exception as exc:
        logger.warning(f"[spotify] token refresh host={host_id} failed exception={exc}")
        return None
    if not info or not info.get("access_token"):
        logger.warning(f"[spotify] token refresh host={host_id} failed reason=no-token")
        return None
    logger.info(f"[spotify] token refresh host={host_id} ok")
    return info.get("access_token")

def _map_track_to_card(item: dict) -> Optional[dict]:
    try:
        t = item.get("track") or item
        if not t:
            return None
        name = t.get("name")
        artists = ", ".join([a.get("name") for a in t.get("artists", []) if a.get("name")])
        album = t.get("album", {})
        release_raw = (album.get("release_date") or "").strip()
        release_precision = album.get("release_date_precision") or "day"
        normalized_date, normalized_precision = _normalize_release_date(release_raw, release_precision)
        images = album.get("images", []) or []
        cover_url = images[0].get("url") if images else None
        track_id = t.get("id") or t.get("uri") or t.get("href")
        uri = t.get("uri") or (f"spotify:track:{track_id}" if track_id else None)
        if not (name and artists and track_id and uri and normalized_date):
            return None
        return {
            "trackId": track_id,
            "uri": uri,
            "name": name,
            "artist": artists,
            "album": album.get("name"),
            "coverUrl": cover_url,
            "release": {
                "date": normalized_date,
                "precision": normalized_precision,
            },
        }
    except Exception:
        return None

async def _load_playlist(host_id: str, playlist_id: str | None = None, name: str | None = None, min_tracks: int = 30) -> list[dict]:
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
                return []
            target_playlist = pr.json()
        else:
            # Find by name (default to "Hitster")
            search_name = (name or "Hitster").strip().lower()
            r = await client.get("https://api.spotify.com/v1/me/playlists", headers=headers, params={"limit": 50})
            r.raise_for_status()
            pls = r.json().get("items", [])
            target_playlist = next((p for p in pls if (p.get("name") or "").strip().lower() == search_name), None)
            if not target_playlist:
                return []
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
    cards: list[dict] = []
    for it in tracks:
        c = _map_track_to_card(it)
        if c:
            cards.append(c)
    random.shuffle(cards)
    if len(cards) < min_tracks:
        return []
    return cards

@app.get("/api/spotify/token")
async def spotify_token(hostId: str):
    logger.info(f"[spotify_token] request for host={hostId}")
    token = await _get_valid_token(hostId)
    if not token:
        logger.info(f"[spotify_token] no valid token, attempting refresh for host={hostId}")
        token = await _attempt_refresh_token(hostId, "token-endpoint")
        if token:
            token = await _get_valid_token(hostId)
    if not token:
        logger.warning(f"[spotify_token] no token available for host={hostId}")
        return Response("Not linked", status_code=401)
    # Return access token with a short TTL hint
    info = spotify_tokens.get(hostId) or {}
    ttl = max(0, int(info.get("expires_at", 0)) - _now())
    logger.info(f"[spotify_token] returning token for host={hostId} ttl={ttl}")
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
    if not host_id or not device_id or not uri or not turn_id:
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
    room_lookup = _find_room_for_turn(host_id, turn_id)

    async with lock:
        try:
            async with httpx.AsyncClient(timeout=20) as client:
                steps = await _queue_next_core(client, headers, host_id, device_id, target_uri)
                if _steps_need_refresh(steps):
                    new_token = await _attempt_refresh_token(host_id, "queue_next")
                    if not new_token:
                        return Response("Spotify authentication failed", status_code=401)
                    token = new_token
                    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
                    steps = await _queue_next_core(client, headers, host_id, device_id, target_uri)
                    if _steps_need_refresh(steps):
                        return Response("Spotify authentication failed", status_code=401)
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
                if room_lookup:
                    code, room_ref = room_lookup
                    turn = room_ref.turn
                    if turn and turn.turnId == turn_id:
                        turn.play_started = True
                        turn.last_play_uri = target_uri
                        turn.phase = "placing"
                        room_ref.status = "placing"
                        logger.info(f"[emit turn:placing] room={code} turnId={turn_id}")
                        await broadcast(code, "turn:placing", {"turnId": turn_id})
                        await _broadcast_room_snapshot(code, room_ref)
        finally:
            queue_locks.pop(lock_key, None)

    return JSONResponse(status_code=200, content=result_payload or {})


@app.post("/api/turn/confirm_position")
async def confirm_position(payload: ConfirmPositionPayload):
    room = rooms.get(payload.roomCode)
    if not room:
        return Response("Room not found", status_code=404)
    logger.info(
        f"[turn:confirm:req] room={room.code} player={payload.playerId} turnId={payload.turnId} phase={room.turn.phase if room.turn else None} play_started={room.turn.play_started if room.turn else None}"
    )
    if not room.turn or room.turn.turnId != payload.turnId:
        logger.warning(f"[turn:confirm] rejected turn mismatch room={room.code} turnId={payload.turnId}")
        return Response("Turn mismatch", status_code=409)
    if room.turn.currentPlayerId != payload.playerId:
        logger.warning(f"[turn:confirm] rejected wrong player room={room.code} player={payload.playerId}")
        return Response("Wrong player", status_code=409)
    if room.turn.phase not in ("playing", "placing"):
        logger.warning(f"[turn:confirm] rejected wrong phase room={room.code} phase={room.turn.phase}")
        return Response("Turn not accepting placements", status_code=409)
    if not room.turn.play_started:
        logger.warning(f"[turn:confirm] rejected play not started room={room.code}")
        return Response("Play not started", status_code=409)
    card = room.turn.drawn
    if not card:
        return Response("No drawn card", status_code=409)
    player = _get_player(room, payload.playerId)
    if not player:
        return Response("Player not found", status_code=404)
    # Ensure the player is not a host
    if player.is_host or player.id == room.hostId or player.id.upper() == "HOST":
        return Response("Host cannot play", status_code=403)

    idx, allowed_range = _compute_insert_position(player.timeline, card, room.tiePolicy)
    insert_index = idx
    correct = False
    if room.tiePolicy == "strict":
        correct = payload.targetIndex == idx
    else:
        left, right = (allowed_range or (idx, idx))
        if payload.targetIndex < left:
            insert_index = left
        elif payload.targetIndex > right:
            insert_index = right
        else:
            insert_index = payload.targetIndex
        correct = left <= payload.targetIndex <= right

    result_payload = {
        "turnId": room.turn.turnId,
        "playerId": player.id,
        "chosenIndex": payload.targetIndex,
        "correctIndex": idx,
    }

    if correct:
        insert_index = max(0, min(insert_index, len(player.timeline)))
        player.timeline.insert(insert_index, card)
        player.score = len(player.timeline)
        room.turn.phase = "result"
        room.status = "result"
        room.turn.drawn = None
        room.turn.play_started = False
        
        result_payload.update(
            {
                "correct": True,
                "finalIndex": insert_index,
                "newScore": player.score,
                "placedTrack": card,
                "revealCard": card,
                "players": [
                    {
                        "id": p.id,
                        "name": p.name,
                        "score": p.score,
                        "timeline": p.timeline,
                        "seat": p.seat,
                    }
                    for p in room.players
                ],
            }
        )
        
        # Check win condition - only for actual players (not hosts)
        logger.info(f"[win_check] player={player.id} score={player.score} target={room.targetPoints} is_host={player.is_host} hostId={room.hostId}")
        if player.score >= room.targetPoints and not player.is_host and player.id != room.hostId and player.id.upper() != "HOST":
            logger.info(f"[WIN_CONDITION_MET] player={player.id} score={player.score} target={room.targetPoints}")
            room.winnerId = player.id
            room.status = "postGame"
            
            # Create ranking sorted by score
            ranking = sorted(room.players, key=lambda p: p.score, reverse=True)
            ranking_info = [
                {
                    "id": p.id,
                    "name": p.name,
                    "score": p.score,
                    "timeline": p.timeline,
                    "seat": p.seat,
                }
                for p in ranking
            ]
            
            # Broadcast gameOver event
            await broadcast(room.code, "gameOver", {
                "ranking": ranking_info,
                "winnerId": player.id,
                "targetPoints": room.targetPoints
            })
            
            # Broadcast winnerDeciding event
            await broadcast(room.code, "winnerDeciding", {
                "winnerId": player.id
            })
    else:
        room.deck.setdefault("discard", set()).add(card.get("trackId"))
        room.turn.phase = "result"
        room.status = "result"
        room.turn.drawn = None
        room.turn.play_started = False
        result_payload.update({
            "correct": False,
            "revealCard": card,
            "players": [
                {
                    "id": p.id,
                    "name": p.name,
                    "score": p.score,
                    "timeline": p.timeline,
                    "seat": p.seat,
                }
                for p in room.players
            ],
        })

    _set_phase(room.hostId, "result")
    # Proactively pause playback when result is determined
    await _pause_playback(room.hostId, reason="result")
    logger.info(
        f"[turn:result] room={room.code} player={player.id} turnId={room.turn.turnId if room.turn else None} correct={correct} finalIndex={result_payload.get('finalIndex')}"
    )
    await broadcast(room.code, "turn:result", result_payload)
    if room.status == "finished" and room.winnerId:
        await broadcast(room.code, "game:finish", {"winnerId": room.winnerId})
    await _broadcast_room_snapshot(room.code, room)
    return JSONResponse(
        {
            "correct": correct,
            "newScore": player.score if correct else None,
            "finalIndex": result_payload.get("finalIndex"),
        }
    )


@app.post("/api/turn/next")
async def next_turn(payload: NextTurnPayload):
    room = rooms.get(payload.roomCode)
    if not room:
        return Response("Room not found", status_code=404)
    if room.status == "finished":
        return Response(status_code=204)
    if not room.turn or room.turn.phase != "result":
        return Response("Turn not completed", status_code=409)
    room.turn = None
    await _advance_turn(payload.roomCode, room)
    await _broadcast_room_snapshot(payload.roomCode, room)
    return Response(status_code=204)

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
        logger.warning(f"[spotify_callback] invalid state: code={code}, state={state}")
        return Response("Invalid state", status_code=400)
    host_id = spotify_states[state]["hostId"]
    logger.info(f"[spotify_callback] processing OAuth for host={host_id}")
    # cleanup state
    spotify_states.pop(state, None)
    try:
        token = await _exchange_code_for_token(code)
        spotify_tokens[host_id] = token
        logger.info(f"[spotify_callback] token stored for host={host_id}, expires_at={token.get('expires_at')}")
    except httpx.HTTPError as e:
        logger.error(f"[spotify_callback] token exchange failed for host={host_id}: {e}")
        return Response(f"Token exchange failed: {e}", status_code=400)
    # Redirect user back to frontend host lobby page (best-effort)
    frontend = _choose_frontend_origin()
    loc = f"{frontend}/host?spotify=ok&hostId={host_id}"
    logger.info(f"[spotify_callback] redirecting to {loc}")
    return Response(status_code=302, headers={"Location": loc})

@app.get("/api/spotify/status")
def spotify_status(hostId: str):
    linked = hostId in spotify_tokens
    logger.info(f"[spotify_status] host={hostId} linked={linked} tokens_count={len(spotify_tokens)}")
    return {"linked": linked}

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
