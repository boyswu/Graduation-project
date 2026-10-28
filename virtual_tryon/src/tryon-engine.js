import visionBundleSource from "../node_modules/@mediapipe/tasks-vision/vision_bundle.js?raw";
import { LandmarkSmoother } from "./one-euro.js";

const POSE_CONNECTIONS = [
  [11, 12],
  [11, 13],
  [13, 15],
  [12, 14],
  [14, 16],
  [11, 23],
  [12, 24],
  [23, 24],
  [23, 25],
  [25, 27],
  [24, 26],
  [26, 28],
];

const LANDMARK_INDEX = {
  leftShoulder: 11,
  rightShoulder: 12,
  leftElbow: 13,
  rightElbow: 14,
  leftWrist: 15,
  rightWrist: 16,
  leftHip: 23,
  rightHip: 24,
  leftKnee: 25,
  rightKnee: 26,
  leftAnkle: 27,
  rightAnkle: 28,
};

const VERTEX_SHADER = `
  attribute vec2 aPosition;
  attribute vec2 aUv;
  varying vec2 vUv;
  varying vec2 vScreenUv;

  void main() {
    gl_Position = vec4(aPosition, 0.0, 1.0);
    vUv = aUv;
    vScreenUv = aPosition * 0.5 + 0.5;
  }
`;

const VIDEO_FRAGMENT_SHADER = `
  precision mediump float;
  varying vec2 vUv;
  uniform sampler2D uVideo;
  uniform sampler2D uMask;
  uniform float uUseMask;
  uniform float uDim;

  void main() {
    vec2 uv = vec2(1.0 - vUv.x, vUv.y);
    vec3 video = texture2D(uVideo, uv).rgb;
    float person = texture2D(uMask, uv).r;
    person = mix(1.0, person, uUseMask);

    vec3 studio = mix(vec3(0.026, 0.034, 0.041), video * 0.58, 0.18);
    float vignette = smoothstep(0.86, 0.18, distance(vUv, vec2(0.5)));
    video *= mix(0.82, 1.0, vignette);
    vec3 color = mix(video, studio, (1.0 - person) * uDim);
    gl_FragColor = vec4(color, 1.0);
  }
`;

const GARMENT_FRAGMENT_SHADER = `
  precision mediump float;
  varying vec2 vUv;
  varying vec2 vScreenUv;
  uniform sampler2D uGarment;
  uniform sampler2D uPersonMask;
  uniform float uShadow;
  uniform float uNeural;
  uniform float uUsePersonMask;

  void main() {
    vec4 sampleColor = texture2D(uGarment, vUv);
    float edge = smoothstep(0.0, 0.035, min(min(vUv.x, 1.0 - vUv.x), min(vUv.y, 1.0 - vUv.y)));
    float fold = 0.965 + 0.035 * sin(vUv.x * 38.0 + vUv.y * 8.0);
    vec3 fabric = sampleColor.rgb;
    fabric *= mix(1.0, mix(0.84, 1.0, edge) * fold, 1.0 - uNeural);
    vec2 maskUv = vec2(1.0 - vScreenUv.x, vScreenUv.y);
    float person = texture2D(uPersonMask, maskUv).r;
    float silhouette = mix(1.0, smoothstep(0.03, 0.58, person), uUsePersonMask);

    if (uShadow > 0.5) {
      gl_FragColor = vec4(0.012, 0.017, 0.02, sampleColor.a * 0.2 * silhouette);
    } else {
      float alpha = mix(sampleColor.a * 0.97, smoothstep(0.02, 0.48, sampleColor.a), uNeural);
      gl_FragColor = vec4(fabric, alpha * silhouette);
    }
  }
`;

const OCCLUSION_FRAGMENT_SHADER = `
  precision mediump float;
  varying vec2 vUv;
  uniform sampler2D uVideo;
  uniform sampler2D uForegroundMask;

  void main() {
    vec2 uv = vec2(1.0 - vUv.x, vUv.y);
    vec3 video = texture2D(uVideo, uv).rgb;
    float foreground = texture2D(uForegroundMask, uv).r;
    float alpha = smoothstep(0.08, 0.72, foreground);
    gl_FragColor = vec4(video, alpha);
  }
`;

const TRYON_WIDTH = 512;
const TRYON_HEIGHT = 768;
const CLOTHING_CATEGORY = 4;
const MAPPING_ANCHORS = [11, 12, 13, 14, 15, 16, 23, 24, 25, 26];

const clamp01 = (value) => Math.max(0, Math.min(1, value));
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (t) => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};

function pointDistance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function mixPoint(a, b, t) {
  return {
    x: lerp(a.x, b.x, t),
    y: lerp(a.y, b.y, t),
  };
}

function normalizeVector(x, y) {
  const length = Math.hypot(x, y) || 1;
  return { x: x / length, y: y / length };
}

function weightedAverage(items) {
  let weight = 0;
  let x = 0;
  let y = 0;
  for (const [point, pointWeight] of items) {
    const safeWeight = Math.max(0.05, pointWeight);
    x += point.x * safeWeight;
    y += point.y * safeWeight;
    weight += safeWeight;
  }
  return { x: x / weight, y: y / weight };
}

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`WebGL shader compile failed: ${message}`);
  }
  return shader;
}

function createProgram(gl, vertexSource, fragmentSource) {
  const program = gl.createProgram();
  const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`WebGL program link failed: ${message}`);
  }
  return program;
}

function createQuadBuffer(gl) {
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([
      -1, -1, 0, 0,
      1, -1, 1, 0,
      1, 1, 1, 1,
      -1, -1, 0, 0,
      1, 1, 1, 1,
      -1, 1, 0, 1,
    ]),
    gl.STATIC_DRAW,
  );
  return buffer;
}

function createTexture(gl) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  return texture;
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Unable to load garment: ${url}`));
    image.src = url;
  });
}

function getWebGLRenderer(gl) {
  const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
  if (!debugInfo) return "WebGL renderer unavailable";
  return String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) || "WebGL");
}

// Off-screen joints are geometry estimates, never claimed to be observed joints.
export function completeUpperBodyPose(points, width = 1, height = 1) {
  if (!points?.[11] || !points?.[12]) return null;
  const visible = (p) => p && Number.isFinite(p.x) && Number.isFinite(p.y) &&
    (p.visibility ?? 0) >= 0.25 && p.x >= -0.05 && p.x <= 1.05 && p.y >= 0 && p.y <= 1;
  if (![points[11], points[12]].every(visible)) return null;
  const left = { x: points[11].x * width, y: points[11].y * height };
  const right = { x: points[12].x * width, y: points[12].y * height };
  const span = pointDistance(left, right);
  if (span < width * 0.045) return null;
  const across = normalizeVector(right.x - left.x, right.y - left.y);
  let down = { x: -across.y, y: across.x };
  if (down.y < 0) down = { x: -down.x, y: -down.y };
  const result = Array.from({ length: 33 }, (_, index) => ({
    x: 0.5, y: 0.5, visibility: 0, ...(points[index] ?? {}),
  }));
  const estimate = (index, origin, along, outward = 0) => {
    if (visible(points[index])) return;
    result[index] = {
      x: (origin.x + down.x * span * along + across.x * span * outward) / width,
      y: (origin.y + down.y * span * along + across.y * span * outward) / height,
      z: 0, visibility: 0, estimated: true,
    };
  };
  const center = mixPoint(left, right, 0.5);
  estimate(23, center, 1.5, -0.36); estimate(24, center, 1.5, 0.36);
  estimate(13, left, 0.75, -0.14); estimate(14, right, 0.75, 0.14);
  estimate(15, left, 1.45, -0.17); estimate(16, right, 1.45, 0.17);
  estimate(25, center, 2.8, -0.36); estimate(26, center, 2.8, 0.36);
  return result;
}

export class TryOnEngine {
  constructor({ canvas, poseCanvas, generatedCanvas, onStats, onStatus }) {
    this.canvas = canvas;
    this.poseCanvas = poseCanvas;
    this.generatedCanvas = generatedCanvas;
    this.ctx = poseCanvas.getContext("2d");
    this.onStats = onStats;
    this.onStatus = onStatus;

    this.gl = canvas.getContext("webgl", {
      alpha: false,
      antialias: true,
      preserveDrawingBuffer: false,
      premultipliedAlpha: false,
    });
    if (!this.gl) throw new Error("WebGL is not available in this browser.");
    this.webglRenderer = getWebGLRenderer(this.gl);
    this.inferenceDelegate = "pending";

    this.video = document.createElement("video");
    this.video.autoplay = true;
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.setAttribute("aria-hidden", "true");

    this.demoCanvas = document.createElement("canvas");
    this.demoCanvas.width = 1280;
    this.demoCanvas.height = 960;
    this.demoCtx = this.demoCanvas.getContext("2d");

    this.maskCanvas = document.createElement("canvas");
    this.maskCtx = this.maskCanvas.getContext("2d", { willReadFrequently: true });
    this.foregroundCanvas = document.createElement("canvas");
    this.foregroundCtx = this.foregroundCanvas.getContext("2d", {
      willReadFrequently: true,
    });

    this.poseLandmarker = null;
    this.segmenter = null;
    this.staticSegmenter = null;
    this.trackingWorker = null;
    this.workerRequests = new Map();
    this.workerSequence = 0;
    this.frameInFlight = false;
    this.imageSegmentationPending = false;
    this.cameraEpoch = 0;
    this.trackingAgeMs = 0;
    this.trackingMode = "none";
    this.modelsReady = false;
    this.modelLoading = false;
    this.cameraStream = null;
    this.source = "demo";
    this.fullFrameMode = false;
    this.landmarks = null;
    this.rawLandmarks = null;
    this.filteredLandmarks = null;
    this.smoother = new LandmarkSmoother(33);
    this.maskData = null;
    this.clothingMaskData = null;
    this.foregroundMaskData = null;
    this.maskReady = false;
    this.garmentImage = null;
    this.garment = null;
    this.neuralLayerReady = false;
    this.neuralCapturePose = null;
    this.neuralLayerDebug = null;
    this.neuralDebugCanvases = null;
    this.neuralLayerUpdatedAt = 0;
    this.lastVideoTime = -1;
    this.lastInferenceAt = 0;
    this.lastMaskAt = 0;
    this.lastPoseAt = 0;
    this.lastPoseInferenceAt = 0;
    this.lastPoseVideoTime = -1;
    this.lastMaskVideoTime = -1;
    this.poseIntervalMs = 1000 / 20;
    this.maskIntervalMs = 1000 / 6;
    this.poseHz = 0;
    this.maskHz = 0;
    this.cameraFps = 0;
    this.cameraFrameCount = 0;
    this.videoFrameCallbackId = null;
    this.latestVideoFrameId = 0;
    this.latestVideoMediaTime = -1;
    this.poseInferenceCount = 0;
    this.maskInferenceCount = 0;
    this.inferenceRateStartedAt = performance.now();
    this.lastFrameAt = performance.now();
    this.lastStatsAt = 0;
    this.frameIntervals = [];
    this.poseSamples = [];
    this.frameCount = 0;
    this.droppedFrames = 0;
    this.poseMs = 0;
    this.segmentMs = 0;
    this.renderMs = 0;
    this.fps = 0;
    this.jitterPx = 0;
    this.confidence = 0;
    this.motion = 0;
    this.previousShoulderCenter = null;
    this.showPose = true;
    this.useMask = true;
    this.backgroundDim = 0.44;
    this.smoothness = 0.58;
    this.smoother.setResponse(this.smoothness);
    this.fitWidth = 1;
    this.drape = 1;
    this.gridColumns = 36;
    this.gridRows = 54;
    this.width = 0;
    this.height = 0;
    this.running = true;

    this.initGL();
    this.buildGarmentMesh();
    this.resizeToSource(this.demoCanvas.width, this.demoCanvas.height);
    this.pageVisible = !document.hidden;
    this.scheduleRender();
  }

  initGL() {
    const gl = this.gl;
    this.videoProgram = createProgram(gl, VERTEX_SHADER, VIDEO_FRAGMENT_SHADER);
    this.garmentProgram = createProgram(gl, VERTEX_SHADER, GARMENT_FRAGMENT_SHADER);
    this.occlusionProgram = createProgram(
      gl,
      VERTEX_SHADER,
      OCCLUSION_FRAGMENT_SHADER,
    );
    this.quadBuffer = createQuadBuffer(gl);
    this.videoTexture = createTexture(gl);
    this.maskTexture = createTexture(gl);
    this.foregroundTexture = createTexture(gl);
    this.garmentTexture = createTexture(gl);

    this.videoLocations = {
      position: gl.getAttribLocation(this.videoProgram, "aPosition"),
      uv: gl.getAttribLocation(this.videoProgram, "aUv"),
      video: gl.getUniformLocation(this.videoProgram, "uVideo"),
      mask: gl.getUniformLocation(this.videoProgram, "uMask"),
      useMask: gl.getUniformLocation(this.videoProgram, "uUseMask"),
      dim: gl.getUniformLocation(this.videoProgram, "uDim"),
    };
    this.garmentLocations = {
      position: gl.getAttribLocation(this.garmentProgram, "aPosition"),
      uv: gl.getAttribLocation(this.garmentProgram, "aUv"),
      garment: gl.getUniformLocation(this.garmentProgram, "uGarment"),
      personMask: gl.getUniformLocation(this.garmentProgram, "uPersonMask"),
      shadow: gl.getUniformLocation(this.garmentProgram, "uShadow"),
      neural: gl.getUniformLocation(this.garmentProgram, "uNeural"),
      usePersonMask: gl.getUniformLocation(this.garmentProgram, "uUsePersonMask"),
    };
    this.occlusionLocations = {
      position: gl.getAttribLocation(this.occlusionProgram, "aPosition"),
      uv: gl.getAttribLocation(this.occlusionProgram, "aUv"),
      video: gl.getUniformLocation(this.occlusionProgram, "uVideo"),
      foregroundMask: gl.getUniformLocation(
        this.occlusionProgram,
        "uForegroundMask",
      ),
    };

    this.positionBuffer = gl.createBuffer();
    this.uvBuffer = gl.createBuffer();
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0.025, 0.032, 0.04, 1);
  }

  buildGarmentMesh() {
    const gl = this.gl;
    const columns = this.gridColumns;
    const rows = this.gridRows;
    const uv = new Float32Array((columns + 1) * (rows + 1) * 2);
    let cursor = 0;
    for (let row = 0; row <= rows; row += 1) {
      const v = row / rows;
      for (let column = 0; column <= columns; column += 1) {
        uv[cursor] = column / columns;
        uv[cursor + 1] = 1 - v;
        cursor += 2;
      }
    }

    const indices = [];
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const a = row * (columns + 1) + column;
        const b = a + 1;
        const c = a + columns + 1;
        const d = c + 1;
        indices.push(a, c, b, b, c, d);
      }
    }

    this.garmentPositions = new Float32Array((columns + 1) * (rows + 1) * 2);
    this.garmentShadowPositions = new Float32Array(this.garmentPositions.length);
    this.indexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(indices), gl.STATIC_DRAW);
    this.indexCount = indices.length;

    gl.bindBuffer(gl.ARRAY_BUFFER, this.uvBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, uv, gl.STATIC_DRAW);
  }

  resizeToSource(width, height) {
    const cappedWidth = Math.min(1280, Math.round(width || 1280));
    const ratio = height / width || 0.75;
    const cappedHeight = Math.round(cappedWidth * ratio);
    if (this.canvas.width === cappedWidth && this.canvas.height === cappedHeight) return;

    this.canvas.width = cappedWidth;
    this.canvas.height = cappedHeight;
    this.poseCanvas.width = cappedWidth;
    this.poseCanvas.height = cappedHeight;
    this.width = cappedWidth;
    this.height = cappedHeight;
    this.gl.viewport(0, 0, cappedWidth, cappedHeight);
  }

  workerCall(type, data = {}, transfer = []) {
    return new Promise((resolve, reject) => {
      const id = ++this.workerSequence;
      const timer = setTimeout(() => {
        this.workerRequests.delete(id);
        reject(new Error(`后台视觉任务超时：${type}`));
      }, type === "init" ? 60000 : 15000);
      this.workerRequests.set(id, { resolve, reject, timer });
      try { this.trackingWorker.postMessage({ id, type, ...data }, transfer); }
      catch (error) { clearTimeout(timer); this.workerRequests.delete(id); reject(error); }
    });
  }

  async loadModels() {
    if (this.modelsReady) return true;
    if (this.modelLoadPromise) return this.modelLoadPromise;
    this.modelLoading = true;
    this.onStatus?.({ phase: "loading", message: "后台加载半身跟踪与分割" });
    this.modelLoadPromise = (async () => {
      try {
        this.trackingWorker = new Worker(new URL("./tracking-worker.js", import.meta.url));
        this.trackingWorker.onmessage = ({ data }) => {
          const pending = this.workerRequests.get(data.id);
          if (!pending) return;
          clearTimeout(pending.timer);
          this.workerRequests.delete(data.id);
          if (data.error) pending.reject(new Error(data.error));
          else pending.resolve(data.result);
        };
        this.trackingWorker.onerror = (event) => {
          const error = new Error(event.message || "后台视觉线程异常");
          for (const pending of this.workerRequests.values()) {
            clearTimeout(pending.timer); pending.reject(error);
          }
          this.workerRequests.clear();
          this.modelsReady = false;
          this.onStatus?.({ phase: "error", message: "跟踪线程异常", detail: error.message });
        };
        const delegate = new URLSearchParams(location.search).get("delegate")?.toUpperCase() === "CPU" ? "CPU" : "GPU";
        const bundleUrl = URL.createObjectURL(new Blob([visionBundleSource], { type: "application/javascript" }));
        let result;
        try {
          result = await this.workerCall("init", { bundleUrl, origin: location.origin, delegate });
        } finally { URL.revokeObjectURL(bundleUrl); }
        this.inferenceDelegate = result.delegate;
        this.modelsReady = true;
        this.onStatus?.({ phase: "ready", message: "后台半身跟踪已就绪" });
        return true;
      } catch (error) {
        this.trackingWorker?.terminate();
        this.trackingWorker = null;
        this.onStatus?.({ phase: "error", message: "模型加载失败", detail: error.message });
        throw error;
      } finally {
        this.modelLoading = false;
        this.modelLoadPromise = null;
      }
    })();
    return this.modelLoadPromise;
  }

  async startCamera(deviceId = null) {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("当前浏览器不支持摄像头访问。");
    }

    this.stopCamera();
    const videoConstraints = {
      width: { ideal: 960 },
      height: { ideal: 720 },
      frameRate: { ideal: 30, max: 30 },
      facingMode: "user",
    };
    if (deviceId) videoConstraints.deviceId = { exact: deviceId };

    this.cameraStream = await navigator.mediaDevices.getUserMedia({
      video: videoConstraints,
      audio: false,
    });
    this.video.srcObject = this.cameraStream;
    await this.video.play();
    this.source = "camera";
    this.lastVideoTime = -1;
    this.lastUploadedVideoFrameId = -1;
    this.latestVideoFrameId = 0;
    this.latestVideoMediaTime = -1;
    if (this.video.requestVideoFrameCallback) {
      const epoch = this.cameraEpoch;
      const onFrame = (_, metadata) => {
        if (epoch !== this.cameraEpoch || this.source !== "camera") return;
        this.latestVideoFrameId = metadata.presentedFrames;
        this.latestVideoMediaTime = metadata.mediaTime;
        this.cameraFrameCount += 1;
        this.videoFrameCallbackId = this.video.requestVideoFrameCallback(onFrame);
      };
      this.videoFrameCallbackId = this.video.requestVideoFrameCallback(onFrame);
    }
    this.lastPoseAt = 0;
    this.lastPoseInferenceAt = 0;
    this.lastMaskAt = 0;
    this.lastPoseVideoTime = -1;
    this.lastMaskVideoTime = -1;
    this.poseInferenceCount = 0;
    this.maskInferenceCount = 0;
    this.inferenceRateStartedAt = performance.now();
    this.poseHz = 0;
    this.maskHz = 0;
    this.cameraFps = 0;
    this.cameraFrameCount = 0;
    this.landmarks = null;
    this.rawLandmarks = null;
    this.filteredLandmarks = null;
    this.maskReady = false;
    this.maskData = null;
    this.clothingMaskData = null;
    this.foregroundMaskData = null;
    this.foregroundCanvas.width = 0;
    this.foregroundCanvas.height = 0;
    this.confidence = 0;
    this.jitterPx = 0;
    this.previousShoulderCenter = null;
    this.poseSamples = [];
    this.smoother = new LandmarkSmoother(33);
    this.smoother.setResponse(this.smoothness);
    this.onStatus?.({ phase: "live", message: "摄像头实时流" });
    if (!this.fullFrameMode) await this.loadModels();
  }

  stopCamera() {
    this.cameraEpoch += 1;
    if (this.videoFrameCallbackId !== null) this.video.cancelVideoFrameCallback?.(this.videoFrameCallbackId);
    this.videoFrameCallbackId = null;
    this.trackingMode = "none";
    if (this.cameraStream) {
      for (const track of this.cameraStream.getTracks()) track.stop();
      this.cameraStream = null;
    }
    this.video.srcObject = null;
    this.rawLandmarks = null;
    if (this.source === "camera") this.source = "demo";
  }

  async setGarment(garment) {
    if (!garment) return;
    this.garment = garment;
    this.neuralLayerReady = false;
    this.neuralCapturePose = null;
    this.neuralLayerDebug = null;
    // Complete-frame generation uses the reference in FullFrameClient; no
    // legacy garment texture needs decoding or uploading to WebGL here.
    if (this.fullFrameMode) return;
    try {
      const image = await loadImage(garment.asset);
      if (this.garment?.id !== garment.id) return;
      // WebGL texture uploads are inconsistent for SVG images; rasterize once to a fixed canvas.
      const textureCanvas = document.createElement("canvas");
      textureCanvas.width = 512;
      textureCanvas.height = 700;
      const textureContext = textureCanvas.getContext("2d");
      textureContext.drawImage(image, 0, 0, textureCanvas.width, textureCanvas.height);
      this.garmentImage = textureCanvas;
      this.neuralLayerReady = false;
      this.neuralCapturePose = null;
      const gl = this.gl;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.garmentTexture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, textureCanvas);
    } catch (error) {
      console.error(error);
      this.onStatus?.({ phase: "error", message: "服装纹理加载失败", detail: error.message });
    }
  }

  uploadGarmentTexture(image) {
    const gl = this.gl;
    this.garmentImage = image;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.garmentTexture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
  }

  async setNeuralGarmentLayer(
    dataUrl,
    { capturedPose, maskDataUrl, capturedPersonDataUrl, signal } = {},
  ) {
    if (!dataUrl) return false;
    const [image, capturedPerson, replacementImage] = await Promise.all([
      loadImage(dataUrl),
      capturedPersonDataUrl ? loadImage(capturedPersonDataUrl) : null,
      maskDataUrl ? loadImage(maskDataUrl) : null,
    ]);
    signal?.throwIfAborted();

    const drawMirrored = (source, readFrequently = false) => {
      if (!source) return null;
      const canvas = document.createElement("canvas");
      canvas.width = TRYON_WIDTH;
      canvas.height = TRYON_HEIGHT;
      const context = canvas.getContext("2d", {
        willReadFrequently: readFrequently,
      });
      context.translate(canvas.width, 0);
      context.scale(-1, 1);
      context.drawImage(source, 0, 0, canvas.width, canvas.height);
      return canvas;
    };

    const mirrored = drawMirrored(image, true);
    const reference = drawMirrored(capturedPerson, true);
    const replacementMask = drawMirrored(replacementImage, true);
    let segmentation = null;
    if (this.trackingWorker && this.modelsReady) {
      this.imageSegmentationPending = true;
      try {
        const bitmap = await createImageBitmap(mirrored);
        segmentation = (await this.workerCall("segment-image", { bitmap }, [bitmap])).mask;
      } finally { this.imageSegmentationPending = false; }
      signal?.throwIfAborted();
    }
    const generatedClothing = this.extractGeneratedClothing(
      mirrored,
      reference,
      replacementMask,
      segmentation,
    );
    if (!generatedClothing) {
      throw new Error("生成图静态服装分割失败，已拒绝宽区域蒙版造成的假换衣");
    }

    const texture = document.createElement("canvas");
    texture.width = TRYON_WIDTH;
    texture.height = TRYON_HEIGHT;
    const textureContext = texture.getContext("2d");
    textureContext.drawImage(mirrored, 0, 0);
    textureContext.globalCompositeOperation = "destination-in";
    textureContext.filter = "blur(0.6px)";
    textureContext.drawImage(generatedClothing.canvas, 0, 0);
    textureContext.filter = "none";
    textureContext.globalCompositeOperation = "source-over";

    this.uploadGarmentTexture(texture);
    this.neuralCapturePose = capturedPose ?? null;
    this.neuralLayerReady = true;
    this.neuralLayerUpdatedAt = performance.now();
    this.neuralLayerDebug = { ...generatedClothing.stats };
    this.neuralDebugCanvases = {
      generated: mirrored,
      reference,
      replacementMask,
      alpha: generatedClothing.canvas,
      texture,
    };
    return true;
  }

  extractGeneratedClothing(source, reference, replacementMask, segmentation = null) {
    if (!this.staticSegmenter && !segmentation) return null;
    let result;
    try {
      result = segmentation ? {
        categoryMask: { width: segmentation.width, height: segmentation.height, getAsUint8Array: () => segmentation.values },
        close() {},
      } : this.staticSegmenter.segment(source);
      const categoryMask = result.categoryMask;
      if (!categoryMask) return null;
      const categories = categoryMask.getAsUint8Array();
      const maskWidth = categoryMask.width;
      const maskHeight = categoryMask.height;
      const sourcePixels = source
        .getContext("2d", { willReadFrequently: true })
        .getImageData(0, 0, TRYON_WIDTH, TRYON_HEIGHT).data;
      const referencePixels = reference
        ?.getContext("2d", { willReadFrequently: true })
        .getImageData(0, 0, TRYON_WIDTH, TRYON_HEIGHT).data;
      const replacementPixels = replacementMask
        ?.getContext("2d", { willReadFrequently: true })
        .getImageData(0, 0, TRYON_WIDTH, TRYON_HEIGHT).data;
      const totalPixels = TRYON_WIDTH * TRYON_HEIGHT;
      const candidate = new Uint8Array(totalPixels);
      const protectedPixels = new Uint8Array(totalPixels);
      const usePriorMask = Boolean(replacementPixels);
      let clothingPixels = 0;
      let changedPixels = 0;
      let priorPixels = 0;

      for (let y = 0; y < TRYON_HEIGHT; y += 1) {
        const maskY = Math.min(
          maskHeight - 1,
          Math.floor((y / TRYON_HEIGHT) * maskHeight),
        );
        for (let x = 0; x < TRYON_WIDTH; x += 1) {
          const index = y * TRYON_WIDTH + x;
          const offset = index * 4;
          const maskX = Math.min(
            maskWidth - 1,
            Math.floor((x / TRYON_WIDTH) * maskWidth),
          );
          const category = categories[maskY * maskWidth + maskX];
          const priorAlpha = replacementPixels?.[offset + 3] ?? 255;
          if (priorAlpha > 24) priorPixels += 1;

          const isClothing = category === CLOTHING_CATEGORY;
          if (isClothing) clothingPixels += 1;

          const isBackground = category === 0;
          const isHair = category === 1;
          const isBodySkin = category === 2;
          const isFaceSkin = category === 3;

          let changed = false;
          if (referencePixels && priorAlpha > 24) {
            const redDifference = Math.abs(
              sourcePixels[offset] - referencePixels[offset],
            );
            const greenDifference = Math.abs(
              sourcePixels[offset + 1] - referencePixels[offset + 1],
            );
            const blueDifference = Math.abs(
              sourcePixels[offset + 2] - referencePixels[offset + 2],
            );
            changed =
              Math.max(redDifference, greenDifference, blueDifference) > 28 ||
              redDifference + greenDifference + blueDifference > 66;
            if (changed) changedPixels += 1;
          }

          if (isBackground || isHair || isFaceSkin) {
            protectedPixels[index] = 1;
            if (!changed) continue;
          }

          if (usePriorMask) {
            // A generated grey pixel can legitimately match a source pixel.
            // Difference-based holes expose the original patterned shirt again;
            // the generated garment must remain a coherent semantic region.
            if (
              priorAlpha > 24 &&
              (isClothing || isBodySkin)
            ) {
              candidate[index] = 1;
            }
            continue;
          }

          if (
            priorAlpha <= 24 ||
            (!isClothing && !changed) ||
            (isBodySkin && !changed)
          ) {
            if (isBodySkin) protectedPixels[index] = 1;
            continue;
          }
          candidate[index] = 1;
        }
      }

      if (clothingPixels < totalPixels * 0.004) return null;

      const baseMask = new Uint8Array(totalPixels);
      if (usePriorMask) {
        // CatVTON leaves a pale halo where the blurred mask meets the image.
        // Repeated inset passes remove that contamination while leaving the
        // generated fabric and skin inside the silhouette intact.
        let currentMask = candidate;
        for (let pass = 0; pass < 3; pass += 1) {
          const eroded = new Uint8Array(totalPixels);
          for (let y = 1; y < TRYON_HEIGHT - 1; y += 1) {
            for (let x = 1; x < TRYON_WIDTH - 1; x += 1) {
              const index = y * TRYON_WIDTH + x;
              if (!currentMask[index]) continue;
              let neighbors = 0;
              for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
                for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
                  if (offsetX === 0 && offsetY === 0) continue;
                  neighbors +=
                    currentMask[index + offsetY * TRYON_WIDTH + offsetX];
                }
              }
              if (neighbors === 8) eroded[index] = 1;
            }
          }
          currentMask = eroded;
        }
        baseMask.set(currentMask);
      } else {
        for (let y = 0; y < TRYON_HEIGHT; y += 1) {
          for (let x = 0; x < TRYON_WIDTH; x += 1) {
            const index = y * TRYON_WIDTH + x;
            if (!candidate[index] || protectedPixels[index]) continue;
            for (let offsetY = -1; offsetY <= 1 && !baseMask[index]; offsetY += 1) {
              const nextY = y + offsetY;
              if (nextY < 0 || nextY >= TRYON_HEIGHT) continue;
              for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
                const nextX = x + offsetX;
                if (nextX < 0 || nextX >= TRYON_WIDTH) continue;
                if (candidate[nextY * TRYON_WIDTH + nextX]) {
                  baseMask[index] = 1;
                  break;
                }
              }
            }
          }
        }
      }

      // Clothing segmentation can split a garment around seams or exposed skin.
      // Fill only enclosed gaps, then apply a second close pass for pinholes.
      const exterior = new Uint8Array(totalPixels);
      const exteriorStack = new Int32Array(totalPixels);
      let exteriorSize = 0;
      for (let x = 0; x < TRYON_WIDTH; x += 1) {
        const top = x;
        const bottom = (TRYON_HEIGHT - 1) * TRYON_WIDTH + x;
        if (!baseMask[top]) {
          exterior[top] = 1;
          exteriorStack[exteriorSize++] = top;
        }
        if (!baseMask[bottom]) {
          exterior[bottom] = 1;
          exteriorStack[exteriorSize++] = bottom;
        }
      }
      for (let y = 0; y < TRYON_HEIGHT; y += 1) {
        const left = y * TRYON_WIDTH;
        const right = left + TRYON_WIDTH - 1;
        if (!baseMask[left] && !exterior[left]) {
          exterior[left] = 1;
          exteriorStack[exteriorSize++] = left;
        }
        if (!baseMask[right] && !exterior[right]) {
          exterior[right] = 1;
          exteriorStack[exteriorSize++] = right;
        }
      }
      while (exteriorSize > 0) {
        const index = exteriorStack[--exteriorSize];
        const x = index % TRYON_WIDTH;
        const y = Math.floor(index / TRYON_WIDTH);
        const neighbors = [
          x > 0 ? index - 1 : -1,
          x + 1 < TRYON_WIDTH ? index + 1 : -1,
          y > 0 ? index - TRYON_WIDTH : -1,
          y + 1 < TRYON_HEIGHT ? index + TRYON_WIDTH : -1,
        ];
        for (const next of neighbors) {
          if (next < 0 || baseMask[next] || exterior[next]) continue;
          exterior[next] = 1;
          exteriorStack[exteriorSize++] = next;
        }
      }
      let filledHolePixels = 0;
      for (let index = 0; index < totalPixels; index += 1) {
        if (!baseMask[index] && !exterior[index]) {
          baseMask[index] = 1;
          filledHolePixels += 1;
        }
      }

      const closed = new Uint8Array(totalPixels);
      if (usePriorMask) {
        closed.set(baseMask);
      } else {
        for (let y = 0; y < TRYON_HEIGHT; y += 1) {
          for (let x = 0; x < TRYON_WIDTH; x += 1) {
            const index = y * TRYON_WIDTH + x;
            if (!baseMask[index]) continue;
            closed[index] = 1;
            if (x === 0 || y === 0 || x === TRYON_WIDTH - 1 || y === TRYON_HEIGHT - 1) {
              continue;
            }
            if (
              baseMask[index - 1] &&
              baseMask[index + 1] &&
              baseMask[index - TRYON_WIDTH] &&
              baseMask[index + TRYON_WIDTH] &&
              (baseMask[index - TRYON_WIDTH - 1] ||
                baseMask[index - TRYON_WIDTH + 1] ||
                baseMask[index + TRYON_WIDTH - 1] ||
                baseMask[index + TRYON_WIDTH + 1])
            ) {
              for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
                for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
                  closed[index + offsetY * TRYON_WIDTH + offsetX] = 1;
                }
              }
            }
          }
        }
      }

      const visited = new Uint8Array(totalPixels);
      const keep = new Uint8Array(totalPixels);
      const stack = new Int32Array(totalPixels);
      const minimumComponent = Math.max(120, Math.round(totalPixels * 0.0004));
      for (let start = 0; start < totalPixels; start += 1) {
        if (!closed[start] || visited[start]) continue;
        let stackSize = 0;
        let componentSize = 0;
        stack[stackSize++] = start;
        visited[start] = 1;
        while (stackSize > 0) {
          const index = stack[--stackSize];
          componentSize += 1;
          const x = index % TRYON_WIDTH;
          const y = Math.floor(index / TRYON_WIDTH);
          for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
            const nextY = y + offsetY;
            if (nextY < 0 || nextY >= TRYON_HEIGHT) continue;
            for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
              const nextX = x + offsetX;
              if (nextX < 0 || nextX >= TRYON_WIDTH) continue;
              const next = nextY * TRYON_WIDTH + nextX;
              if (!closed[next] || visited[next]) continue;
              visited[next] = 1;
              stack[stackSize++] = next;
            }
          }
        }
        if (componentSize < minimumComponent) continue;
        stackSize = 0;
        stack[stackSize++] = start;
        keep[start] = 1;
        while (stackSize > 0) {
          const index = stack[--stackSize];
          const x = index % TRYON_WIDTH;
          const y = Math.floor(index / TRYON_WIDTH);
          for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
            const nextY = y + offsetY;
            if (nextY < 0 || nextY >= TRYON_HEIGHT) continue;
            for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
              const nextX = x + offsetX;
              if (nextX < 0 || nextX >= TRYON_WIDTH) continue;
              const next = nextY * TRYON_WIDTH + nextX;
              if (!closed[next] || keep[next]) continue;
              keep[next] = 1;
              stack[stackSize++] = next;
            }
          }
        }
      }

      const canvas = document.createElement("canvas");
      canvas.width = TRYON_WIDTH;
      canvas.height = TRYON_HEIGHT;
      const context = canvas.getContext("2d");
      const output = context.createImageData(TRYON_WIDTH, TRYON_HEIGHT);
      let visiblePixels = 0;
      let rejectedOldClothingPixels = 0;
      for (let index = 0; index < totalPixels; index += 1) {
        if (!keep[index]) continue;
        const offset = index * 4;
        output.data[offset] = 255;
        output.data[offset + 1] = 255;
        output.data[offset + 2] = 255;
        output.data[offset + 3] = usePriorMask
          ? Math.min(255, replacementPixels[offset + 3])
          : 255;
        visiblePixels += 1;
      }
      if (visiblePixels < totalPixels * 0.004) return null;
      context.putImageData(output, 0, 0);
      return {
        canvas,
        stats: {
          visiblePixels,
          replacementMaskPixels: priorPixels,
          clothingPixels,
          changedPixels,
          filledHolePixels,
          rejectedOldClothingPixels,
          maskDriven: usePriorMask,
          sourceConstrained: Boolean(referencePixels),
        },
      };
    } catch (error) {
      console.warn("Generated garment extraction skipped.", error);
      return null;
    } finally {
      result?.close();
    }
  }

  setOptions({ showPose, useMask, backgroundDim, smoothness, fitWidth, drape } = {}) {
    if (typeof showPose === "boolean") this.showPose = showPose;
    if (typeof useMask === "boolean") this.useMask = useMask;
    if (Number.isFinite(backgroundDim)) this.backgroundDim = backgroundDim;
    if (Number.isFinite(smoothness)) {
      this.smoothness = smoothness;
      this.smoother.setResponse(smoothness);
    }
    if (Number.isFinite(fitWidth)) this.fitWidth = fitWidth;
    if (Number.isFinite(drape)) this.drape = drape;
  }

  createDemoLandmarks(now) {
    const t = now / 1000;
    const sway = Math.sin(t * 0.62) * 0.018;
    const counter = Math.sin(t * 0.62 + Math.PI) * 0.009;
    const arm = Math.sin(t * 0.9);
    const shoulderY = 0.345 + Math.sin(t * 0.46) * 0.004;
    const hipY = 0.59 + Math.sin(t * 0.46 + 0.8) * 0.003;
    const points = Array.from({ length: 33 }, () => ({
      x: 0.5,
      y: 0.5,
      z: 0,
      visibility: 0,
    }));

    const set = (index, x, y, visibility = 0.99) => {
      points[index] = { x, y, z: 0, visibility };
    };
    set(0, 0.5 + sway, 0.176);
    set(2, 0.47 + sway, 0.177);
    set(5, 0.53 + sway, 0.177);
    set(7, 0.442 + sway, 0.185);
    set(8, 0.558 + sway, 0.185);
    set(9, 0.468 + sway, 0.22);
    set(10, 0.532 + sway, 0.22);
    set(11, 0.385 + sway, shoulderY);
    set(12, 0.615 + sway, shoulderY + 0.002);
    set(13, 0.3 + sway - arm * 0.019, 0.489 + arm * 0.009);
    set(14, 0.7 + sway + arm * 0.019, 0.489 - arm * 0.009);
    set(15, 0.255 + sway - arm * 0.024, 0.645 + arm * 0.012);
    set(16, 0.745 + sway + arm * 0.024, 0.645 - arm * 0.012);
    set(17, 0.272 + sway, 0.658);
    set(18, 0.728 + sway, 0.658);
    set(19, 0.29 + sway, 0.636);
    set(20, 0.71 + sway, 0.636);
    set(21, 0.284 + sway, 0.642);
    set(22, 0.716 + sway, 0.642);
    set(23, 0.43 + counter, hipY);
    set(24, 0.57 + counter, hipY + 0.002);
    set(25, 0.452 + counter, 0.772);
    set(26, 0.548 + counter, 0.772);
    set(27, 0.463 + counter, 0.932);
    set(28, 0.537 + counter, 0.932);
    set(29, 0.458 + counter, 0.947);
    set(30, 0.542 + counter, 0.947);
    set(31, 0.447 + counter, 0.956);
    set(32, 0.553 + counter, 0.956);
    return points;
  }

  drawDemoSource(now, landmarks) {
    const ctx = this.demoCtx;
    const { width, height } = this.demoCanvas;
    ctx.clearRect(0, 0, width, height);

    const background = ctx.createLinearGradient(0, 0, 0, height);
    background.addColorStop(0, "#222a2c");
    background.addColorStop(0.58, "#111719");
    background.addColorStop(1, "#080b0d");
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, width, height);

    ctx.fillStyle = "rgba(216, 255, 88, 0.035)";
    ctx.fillRect(width * 0.075, 0, 2, height);
    ctx.fillRect(width * 0.925, 0, 2, height);
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(width * 0.08, height * 0.82);
    ctx.lineTo(width * 0.92, height * 0.82);
    ctx.stroke();

    const p = (index) => ({
      x: landmarks[index].x * width,
      y: landmarks[index].y * height,
    });
    const shape = [11, 12, 24, 23].map(p);
    const shoulderCenter = mixPoint(p(11), p(12), 0.5);
    const hipCenter = mixPoint(p(23), p(24), 0.5);

    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.55)";
    ctx.shadowBlur = 42;
    ctx.shadowOffsetY = 26;
    ctx.fillStyle = "#6e766f";
    ctx.beginPath();
    ctx.ellipse(width * 0.5, height * 0.852, width * 0.22, height * 0.026, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.strokeStyle = "#767e76";
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = width * 0.045;
    const drawLimb = (a, b, c) => {
      ctx.beginPath();
      ctx.moveTo(p(a).x, p(a).y);
      ctx.lineTo(p(b).x, p(b).y);
      ctx.lineTo(p(c).x, p(c).y);
      ctx.stroke();
    };
    drawLimb(11, 13, 15);
    drawLimb(12, 14, 16);
    drawLimb(23, 25, 27);
    drawLimb(24, 26, 28);

    ctx.fillStyle = "#90988f";
    ctx.beginPath();
    ctx.ellipse(width * 0.5 + (shoulderCenter.x - width * 0.5) * 0.25, height * 0.165, width * 0.057, height * 0.083, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillRect(width * 0.474, height * 0.23, width * 0.052, height * 0.07);

    const torso = ctx.createLinearGradient(width * 0.34, 0, width * 0.66, 0);
    torso.addColorStop(0, "#525a54");
    torso.addColorStop(0.48, "#969e94");
    torso.addColorStop(1, "#434b46");
    ctx.fillStyle = torso;
    ctx.beginPath();
    ctx.moveTo(shape[0].x, shape[0].y);
    ctx.lineTo(shape[1].x, shape[1].y);
    ctx.lineTo(shape[2].x, shape[2].y);
    ctx.lineTo(shape[3].x, shape[3].y);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = "rgba(216,255,88,0.38)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(hipCenter.x - width * 0.13, height * 0.84);
    ctx.lineTo(hipCenter.x + width * 0.13, height * 0.84);
    ctx.stroke();
  }

  processInference(now, sourceElement) {
    if (!this.modelsReady || this.source !== "camera" || this.video.readyState < 2) return;
    if (this.frameInFlight || this.imageSegmentationPending) return;
    const videoTime = this.latestVideoMediaTime >= 0 ? this.latestVideoMediaTime : this.video.currentTime;
    const poseDue =
      now - this.lastPoseInferenceAt >= this.poseIntervalMs &&
      videoTime !== this.lastPoseVideoTime;
    const maskDue =
      now - this.lastMaskAt >= this.maskIntervalMs &&
      videoTime !== this.lastMaskVideoTime;
    if (!poseDue && !maskDue) return;

    if (poseDue) {
      this.lastPoseInferenceAt = now;
      this.lastPoseVideoTime = videoTime;
    }
    if (maskDue) {
      this.lastMaskAt = now;
      this.lastMaskVideoTime = videoTime;
    }
    this.frameInFlight = true;
    const epoch = this.cameraEpoch;
    // One in-flight snapshot: newer camera frames are never queued behind stale ones.
    void (async () => {
      try {
        const scale = Math.min(1, 640 / Math.max(this.video.videoWidth, this.video.videoHeight));
        const bitmap = await createImageBitmap(sourceElement, {
          resizeWidth: Math.max(1, Math.round(this.video.videoWidth * scale)),
          resizeHeight: Math.max(1, Math.round(this.video.videoHeight * scale)),
          resizeQuality: "low",
        });
        if (epoch !== this.cameraEpoch) { bitmap.close(); return; }
        const result = await this.workerCall("frame", { bitmap, timestamp: now, poseDue, maskDue }, [bitmap]);
        if (epoch !== this.cameraEpoch || this.source !== "camera") return;
        this.trackingAgeMs = performance.now() - now;
        if (poseDue) {
          this.poseMs = this.poseMs * 0.82 + result.poseMs * 0.18;
          this.poseInferenceCount += 1;
          this.acceptTrackedPose(result.landmarks, performance.now());
        }
        if (maskDue && result.mask) {
          this.segmentMs = this.segmentMs * 0.82 + result.segmentMs * 0.18;
          this.maskInferenceCount += 1;
          this.updateMask(result.mask.values, result.mask.width, result.mask.height);
        }
      } catch (error) {
        if (epoch === this.cameraEpoch) this.onStatus?.({ phase: "error", message: "后台跟踪暂不可用", detail: error.message });
      } finally { this.frameInFlight = false; }
    })();
  }

  acceptTrackedPose(tracked, now) {
    const completed = completeUpperBodyPose(tracked, this.video.videoWidth, this.video.videoHeight);
    if (completed) {
      this.rawLandmarks = completed;
      this.trackingMode = completed[23].estimated || completed[24].estimated ? "upper-body" : "full-body";
      const mirrored = completed.map((point) => ({ ...point, x: 1 - point.x }));
      this.landmarks = mirrored;
      this.filteredLandmarks = this.smoother.filter(mirrored, now);
      this.confidence = (completed[11].visibility + completed[12].visibility) / 2;
      this.lastPoseAt = now;
      this.refreshForegroundMask();
    } else if (now - this.lastPoseAt > 800) {
      this.landmarks = null;
      this.rawLandmarks = null;
      this.filteredLandmarks = null;
      this.trackingMode = "none";
      this.confidence = 0;
    }
  }

  hasUpperBody() {
    return Boolean(this.rawLandmarks && [11, 12].every((index) => {
      const point = this.rawLandmarks[index];
      return point && Number.isFinite(point.x) && Number.isFinite(point.y) && (point.visibility ?? 0) >= 0.25;
    }));
  }

  updateMask(values, width, height) {
    this.segmentationCategories = new Uint8Array(values);
    if (!this.maskData || this.maskData.length !== values.length) {
      this.maskData = new Float32Array(values.length);
      this.clothingMaskData = new Float32Array(values.length);
      this.foregroundMaskData = new Float32Array(values.length);
      this.maskCanvas.width = width;
      this.maskCanvas.height = height;
      this.foregroundCanvas.width = width;
      this.foregroundCanvas.height = height;
    }

    const image = this.maskCtx.createImageData(width, height);
    for (let index = 0; index < values.length; index += 1) {
      const personTarget = values[index] > 0 ? 255 : 0;
      const clothingTarget = values[index] === CLOTHING_CATEGORY ? 255 : 0;
      this.maskData[index] = this.maskData[index] * 0.64 + personTarget * 0.36;
      this.clothingMaskData[index] =
        this.clothingMaskData[index] * 0.55 + clothingTarget * 0.45;
      const value = this.maskData[index];
      const output = index * 4;
      image.data[output] = value;
      image.data[output + 1] = value;
      image.data[output + 2] = value;
      image.data[output + 3] = 255;
    }
    this.maskCtx.putImageData(image, 0, 0);
    this.refreshForegroundMask();

    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.maskTexture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.maskCanvas);
    this.maskReady = true;
  }

  refreshForegroundMask() {
    const width = this.foregroundCanvas.width;
    const height = this.foregroundCanvas.height;
    if (!width || !height || !this.foregroundMaskData) return;

    const landmarks = this.rawLandmarks;
    const shoulderSpan = landmarks?.[11] && landmarks?.[12]
      ? pointDistance({ x: landmarks[11].x * width, y: landmarks[11].y * height }, { x: landmarks[12].x * width, y: landmarks[12].y * height }) : 30;
    const forearms = [[13, 15], [14, 16]].map(([a, b]) => {
      const start = landmarks?.[a], end = landmarks?.[b];
      if (!start || !end || Math.min(start.visibility ?? 0, end.visibility ?? 0) < 0.3) return null;
      return { x: start.x * width, y: start.y * height,
        dx: (end.x - start.x) * width, dy: (end.y - start.y) * height };
    }).filter(Boolean);
    const nearForearm = (x, y) => forearms.some((arm) => {
      const length2 = arm.dx * arm.dx + arm.dy * arm.dy;
      if (length2 < 1) return false;
      const t = ((x - arm.x) * arm.dx + (y - arm.y) * arm.dy) / length2;
      if (t < 0.25 || t > 1.15) return false;
      return Math.hypot(x - arm.x - arm.dx * t, y - arm.y - arm.dy * t) < shoulderSpan * 0.11;
    });
    const image = this.foregroundCtx.createImageData(width, height);
    for (let index = 0; index < this.foregroundMaskData.length; index += 1) {
      const offset = index * 4;
      const category = this.segmentationCategories?.[index] ?? 0;
      // Do not restore every non-clothing pixel: patterned shirts are often
      // classified as skin/other. Only face/hair and tracked bare forearms occlude.
      const target = category === 1 || category === 3 ||
        (category === 2 && nearForearm(index % width, Math.floor(index / width))) ? 255 : 0;
      this.foregroundMaskData[index] = this.foregroundMaskData[index] * 0.28 + target * 0.72;
      const value = this.foregroundMaskData[index];
      image.data[offset] = value;
      image.data[offset + 1] = value;
      image.data[offset + 2] = value;
      image.data[offset + 3] = 255;
    }
    this.foregroundCtx.putImageData(image, 0, 0);
    this.stampHandOcclusion(width, height);

    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.foregroundTexture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      this.foregroundCanvas,
    );
  }

  stampHandOcclusion(width, height) {
    const landmarks = this.rawLandmarks;
    if (!landmarks) return;
    const ctx = this.foregroundCtx;
    const hands = [
      [15, 17, 18, 19, 20, 21, 22],
      [16, 18, 17, 20, 19, 22, 21],
    ];

    ctx.save();
    ctx.fillStyle = "#fff";
    ctx.strokeStyle = "#fff";
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const hand of hands) {
      const wrist = landmarks[hand[0]];
      const pinky = landmarks[hand[1]];
      const index = landmarks[hand[3]];
      if (
        !wrist ||
        !pinky ||
        !index ||
        [wrist, pinky, index].some((point) => (point.visibility ?? 0) < 0.25)
      ) {
        continue;
      }
      const center = weightedAverage([
        [wrist, 1],
        [pinky, 1],
        [index, 1],
      ]);
      const palmRadius =
        Math.max(
          pointDistance(wrist, center),
          pointDistance(pinky, center),
          pointDistance(index, center),
        ) * 1.08;
      const radius = Math.max(palmRadius, pointDistance(wrist, index) * 0.72);

      ctx.beginPath();
      ctx.arc(center.x * width, center.y * height, radius * width, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = Math.max(2, radius * width * 0.56);
      ctx.beginPath();
      ctx.moveTo(pinky.x * width, pinky.y * height);
      ctx.lineTo(landmarks[hand[2]].x * width, landmarks[hand[2]].y * height);
      ctx.lineTo(index.x * width, index.y * height);
      ctx.lineTo(landmarks[hand[4]].x * width, landmarks[hand[4]].y * height);
      ctx.stroke();
    }
    ctx.restore();
  }

  getTryOnSourceView() {
    const videoWidth = this.video.videoWidth;
    const videoHeight = this.video.videoHeight;
    const targetAspect = TRYON_WIDTH / TRYON_HEIGHT;
    let sourceWidth = videoWidth;
    let sourceHeight = videoHeight;

    const requiredPoints = [11, 12, 13, 14, 23, 24].map((index) => this.rawLandmarks?.[index]);
    if (this.hasUpperBody() && requiredPoints.every(Boolean)) {
      const points = requiredPoints.map((landmark) => ({
        x: landmark.x * videoWidth,
        y: landmark.y * videoHeight,
      }));
      const leftShoulder = points[0];
      const rightShoulder = points[1];
      const leftHip = points[4];
      const rightHip = points[5];
      const shoulderWidth = Math.max(1, pointDistance(leftShoulder, rightShoulder));
      const shoulderCenter = mixPoint(leftShoulder, rightShoulder, 0.5);
      const hipCenter = mixPoint(leftHip, rightHip, 0.5);
      const torsoHeight = Math.max(
        shoulderWidth * 0.7,
        pointDistance(shoulderCenter, hipCenter),
      );
      const minX = Math.min(...points.map((point) => point.x));
      const maxX = Math.max(...points.map((point) => point.x));
      const bodyCenterX = lerp((minX + maxX) * 0.5, shoulderCenter.x, 0.72);
      const bodyCenterY = lerp(
        (shoulderCenter.y + hipCenter.y) * 0.5,
        hipCenter.y,
        0.16,
      );

      if (this.trackingMode === "upper-body") {
        // Preserve both shoulders in close-up views. Padding below a clipped
        // torso is preferable to cropping off the visible shoulders or stretching it.
        sourceWidth = Math.min(videoWidth, Math.max(videoHeight * targetAspect, shoulderWidth * 1.7));
        sourceHeight = sourceWidth / targetAspect;
        return {
          videoWidth, videoHeight, sourceWidth, sourceHeight,
          sourceX: Math.max(0, Math.min(videoWidth - sourceWidth, shoulderCenter.x - sourceWidth * 0.5)),
          sourceY: Math.min(0, shoulderCenter.y - sourceHeight * 0.26),
        };
      }

      sourceHeight = Math.min(
        videoHeight,
        Math.max(torsoHeight * 3.15, shoulderWidth * 4.5),
      );
      sourceWidth = Math.min(videoWidth, sourceHeight * targetAspect);
      sourceHeight = sourceWidth / targetAspect;
      const sourceX = Math.max(
        0,
        Math.min(videoWidth - sourceWidth, bodyCenterX - sourceWidth * 0.5),
      );
      const sourceY = Math.max(
        0,
        Math.min(videoHeight - sourceHeight, bodyCenterY - sourceHeight * 0.5),
      );
      return {
        videoWidth,
        videoHeight,
        sourceX,
        sourceY,
        sourceWidth,
        sourceHeight,
      };
    }

    if (videoWidth / videoHeight > targetAspect) {
      sourceWidth = videoHeight * targetAspect;
    } else {
      sourceHeight = videoWidth / targetAspect;
    }
    return {
      videoWidth,
      videoHeight,
      sourceX: (videoWidth - sourceWidth) * 0.5,
      sourceY: (videoHeight - sourceHeight) * 0.5,
      sourceWidth,
      sourceHeight,
    };
  }

  captureTryOnInput() {
    if (
      this.source !== "camera" ||
      this.video.readyState < 2 ||
      !this.rawLandmarks
    ) {
      throw new Error("请让双肩进入摄像头画面后执行换衣，腰部可以在画面外");
    }

    const completed = completeUpperBodyPose(this.rawLandmarks, this.video.videoWidth, this.video.videoHeight);
    if (!completed) {
      throw new Error("未看清双肩，请将肩部移入画面；不需要露出肘部或髋部");
    }
    this.rawLandmarks = completed;
    this.trackingMode = completed[23].estimated || completed[24].estimated ? "upper-body" : "full-body";

    const {
      videoWidth,
      videoHeight,
      sourceX,
      sourceY,
      sourceWidth,
      sourceHeight,
    } = this.getTryOnSourceView();

    const personCanvas = document.createElement("canvas");
    personCanvas.width = TRYON_WIDTH;
    personCanvas.height = TRYON_HEIGHT;
    const personContext = personCanvas.getContext("2d");
    personContext.fillStyle = "#e4e5e5";
    personContext.fillRect(0, 0, TRYON_WIDTH, TRYON_HEIGHT);
    personContext.drawImage(
      this.video,
      sourceX,
      sourceY,
      sourceWidth,
      sourceHeight,
      0,
      0,
      TRYON_WIDTH,
      TRYON_HEIGHT,
    );

    const maskCanvas = document.createElement("canvas");
    maskCanvas.width = TRYON_WIDTH;
    maskCanvas.height = TRYON_HEIGHT;
    const maskContext = maskCanvas.getContext("2d");
    maskContext.fillStyle = "#000";
    maskContext.fillRect(0, 0, TRYON_WIDTH, TRYON_HEIGHT);
    maskContext.fillStyle = "#fff";
    maskContext.strokeStyle = "#fff";
    maskContext.lineJoin = "round";
    maskContext.lineWidth = 4;

    const point = (index) => {
      const landmark = this.rawLandmarks[index];
      return {
        x: ((landmark.x * videoWidth - sourceX) / sourceWidth) * TRYON_WIDTH,
        y: ((landmark.y * videoHeight - sourceY) / sourceHeight) * TRYON_HEIGHT,
      };
    };
    const polygon = (points) => {
      maskContext.beginPath();
      maskContext.moveTo(points[0].x, points[0].y);
      for (const next of points.slice(1)) maskContext.lineTo(next.x, next.y);
      maskContext.closePath();
      maskContext.fill();
      maskContext.stroke();
    };
    const circle = (center, radius) => {
      maskContext.beginPath();
      maskContext.arc(center.x, center.y, radius, 0, Math.PI * 2);
      maskContext.fill();
      maskContext.stroke();
    };
    const createSegmentationLayer = (values, maskWidth, maskHeight, predicate) => {
      if (!values || !maskWidth || !maskHeight) return null;
      const layer = document.createElement("canvas");
      layer.width = maskWidth;
      layer.height = maskHeight;
      const layerContext = layer.getContext("2d");
      const layerPixels = layerContext.createImageData(maskWidth, maskHeight);
      let hits = 0;
      for (let index = 0; index < values.length; index += 1) {
        if (!predicate(values[index], index)) continue;
        const offset = index * 4;
        layerPixels.data[offset] = 255;
        layerPixels.data[offset + 1] = 255;
        layerPixels.data[offset + 2] = 255;
        layerPixels.data[offset + 3] = 255;
        hits += 1;
      }
      if (!hits) return null;
      layerContext.putImageData(layerPixels, 0, 0);
      return layer;
    };

    const leftShoulder = point(11);
    const rightShoulder = point(12);
    const leftElbow = point(13);
    const rightElbow = point(14);
    const leftWrist = point(15);
    const rightWrist = point(16);
    const leftHip = point(23);
    const rightHip = point(24);
    const shoulderWidth = Math.max(24, pointDistance(leftShoulder, rightShoulder));
    const torsoHeight = Math.max(
      40,
      pointDistance(
        mixPoint(leftShoulder, rightShoulder, 0.5),
        mixPoint(leftHip, rightHip, 0.5),
      ),
    );
    const leftOutward = normalizeVector(
      leftShoulder.x - rightShoulder.x,
      leftShoulder.y - rightShoulder.y,
    );
    const rightOutward = { x: -leftOutward.x, y: -leftOutward.y };
    const dress = (this.garment?.lengthScale ?? 0) > 0.4;
    const upperBodyDrop =
      0.01 + Math.min(0.3, this.garment?.lengthScale ?? 0.12) * 0.35;

    const leftTop = {
      x: leftShoulder.x + leftOutward.x * shoulderWidth * 0.27,
      y: leftShoulder.y - torsoHeight * 0.13,
    };
    const rightTop = {
      x: rightShoulder.x + rightOutward.x * shoulderWidth * 0.27,
      y: rightShoulder.y - torsoHeight * 0.13,
    };
    const leftBottom = {
      x: leftHip.x + leftOutward.x * shoulderWidth * 0.22,
      y: leftHip.y + torsoHeight * (dress ? 1.3 : upperBodyDrop),
    };
    const rightBottom = {
      x: rightHip.x + rightOutward.x * shoulderWidth * 0.22,
      y: rightHip.y + torsoHeight * (dress ? 1.3 : upperBodyDrop),
    };
    polygon([
      leftTop,
      mixPoint(leftTop, rightTop, 0.5),
      rightTop,
      rightBottom,
      mixPoint(leftBottom, rightBottom, 0.5),
      leftBottom,
    ]);

    const limbPolygon = (start, end, startRadius, endRadius) => {
      const direction = normalizeVector(end.x - start.x, end.y - start.y);
      const normal = { x: -direction.y, y: direction.x };
      polygon([
        { x: start.x + normal.x * startRadius, y: start.y + normal.y * startRadius },
        { x: end.x + normal.x * endRadius, y: end.y + normal.y * endRadius },
        { x: end.x - normal.x * endRadius, y: end.y - normal.y * endRadius },
        { x: start.x - normal.x * startRadius, y: start.y - normal.y * startRadius },
      ]);
      circle(start, startRadius);
      circle(end, endRadius);
    };
    const drawArmMask = () => {
      limbPolygon(leftShoulder, leftElbow, shoulderWidth * 0.3, shoulderWidth * 0.25);
      limbPolygon(leftElbow, leftWrist, shoulderWidth * 0.24, shoulderWidth * 0.18);
      limbPolygon(rightShoulder, rightElbow, shoulderWidth * 0.3, shoulderWidth * 0.25);
      limbPolygon(rightElbow, rightWrist, shoulderWidth * 0.24, shoulderWidth * 0.18);
    };
    drawArmMask();

    const garmentRegionCanvas = document.createElement("canvas");
    garmentRegionCanvas.width = TRYON_WIDTH;
    garmentRegionCanvas.height = TRYON_HEIGHT;
    garmentRegionCanvas.getContext("2d").drawImage(maskCanvas, 0, 0);

    if (this.maskData && this.maskCanvas.width) {
      const personMask = document.createElement("canvas");
      personMask.width = this.maskCanvas.width;
      personMask.height = this.maskCanvas.height;
      const personContext = personMask.getContext("2d");
      const personPixels = personContext.createImageData(
        personMask.width,
        personMask.height,
      );
      for (let index = 0; index < this.maskData.length; index += 1) {
        if (this.maskData[index] < 80) continue;
        const offset = index * 4;
        personPixels.data[offset] = 255;
        personPixels.data[offset + 1] = 255;
        personPixels.data[offset + 2] = 255;
        personPixels.data[offset + 3] = 255;
      }
      personContext.putImageData(personPixels, 0, 0);
      maskContext.globalCompositeOperation = "destination-in";
      maskContext.drawImage(
        personMask,
        (sourceX / videoWidth) * personMask.width,
        (sourceY / videoHeight) * personMask.height,
        (sourceWidth / videoWidth) * personMask.width,
        (sourceHeight / videoHeight) * personMask.height,
        0,
        0,
        TRYON_WIDTH,
        TRYON_HEIGHT,
      );
      maskContext.globalCompositeOperation = "source-over";

      // Patterned or low-contrast sleeves can be classified as background by
      // the person segmenter. Reapply the pose-bounded arm capsules after the
      // silhouette clip so the inpainting mask always reaches both wrists.
      drawArmMask();
    }

    // Recover patterned fabric that the person silhouette misses, while keeping
    // the multiclass clothing result inside the torso and arm region.
    const clothingLayer = createSegmentationLayer(
      this.clothingMaskData,
      this.maskCanvas.width,
      this.maskCanvas.height,
      (value) => value > 80,
    );
    if (clothingLayer) {
      const constrainedClothing = document.createElement("canvas");
      constrainedClothing.width = TRYON_WIDTH;
      constrainedClothing.height = TRYON_HEIGHT;
      const constrainedContext = constrainedClothing.getContext("2d");
      constrainedContext.drawImage(
        clothingLayer,
        (sourceX / videoWidth) * clothingLayer.width,
        (sourceY / videoHeight) * clothingLayer.height,
        (sourceWidth / videoWidth) * clothingLayer.width,
        (sourceHeight / videoHeight) * clothingLayer.height,
        0,
        0,
        TRYON_WIDTH,
        TRYON_HEIGHT,
      );
      constrainedContext.globalCompositeOperation = "destination-in";
      constrainedContext.drawImage(garmentRegionCanvas, 0, 0);
      maskContext.drawImage(constrainedClothing, 0, 0);
    }

    const capturePose = Object.fromEntries(
      MAPPING_ANCHORS.map((index) => {
        const landmark = this.rawLandmarks[index];
        const mapped = point(index);
        return [
          index,
          {
            x: TRYON_WIDTH - mapped.x,
            y: mapped.y,
            visibility: landmark?.visibility ?? 0,
          },
        ];
      }),
    );

    return {
      personImage: personCanvas.toDataURL("image/jpeg", 0.92),
      maskImage: maskCanvas.toDataURL("image/png"),
      pose: capturePose,
      width: TRYON_WIDTH,
      height: TRYON_HEIGHT,
      capturedAt: performance.now(),
    };
  }

  updateMotion(landmarks) {
    if (!landmarks) {
      this.motion *= 0.92;
      return;
    }
    const left = landmarks[LANDMARK_INDEX.leftShoulder];
    const right = landmarks[LANDMARK_INDEX.rightShoulder];
    const center = {
      x: ((left.x + right.x) * 0.5) * this.width,
      y: ((left.y + right.y) * 0.5) * this.height,
    };
    if (this.previousShoulderCenter) {
      const distance = pointDistance(center, this.previousShoulderCenter);
      this.motion = this.motion * 0.86 + Math.min(1, distance / 12) * 0.14;
    }
    this.previousShoulderCenter = center;
  }

  poseFrame(points) {
    const leftShoulder = points[11];
    const rightShoulder = points[12];
    const leftHip = points[23];
    const rightHip = points[24];
    const shoulderCenter = mixPoint(leftShoulder, rightShoulder, 0.5);
    const hipCenter = mixPoint(leftHip, rightHip, 0.5);
    return {
      points,
      shoulderCenter,
      hipCenter,
      shoulderWidth: Math.max(1, pointDistance(leftShoulder, rightShoulder)),
      torsoHeight: Math.max(1, pointDistance(shoulderCenter, hipCenter)),
      xAxis: normalizeVector(
        rightShoulder.x - leftShoulder.x,
        rightShoulder.y - leftShoulder.y,
      ),
      yAxis: normalizeVector(
        hipCenter.x - shoulderCenter.x,
        hipCenter.y - shoulderCenter.y,
      ),
    };
  }

  currentPosePoints(landmarks) {
    return Object.fromEntries(
      MAPPING_ANCHORS.map((index) => {
        const point = landmarks[index] ?? { x: 0.5, y: 0.5, visibility: 0 };
        return [
          index,
          {
            x: point.x * this.width,
            y: point.y * this.height,
            visibility: point.visibility ?? 0,
          },
        ];
      }),
    );
  }

  createNeuralSkinningRig(landmarks) {
    if (!this.neuralCapturePose || !landmarks) return null;
    const sourceFrame = this.poseFrame(this.neuralCapturePose);
    const destinationFrame = this.poseFrame(this.currentPosePoints(landmarks));
    const sourceWidth = sourceFrame.shoulderWidth;
    const widthScale =
      (destinationFrame.shoulderWidth / sourceFrame.shoulderWidth) *
      Math.max(0.82, Math.min(1.18, this.fitWidth || 1));
    const lengthScale =
      (destinationFrame.torsoHeight / sourceFrame.torsoHeight) *
      (0.96 + Math.max(0.4, Math.min(1.8, this.drape || 1)) * 0.04);

    const transformTorso = (point) => {
      const offsetX = point.x - sourceFrame.shoulderCenter.x;
      const offsetY = point.y - sourceFrame.shoulderCenter.y;
      const along = offsetX * sourceFrame.xAxis.x + offsetY * sourceFrame.xAxis.y;
      const down = offsetX * sourceFrame.yAxis.x + offsetY * sourceFrame.yAxis.y;
      return {
        x:
          destinationFrame.shoulderCenter.x +
          destinationFrame.xAxis.x * along * widthScale +
          destinationFrame.yAxis.x * down * lengthScale,
        y:
          destinationFrame.shoulderCenter.y +
          destinationFrame.xAxis.y * along * widthScale +
          destinationFrame.yAxis.y * down * lengthScale,
      };
    };

    const makeLimbBone = (name, startIndex, endIndex, radius, signature) => {
      const sourceStart = sourceFrame.points[startIndex];
      const sourceEnd = sourceFrame.points[endIndex];
      const destinationStart = destinationFrame.points[startIndex];
      const destinationEnd = destinationFrame.points[endIndex];
      const visibility = Math.min(
        sourceStart?.visibility ?? 0,
        sourceEnd?.visibility ?? 0,
        destinationStart?.visibility ?? 0,
        destinationEnd?.visibility ?? 0,
      );
      if (visibility < 0.15) return null;
      const sourceVector = {
        x: sourceEnd.x - sourceStart.x,
        y: sourceEnd.y - sourceStart.y,
      };
      const destinationVector = {
        x: destinationEnd.x - destinationStart.x,
        y: destinationEnd.y - destinationStart.y,
      };
      const sourceLength = Math.hypot(sourceVector.x, sourceVector.y);
      const destinationLength = Math.hypot(
        destinationVector.x,
        destinationVector.y,
      );
      if (sourceLength < 1 || destinationLength < 1) return null;
      const sourceDirection = {
        x: sourceVector.x / sourceLength,
        y: sourceVector.y / sourceLength,
      };
      const destinationDirection = {
        x: destinationVector.x / destinationLength,
        y: destinationVector.y / destinationLength,
      };
      const scale = Math.max(
        0.35,
        Math.min(2.4, destinationLength / sourceLength),
      );

      return {
        name,
        signature,
        radius,
        bias: name.includes("forearm") ? 0.92 : 1,
        sourceStart,
        sourceEnd,
        transform(point) {
          const offsetX = point.x - sourceStart.x;
          const offsetY = point.y - sourceStart.y;
          const along = offsetX * sourceDirection.x + offsetY * sourceDirection.y;
          const across =
            -offsetX * sourceDirection.y + offsetY * sourceDirection.x;
          return {
            x:
              destinationStart.x +
              destinationDirection.x * along * scale -
              destinationDirection.y * across * scale,
            y:
              destinationStart.y +
              destinationDirection.y * along * scale +
              destinationDirection.x * across * scale,
          };
        },
      };
    };

    const bones = [
      {
        name: "torso",
        signature: 0,
        radius: sourceWidth * 0.82,
        bias: 0.72,
        sourceStart: sourceFrame.shoulderCenter,
        sourceEnd: sourceFrame.hipCenter,
        transform: transformTorso,
      },
      makeLimbBone(
        "left-upper-arm",
        11,
        13,
        sourceWidth * 0.46,
        -1,
      ),
      makeLimbBone(
        "left-forearm",
        13,
        15,
        sourceWidth * 0.36,
        -1,
      ),
      makeLimbBone(
        "right-upper-arm",
        12,
        14,
        sourceWidth * 0.46,
        1,
      ),
      makeLimbBone(
        "right-forearm",
        14,
        16,
        sourceWidth * 0.36,
        1,
      ),
      makeLimbBone("left-thigh", 23, 25, sourceWidth * 0.5, -1),
      makeLimbBone("right-thigh", 24, 26, sourceWidth * 0.5, 1),
    ].filter(Boolean);

    return {
      sourceFrame,
      destinationFrame,
      sourceWidth,
      bones,
      transformTorso,
    };
  }

  mapNeuralGarmentPoint(sourcePoint, rig) {
    if (!rig) return null;
    const { sourceFrame, sourceWidth, bones, transformTorso } = rig;
    const offsetX = sourcePoint.x - sourceFrame.shoulderCenter.x;
    const offsetY = sourcePoint.y - sourceFrame.shoulderCenter.y;
    const side =
      offsetX * sourceFrame.xAxis.x + offsetY * sourceFrame.xAxis.y;
    const weighted = [];
    let totalWeight = 0;

    for (const bone of bones) {
      const start = bone.sourceStart;
      const end = bone.sourceEnd;
      const segmentX = end.x - start.x;
      const segmentY = end.y - start.y;
      const segmentLengthSquared = segmentX * segmentX + segmentY * segmentY;
      const projection =
        segmentLengthSquared > 1
          ? clamp01(
              ((sourcePoint.x - start.x) * segmentX +
                (sourcePoint.y - start.y) * segmentY) /
                segmentLengthSquared,
            )
          : 0;
      const closestX = start.x + segmentX * projection;
      const closestY = start.y + segmentY * projection;
      const distance = Math.hypot(
        sourcePoint.x - closestX,
        sourcePoint.y - closestY,
      );
      let gate = 1;
      if (bone.signature) {
        const signedSide = side * bone.signature;
        gate = clamp01(
          (signedSide - sourceWidth * 0.04) / (sourceWidth * 0.26),
        );
      } else {
        // The torso bone must release the sleeve pixels. A broad Gaussian
        // blends both arms back toward the body center whenever the arms lift.
        gate =
          1 -
          smoothstep(
            (Math.abs(side) - sourceWidth * 0.34) / (sourceWidth * 0.3),
          );
      }
      if (gate <= 0.002) continue;
      const normalizedDistance = distance / Math.max(1, bone.radius);
      const limbBoost = bone.signature
        ? bone.name.includes("forearm")
          ? 1.22
          : 1.38
        : 1;
      const weight =
        bone.bias *
        limbBoost *
        gate *
        Math.exp(-0.5 * normalizedDistance * normalizedDistance);
      if (weight < 1e-5) continue;
      weighted.push({ bone, weight });
      totalWeight += weight;
    }

    if (totalWeight < 1e-5) return transformTorso(sourcePoint);
    weighted.sort((left, right) => right.weight - left.weight);
    const activeBones = weighted.slice(0, 3);
    const activeWeight = activeBones.reduce(
      (sum, item) => sum + item.weight,
      0,
    );
    let x = 0;
    let y = 0;
    for (const { bone, weight } of activeBones) {
      const transformed = bone.transform(sourcePoint);
      x += transformed.x * (weight / activeWeight);
      y += transformed.y * (weight / activeWeight);
    }
    return { x, y };
  }

  computeGarmentPoint(u, v, landmarks, now) {
    const width = this.width;
    const height = this.height;
    const px = (index) => {
      const point = landmarks[index] ?? { x: 0.5, y: 0.5 };
      return { x: point.x * width, y: point.y * height };
    };

    const leftShoulder = px(LANDMARK_INDEX.leftShoulder);
    const rightShoulder = px(LANDMARK_INDEX.rightShoulder);
    const leftElbow = px(LANDMARK_INDEX.leftElbow);
    const rightElbow = px(LANDMARK_INDEX.rightElbow);
    const leftHip = px(LANDMARK_INDEX.leftHip);
    const rightHip = px(LANDMARK_INDEX.rightHip);
    const leftKnee = px(LANDMARK_INDEX.leftKnee);
    const rightKnee = px(LANDMARK_INDEX.rightKnee);

    const shoulderCenter = mixPoint(leftShoulder, rightShoulder, 0.5);
    const hipCenter = mixPoint(leftHip, rightHip, 0.5);
    const shoulderWidth = Math.max(height * 0.07, pointDistance(leftShoulder, rightShoulder));
    const hipWidth = Math.max(height * 0.05, pointDistance(leftHip, rightHip));
    const torsoHeight = Math.max(height * 0.14, pointDistance(shoulderCenter, hipCenter));
    const shoulderDirection = normalizeVector(
      rightShoulder.x - leftShoulder.x,
      rightShoulder.y - leftShoulder.y,
    );
    const leftDirection = { x: -shoulderDirection.x, y: -shoulderDirection.y };
    const rightDirection = shoulderDirection;
    const garmentWidth = shoulderWidth * (this.fitWidth || 1) * (this.garment?.widthScale ?? 1);
    const lengthScale = this.garment?.lengthScale ?? 0;

    const leftTop = {
      x: leftShoulder.x + leftDirection.x * garmentWidth * 0.56,
      y: leftShoulder.y + leftDirection.y * garmentWidth * 0.56 - height * 0.007,
    };
    const rightTop = {
      x: rightShoulder.x + rightDirection.x * garmentWidth * 0.56,
      y: rightShoulder.y + rightDirection.y * garmentWidth * 0.56 - height * 0.007,
    };
    const leftSleeve = {
      x: lerp(leftShoulder.x, leftElbow.x, 0.42) + leftDirection.x * garmentWidth * 0.15,
      y: lerp(leftShoulder.y, leftElbow.y, 0.42) + leftDirection.y * garmentWidth * 0.15,
    };
    const rightSleeve = {
      x: lerp(rightShoulder.x, rightElbow.x, 0.42) + rightDirection.x * garmentWidth * 0.15,
      y: lerp(rightShoulder.y, rightElbow.y, 0.42) + rightDirection.y * garmentWidth * 0.15,
    };
    const leftTorso = {
      x: lerp(leftShoulder.x, leftHip.x, 0.22) + leftDirection.x * garmentWidth * 0.2,
      y: lerp(leftShoulder.y, leftHip.y, 0.22) + leftDirection.y * garmentWidth * 0.2,
    };
    const rightTorso = {
      x: lerp(rightShoulder.x, rightHip.x, 0.22) + rightDirection.x * garmentWidth * 0.2,
      y: lerp(rightShoulder.y, rightHip.y, 0.22) + rightDirection.y * garmentWidth * 0.2,
    };

    let leftBottom;
    let rightBottom;
    if (lengthScale > 0.4) {
      const skirtDrop = torsoHeight * (0.75 + lengthScale * 0.88);
      leftBottom = {
        x: leftHip.x + leftDirection.x * hipWidth * 0.26 + (leftKnee.x - leftHip.x) * 0.24,
        y: leftHip.y + skirtDrop,
      };
      rightBottom = {
        x: rightHip.x + rightDirection.x * hipWidth * 0.26 + (rightKnee.x - rightHip.x) * 0.24,
        y: rightHip.y + skirtDrop,
      };
    } else {
      const hemDrop = torsoHeight * (0.1 + lengthScale);
      leftBottom = {
        x: leftHip.x + leftDirection.x * hipWidth * 0.2,
        y: leftHip.y + hemDrop,
      };
      rightBottom = {
        x: rightHip.x + rightDirection.x * hipWidth * 0.2,
        y: rightHip.y + hemDrop,
      };
    }

    let leftSide;
    let rightSide;
    if (v < 0.15) {
      const t = smoothstep(v / 0.15);
      leftSide = mixPoint(leftTop, leftSleeve, t);
      rightSide = mixPoint(rightTop, rightSleeve, t);
    } else if (v < 0.38) {
      const t = smoothstep((v - 0.15) / 0.23);
      leftSide = mixPoint(leftSleeve, leftTorso, t);
      rightSide = mixPoint(rightSleeve, rightTorso, t);
    } else {
      const t = smoothstep((v - 0.38) / 0.62);
      leftSide = mixPoint(leftTorso, leftBottom, t);
      rightSide = mixPoint(rightTorso, rightBottom, t);
    }

    const x = lerp(leftSide.x, rightSide.x, u);
    const baseY = lerp(leftSide.y, rightSide.y, u);
    const droop = (1 - Math.abs(u - 0.5) * 2) * v * v * torsoHeight * 0.018;
    const drape = (this.garment?.drape ?? 1) * this.drape;
    const sway =
      Math.sin(now * 0.0022 + v * 3.4 + u * 2.1) *
      torsoHeight *
      0.0022 *
      drape *
      (0.32 + this.motion);
    const breathing = Math.sin(now * 0.0017 + v * 1.8) * torsoHeight * 0.0012;
    return { x, y: baseY + droop + sway + breathing };
  }

  updateGarmentMesh(landmarks, now) {
    if (!this.garmentImage || !landmarks) return false;
    const columns = this.gridColumns;
    const rows = this.gridRows;
    const useNeuralSkinning = this.neuralLayerReady && this.neuralCapturePose;
    const skinningRig = useNeuralSkinning
      ? this.createNeuralSkinningRig(landmarks)
      : null;
    if (useNeuralSkinning && !skinningRig) return false;
    let cursor = 0;
    let shadowCursor = 0;
    const shadowX = -this.width * 0.005;
    const shadowY = this.height * 0.009;

    for (let row = 0; row <= rows; row += 1) {
      const v = row / rows;
      for (let column = 0; column <= columns; column += 1) {
        const u = column / columns;
        const point =
          useNeuralSkinning
            ? this.mapNeuralGarmentPoint(
                { x: u * TRYON_WIDTH, y: v * TRYON_HEIGHT },
                skinningRig,
              )
            : this.computeGarmentPoint(u, v, landmarks, now);
        if (!point) return false;
        const clipX = (point.x / this.width) * 2 - 1;
        const clipY = 1 - (point.y / this.height) * 2;
        this.garmentPositions[cursor] = clipX;
        this.garmentPositions[cursor + 1] = clipY;
        this.garmentShadowPositions[shadowCursor] = clipX + (shadowX / this.width) * 2;
        this.garmentShadowPositions[shadowCursor + 1] = clipY - (shadowY / this.height) * 2;
        cursor += 2;
        shadowCursor += 2;
      }
    }
    return true;
  }

  drawVideo(now) {
    const gl = this.gl;
    const source = this.source === "camera" ? this.video : this.demoCanvas;
    if (this.source === "camera" && this.video.readyState < 2) return;

    gl.useProgram(this.videoProgram);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.enableVertexAttribArray(this.videoLocations.position);
    gl.vertexAttribPointer(this.videoLocations.position, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(this.videoLocations.uv);
    gl.vertexAttribPointer(this.videoLocations.uv, 2, gl.FLOAT, false, 16, 8);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.videoTexture);
    const videoFrameId = this.videoFrameCallbackId !== null ? this.latestVideoFrameId
      : (this.video.getVideoPlaybackQuality?.().totalVideoFrames ?? this.video.currentTime);
    if (this.source !== "camera" || this.lastUploadedVideoFrameId !== videoFrameId) {
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      this.lastUploadedVideoFrameId = this.source === "camera" ? videoFrameId : -1;
      if (this.source === "camera" && this.videoFrameCallbackId === null) this.cameraFrameCount += 1;
    }
    gl.uniform1i(this.videoLocations.video, 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.maskTexture);
    gl.uniform1i(this.videoLocations.mask, 1);
    gl.uniform1f(this.videoLocations.useMask, !this.fullFrameMode && this.source === "camera" && this.maskReady && this.useMask ? 1 : 0);
    gl.uniform1f(this.videoLocations.dim, this.backgroundDim);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  drawGarment(landmarks, now) {
    if (this.fullFrameMode) return;
    if (this.source === "camera" && !this.neuralLayerReady) return;
    if (!landmarks || !this.updateGarmentMesh(landmarks, now)) return;
    const gl = this.gl;
    gl.useProgram(this.garmentProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.garmentTexture);
    gl.uniform1i(this.garmentLocations.garment, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.maskTexture);
    gl.uniform1i(this.garmentLocations.personMask, 1);
    gl.uniform1f(this.garmentLocations.neural, this.neuralLayerReady ? 1 : 0);
    gl.uniform1f(
      this.garmentLocations.usePersonMask,
      this.neuralLayerReady && this.maskReady ? 1 : 0,
    );
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);

    const drawMesh = (positions, shadow) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, positions, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(this.garmentLocations.position);
      gl.vertexAttribPointer(this.garmentLocations.position, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.uvBuffer);
      gl.enableVertexAttribArray(this.garmentLocations.uv);
      gl.vertexAttribPointer(this.garmentLocations.uv, 2, gl.FLOAT, false, 0, 0);
      gl.uniform1f(this.garmentLocations.shadow, shadow ? 1 : 0);
      gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_SHORT, 0);
    };

    if (!this.neuralLayerReady) drawMesh(this.garmentShadowPositions, true);
    drawMesh(this.garmentPositions, false);
  }

  drawOcclusion() {
    if (this.source !== "camera" || !this.maskReady || !this.neuralLayerReady) return;
    const gl = this.gl;
    gl.useProgram(this.occlusionProgram);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.enableVertexAttribArray(this.occlusionLocations.position);
    gl.vertexAttribPointer(
      this.occlusionLocations.position,
      2,
      gl.FLOAT,
      false,
      16,
      0,
    );
    gl.enableVertexAttribArray(this.occlusionLocations.uv);
    gl.vertexAttribPointer(
      this.occlusionLocations.uv,
      2,
      gl.FLOAT,
      false,
      16,
      8,
    );
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.videoTexture);
    gl.uniform1i(this.occlusionLocations.video, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.foregroundTexture);
    gl.uniform1i(this.occlusionLocations.foregroundMask, 1);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  drawPoseOverlay(landmarks) {
    const ctx = this.ctx;
    const { width, height } = this.poseCanvas;
    ctx.clearRect(0, 0, width, height);
    if (!this.showPose || !landmarks) return;

    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "rgba(216, 255, 88, 0.66)";
    ctx.lineWidth = Math.max(1.2, width / 780);
    ctx.shadowColor = "rgba(216,255,88,0.28)";
    ctx.shadowBlur = 8;
    for (const [start, end] of POSE_CONNECTIONS) {
      const a = landmarks[start];
      const b = landmarks[end];
      if (!a || !b || (a.visibility ?? 1) < 0.35 || (b.visibility ?? 1) < 0.35) continue;
      ctx.beginPath();
      ctx.moveTo(a.x * width, a.y * height);
      ctx.lineTo(b.x * width, b.y * height);
      ctx.stroke();
    }
    ctx.fillStyle = "rgba(243, 255, 205, 0.92)";
    for (const index of Object.values(LANDMARK_INDEX)) {
      const point = landmarks[index];
      if (!point || (point.visibility ?? 1) < 0.4) continue;
      ctx.beginPath();
      ctx.arc(point.x * width, point.y * height, Math.max(2, width / 520), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  computePoseJitter(landmarks, now) {
    if (!landmarks) {
      this.jitterPx *= 0.9;
      return;
    }
    const sample = Object.values(LANDMARK_INDEX).map((index) => landmarks[index]).filter(Boolean);
    if (!sample.length) return;
    const center = sample.reduce(
      (accumulator, point) => {
        accumulator.x += point.x;
        accumulator.y += point.y;
        return accumulator;
      },
      { x: 0, y: 0 },
    );
    center.x /= sample.length;
    center.y /= sample.length;
    const current = { x: center.x * this.width, y: center.y * this.height, time: now };
    this.poseSamples.push(current);
    if (this.poseSamples.length > 20) this.poseSamples.shift();
    if (this.poseSamples.length < 4) return;

    let total = 0;
    for (let index = 1; index < this.poseSamples.length; index += 1) {
      total += pointDistance(this.poseSamples[index - 1], this.poseSamples[index]);
    }
    const measured = total / (this.poseSamples.length - 1);
    this.jitterPx = this.jitterPx * 0.9 + measured * 0.1;
  }

  emitStats(now, renderStart, rendered = true) {
    this.renderMs = this.renderMs * 0.92 + (performance.now() - renderStart) * 0.08;
    if (rendered) this.frameCount += 1;
    if (rendered && now - this.lastFrameAt > 0) {
      this.frameIntervals.push(now - this.lastFrameAt);
      if (this.frameIntervals.length > 90) this.frameIntervals.shift();
    }
    if (rendered) this.lastFrameAt = now;

    if (now - this.lastStatsAt < 300) return;
    this.lastStatsAt = now;
    const inferenceWindowMs = now - this.inferenceRateStartedAt;
    if (inferenceWindowMs >= 1000) {
      this.poseHz = (this.poseInferenceCount * 1000) / inferenceWindowMs;
      this.maskHz = (this.maskInferenceCount * 1000) / inferenceWindowMs;
      this.cameraFps = (this.cameraFrameCount * 1000) / inferenceWindowMs;
      this.poseInferenceCount = 0;
      this.maskInferenceCount = 0;
      this.cameraFrameCount = 0;
      this.inferenceRateStartedAt = now;
    }
    const intervals = this.frameIntervals;
    if (intervals.length > 5) {
      const mean = intervals.reduce((sum, value) => sum + value, 0) / intervals.length;
      const variance =
        intervals.reduce((sum, value) => sum + (value - mean) ** 2, 0) / intervals.length;
      this.fps = 1000 / mean;
      this.frameJitterMs = Math.sqrt(variance);
    }

    this.onStats?.({
      fps: this.fps,
      cameraFps: this.cameraFps,
      poseHz: this.poseHz,
      maskHz: this.maskHz,
      poseMs: this.poseMs,
      segmentMs: this.segmentMs,
      renderMs: this.renderMs,
      jitterPx: this.jitterPx,
      frameJitterMs: this.frameJitterMs ?? 0,
      confidence: this.confidence,
      frames: this.frameCount,
      dropped: this.droppedFrames,
      source: this.source,
      modelReady: this.modelsReady,
      inferenceThread: this.trackingWorker ? "worker" : "none",
      trackingMode: this.trackingMode,
      trackingAgeMs: this.trackingAgeMs,
      observedPoints: this.rawLandmarks?.filter((point) => (point.visibility ?? 0) >= 0.25).length ?? 0,
      delegate: this.inferenceDelegate,
      webglRenderer: this.webglRenderer,
      neuralLayerReady: this.neuralLayerReady,
      neuralLayerUpdatedAt: this.neuralLayerUpdatedAt,
      neuralLayerDebug: this.neuralLayerDebug,
    });
  }

  scheduleRender() {
    if (!this.running || !this.pageVisible) return;
    cancelAnimationFrame(this.renderRequest);
    clearTimeout(this.renderTimer);
    if (this.fullFrameMode && (this.source === "demo" || (this.generatedCanvas && !this.generatedCanvas.hidden))) {
      // Generated frames are painted by FullFrameClient, not this loop.
      // Update telemetry four times a second without a permanent 60 Hz loop.
      this.renderTimer = setTimeout(() => this.loop(performance.now()), 250);
    } else this.renderRequest = requestAnimationFrame((time) => this.loop(time));
  }

  setPageVisible(visible) {
    this.pageVisible = visible;
    cancelAnimationFrame(this.renderRequest);
    clearTimeout(this.renderTimer);
    if (visible) {
      this.lastRawPreviewToken = null;
      this.lastFrameAt = 0;
      this.frameIntervals = [];
      this.scheduleRender();
    }
  }

  resumeRendering() {
    this.running = true;
    this.scheduleRender();
  }

  loop(now) {
    if (!this.running) return;
    if (!this.pageVisible) return;
    const renderStart = performance.now();

    // The complete-frame idle screen is HTML. Keep numeric telemetry alive
    // without rendering an invisible animated mannequin underneath it.
    if (this.fullFrameMode && this.source === "demo") {
      this.emitStats(now, renderStart, false);
      this.scheduleRender();
      return;
    }

    // The generated image covers the raw WebGL preview. Keep camera callbacks
    // and stats alive, without uploading/drawing an invisible second video.
    if (this.fullFrameMode && this.generatedCanvas && !this.generatedCanvas.hidden) {
      this.lastRawPreviewToken = null;
      this.emitStats(now, renderStart, false);
      this.scheduleRender();
      return;
    }

    if (this.source === "camera" && this.video.readyState >= 2) {
      const frameIdentity = this.video.requestVideoFrameCallback ? this.latestVideoFrameId : this.video.currentTime;
      const token = `${this.cameraEpoch}:${frameIdentity}`;
      if (this.fullFrameMode && token === this.lastRawPreviewToken) {
        this.emitStats(now, renderStart, false);
        this.scheduleRender();
        return;
      }
      this.lastRawPreviewToken = token;
      this.resizeToSource(this.video.videoWidth, this.video.videoHeight);
      if (!this.fullFrameMode) this.processInference(now, this.video);
    } else {
      this.resizeToSource(this.demoCanvas.width, this.demoCanvas.height);
      this.rawLandmarks = null;
      this.landmarks = this.createDemoLandmarks(now);
      this.filteredLandmarks = this.landmarks;
      this.confidence = 0.99;
    }

    const activeLandmarks = this.filteredLandmarks ?? this.landmarks;
    this.updateMotion(activeLandmarks);
    if (this.source === "demo") this.drawDemoSource(now, activeLandmarks);

    const gl = this.gl;
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.drawVideo(now);
    this.drawGarment(activeLandmarks, now);
    if (!this.fullFrameMode) this.drawOcclusion();
    if (!this.fullFrameMode) this.drawPoseOverlay(activeLandmarks);
    else this.ctx.clearRect(0, 0, this.poseCanvas.width, this.poseCanvas.height);
    this.computePoseJitter(activeLandmarks, now);
    this.emitStats(now, renderStart);

    this.scheduleRender();
  }

  destroy() {
    this.running = false;
    cancelAnimationFrame(this.renderRequest);
    clearTimeout(this.renderTimer);
    this.stopCamera();
    this.poseLandmarker?.close();
    this.segmenter?.close();
    this.staticSegmenter?.close();
    this.trackingWorker?.terminate();
    for (const pending of this.workerRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(new DOMException("Engine destroyed", "AbortError"));
    }
    this.workerRequests.clear();
  }
}
