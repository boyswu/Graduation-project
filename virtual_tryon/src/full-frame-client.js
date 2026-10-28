// A negotiated, bounded upload window hides ACK round trips. The server keeps
// only its newest waiting input, never a FIFO backlog of old camera poses.
import { LatencyLog } from "./latency-log.js";

export class FullFrameClient {
  constructor({ video, canvas, onStatus, onFrame, url = "ws://127.0.0.1:8022/api/stream" }) {
    Object.assign(this, { video, canvas, onStatus, onFrame, url });
    this.epoch = 0;
    this.running = false;
    this.capture = document.createElement("canvas");
    this.capture.width = this.capture.height = 512;
    this.playbackEpoch = 0;
    this.log = new LatencyLog();
    this.captureSequence = 0;
  }

  startCaptureWorker() {
    if (!globalThis.Worker || !globalThis.OffscreenCanvas) return;
    try {
      const worker = this.captureWorker = new Worker(new URL("./capture-worker.js", import.meta.url), { type: "module" });
      worker.onmessage = ({ data }) => {
        const job = this.captureJob;
        if (!job || data.id !== job.id) return;
        clearTimeout(job.timer); this.captureJob = null;
        if (data.error) job.reject(new Error("capture-worker-error"));
        else job.resolve(data);
      };
      worker.onerror = () => {
        const job = this.captureJob;
        this.captureJob = null;
        if (job) { clearTimeout(job.timer); job.reject(new Error("capture-worker-unavailable")); }
        worker.terminate(); this.captureWorker = null;
      };
    } catch { this.captureWorker = null; }
  }

  async encodeFrame(epoch) {
    const started = performance.now();
    if (this.captureWorker) {
      let frame;
      try {
        const mode = typeof VideoFrame === "function" ? 2 : 1;
        frame = mode === 2 ? new VideoFrame(this.video, { timestamp: Math.round(started * 1000) }) : await createImageBitmap(this.video);
        const snapshotMs = performance.now() - started;
        if (epoch !== this.epoch) { frame.close(); return null; }
        const id = ++this.captureSequence;
        const result = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("capture-worker-timeout")), 2500);
          this.captureJob = { id, resolve, reject, timer };
          this.captureWorker.postMessage({ id, frame }, [frame]);
        });
        return { ...result, capture_mode: mode, snapshot_ms: snapshotMs };
      } catch {
        frame?.close();
        if (epoch !== this.epoch) return null;
        if (this.captureJob) clearTimeout(this.captureJob.timer);
        this.captureJob = null;
        this.captureWorker?.terminate(); this.captureWorker = null;
        this.log.record("client_capture_fallback", null);
      }
    }
    const size = 512;
    if (this.capture.width !== size) this.capture.width = this.capture.height = size;
    const ctx = this.capture.getContext("2d");
    const video = this.video, scale = Math.min(size / video.videoWidth, size / video.videoHeight);
    const width = video.videoWidth * scale, height = video.videoHeight * scale;
    const content_x = (size - width) / 2, content_y = (size - height) / 2;
    ctx.fillStyle = "white"; ctx.fillRect(0, 0, size, size);
    ctx.drawImage(video, content_x, content_y, width, height);
    return { blob: await new Promise((resolve) => this.capture.toBlob(resolve, "image/jpeg", 0.9)), capture_mode: 0,
      input_width: size, input_height: size, content_x, content_y, content_width: width, content_height: height };
  }

  cancelPlayback() {
    this.playbackEpoch += 1;
    clearTimeout(this.playbackTimer);
    this.playbackWake?.();
    this.playbackWake = null;
    return this.playbackEpoch;
  }

  stop() {
    if (this.running) this.log.stop();
    if (this.captureJob) {
      clearTimeout(this.captureJob.timer);
      this.captureJob.reject(new DOMException("Capture stopped", "AbortError"));
      this.captureJob = null;
    }
    this.captureWorker?.terminate(); this.captureWorker = null;
    this.epoch += 1;
    this.running = false;
    this.cancelPlayback();
    clearTimeout(this.timer);
    this.timer = null;
    clearTimeout(this.timeout);
    clearTimeout(this.ackTimeout);
    clearInterval(this.pingTimer);
    this.controller?.abort();
    this.socket?.close();
    this.socket = null;
    this.pending = null;
    for (const upload of this.uploads?.values() || []) clearTimeout(upload.ackTimer);
    this.uploads = new Map();
    this.records = new Map();
    this.resultMeta = null;
    if (this.videoFrameCallbackId != null) this.video.cancelVideoFrameCallback?.(this.videoFrameCallbackId);
    this.videoFrameCallbackId = null;
    this.canvas.hidden = true;
    this.canvas.removeAttribute("data-frame-id");
  }

  async start(garment, { smooth = false, profile = "detail" } = {}) {
    this.stop();
    const epoch = this.epoch;
    const current = () => epoch === this.epoch;
    this.running = true;
    this.traceId = crypto.randomUUID();
    this.log.begin(this.traceId, smooth);
    this.startCaptureWorker();
    this.frames = 0;
    this.displayFrames = 0;
    this.displayStartedAt = 0;
    this.startedAt = 0;
    this.sequence = 0;
    this.lastVideoTime = -1;
    this.lastDisplayedId = 0;
    this.latestMode = false;
    this.uploadWindow = 1;
    this.lastCaptureAt = 0;
    this.captureFps = 12;
    this.smoothing = false;
    this.decodeSequence = 0;
    this.pings = new Map();
    this.rttSamples = [];
    this.pingSequence = 0;
    this.presentedFrame = -1;
    this.lastPresentedFrame = -1;
    this.lastCameraObservedAt = null;
    if (this.video.requestVideoFrameCallback) {
      const videoFrame = (_, metadata) => {
        if (!current()) return;
        this.presentedFrame = metadata.presentedFrames;
        this.lastCameraObservedAt = performance.now();
        this.videoFrameCallbackId = this.video.requestVideoFrameCallback(videoFrame);
      };
      this.videoFrameCallbackId = this.video.requestVideoFrameCallback(videoFrame);
    }
    this.controller = new AbortController();
    const fail = (message) => {
      if (!current()) return;
      this.log.record("client_error", this.pending?.id ?? null, { buffered_bytes: this.socket?.bufferedAmount || 0 });
      this.stop();
      this.onStatus("error", message);
    };
    this.onStatus("connecting", "正在连接完整画面生成服务");
    this.timeout = setTimeout(() => fail("连接或参考服装初始化超时，请重试"), 30000);
    try {
      const response = await fetch(garment.asset, { signal: this.controller.signal });
      if (!response.ok) throw new Error("无法读取参考衣服");
      const blob = await response.blob();
      const garmentImage = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error("参考衣服编码失败"));
        reader.readAsDataURL(blob);
      });
      if (!current()) return;
      const socket = this.socket = new WebSocket(this.url);
      socket.binaryType = "blob";
      socket.onopen = () => {
        if (current()) socket.send(JSON.stringify({ type: "init", protocol: 2, smoothing: smooth, trace_id: this.traceId,
          automated: navigator.webdriver === true, garment_id: garment.id, garment_image: garmentImage, generation_profile: profile,
          cache_policy: "motion-priority" }));
      };
      socket.onerror = () => fail("完整画面服务连接失败，请检查 5090 隧道 8022");
      socket.onclose = () => fail("生成连接已关闭；已清除旧输出，请重新开始");
      socket.onmessage = async ({ data }) => {
        if (!current()) return;
        try {
          if (typeof data === "string") {
            const meta = JSON.parse(data);
            if (meta.type === "error") return fail(meta.message);
            if (meta.type === "ready") {
              clearTimeout(this.timeout);
              this.timeout = null;
              this.latestMode = meta.flow_control === "latest-frame";
              this.uploadWindow = this.latestMode && Number.isInteger(meta.upload_window)
                ? Math.max(1, Math.min(3, meta.upload_window)) : 1;
              this.smoothing = meta.smoothing === true;
              this.motionPriority = meta.motion_priority === true;
              this.captureFps = Math.max(1, Math.min(15, meta.capture_fps || 12));
              this.log.record("client_ready", null, { smooth: this.smoothing, latest_mode: this.latestMode, capture_fps: this.captureFps,
                output_width: meta.width, output_height: meta.height, input_width: 512, upload_window: this.uploadWindow,
                motion_priority: this.motionPriority });
              if (meta.heartbeat && this.latestMode) {
                const ping = () => {
                  if (!current() || socket.readyState !== WebSocket.OPEN) return;
                  const id = ++this.pingSequence;
                  this.pings.set(id, performance.now());
                  if (this.pings.size > 8) this.pings.delete(this.pings.keys().next().value);
                  socket.send(JSON.stringify({ type: "ping", id }));
                };
                ping(); this.pingTimer = setInterval(ping, 2000);
              }
              this.onStatus("generating", "正在生成当前相机画面");
              this.scheduleCapture(epoch, fail);
            } else if (meta.type === "pong") {
              const sentAt = this.pings.get(meta.id);
              if (sentAt != null) {
                this.rttSamples.push(performance.now() - sentAt);
                if (this.rttSamples.length > 32) this.rttSamples.shift();
                this.pings.delete(meta.id);
              }
            } else if (meta.type === "accepted" && this.latestMode) {
              const upload = this.uploads.get(meta.id);
              if (!upload) throw new Error("上传确认与已发送帧不匹配");
              upload.uploadAckMs = performance.now() - upload.capturedAt;
              clearTimeout(upload.ackTimer);
              this.uploads.delete(meta.id);
              this.log.record("client_ack", meta.id, { upload_ack_ms: upload.uploadAckMs, buffered_bytes: socket.bufferedAmount,
                unacked_uploads: this.uploads.size, upload_window: this.uploadWindow });
              if (meta.dropped_id != null) {
                this.records.delete(meta.dropped_id);
                this.log.record("client_input_dropped", meta.dropped_id);
              }
              this.scheduleCapture(epoch, fail, Math.max(0, this.lastCaptureAt + 1000 / this.captureFps - performance.now()));
            } else if (meta.type === "frame") {
              const captured = this.records.get(meta.id);
              if (!captured) throw new Error("输出帧与已采样帧不匹配");
              this.resultMeta = { ...captured, meta, metadataReceivedAt: performance.now() };
            }
            return;
          }
          const pending = this.resultMeta;
          this.resultMeta = null;
          if (!pending?.meta) throw new Error("生成画面缺少对应时间记录");
          const receivedAt = performance.now();
          this.log.record("client_receive", pending.id, { capture_to_payload_ms: receivedAt - pending.capturedAt,
            header_to_payload_ms: receivedAt - pending.metadataReceivedAt, response_bytes: data.size,
            buffered_bytes: socket.bufferedAmount, records: this.records.size });
          this.frames += 1;
          if (!this.startedAt) this.startedAt = receivedAt;
          const frames = this.frames;
          const generatedFps = frames > 1 ? (frames - 1) * 1000 / (receivedAt - this.startedAt) : 0;
          this.records.delete(pending.id);
          clearTimeout(this.timeout);
          this.timeout = null;
          if (this.latestMode) this.timeout = setTimeout(() => fail("连续生成超时；已清除旧输出，请重试"), 30000);
          const sequence = ++this.decodeSequence;
          const lengths = pending.meta.image_lengths || [data.size];
          if (!Array.isArray(lengths) || lengths.length < 1 || lengths.length > 4 ||
              lengths.some((n) => !Number.isInteger(n) || n <= 0) || lengths.reduce((a, b) => a + b, 0) !== data.size) {
            throw new Error("完整帧数据长度异常");
          }
          // A newer full frame has arrived. Do not replay old intermediate
          // poses while its image decoder is busy; keep the last shown frame.
          this.cancelPlayback();
          if (this.latestMode && receivedAt - pending.capturedAt > 2000) {
            this.log.record("client_output_dropped", pending.id, { expired: true, age_ms: receivedAt - pending.capturedAt });
            this.onStatus("generating", "传输延迟，已跳过过期画面，等待最新人物帧");
            return;
          }
          let offset = 0;
          const decodeStartedAt = performance.now();
          const decoded = await Promise.allSettled(lengths.map((length) => {
            const part = data.slice(offset, offset + length, pending.meta.mime_type || "image/jpeg"); offset += length;
            return createImageBitmap(part);
          }));
          const bitmaps = decoded.filter((part) => part.status === "fulfilled").map((part) => part.value);
          const decodedAt = performance.now();
          if (decoded.some((part) => part.status === "rejected")) {
            bitmaps.forEach((bitmap) => bitmap.close());
            throw new Error("完整画面解码失败");
          }
          if (!current() || sequence !== this.decodeSequence || pending.id <= this.lastDisplayedId) {
            this.log.record("client_output_dropped", pending.id, { decode_ms: decodedAt - decodeStartedAt });
            bitmaps.forEach((bitmap) => bitmap.close()); return;
          }
          const playback = this.playbackEpoch;
          // Interpolation must not keep replaying an old pose after a slow
          // inference/network hop. Spend at most 90ms, within a 420ms frame age.
          const lastIndex = bitmaps.length - 1;
          const playbackBudget = Math.min(90, Math.max(0, 420 - (decodedAt - pending.capturedAt)));
          const spacing = lastIndex > 0 ? Math.min(
            Math.min(240, Math.max(0, pending.meta.display_span_ms || 200)) / bitmaps.length,
            playbackBudget / lastIndex,
          ) : 0;
          let skippedIntermediates = spacing > 0 ? 0 : lastIndex;
          try {
            for (let index = spacing > 0 ? 0 : lastIndex; index < bitmaps.length; index += 1) {
              if (index > 0) await new Promise((resolve) => {
                this.playbackWake = resolve;
                this.playbackTimer = setTimeout(resolve, Math.max(0, decodedAt + index * spacing - performance.now()));
              });
              if (!current() || playback !== this.playbackEpoch) return;
              if (index < lastIndex && performance.now() - pending.capturedAt >= 420) {
                skippedIntermediates += lastIndex - index;
                index = lastIndex;
              }
              const bitmap = bitmaps[index], { canvas } = this;
              // The model edits the whole letterboxed square, including its
              // padding. Present only this capture's actual camera rectangle;
              // generated padding is not part of the person's camera view.
              const rect = pending.contentRect || { x: 0, y: 0, width: 1, height: 1 };
              const left = Math.max(0, Math.min(bitmap.width - 1, Math.round(rect.x * bitmap.width)));
              const top = Math.max(0, Math.min(bitmap.height - 1, Math.round(rect.y * bitmap.height)));
              const width = Math.max(1, Math.min(bitmap.width, Math.round((rect.x + rect.width) * bitmap.width)) - left);
              const height = Math.max(1, Math.min(bitmap.height, Math.round((rect.y + rect.height) * bitmap.height)) - top);
              if (canvas.width !== width) canvas.width = width;
              if (canvas.height !== height) canvas.height = height;
              const ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
              ctx.setTransform(-1, 0, 0, 1, canvas.width, 0);
              ctx.drawImage(bitmap, left, top, width, height, 0, 0, width, height);
              canvas.hidden = false;
              this.displayFrames += 1;
              const paintedAt = performance.now();
              this.log.record("client_paint", pending.id, { batch_index: index, batch_size: bitmaps.length,
                intermediate: index < bitmaps.length - 1, capture_to_paint_ms: paintedAt - pending.capturedAt });
              if (!this.displayStartedAt) this.displayStartedAt = paintedAt;
              if (index === bitmaps.length - 1) {
                canvas.dataset.frameId = String(pending.id);
                this.lastDisplayedId = pending.id;
                const rafStartedAt = performance.now();
                await new Promise(requestAnimationFrame);
                if (!current() || playback !== this.playbackEpoch) return;
                const displayedAt = performance.now();
                const sortedRtt = [...this.rttSamples].sort((a, b) => a - b);
                this.log.displayed(pending.id, pending.capturedAt, {
                  total_ms: displayedAt - pending.capturedAt, capture_encode_ms: pending.captureEncodeMs,
                  capture_mode: pending.captureMode, worker_encode_ms: pending.workerEncodeMs,
                  worker_draw_ms: pending.workerDrawMs, snapshot_ms: pending.snapshotMs,
                  upload_ack_ms: pending.uploadAckMs, capture_to_payload_ms: receivedAt - pending.capturedAt,
                  header_to_payload_ms: receivedAt - pending.metadataReceivedAt,
                  decode_ms: decodedAt - decodeStartedAt, playback_ms: paintedAt - decodedAt,
                  playback_budget_ms: playbackBudget, skipped_intermediates: skippedIntermediates,
                  raf_wait_ms: displayedAt - rafStartedAt, display_buffer_ms: displayedAt - receivedAt,
                  inference_ms: pending.meta.inference_ms, service_ms: pending.meta.service_ms,
                  queue_ms: pending.meta.queue_ms, executor_wait_ms: pending.meta.executor_wait_ms,
                  interpolation_ms: pending.meta.interpolation_ms, response_encode_ms: pending.meta.response_encode_ms,
                  response_bytes: data.size, generated_fps: generatedFps, smooth: this.smoothing,
                  upload_window: this.uploadWindow, unacked_uploads: this.uploads.size,
                  output_width: bitmap.width, output_height: bitmap.height,
                  visible_width: width, visible_height: height, padding_removed: width !== bitmap.width || height !== bitmap.height,
                  motion_priority: pending.meta.motion_priority === true,
                  network_rtt_ms: sortedRtt.length ? sortedRtt[Math.floor(sortedRtt.length / 2)] : undefined,
                  hidden: document.hidden, automated: navigator.webdriver === true,
                });
                this.onFrame({ ...pending.meta, frames, generatedFps, smoothing: this.smoothing,
                  captureEncodeMs: pending.captureEncodeMs,
                  captureMode: pending.captureMode, workerEncodeMs: pending.workerEncodeMs,
                  uploadAckMs: pending.uploadAckMs,
                  networkRttMs: sortedRtt.length ? sortedRtt[Math.floor(sortedRtt.length / 2)] : null,
                  networkP95Ms: sortedRtt.length ? sortedRtt[Math.min(sortedRtt.length - 1, Math.ceil(sortedRtt.length * .95) - 1)] : null,
                  displayFps: this.displayFrames > 1 ? (this.displayFrames - 1) * 1000 / (paintedAt - this.displayStartedAt) : 0,
                  displayBufferMs: displayedAt - receivedAt,
                  sampleToDrawMs: displayedAt - pending.capturedAt, responseBytes: data.size });
                this.onStatus("ready", "完整画面由模型连续生成");
              }
            }
          } finally { bitmaps.forEach((bitmap) => bitmap.close()); }
          if (!this.latestMode && current()) {
            this.pending = null;
            this.scheduleCapture(epoch, fail);
          }
        } catch (error) { fail(error.message); }
      };
    } catch (error) { if (current()) fail(error.message); }
  }

  scheduleCapture(epoch, fail, delay = 0) {
    if (epoch !== this.epoch || !this.running || this.timer != null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.sendLatest(epoch, fail);
    }, delay);
  }

  async sendLatest(epoch, fail) {
    if (epoch !== this.epoch || !this.running || this.pending) return;
    if (this.latestMode && this.uploads.size >= this.uploadWindow) return;
    if (this.socket?.bufferedAmount > 128 * 1024) {
      this.scheduleCapture(epoch, fail, 20);
      return;
    }
    const video = this.video;
    const frameNumber = this.videoFrameCallbackId != null ? this.presentedFrame : (video.getVideoPlaybackQuality?.().totalVideoFrames || video.currentTime);
    if (video.readyState < 2 || frameNumber < 0 || frameNumber === this.lastPresentedFrame) {
      this.scheduleCapture(epoch, fail, 30);
      return;
    }
    this.lastVideoTime = video.currentTime;
    this.lastPresentedFrame = frameNumber;
    const capturedAt = performance.now();
    this.lastCaptureAt = capturedAt;
    this.pending = { id: ++this.sequence, capturedAt };
    this.records.set(this.pending.id, this.pending);
    if (this.records.size > 64) this.records.delete(this.records.keys().next().value);
    if (!this.timeout) this.timeout = setTimeout(() => fail("当前帧生成超时；已清除旧输出，请重试"), 30000);
    let encoded;
    try { encoded = await this.encodeFrame(epoch); }
    catch { if (epoch === this.epoch) fail("相机帧编码失败"); return; }
    if (epoch !== this.epoch || !encoded) return;
    const { blob } = encoded;
    this.pending.captureEncodeMs = performance.now() - capturedAt;
    this.pending.captureMode = encoded.capture_mode;
    this.pending.workerEncodeMs = encoded.worker_encode_ms;
    this.pending.workerDrawMs = encoded.worker_draw_ms;
    this.pending.snapshotMs = encoded.snapshot_ms;
    this.pending.contentRect = {
      x: encoded.content_x / encoded.input_width, y: encoded.content_y / encoded.input_height,
      width: encoded.content_width / encoded.input_width, height: encoded.content_height / encoded.input_height,
    };
    const rect = this.pending.contentRect;
    if (!Number.isFinite(rect.x + rect.y + rect.width + rect.height) || rect.width <= 0 || rect.height <= 0) {
      this.pending.contentRect = { x: 0, y: 0, width: 1, height: 1 };
    }
    this.log.record("client_capture", this.pending.id, { capture_encode_ms: this.pending.captureEncodeMs,
      camera_callback_age_ms: this.lastCameraObservedAt != null ? capturedAt - this.lastCameraObservedAt : undefined,
      source_frame: frameNumber, input_bytes: blob?.size || 0, buffered_bytes: this.socket?.bufferedAmount || 0,
      unacked_uploads: this.uploads.size, upload_window: this.uploadWindow, input_width: encoded.input_width,
      input_height: encoded.input_height, content_x: encoded.content_x, content_y: encoded.content_y,
      content_width: encoded.content_width, content_height: encoded.content_height });
    if (!blob || this.socket?.readyState !== WebSocket.OPEN) return fail("相机帧编码或连接失败");
    const upload = this.pending;
    if (this.latestMode) {
      upload.ackTimer = setTimeout(() => { if (epoch === this.epoch) fail("上传确认超时；请重试"); }, 30000);
      this.uploads.set(upload.id, upload);
    }
    this.socket.send(JSON.stringify({ type: "frame", id: upload.id }));
    this.socket.send(blob);
    if (this.latestMode) {
      this.pending = null;
      if (this.uploads.size < this.uploadWindow) {
        this.scheduleCapture(epoch, fail, Math.max(0, capturedAt + 1000 / this.captureFps - performance.now()));
      }
    }
  }
}
