/* Classic worker: MediaPipe's WASM loader uses importScripts. */
let pose;
let segmenter;
let imageSegmenter;

async function initialize({ bundleUrl, origin, delegate }) {
  importScripts(bundleUrl);
  const vision = await Vision.FilesetResolver.forVisionTasks(`${origin}/wasm`);
  async function createModels(selectedDelegate) {
    const canvas = () => new OffscreenCanvas(256, 256);
    // The loader stores ModuleFactory globally. Initialize graphs sequentially.
    pose = await Vision.PoseLandmarker.createFromOptions(vision, {
      canvas: canvas(),
      baseOptions: { modelAssetPath: `${origin}/models/pose_landmarker_lite.task`, delegate: selectedDelegate },
      runningMode: "VIDEO", numPoses: 1,
      minPoseDetectionConfidence: 0.35, minPosePresenceConfidence: 0.35,
      minTrackingConfidence: 0.4, outputSegmentationMasks: false,
    });
    const options = {
      baseOptions: { modelAssetPath: `${origin}/models/selfie_multiclass_256x256.tflite`, delegate: selectedDelegate },
      outputCategoryMask: true, outputConfidenceMasks: false,
    };
    segmenter = await Vision.ImageSegmenter.createFromOptions(vision, { ...options, canvas: canvas(), runningMode: "VIDEO" });
    imageSegmenter = await Vision.ImageSegmenter.createFromOptions(vision, { ...options, canvas: canvas(), runningMode: "IMAGE" });
  }
  try { await createModels(delegate); }
  catch (error) {
    if (delegate === "CPU") throw error;
    pose?.close(); segmenter?.close(); imageSegmenter?.close();
    delegate = "CPU";
    await createModels(delegate);
  }
  return { delegate };
}

function readMask(result) {
  try {
    const mask = result.categoryMask;
    return mask ? { values: new Uint8Array(mask.getAsUint8Array()), width: mask.width, height: mask.height } : null;
  } finally { result.close(); }
}

self.onmessage = async ({ data }) => {
  const { id, type, bitmap } = data;
  try {
    let result;
    if (type === "init") {
      result = await initialize(data);
    } else if (type === "frame") {
      result = {};
      if (data.poseDue) {
        const start = performance.now();
        result.landmarks = pose.detectForVideo(bitmap, data.timestamp).landmarks[0] ?? null;
        result.poseMs = performance.now() - start;
      }
      if (data.maskDue) {
        const start = performance.now();
        result.mask = readMask(segmenter.segmentForVideo(bitmap, data.timestamp));
        result.segmentMs = performance.now() - start;
      }
    } else if (type === "segment-image") {
      result = { mask: readMask(imageSegmenter.segment(bitmap)) };
    } else {
      throw new Error(`Unknown tracking task: ${type}`);
    }
    const transfer = result.mask ? [result.mask.values.buffer] : [];
    self.postMessage({ id, result }, transfer);
  } catch (error) {
    self.postMessage({ id, error: error.message || String(error) });
  } finally { bitmap?.close(); }
};
