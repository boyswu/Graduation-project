"""Full-frame camera editing. No masks, landmarks, garment extraction or warping."""

from __future__ import annotations

import asyncio
import base64
import io
import json
import logging
import math
import os
import platform
import re
import queue
import sys
import time
import tempfile
from logging.handlers import QueueHandler, QueueListener, RotatingFileHandler
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path

import numpy as np
import torch
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image, ImageOps

ROOT = Path(os.environ.get("FLUXRT_ROOT", "/output/live-vton/candidates/fluxrt"))
ORIGINS = {"http://127.0.0.1:8766", "http://localhost:8766"}
SIZE = (512, 512)
GENERATION_PROFILES = {"detail": 512, "balanced": 384, "fast": 320}
DESCRIPTIONS = {
    "neural-look-01": "grey knitted cardigan with green V-neck trim, green button placket, beige buttons and black and white dog graphic",
    "neural-look-02": "cream shirt with pink trim and the dog playing tennis graphic",
    "neural-look-03": "black printed T-shirt, preserving its exact design and print",
    "neural-look-04": "brown and white sports jersey with a V-neck collar, maple leaf sleeve patch and large outlined number 95 on the chest",
    "neural-look-05": "deep blue short-sleeved velvet wrap top with an overlapping V-neck, side knot and long waist ties",
    "neural-look-06": "white sleeveless camisole with two thin shoulder straps, square neckline, narrow lace edging and a vertical row of small gold buttons; shoulders and upper arms must remain bare, with no sleeves",
    "neural-look-07": "light blue and dark navy color-block short-sleeved polo shirt with pointed collar, light blue shoulders, dark navy lower torso and dark sleeve cuffs",
    "neural-look-08": "bright red short-sleeved top with an asymmetric side wrap, gathered waist knot and long hanging waist ties",
}
executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="fluxrt-gpu")
model = None
loading = True
load_error = None
active_session = False
session_lock = asyncio.Lock()
inference_count = 0
interpolator = None
smoothing_error = None
previous_output = None
TRACE_DIR = Path(tempfile.gettempdir()) / "codex/Graduation-project/live-diagnostics"
TRACE_DIR.mkdir(parents=True, exist_ok=True)
trace_queue = queue.Queue(maxsize=4096)


class NonblockingTraceHandler(QueueHandler):
    def enqueue(self, record):
        try:
            self.queue.put_nowait(record)
        except queue.Full:
            pass  # Diagnostic congestion must not stall the video/GPU worker.


trace_file = RotatingFileHandler(TRACE_DIR / "runtime.jsonl", maxBytes=5_000_000, backupCount=1, encoding="utf-8")
trace_file.setFormatter(logging.Formatter("%(message)s"))
trace_logger = logging.getLogger("vton.runtime")
trace_logger.setLevel(logging.INFO)
trace_logger.propagate = False
trace_logger.addHandler(NonblockingTraceHandler(trace_queue))
trace_listener = QueueListener(trace_queue, trace_file)
trace_listener.start()
seen_client_events = {}


def trace_event(trace_id, event, frame_id=None, **metrics):
    safe = {k: v for k, v in metrics.items() if isinstance(v, (int, float, bool)) and math.isfinite(v)}
    trace_logger.info(json.dumps({"trace_id": trace_id, "event": event, "frame_id": frame_id,
                                  "wall_time_ms": time.time() * 1000, "server_ms": time.perf_counter() * 1000,
                                  "metrics": safe}, separators=(",", ":")))


def decode_image(payload: bytes) -> Image.Image:
    if not payload or len(payload) > 3_000_000:
        raise ValueError("Image exceeds 3 MB limit")
    with Image.open(io.BytesIO(payload)) as image:
        if image.width * image.height > 16_000_000:
            raise ValueError("Image dimensions exceed limit")
        return ImageOps.exif_transpose(image).convert("RGB")


def motion_controller_class():
    from fluxrt.stream_processor.update_controller import UpdateController
    from torchvision.transforms.functional import gaussian_blur
    from torch.nn import functional as functional

    class MotionPriorityController(UpdateController):
        motion_priority = False  # Opt in per session, after comparison with adaptive.

        def update_and_get_mask(self, frame):
            if (not self.motion_priority or self.requires_reset or
                    self.mask_calculation_method != "auto" or self.reset_period is not None):
                return super().update_and_get_mask(frame)
            difference = (gaussian_blur(self.cached_frame, 3, .5) - gaussian_blur(frame, 3, .5)).square().mean(1, keepdim=True)
            energy = functional.max_pool2d(difference, self.compression_ratio)
            strong = energy > .1
            core = functional.max_pool2d(strong.float(), 3, 1, 1) > 0
            original = functional.max_pool2d(core.float(), 3, 1, 1) > 0
            # Keep every strong-change block and its immediate neighbours.
            # Spend only the original outer padding's budget on weak motion.
            # The number of executed tokens never exceeds the adaptive mask.
            score = torch.where((energy > .0025) & ~original, 1 + energy, -torch.ones_like(energy))
            score = torch.where(original, torch.maximum(score, torch.full_like(score, .0001)), score)
            score = torch.where(core, torch.full_like(score, 10), score).flatten()
            order = torch.argsort(score, descending=True, stable=True)
            rank = torch.empty_like(order)
            rank.scatter_(0, order, torch.arange(order.numel(), device=order.device))
            selected = (rank < original.sum()).reshape_as(original)
            expanded = functional.interpolate(selected.float(), size=(self.height, self.width), mode="nearest").bool()
            self.cached_frame = torch.where(expanded, frame, self.cached_frame)
            mask = selected.squeeze(1).to(torch.int32)
            if self.requires_update_image_cache:
                if not self.always_update_image_cache:
                    self.requires_update_image_cache = False
                return mask * 2
            return mask

    return MotionPriorityController


def load_model():
    global model, loading, load_error, interpolator, smoothing_error
    try:
        from fluxrt.stream_processor.model_inference_subprocess import ModelInferenceSubprocess

        torch.set_float32_matmul_precision("high")
        instance = ModelInferenceSubprocess.__new__(ModelInferenceSubprocess)
        instance.config = {
            "models_path": str(ROOT / "FLUX.2-klein-4B"),
            "default_steps": 2, "default_seed": 42, "default_prompt": "Change clothing.",
            "resolution": {"width": SIZE[0], "height": SIZE[1]},
            "compile_models": False, "enable_spatial_cache": True,
            "enable_int8_quantization": False, "enable_tiny_vae": False,
            "enable_flow_upscaler": False, "interpolation_exp": 0,
            "use_reference_image": True,
            "reference_image_resolution": {"width": 256, "height": 256}, "logging": False,
        }
        instance.width, instance.height = SIZE
        instance.resolution = instance.config["resolution"]
        instance.interpolation_exp = 0
        instance.init_process_state()
        instance.load_models()
        instance.update_controller = motion_controller_class()(
            instance.config, SIZE[0], SIZE[1], compression_ratio=16, reference_image_seq_len=256,
        )
        instance.pipe.update_controller = instance.update_controller
        instance.pipe.set_progress_bar_config(disable=True)
        # This pipeline uses deterministic VAE argmax encoding. The 256px
        # reference garment is identical throughout a session, unlike the camera.
        instance.reference_latent = None
        encode_vae = instance.pipe._encode_vae_image

        def encode_with_reference_cache(image, generator):
            if tuple(image.shape[-2:]) != (256, 256):
                return encode_vae(image, generator)
            if instance.reference_latent is None:
                instance.reference_latent = encode_vae(image, generator)
            return instance.reference_latent

        instance.pipe._encode_vae_image = encode_with_reference_cache
        try:
            from safetensors.torch import load_file

            sys.path.insert(0, str(ROOT / "RIFE-safetensors"))
            from rife_ifnet import IFNet, detect_rife_config

            weights = load_file(str(ROOT / "RIFE-safetensors/rife_v4.25_lite.safetensors"))
            remapped = {}
            for key, value in weights.items():
                key = key.removeprefix("module.").removeprefix("flownet.")
                for index in range(5):
                    key = key.replace(f"block{index}.", f"blocks.{index}.", 1) if key.startswith(f"block{index}.") else key
                if not key.startswith(("teacher.", "caltime.")):
                    remapped[key] = value
            head_channels, channels = detect_rife_config(remapped)
            interpolator = IFNet(head_ch=head_channels, channels=channels, device="cuda", dtype=torch.float16).eval()
            interpolator.load_state_dict(remapped)
        except Exception as exc:
            smoothing_error = f"{type(exc).__name__}: {exc}"
            interpolator = None
        model = instance
    except Exception as exc:
        load_error = f"{type(exc).__name__}: {exc}"
    finally:
        loading = False


def configure_profile(profile: str):
    if profile not in GENERATION_PROFILES:
        raise ValueError("Invalid generation profile")
    size = GENERATION_PROFILES[profile]
    if model.resolution != {"width": size, "height": size}:
        # Reuse weights, but never reuse spatial tokens with another shape.
        model.resolution = {"width": size, "height": size}
        model.width = model.height = size
        model.config["resolution"] = model.resolution
        model.pipe.spatial_cache.clear()
        model.update_controller = type(model.update_controller)(
            model.config, size, size, compression_ratio=16, reference_image_seq_len=256,
        )
        model.pipe.update_controller = model.update_controller
    model.generation_profile = profile


def begin_session(garment: bytes, garment_id: str, profile="detail", cache_policy="adaptive"):
    global previous_output
    previous_output = None
    reference = ImageOps.pad(decode_image(garment), (256, 256), color="white")
    prompt = (
        "Use image 1 as the person and image 2 as the exact target garment. "
        f"Dress the person in the {DESCRIPTIONS.get(garment_id, 'exact reference garment, preserving its color, cut, neckline, sleeves, fabric and any visible pattern or print')} from image 2. "
        "Preserve the person face, hairstyle, current body pose, hands and background. "
        "Render the clothing naturally worn on the visible body, with correct folds and occlusion. "
        "Do not change the framing or invent body parts outside the camera view."
    )
    with torch.inference_mode():
        configure_profile(profile)
        model.update_controller.motion_priority = cache_policy == "motion-priority"
        model.reference_latent = None
        model.reference_image = reference
        model.update_prompt_embeds(prompt)  # Also invalidates all previous-session caches.


def generate_frame(payload: bytes, smooth=False, dispatched_at=None):
    global inference_count, previous_output
    started = time.perf_counter()
    executor_wait_ms = (started - dispatched_at) * 1000 if dispatched_at is not None else 0
    frame = decode_image(payload)
    output_size = (model.resolution["width"], model.resolution["height"])
    if frame.size != SIZE:
        raise ValueError("Expected a complete 512x512 letterboxed camera frame")
    if frame.size != output_size:
        frame = frame.resize(output_size, Image.Resampling.LANCZOS)
    input_decode_ms = (time.perf_counter() - started) * 1000
    sync_started = time.perf_counter()
    torch.cuda.synchronize()
    cuda_wait_ms = (time.perf_counter() - sync_started) * 1000
    inference_started = time.perf_counter()
    with torch.inference_mode():
        result = model.process_frame_with_pipeline(np.asarray(frame))
    torch.cuda.synchronize()
    inference_ms = (time.perf_counter() - inference_started) * 1000
    frames = []
    interpolation_ms = 0
    if smooth and interpolator is not None:
        interpolation_started = time.perf_counter()
        current = torch.from_numpy(result).to(device="cuda", dtype=torch.float16).permute(2, 0, 1).unsqueeze(0) / 255
        if previous_output is not None:
            with torch.inference_mode():
                times = torch.tensor([.25, .5, .75], device="cuda", dtype=torch.float16).view(3, 1, 1, 1).expand(3, 1, *current.shape[-2:])
                cached_features = {"img0": interpolator.extract_features(previous_output), "img1": interpolator.extract_features(current)}
                mids = interpolator(previous_output.expand(3, -1, -1, -1), current.expand(3, -1, -1, -1), times, cache=cached_features)
                mids = mids.clamp(0, 1).mul(255).round().to(torch.uint8).permute(0, 2, 3, 1).cpu().numpy()
                frames.extend(Image.fromarray(mid) for mid in mids)
        previous_output = current
        torch.cuda.synchronize()
        interpolation_ms = (time.perf_counter() - interpolation_started) * 1000
    frames.append(Image.fromarray(result))  # Preserve the exact model output as the final frame.
    encoded = []
    encode_started = time.perf_counter()
    for image in frames:
        output = io.BytesIO()
        image.save(output, "WEBP" if smooth else "JPEG", quality=90, **({"method": 0} if smooth else {}))
        encoded.append(output.getvalue())
    inference_count += 1
    return b"".join(encoded), inference_ms, (time.perf_counter() - started) * 1000, {
        "image_lengths": [len(part) for part in encoded], "interpolated_frames": len(frames) - 1,
        "interpolation_ms": interpolation_ms,
        "mime_type": "image/webp" if smooth else "image/jpeg",
        "executor_wait_ms": executor_wait_ms, "input_decode_ms": input_decode_ms,
        "cuda_wait_ms": cuda_wait_ms, "response_encode_ms": (time.perf_counter() - encode_started) * 1000,
        "output_width": output_size[0], "output_height": output_size[1],
        "motion_priority": model.update_controller.motion_priority,
    }


@asynccontextmanager
async def lifespan(_):
    # CUDA state, prompt changes and frame generation all use one GPU thread.
    future = asyncio.get_running_loop().run_in_executor(executor, load_model)
    yield
    await asyncio.shield(future)
    executor.shutdown(wait=True)
    trace_listener.stop()


app = FastAPI(title="Full-frame FluxRT try-on", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=list(ORIGINS), allow_methods=["GET", "POST"], allow_headers=["*"])


@app.post("/api/telemetry")
async def receive_telemetry(request: Request):
    raw = await request.body()
    if len(raw) > 160_000:
        raise HTTPException(413, "Telemetry batch too large")
    try:
        rows = json.loads(raw).get("events", [])
    except (ValueError, AttributeError):
        raise HTTPException(422, "Invalid telemetry")
    if not isinstance(rows, list) or len(rows) > 128:
        raise HTTPException(422, "Invalid telemetry batch")
    accepted = 0
    for row in rows:
        if not isinstance(row, dict):
            continue
        trace_id, event, sequence = row.get("trace_id"), row.get("event"), row.get("sequence")
        if not isinstance(trace_id, str) or not re.fullmatch(r"[a-f0-9-]{36}", trace_id):
            continue
        if not isinstance(event, str) or not re.fullmatch(r"client_[a-z_]{1,32}", event) or type(sequence) is not int:
            continue
        key = (trace_id, sequence)
        if key in seen_client_events:
            continue
        seen_client_events[key] = True
        if len(seen_client_events) > 4096:
            seen_client_events.pop(next(iter(seen_client_events)))
        metrics = row.get("metrics", {})
        if not isinstance(metrics, dict):
            continue
        safe = {k: v for k, v in list(metrics.items())[:80] if isinstance(k, str) and re.fullmatch(r"[a-zA-Z_][a-zA-Z0-9_]{0,47}", k)
                and isinstance(v, (int, float, bool)) and math.isfinite(v)}
        for name in ("at_ms", "wall_time_ms"):
            value = row.get(name)
            if isinstance(value, (int, float)) and math.isfinite(value):
                safe["client_" + name] = value
        safe["client_sequence"] = sequence
        frame_id = row.get("frame_id")
        trace_event(trace_id, event, frame_id if type(frame_id) is int else None, **safe)
        accepted += 1
    return {"accepted": accepted}


@app.get("/api/diagnostics")
def diagnostics(trace_id: str = ""):
    if trace_id and not re.fullmatch(r"[a-f0-9-]{36}", trace_id):
        raise HTTPException(422, "Invalid trace id")
    rows = []
    for filename in ("runtime.jsonl.1", "runtime.jsonl"):
        path = TRACE_DIR / filename
        if not path.exists():
            continue
        with path.open(encoding="utf-8") as source:
            for line in source:
                try:
                    row = json.loads(line)
                except ValueError:
                    continue
                if not trace_id or row.get("trace_id") == trace_id:
                    rows.append(row)
                    if len(rows) > 5000:
                        del rows[:1000]
    return {"version": 1, "events": rows, "retention": "two files of at most 5 MB; no images"}


@app.get("/api/status")
def status():
    return {
        "ready": model is not None, "loading": loading, "error": load_error,
        "engine": "FLUX.2-klein-4B / FluxRT", "output": "full-frame", "interpolated": False,
        "host": platform.node(), "busy": active_session, "inference_count": inference_count,
        "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
        "resolution": [model.resolution["width"], model.resolution["height"]] if model is not None else list(SIZE),
        "generation_profiles": GENERATION_PROFILES, "steps": 2, "flow_control": "latest-frame", "upload_window": 3,
        "supported_cache_policies": ["adaptive", "motion-priority"],
        "smoothing_available": interpolator is not None, "smoothing_error": smoothing_error,
    }


@app.websocket("/api/stream")
async def stream(socket: WebSocket):
    global active_session
    # No public camera endpoint: browser origin must be the local preview.
    if socket.headers.get("origin") not in ORIGINS:
        await socket.close(code=1008)
        return
    await socket.accept()
    if model is None:
        await socket.send_json({"type": "error", "message": "模型尚未就绪，请稍后重试"})
        await socket.close(code=1013)
        return
    try:
        # A garment switch can arrive while the disconnected session's last
        # frame is finishing. Wait briefly for its lease, without queueing frames.
        await asyncio.wait_for(session_lock.acquire(), timeout=2)
    except asyncio.TimeoutError:
        await socket.send_json({"type": "error", "message": "已有生成会话占用服务，请停止另一页面的生成后重试"})
        await socket.close(code=1013)
        return
    active_session = True
    loop = asyncio.get_running_loop()
    last_id = -1
    try:
        init = await asyncio.wait_for(socket.receive_json(), timeout=15)
        trace_id = init.get("trace_id", "")
        if not isinstance(trace_id, str) or not re.fullmatch(r"[a-f0-9-]{36}", trace_id):
            trace_id = "00000000-0000-0000-0000-000000000000"
        trace_event(trace_id, "server_start", automated=init.get("automated") is True, smooth=init.get("smoothing") is True)
        if init.get("type") != "init" or not isinstance(init.get("garment_id"), str) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,64}", init["garment_id"]):
            raise ValueError("Invalid garment selection")
        encoded = init.get("garment_image", "")
        if not isinstance(encoded, str) or len(encoded) > 4_100_000:
            raise ValueError("Invalid garment image")
        garment = base64.b64decode(encoded.split(",", 1)[-1], validate=True)
        profile = init.get("generation_profile", "detail")
        if not isinstance(profile, str) or profile not in GENERATION_PROFILES:
            raise ValueError("Invalid generation profile")
        cache_policy = init.get("cache_policy", "adaptive")
        if cache_policy not in ("adaptive", "motion-priority"):
            raise ValueError("Invalid cache policy")
        await loop.run_in_executor(executor, begin_session, garment, init["garment_id"], profile, cache_policy)
        latest_mode = init.get("protocol") == 2
        smooth = latest_mode and init.get("smoothing") is True and interpolator is not None
        size = GENERATION_PROFILES[profile]
        await socket.send_json({"type": "ready", "width": size, "height": size, "steps": 2,
                                "generation_profile": profile, "input_width": SIZE[0], "input_height": SIZE[1],
                                "flow_control": "latest-frame" if latest_mode else "serial", "capture_fps": {320: 9, 384: 8, 512: 6}[size],
                                "smoothing": smooth, "heartbeat": latest_mode, "upload_window": 3 if latest_mode else 1,
                                "motion_priority": cache_policy == "motion-priority"})
        if latest_mode:
            await stream_latest(socket, loop, smooth, trace_id)
            return
        while True:
            header = await asyncio.wait_for(socket.receive_json(), timeout=30)
            frame_id = header.get("id")
            if header.get("type") != "frame" or type(frame_id) is not int or frame_id <= last_id:
                raise ValueError("Invalid frame sequence")
            last_id = frame_id
            payload = await asyncio.wait_for(socket.receive_bytes(), timeout=15)
            output, inference_ms, service_ms, _ = await loop.run_in_executor(executor, generate_frame, payload)
            await socket.send_json({"type": "frame", "id": frame_id, "inference_ms": inference_ms, "service_ms": service_ms})
            await socket.send_bytes(output)
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        try:
            await socket.send_json({"type": "error", "message": str(exc)[:240]})
            await socket.close(code=1011)
        except (WebSocketDisconnect, RuntimeError):
            pass
    finally:
        # The executor serializes an already-running frame before a new session.
        active_session = False
        session_lock.release()


async def stream_latest(socket: WebSocket, loop, smooth=False, trace_id=""):
    """Overlap capture/upload, GPU and download with a single replaceable slot."""
    available = asyncio.Event()
    send_lock = asyncio.Lock()
    latest = None
    dropped = 0
    previous_finished = None

    async def receive_frames():
        nonlocal latest, dropped
        last_id = -1
        try:
            while True:
                header = await asyncio.wait_for(socket.receive_json(), timeout=30)
                if header.get("type") == "ping":
                    async with send_lock:
                        await socket.send_json({"type": "pong", "id": header.get("id")})
                    continue
                frame_id = header.get("id")
                if header.get("type") != "frame" or type(frame_id) is not int or frame_id <= last_id:
                    raise ValueError("Invalid frame sequence")
                last_id = frame_id
                payload = await asyncio.wait_for(socket.receive_bytes(), timeout=15)
                if not payload or len(payload) > 3_000_000:
                    raise ValueError("Image exceeds limit")
                discarded = latest[0] if latest is not None else None
                if discarded is not None:
                    dropped += 1
                latest = (frame_id, payload, time.perf_counter())
                trace_event(trace_id, "server_receive", frame_id, input_bytes=len(payload), dropped_frames=dropped)
                available.set()
                async with send_lock:
                    await socket.send_json({"type": "accepted", "id": frame_id, "dropped_id": discarded})
        finally:
            available.set()

    receiver = asyncio.create_task(receive_frames())
    try:
        while True:
            await available.wait()
            if receiver.done():
                await receiver
                return
            frame_id, payload, arrived_at = latest
            latest = None
            available.clear()
            queue_ms = (time.perf_counter() - arrived_at) * 1000
            dispatched_at = time.perf_counter()
            output, inference_ms, service_ms, extra = await loop.run_in_executor(executor, generate_frame, payload, smooth, dispatched_at)
            trace_event(trace_id, "server_generate", frame_id, queue_ms=queue_ms, inference_ms=inference_ms,
                        service_ms=service_ms, response_bytes=len(output), dropped_frames=dropped,
                        **{k: v for k, v in extra.items() if isinstance(v, (int, float))})
            finished = time.perf_counter()
            span_ms = min(240, (finished - previous_finished) * 1000) if previous_finished else 0
            previous_finished = finished
            lock_started = time.perf_counter()
            async with send_lock:
                send_started = time.perf_counter()
                await socket.send_json({"type": "frame", "id": frame_id, "inference_ms": inference_ms,
                                        "service_ms": service_ms, "queue_ms": queue_ms, "dropped_frames": dropped,
                                        "display_span_ms": span_ms, **extra})
                await socket.send_bytes(output)
            trace_event(trace_id, "server_send", frame_id, send_lock_ms=(send_started - lock_started) * 1000,
                        send_ms=(time.perf_counter() - send_started) * 1000, response_bytes=len(output))
    finally:
        receiver.cancel()
        await asyncio.gather(receiver, return_exceptions=True)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8030, ws_max_size=4_200_000, ws_per_message_deflate=False)
