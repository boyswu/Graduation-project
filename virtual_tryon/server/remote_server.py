"""Latency probe and future remote-inference transport for LIVE VTON.

The current service intentionally implements transport diagnostics only. Run the
pose, segmentation and garment-warp pipeline locally until a remote GPU worker
is benchmarked and connected.
"""

from __future__ import annotations

import asyncio
import json
import os
import time
import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

PROTOCOL_VERSION = "1.0"
MAX_TEXT_BYTES = 1_048_576


def utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def monotonic_ms() -> float:
    return time.perf_counter() * 1000.0


app = FastAPI(
    title="LIVE VTON Remote GPU Gateway",
    version="0.1.0",
    description="WebSocket RTT diagnostics for a future remote inference worker.",
)

allowed_origins = [
    origin.strip()
    for origin in os.getenv(
        "VTON_ALLOWED_ORIGINS",
        "http://127.0.0.1:8766,http://localhost:8766",
    ).split(",")
    if origin.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=False,
    allow_methods=["GET"],
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "service": "live-vton-remote",
        "version": app.version,
        "protocol_version": PROTOCOL_VERSION,
        "utc": utc_iso(),
        "inference_worker": "not_connected",
    }


@app.websocket("/ws")
async def latency_probe(websocket: WebSocket) -> None:
    await websocket.accept()
    session_id = uuid.uuid4().hex[:12]
    await websocket.send_json(
        {
            "type": "welcome",
            "protocol_version": PROTOCOL_VERSION,
            "session_id": session_id,
            "server_utc": utc_iso(),
        }
    )

    try:
        while True:
            try:
                message = await asyncio.wait_for(websocket.receive(), timeout=35.0)
            except asyncio.TimeoutError:
                await websocket.send_json(
                    {"type": "heartbeat", "server_utc": utc_iso()}
                )
                continue

            received_at = monotonic_ms()
            message_type = message.get("type")

            if message_type == "websocket.disconnect":
                raise WebSocketDisconnect(message.get("code", 1000))

            if message_type == "websocket.receive":
                if message.get("text") is not None:
                    await handle_text(websocket, message["text"], received_at)
                    continue

                payload = message.get("bytes") or b""
                await websocket.send_json(
                    {
                        "type": "frame_ack",
                        "bytes_received": len(payload),
                        "server_elapsed_ms": round(monotonic_ms() - received_at, 3),
                        "server_utc": utc_iso(),
                        "note": "transport_only_no_inference",
                    }
                )
    except WebSocketDisconnect:
        return


async def handle_text(websocket: WebSocket, text: str, received_at: float) -> None:
    if len(text.encode("utf-8")) > MAX_TEXT_BYTES:
        await websocket.close(code=1009, reason="message too large")
        return

    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        await websocket.send_json({"type": "error", "message": "invalid JSON"})
        return

    message_type = payload.get("type")
    if message_type == "ping":
        client_sent_ms = payload.get("client_sent_ms")
        if not isinstance(client_sent_ms, (int, float)):
            await websocket.send_json(
                {"type": "error", "message": "client_sent_ms must be numeric"}
            )
            return

        await websocket.send_json(
            {
                "type": "pong",
                "seq": payload.get("seq"),
                "client_sent_ms": client_sent_ms,
                "server_elapsed_ms": round(monotonic_ms() - received_at, 3),
                "server_utc": utc_iso(),
                "session_echo": payload.get("session_id"),
            }
        )
        return

    if message_type == "hello":
        await websocket.send_json(
            {
                "type": "hello_ack",
                "protocol_version": PROTOCOL_VERSION,
                "capabilities": ["ping_pong", "frame_transport_ack"],
                "inference_worker": "not_connected",
            }
        )
        return

    await websocket.send_json(
        {"type": "error", "message": f"unsupported message type: {message_type!r}"}
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "remote_server:app",
        host=os.getenv("VTON_REMOTE_HOST", "127.0.0.1"),
        port=int(os.getenv("VTON_REMOTE_PORT", "8010")),
        reload=False,
    )
