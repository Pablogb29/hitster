from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import random, string, json, os

app = FastAPI()

# CORS configuration: allow frontend origin(s) from env for Railway
# FRONTEND_ORIGINS can be a comma-separated list of origins.
origins_env = os.getenv("FRONTEND_ORIGINS") or os.getenv("FRONTEND_ORIGIN")
if origins_env:
    allow_origins = [o.strip() for o in origins_env.split(",") if o.strip()]
else:
    allow_origins = ["http://localhost:5173"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allow_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

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
    players: list[Player] = []
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
