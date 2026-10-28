"""Repeatable HTTP keyframe benchmark; output defaults to OS temporary storage."""
import argparse
import base64
import hashlib
import json
import math
import statistics
import tempfile
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("person", "garment", "mask"):
        parser.add_argument(f"--{name}", type=Path, required=True)
    parser.add_argument("--url", action="append", required=True)
    parser.add_argument("--runs", type=int, default=5)
    parser.add_argument("--steps", type=int, default=8)
    parser.add_argument("--format", choices=["png", "compact", "lossless"], default="compact")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.runs < 1:
        parser.error("--runs must be positive")
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    output = args.output or Path(tempfile.gettempdir()) / "codex/Graduation-project" / f"benchmark-{stamp}/results.json"
    body = dict(width=512, height=768, steps=args.steps, guidance_scale=2.5, seed=42, response_format=args.format)
    fingerprints = {}
    for name in ("person", "garment", "mask"):
        raw = getattr(args, name).read_bytes()
        body[f"{name}_image"] = base64.b64encode(raw).decode("ascii")
        fingerprints[name] = hashlib.sha256(raw).hexdigest()
    payload = json.dumps(body).encode()
    report = dict(utc=stamp, settings={k: v for k, v in body.items() if not k.endswith("_image")},
                  input_sha256=fingerprints, request_bytes=len(payload), endpoints=[])
    output.parent.mkdir(parents=True, exist_ok=True)
    for url in args.url:
        url = url.rstrip("/")
        with urllib.request.urlopen(url + "/api/status", timeout=10) as response:
            status = json.load(response)
        if not status.get("ready"):
            raise RuntimeError(f"Service not ready: {url}")
        rtts = []
        for _ in range(24):
            start = time.perf_counter()
            with urllib.request.urlopen(url + "/api/status", timeout=10) as response:
                response.read()
            rtts.append((time.perf_counter() - start) * 1000)
        endpoint = dict(url=url, gpu=status.get("gpu"), torch=status.get("torch"), rtt_ms=rtts,
                        rtt_median_ms=statistics.median(rtts), rtt_p95_ms=sorted(rtts)[math.ceil(.95 * len(rtts)) - 1],
                        rtt_stddev_ms=statistics.pstdev(rtts), runs=[])
        report["endpoints"].append(endpoint)
        for index in range(args.runs + 1):
            start = time.perf_counter()
            request = urllib.request.Request(url + "/api/tryon", data=payload, headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(request, timeout=90) as response:
                raw = response.read()
            result = json.loads(raw)
            row = dict(warmup=index == 0, http_ms=(time.perf_counter() - start) * 1000,
                       response_bytes=len(raw), timings_ms=result["timings_ms"], service_ms=result["service_ms"],
                       response_encode_ms=result.get("response_encode_ms"))
            endpoint["runs"].append(row)
            output.write_text(json.dumps(report, indent=2), encoding="utf-8")
            print(json.dumps(dict(url=url, run=index, **row)), flush=True)
        warm = [row["http_ms"] for row in endpoint["runs"] if not row["warmup"]]
        print(json.dumps(dict(url=url, median_http_ms=statistics.median(warm), min_ms=min(warm), max_ms=max(warm))), flush=True)
    print(f"Results: {output}")


if __name__ == "__main__":
    main()
