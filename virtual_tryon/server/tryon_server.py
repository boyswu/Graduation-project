"""FastAPI service exposing CatVTON camera-keyframe inference."""

from __future__ import annotations

import asyncio
import base64
import io
import os
import platform
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

import torch
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image
from pydantic import BaseModel, Field

from catvton_engine import CatVTONRuntime


DEFAULT_MODEL_ROOT = Path(
    os.environ.get(
        "CATVTON_MODEL_ROOT",
        r"D:\Temp\codex\Graduation-project\catvton\models\catvton-bundle",
    )
)


def decode_image(payload: str) -> Image.Image:
    if "," in payload:
        payload = payload.split(",", 1)[1]
    try:
        raw = base64.b64decode(payload, validate=True)
        return Image.open(io.BytesIO(raw))
    except Exception as exc:
        raise HTTPException(status_code=422, detail="Invalid base64 image") from exc


def encode_png(image: Image.Image) -> str:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=False, compress_level=1)
    return base64.b64encode(buffer.getvalue()).decode("ascii")


class TryOnRequest(BaseModel):
    person_image: str
    garment_image: str
    mask_image: str
    width: int = Field(default=512, ge=256, le=1024)
    height: int = Field(default=768, ge=256, le=1024)
    steps: int = Field(default=8, ge=8, le=50)
    guidance_scale: float = Field(default=1.0, ge=1.0, le=5.0)
    seed: int = Field(default=42, ge=0)
    response_format: Literal["png", "compact", "lossless"] = "png"


class ServiceState:
    def __init__(self):
        self.runtime: CatVTONRuntime | None = None
        self.ready = False
        self.loading = True
        self.error: str | None = None
        self.load_ms: float | None = None
        self.started_at = time.time()
        self.inference_lock = threading.Lock()
        self.last_timings: dict[str, float] | None = None
        self.inference_count = 0


state = ServiceState()


def load_model() -> None:
    try:
        runtime = CatVTONRuntime(DEFAULT_MODEL_ROOT)
        state.runtime = runtime
        state.load_ms = runtime.load_ms
        state.ready = True
    except Exception as exc:
        state.error = f"{type(exc).__name__}: {exc}"
    finally:
        state.loading = False


@asynccontextmanager
async def lifespan(_: FastAPI):
    threading.Thread(target=load_model, name="catvton-loader", daemon=True).start()
    yield


app = FastAPI(title="Live CatVTON", version="1.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:8766", "http://localhost:8766"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


@app.get("/api/status")
def status():
    runtime = state.runtime
    response = {
        "ready": state.ready,
        "loading": state.loading,
        "error": state.error,
        "load_ms": state.load_ms,
        "inference_count": state.inference_count,
        "last_timings": state.last_timings,
        "model_root": str(DEFAULT_MODEL_ROOT),
        "host": platform.node(),
        "device": "cpu",
        "gpu": None,
        "torch": torch.__version__,
        "busy": state.inference_lock.locked(),
        "response_formats": ["png", "compact", "lossless"],
    }
    if runtime and torch.cuda.is_available():
        response["device"] = "cuda"
        response["gpu"] = torch.cuda.get_device_name(runtime.device)
        response["vram"] = runtime.gpu_metrics()
    return response


@app.post("/api/tryon")
def try_on(request: TryOnRequest):
    accepted_at = time.perf_counter()
    if not state.ready or state.runtime is None:
        raise HTTPException(
            status_code=503,
            detail={"state": "loading" if state.loading else "error", "error": state.error},
        )

    if not state.inference_lock.acquire(blocking=False):
        raise HTTPException(status_code=409, detail="GPU 正忙，请在当前生成结束后重试", headers={"Retry-After": "1"})
    try:
        person = decode_image(request.person_image)
        garment = decode_image(request.garment_image)
        mask = decode_image(request.mask_image)
        input_ms = (time.perf_counter() - accepted_at) * 1000
        result = state.runtime.infer(
            person,
            garment,
            mask,
            width=request.width,
            height=request.height,
            steps=request.steps,
            guidance_scale=request.guidance_scale,
            seed=request.seed,
        )
        state.inference_count += 1
        state.last_timings = result.timings_ms
        encode_started = time.perf_counter()
        if request.response_format in ("compact", "lossless"):
            buffer = io.BytesIO()
            result.image.save(buffer, format="WEBP", lossless=request.response_format == "lossless", quality=95, method=0)
            image = "data:image/webp;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")
            # Keep the original alpha exactly; do not send duplicate RGB pixels.
            alpha_layer = Image.new("RGBA", result.output_size, (255, 255, 255, 0))
            alpha_layer.putalpha(result.garment_layer.getchannel("A"))
            garment_layer = encode_png(alpha_layer)
        else:
            image = encode_png(result.image)
            garment_layer = encode_png(result.garment_layer)
        response_encode_ms = (time.perf_counter() - encode_started) * 1000
    finally:
        state.inference_lock.release()

    service_ms = (time.perf_counter() - accepted_at) * 1000
    return {
        "image": image,
        "garment_layer": garment_layer,
        "response_format": request.response_format,
        "input_ms": input_ms,
        "response_encode_ms": response_encode_ms,
        "seed": result.seed,
        "output_size": result.output_size,
        "timings_ms": result.timings_ms,
        "service_ms": service_ms,
        "vram": state.runtime.gpu_metrics(),
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8020)
