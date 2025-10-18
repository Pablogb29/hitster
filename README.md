HITSTER

Small party game scaffold (host creates a room, players join by code/QR). Monorepo with FastAPI backend and React + Vite frontend.

Repo Layout
- `backend/` – FastAPI app, WebSocket hub, in-memory room state
- `frontend/` – React UI (Host and Join), Tailwind, Vite

Local Development
- Backend
  - `pip install -r backend/requirements.txt`
  - `uvicorn backend.main:app --reload --host 0.0.0.0 --port 8000`
- Frontend
  - `cd frontend && pnpm install` (or `npm install`)
  - `pnpm dev` (or `npm run dev`) → `http://localhost:5173`

Railway Deployment (monorepo)
Create a Railway project with two services from this repo:

- Backend service
  - Root directory: `backend`
  - Start command: `uvicorn main:app --host 0.0.0.0 --port $PORT`
  - Environment: set `FRONTEND_ORIGINS` to your frontend public URL (e.g., `https://your-frontend.up.railway.app`)

- Frontend service
  - Root directory: `frontend`
  - Build command: `pnpm i --frozen-lockfile && pnpm build` (or npm equivalent)
  - Start command: `pnpm start` (uses `vite preview --host --port $PORT`)
  - Environment: set `VITE_BACKEND_URL` to your backend public URL (e.g., `https://your-backend.up.railway.app`)

Notes
- CORS origins are configurable via `FRONTEND_ORIGINS` (comma-separated). Dev default is `http://localhost:5173`.
- Frontend uses `VITE_BACKEND_URL` for REST and WS endpoints. Dev fallback is `http://localhost:8000`.
- No virtual environments or build artifacts are tracked (see `.gitignore`).

Production URLs
After both services are deployed:
- Update `FRONTEND_ORIGINS` in the backend to the actual frontend URL.
- Update `VITE_BACKEND_URL` in the frontend to the actual backend URL and redeploy the frontend.

Scripts
- Frontend: `dev`, `build`, `preview`, `start` (Railway runtime)
- Backend: run with `uvicorn main:app --host 0.0.0.0 --port $PORT` in production

