#!/usr/bin/env bash
set -euo pipefail

# Start FastAPI via Uvicorn on the Railway-provided PORT
python -m uvicorn main:app --host 0.0.0.0 --port "${PORT:-8000}"

