# Local AI and Remote Diagnostics

The default full-frame experiment uses `fluxrt_server.py`: FLUX.2 Klein / FluxRT
on the remote 5090, port `8030`, forwarded to localhost `8022`. It generates the
entire displayed frame from each sampled camera frame. No pose, input clothing
mask, garment extraction or WebGL skinning is involved in this mode. Protocol 2
overlaps capture/upload, generation and download. The browser permits one
encoding job and at most three unacknowledged uploads; the server keeps one replaceable waiting frame. Old
waiting inputs are dropped instead of forming a FIFO queue. Native generation
still does not promise 30 FPS.

Camera frames are letterboxed into the existing 512 square before inference.
The model may generate content inside that artificial padding. The browser now
records each captured frame's actual content rectangle and presents only that
rectangle from the generated square, preserving the entire real camera field.
For a 4:3 camera, the model's 320 square is displayed as its central 320x240
camera area, not its generated top/bottom padding. This adds no model call or
waiting period; it is not a person/garment crop. Model output dimensions remain
unchanged; numeric display logs separately report visible dimensions.

The retained legacy comparison uses two independent services:

- `tryon_server.py`: CatVTON keyframe inference on CUDA, port `8020`.
- `remote_server.py`: WebSocket RTT and transport diagnostics, port `8010`.

In legacy mode the browser owns camera capture, MediaPipe pose/segmentation and the
real-time WebGL Warp. CatVTON runs once for a captured keyframe; it does not
generate every camera frame.

## One-command Start

The remote full-frame model/runtime must already be provisioned as documented
in `../docs/MODEL_COMPARISON.md`. Deploy `fluxrt_server.py` next to its isolated
venv and model. In that remote directory run:

```bash
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 PYTHONDONTWRITEBYTECODE=1 \
  ./venv/bin/python -u -B fluxrt_server.py
```

The runtime additionally needs `requirements-fluxrt.txt`. The evaluated FluxRT
source includes the zero-interpolation RIFE initialization fix documented in
MODEL_COMPARISON. The API is loopback-only. Start its reconnecting tunnel locally:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-remote-tunnel.ps1 -LocalPort 8022 -RemotePort 8030
```

`GET /api/status` identifies `output: full-frame`. WebSocket `/api/stream` accepts
one `init` JSON with garment id/base64 image, then alternating `frame` JSON
(`id`) and JPEG binary messages. Legacy protocol replies with one complete JPEG.
With `protocol: 2`, `ready.flow_control: latest-frame` enables early `accepted`
acknowledgments (including `dropped_id`). Generated replies carry `image_lengths`
and `mime_type`: one JPEG in low-latency mode, or up to four concatenated WebP90
images when `init.smoothing: true`. The final image in a batch comes directly
from the model; preceding images are RIFE interpolations. No alpha/matte or
landmark payload exists. Origin is
restricted to the local preview. One GPU thread and one active session isolate
cache state; switching garment resets the cache. A 2 s admission wait lets a
disconnected session finish its last frame; other occupied sessions are rejected.
Inputs are processed in memory and never saved by the service. Client disconnect,
stop, camera shutdown and garment change clear the old displayed output.

Garment IDs may be any 1–64 character ASCII alphanumeric/underscore/hyphen
identifier. The eight built-in references have garment descriptions; other IDs use a
generic reference-garment prompt. This supports newly added catalog assets and
session-local uploaded images without model retraining or editing the service
for each garment. All reference/spatial/interpolation caches reset per session.
The current client requests `init.cache_policy: motion-priority`; omitted policy
retains `adaptive` for compatibility. Status lists `supported_cache_policies`,
and ready/frame messages report `motion_priority`. The new policy preserves
strong changes and their immediate neighbours, then spends the adaptive mask's
outer-padding token budget on weaker motion elsewhere. Its selected token count
never exceeds the adaptive mask computed from the same cached input. It does
not force a whole-person refresh or guarantee face fidelity. Changed cache
histories can affect subsequent budgets, so measured timing remains necessary.
The browser keeps desynchronized drawing, cancels old interpolation as soon as
a newer payload arrives, and skips latest-mode outputs captured over 2 seconds
ago. These checks add no intentional display wait or additional GPU inference.
Protocol 2 also accepts `ping` JSON and replies `pong` with its id independently
of the GPU worker. `ready.heartbeat` advertises this; clients must not send such
control messages to legacy services that do not advertise it.

Runtime diagnostics: the client supplies a random `trace_id` in init. The
service asynchronously rotates numeric-only receive/generate/send records to
the OS temporary directory `codex/Graduation-project/live-diagnostics/runtime.jsonl`
(5 MB plus one backup). `POST /api/telemetry` accepts at most128 sanitized client
events per batch; numeric/boolean metrics only, no images, prompts, URLs or file
names. `GET /api/diagnostics?trace_id=<uuid>` returns corresponding recent records.
GPU dispatch wait, input decoding, CUDA pre-sync, inference, interpolation,
response encoding, send-lock and socket send-wait are timed separately. Client
capture/ACK/metadata/payload/decode/paint/rAF timestamps use the browser clock;
never subtract browser and server monotonic timestamps directly.

Optional smooth mode needs `RIFE-safetensors/rife_v4.25_lite.safetensors` and the
standalone `rife_ifnet.py`/license/manifest described in THIRD_PARTY_NOTICES.
Status reports `smoothing_available` and any load error. The client caps smooth
batch pacing at 240 ms, replaces unfinished batches with newer ones, and reports
display FPS separately from native generated FPS. Smooth mode adds buffering;
low-latency mode displays complete generated frames immediately. Resolution,
two diffusion steps and original VAE remain unchanged. Only the session-static
256px garment's deterministic VAE argmax latent is cached and invalidated on
every session/garment change.

The following original launcher also starts the full-frame tunnel with `-Remote`
when the remote service is already running. Without `-Remote`, the local CatVTON
service only supports the legacy comparison.

From `virtual_tryon/`:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-demo.ps1
```

Default local paths:

```text
Python:
D:\Temp\codex\Graduation-project\catvton\.venv\Scripts\python.exe

Model:
D:\Temp\codex\Graduation-project\catvton\models\catvton-bundle
```

Override them with `CATVTON_PYTHON` and `CATVTON_MODEL_ROOT`.

## CatVTON Service

Start manually when the Python environment is already provisioned:

```powershell
$env:CATVTON_MODEL_ROOT = "D:\path\to\catvton-bundle"
& "D:\path\to\python.exe" server\tryon_server.py
```

Check readiness:

```powershell
Invoke-RestMethod http://127.0.0.1:8020/api/status
```

Expected fields include `ready`, `device: "cuda"`, the RTX GPU name, model load
time, inference count and last-stage timings.

`POST /api/tryon` accepts base64 PNG/JPEG payloads for `person_image`,
`garment_image` and `mask_image`, plus optional size, step, guidance and seed
fields. The response contains the generated image, an RGBA garment layer,
timings and VRAM metrics. Concurrent requests return HTTP 409 with Retry-After,
instead of queueing stale frames. Status includes busy and response_formats.

Current benchmark: 512×768, 8 steps, CFG 2.5, seed 42, one warmup + five runs.
HTTP median: local 4060 4.755 s; tunneled 5090 0.961 s (model 0.568 s).
These exclude capture and browser extraction; see ../docs/benchmark-20261026.json.

response_format defaults to png for compatibility. compact returns image as a
WebP quality-95 data URL, and garment_layer as a white RGBA PNG carrying only
the original alpha. Combine image RGB with that alpha; garment_layer is not
a standalone garment texture in this mode. lossless uses lossless WebP and the
same exact alpha. service_ms includes image encoding but excludes JSON
serialization and network transfer; response_encode_ms isolates image encoding.

CUDA stages synchronize before timing. VAE sampling uses the supplied seed.
A single-entry garment latent cache is keyed by resized pixels, size and seed.
Start scripts/start-remote-tunnel.ps1 for a reconnecting localhost:8021 tunnel;
start-demo.ps1 -Remote also starts it. The page selects the backend explicitly.

## Remote Diagnostics

Install the lightweight diagnostic service dependencies in a separate venv:

```powershell
python -m venv $env:TEMP\vton-server-venv
& "$env:TEMP\vton-server-venv\Scripts\python.exe" -m pip install -r server\requirements.txt
& "$env:TEMP\vton-server-venv\Scripts\python.exe" -m uvicorn server.remote_server:app --host 127.0.0.1 --port 8010
```

Verify:

```powershell
Invoke-RestMethod http://127.0.0.1:8010/health
```

In the web app, open the diagnostics dialog, connect to
`ws://127.0.0.1:8010/ws` and run the 24 probes. The result reports median, P95
and successive-sample network jitter.

This port only tests transport. It does not execute pose, segmentation or
CatVTON inference. Do not present its RTT as an end-to-end try-on latency.

## Production Direction

The CatVTON HTTP contract remains a legacy still-image comparison. The new
full-frame prototype sends binary JPEG over WebSocket and intentionally bypasses
pose/segmentation/Warp. For continuous video, evaluate WebRTC media transport
after real-human quality, identity and occlusion checks; do not mistake the
prototype's sampled output rate for full camera-rate generation.

Do not expose an unauthenticated model endpoint to the public internet. Restrict
the service to the presentation host over a private network or VPN.

CatVTON code and weights are licensed under `CC BY-NC-SA 4.0`. See
`THIRD_PARTY_NOTICES.md`; model weights are not redistributed in this
repository.
