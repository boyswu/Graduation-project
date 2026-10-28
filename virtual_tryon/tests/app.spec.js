import { expect, test } from "@playwright/test";

// These existing regressions exercise the explicitly retained legacy comparison.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("vton-pipeline", "legacy"));
  // UI/pose regressions must not require loading the optional local GPU model.
  await page.route("**/api/status", route => route.fulfill({ json: { ready: false, loading: false, error: null } }));
});

test("normalized pose smoothing responds to movement without amplifying jitter", async ({ page }) => {
  await page.goto("/studio");
  const measurements = await page.evaluate(async () => {
    const { LandmarkSmoother } = await import("/src/one-euro.js");
    return [14, 18].map((hz) => {
      const smoother = new LandmarkSmoother(33); smoother.setResponse(0.58);
      let response90Ms = null;
      for (let i = 0; i < 60; i += 1) {
        const x = i < 20 ? 0.3 : 0.6;
        const points = Array.from({ length: 33 }, () => ({ x, y: 0.5, visibility: 1 }));
        const result = smoother.filter(points, i * 1000 / hz);
        if (i >= 20 && response90Ms === null && result[0].x >= 0.57) response90Ms = (i - 20) * 1000 / hz;
      }
      const stationary = new LandmarkSmoother(33); stationary.setResponse(0.58);
      const values = [];
      for (let i = 0; i < 100; i += 1) {
        const x = 0.5 + 0.002 * Math.sin(i * 0.8) + 0.001 * Math.cos(i * 2.3);
        const result = stationary.filter(Array.from({ length: 33 }, () => ({ x, y: 0.5, visibility: 1 })), i * 1000 / hz);
        if (i >= 20) values.push(result[0].x * 640);
      }
      const mean = values.reduce((a, b) => a + b) / values.length;
      const jitterPx = Math.sqrt(values.reduce((sum, x) => sum + (x - mean) ** 2, 0) / values.length);
      return { hz, response90Ms, jitterPx };
    });
  });
  for (const measurement of measurements) {
    expect(measurement.response90Ms).not.toBeNull();
    expect(measurement.response90Ms).toBeLessThan(100);
    expect(measurement.jitterPx).toBeLessThan(0.8);
  }
});

test("complete model output remains viewable when garment extraction fails", async ({ page }) => {
  await page.route("**/api/status", (route) => route.fulfill({ json: { ready: true, gpu: "test" } }));
  await page.goto("/studio");
  await waitForRenderer(page);
  const expected = await page.evaluate(async () => {
    const d = window.__VTON_DEBUG__;
    d.engine.running = false;
    await new Promise((resolve) => setTimeout(resolve, 100));
    const image = (fill) => {
      const canvas = document.createElement("canvas"); canvas.width = 64; canvas.height = 96;
      canvas.getContext("2d").fillStyle = fill; canvas.getContext("2d").fillRect(0, 0, 64, 96);
      return canvas.toDataURL();
    };
    const person = image("red"), output = image("blue"), alpha = image("white");
    d.engine.source = "camera";
    d.engine.rawLandmarks = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 1 }));
    d.engine.captureTryOnInput = () => ({ personImage: person, maskImage: alpha, pose: {} });
    d.engine.setNeuralGarmentLayer = async () => { throw new Error("test extraction failure"); };
    d.state.aiService = { ready: true };
    d.catvton.tryOn = async () => ({ image: output, garment_layer: alpha, output_size: [64, 96], timings_ms: { total: 250 } });
    await d.generateNeuralGarmentLayer();
    return { person, output };
  });
  await expect(page.locator("#openRawResult")).toBeEnabled();
  await expect(page.locator("#neuralRunTitle")).toContainText("衣层处理失败");
  await page.locator("#openRawResult").click();
  await expect(page.locator("#rawResultDialog")).toBeVisible();
  await expect(page.locator("#rawGeneratedImage")).toHaveAttribute("src", expected.output);
  await expect(page.locator("#rawPersonImage")).toHaveAttribute("src", expected.person);
  await expect(page.locator("#rawResultMeta")).toContainText("50 步");
  await expect(page.locator("#rawResultDialog")).toContainText("静态照片");
  await page.setViewportSize({ width: 390, height: 844 });
  const dialogWidths = await page.locator("#rawResultDialog").evaluate((dialog) => [dialog.scrollWidth, dialog.clientWidth]);
  expect(dialogWidths[0]).toBeLessThanOrEqual(dialogWidths[1] + 1);
  await page.getByRole("button", { name: "关闭完整结果", exact: true }).click();
  await page.evaluate(() => { window.__VTON_DEBUG__.engine.source = "demo"; });
  await page.locator('[data-id="neural-look-02"]').click();
  await expect(page.locator("#openRawResult")).toBeDisabled();
});

test("inference backend selection persists and identifies the actual GPU", async ({ page }) => {
  await page.route("**/api/status", (route) => route.fulfill({ json: {
    ready: true, gpu: route.request().url().includes(":8021") ? "RTX 5090" : "RTX 4060",
  } }));
  await page.goto("/studio");
  await waitForRenderer(page);
  await page.locator(".connection-settings > summary").click();
  await page.locator("#inferenceBackend").selectOption("http://127.0.0.1:8021");
  await expect(page.locator("#localBackendLabel")).toHaveText("RTX 5090");
  await expect(page.locator("#networkState")).toContainText("REMOTE");
  await page.reload();
  await expect(page.locator("#inferenceBackend")).toHaveValue("http://127.0.0.1:8021");
  await expect(page.locator("#localBackendLabel")).toHaveText("RTX 5090");
});

test("compact transport preserves generation settings and reports wire bytes", async ({ page }) => {
  let request;
  await page.route("**/api/tryon", (route) => {
    request = route.request().postDataJSON();
    return route.fulfill({ json: { image: "data:image/webp;base64,YQ==", garment_layer: "YQ==" } });
  });
  await page.goto("/studio");
  const result = await page.evaluate(async () => {
    const { CatVTONClient } = await import("/src/catvton-client.js");
    return new CatVTONClient().tryOn({ personImage: "YQ==", maskImage: "YQ==", garmentAsset: "/garments/products/look-01.jpg", steps: 8, guidanceScale: 2.5 });
  });
  expect(request).toMatchObject({ response_format: "compact", steps: 8, guidance_scale: 2.5, width: 512, height: 768 });
  expect(result.image).toBe("data:image/webp;base64,YQ==");
  expect(result.responseBytes).toBeGreaterThan(30);
  expect(result.requestBytes).toBeGreaterThan(request.garment_image.length);
});

test("an obsolete generation cannot clear or replace a newer garment request", async ({ page }) => {
  await page.route("**/api/status", (route) => route.fulfill({ json: { ready: true, gpu: "test" } }));
  await page.goto("/studio");
  await waitForRenderer(page);
  const outcome = await page.evaluate(async () => {
    const debug = window.__VTON_DEBUG__;
    const engine = debug.engine;
    engine.running = false;
    await new Promise((resolve) => setTimeout(resolve, 100));
    const pending = [];
    debug.catvton.tryOn = () => new Promise((resolve) => pending.push(resolve));
    engine.source = "camera";
    engine.rawLandmarks = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 1 }));
    engine.captureTryOnInput = () => ({ personImage: "person", maskImage: "mask", pose: {} });
    engine.setGarment = async () => { engine.neuralLayerReady = false; };
    let applied = 0;
    engine.setNeuralGarmentLayer = async () => { applied += 1; };
    debug.state.aiService = { ready: true };
    const first = debug.generateNeuralGarmentLayer();
    const nextId = document.querySelectorAll(".garment-card")[1].dataset.id;
    await debug.selectGarment(nextId);
    pending[0]({});
    await first;
    const busyWhileNewRequestPending = debug.state.aiBusy;
    pending[1]({ image: "result", timings_ms: { total: 500 }, requestBytes: 100, responseBytes: 80, roundTripMs: 600 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { requests: pending.length, busyWhileNewRequestPending, applied, busyAfterCompletion: debug.state.aiBusy };
  });
  expect(outcome).toEqual({ requests: 2, busyWhileNewRequestPending: true, applied: 1, busyAfterCompletion: false });
});

function collectRuntimeFailures(page) {
  const failures = [];
  const ignoredWarnings = [/OpenGL error checking is disabled/];
  page.on("pageerror", (error) => failures.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (ignoredWarnings.some((pattern) => pattern.test(message.text()))) return;
    if (message.type() === "error" || message.type() === "warning") {
      failures.push(`${message.type()}: ${message.text()}`);
    }
  });
  return failures;
}

async function waitForRenderer(page) {
  await expect
    .poll(
      () =>
        page.evaluate(() => ({
          ready: Boolean(window.__VTON_DEBUG__?.engine?.garmentImage),
          frames: window.__VTON_DEBUG__?.getStats?.()?.frames ?? 0,
        })),
      { timeout: 12_000 },
    )
    .toMatchObject({ ready: true });
  await expect
    .poll(
      () => page.evaluate(() => window.__VTON_DEBUG__?.getStats?.()?.frames ?? 0),
      { timeout: 8_000 },
    )
    .toBeGreaterThan(12);
}

async function expectNoHorizontalOverflow(page) {
  const dimensions = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1);
  expect(dimensions.clientWidth).toBeLessThanOrEqual(dimensions.innerWidth);
}

test("desktop demo renders and controls remain interactive", async ({ page }) => {
  const failures = collectRuntimeFailures(page);
  await page.goto("/studio");
  await waitForRenderer(page);

  await expect(page.locator("#tryonCanvas")).toBeVisible();
  await expect(page.locator(".garment-card")).toHaveCount(8);
  await expect(page.locator("#fpsValue")).not.toHaveText("--");
  await expect(page.locator("#activeGarmentName")).toHaveText("Neural Look 03");
  await expect(page.locator("#qualitySwitch .quality-option.is-active")).toHaveAttribute(
    "data-steps",
    "50",
  );

  const canvasProbe = await page.locator("#tryonCanvas").evaluate((canvas) => {
    const gl = canvas.getContext("webgl");
    // The renderer discards its backbuffer after presentation. Probe a freshly
    // drawn frame in the same task instead of reading an already discarded one.
    const engine = window.__VTON_DEBUG__.engine;
    engine.drawVideo(performance.now());
    engine.drawGarment(engine.filteredLandmarks ?? engine.landmarks, performance.now());
    const width = canvas.width;
    const height = canvas.height;
    const pixels = new Uint8Array(4 * 9);
    const samples = [];
    for (const xRatio of [0.25, 0.5, 0.75]) {
      for (const yRatio of [0.25, 0.5, 0.75]) {
        gl.readPixels(
          Math.floor(width * xRatio),
          Math.floor(height * yRatio),
          1,
          1,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          pixels.subarray(samples.length * 4, samples.length * 4 + 4),
        );
        samples.push(0);
      }
    }
    const values = Array.from(pixels);
    return {
      error: gl.getError(),
      distinct: new Set(values.map((value, index) => (index % 4 === 3 ? 255 : value))).size,
      max: Math.max(...values),
      min: Math.min(...values),
    };
  });
  expect(canvasProbe.error).toBe(0);
  expect(canvasProbe.max).toBeGreaterThan(8);
  expect(canvasProbe.distinct).toBeGreaterThan(3);

  await page.locator('[data-id="neural-look-02"]').click();
  await expect(page.locator("#activeGarmentName")).toHaveText("Neural Look 02");
  await expect(page.locator('[data-id="neural-look-02"]')).toHaveAttribute("aria-pressed", "true");

  await page.locator("#widthRange").fill("112");
  await expect(page.locator("#widthOutput")).toHaveText("112%");
  await page.locator("#smoothRange").fill("72");
  await expect(page.locator("#smoothOutput")).toHaveText("0.72");
  await page.locator('#qualitySwitch [data-steps="20"]').click();
  await expect(page.locator('#qualitySwitch [data-steps="20"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.locator("#aiLatencyFoot")).toContainText("CATVTON 20 STEPS");

  await page.locator("#maskSwitch").uncheck();
  await expect(page.locator("#dimRange")).toBeDisabled();
  await page.locator("#maskSwitch").check();
  await expect(page.locator("#dimRange")).toBeEnabled();

  await page.locator("#togglePauseButton").click();
  await expect(page.locator("#statusText")).toHaveText("预览已暂停");
  await page.locator("#togglePauseButton").click();
  await expect(page.locator("#statusText")).toHaveText("演示姿态运行中");

  await page.locator("#openDiagnostics").click();
  await expect(page.locator("#diagnosticsDialog")).toBeVisible();
  await expect(page.locator("#remoteUrl")).toHaveValue("ws://127.0.0.1:8010/ws");
  await page.locator("#diagnosticsDialog .dialog-close").click();

  await expectNoHorizontalOverflow(page);
  expect(failures).toEqual([]);
});

test("390 px layout stays inside the viewport", async ({ page }) => {
  const failures = collectRuntimeFailures(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/studio");
  await waitForRenderer(page);

  await expectNoHorizontalOverflow(page);
  const mirror = await page.locator("#mirrorFrame").boundingBox();
  expect(mirror.width).toBeLessThanOrEqual(390);
  expect(mirror.height).toBeGreaterThan(400);

  const clipped = await page.evaluate(() =>
    Array.from(document.querySelectorAll("button, h1, h2, .garment-info, .host-row"))
      .filter((element) => {
        const style = getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden") return false;
        return element.scrollWidth > element.clientWidth + 2;
      })
      .map((element) => ({
        tag: element.tagName,
        id: element.id,
        className: element.className,
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
      })),
  );
  expect(clipped).toEqual([]);
  expect(failures).toEqual([]);
});

test("fake camera initializes the realtime inference path", async ({ page, context }) => {
  test.slow();
  const failures = collectRuntimeFailures(page);
  await context.grantPermissions(["camera"], { origin: "http://127.0.0.1:8766" });
  await page.goto("/studio");
  await waitForRenderer(page);
  await page.locator("#startCameraButton").click();

  await expect
    .poll(
      () =>
        page.evaluate(() => ({
          source: window.__VTON_DEBUG__?.engine?.source,
          modelReady: window.__VTON_DEBUG__?.getStats?.()?.modelReady,
          readyState: window.__VTON_DEBUG__?.engine?.video?.readyState,
        })),
      { timeout: 30_000 },
    )
    .toMatchObject({ source: "camera", modelReady: true, readyState: 4 });

  await expect(page.locator("#sourceValue")).toHaveText("CAMERA");
  await expect(page.locator("#statusText")).toHaveText("摄像头实时流运行中");
  await page.waitForTimeout(1500);
  const cameraStats = await page.evaluate(() => window.__VTON_DEBUG__.getStats());
  expect(cameraStats.source).toBe("camera");
  expect(cameraStats.frames).toBeGreaterThan(20);
  expect(["GPU", "CPU"]).toContain(cameraStats.delegate);
  expect(cameraStats.webglRenderer.length).toBeGreaterThan(3);
  expect(cameraStats.inferenceThread).toBe("worker");
  expect(cameraStats.cameraFps).toBeGreaterThan(10);
  expect(cameraStats.cameraFps).toBeLessThan(40);
  const aiService = await page.evaluate(() => window.__VTON_DEBUG__.state.aiService);
  if (aiService?.ready) {
    await expect(page.locator("#localBackendLabel")).toContainText(aiService.gpu);
    await expect(page.locator("#localBackendDetail")).toContainText(
      `${cameraStats.delegate}`,
    );
  } else {
    await expect(page.locator("#localBackendLabel")).toContainText(
      `${cameraStats.delegate} DELEGATE`,
    );
  }
  expect(failures).toEqual([]);

  await page.locator("#topCameraButton").click();
  await expect(page.locator("#sourceValue")).toHaveText("DEMO");
});

test("worker tracking keeps one frame in flight and drops stale snapshots", async ({ page }) => {
  await page.goto("/studio");
  await waitForRenderer(page);

  const schedule = await page.evaluate(async () => {
    const engine = window.__VTON_DEBUG__.engine;
    engine.running = false;
    await new Promise((resolve) => setTimeout(resolve, 100));

    const calls = [];
    const source = document.createElement("canvas");
    source.width = 640; source.height = 480;
    engine.video = { readyState: 2, currentTime: 100, videoWidth: 640, videoHeight: 480 };
    engine.modelsReady = true;
    engine.source = "camera";
    engine.poseIntervalMs = 200;
    engine.maskIntervalMs = 40;
    engine.lastPoseInferenceAt = 0;
    engine.lastMaskAt = 0;
    engine.lastPoseVideoTime = -1;
    engine.lastMaskVideoTime = -1;
    let finish;
    engine.workerCall = (_, request) => {
      request.bitmap.close();
      calls.push(request.timestamp);
      return new Promise((resolve) => { finish = resolve; });
    };
    engine.processInference(1000, source);
    await new Promise((resolve) => setTimeout(resolve, 30));
    for (let i = 0; i < 5; i += 1) {
      engine.video.currentTime += 1;
      engine.processInference(1200 + i * 100, source);
    }
    const callsWhileBusy = [...calls];
    finish({ landmarks: null, poseMs: 200 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    engine.video.currentTime += 1;
    engine.processInference(3000, source);
    await new Promise((resolve) => setTimeout(resolve, 30));
    finish({ landmarks: null, poseMs: 20 });
    return { callsWhileBusy, calls };
  });

  expect(schedule.callsWhileBusy).toEqual([1000]);
  expect(schedule.calls).toEqual([1000, 3000]);
});

test("half-body capture accepts visible shoulders with hidden hips and elbows", async ({ page }) => {
  await page.goto("/studio");
  await waitForRenderer(page);
  const result = await page.evaluate(async () => {
    const { completeUpperBodyPose } = await import("/src/tryon-engine.js");
    const points = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 0 }));
    points[11] = { x: 0.35, y: 0.5, visibility: 0.95 };
    points[12] = { x: 0.65, y: 0.5, visibility: 0.95 };
    const completed = completeUpperBodyPose(points, 640, 480);
    const noPerson = completeUpperBodyPose(points.map((p) => ({ ...p, visibility: 0 })), 640, 480);
    const engine = window.__VTON_DEBUG__.engine;
    engine.running = false;
    await new Promise((resolve) => setTimeout(resolve, 100));
    const source = document.createElement("canvas");
    source.width = 640; source.height = 480;
    Object.assign(source, { videoWidth: 640, videoHeight: 480, readyState: 2 });
    source.getContext("2d").fillRect(0, 0, 640, 480);
    engine.video = source; engine.source = "camera";
    engine.resizeToSource(640, 480);
    engine.acceptTrackedPose(points, performance.now());
    const capture = engine.captureTryOnInput();
    engine.neuralCapturePose = capture.pose;
    const mirrored = engine.rawLandmarks.map((p) => ({ ...p, x: 1 - p.x }));
    const sourcePoint = { x: 256, y: 500 };
    const before = engine.mapNeuralGarmentPoint(sourcePoint, engine.createNeuralSkinningRig(mirrored));
    const shifted = mirrored.map((p) => ({ ...p, x: p.x - 0.1 }));
    const after = engine.mapNeuralGarmentPoint(sourcePoint, engine.createNeuralSkinningRig(shifted));
    return { inferredHips: completed[23].estimated && completed[24].estimated,
      hipBelowFrame: completed[23].y > 1,
      hipConfidence: completed[23].visibility,
      noPerson: noPerson === null, mode: engine.trackingMode,
      hasUpperBody: engine.hasUpperBody(), captured: capture.personImage.startsWith("data:image/jpeg"),
      garmentShiftX: Math.round(after.x - before.x) };
  });
  expect(result).toEqual({ inferredHips: true, hipBelowFrame: true, hipConfidence: 0,
    noPerson: true, mode: "upper-body", hasUpperBody: true, captured: true, garmentShiftX: -64 });
});

test("occlusion does not restore torso pixels misclassified as skin or other", async ({ page }) => {
  await page.goto("/studio");
  await waitForRenderer(page);
  const values = await page.evaluate(() => {
    const engine = window.__VTON_DEBUG__.engine;
    engine.rawLandmarks = null;
    engine.updateMask(new Uint8Array([0, 1, 2, 3, 4, 5]), 3, 2);
    return Array.from(engine.foregroundMaskData).map(Math.round);
  });
  expect(values[0]).toBe(0);
  expect(values[1]).toBeGreaterThan(180);
  expect(values[2]).toBe(0);
  expect(values[3]).toBeGreaterThan(180);
  expect(values[4]).toBe(0);
  expect(values[5]).toBe(0);
});

test("generated matte rejects background and keeps unchanged fabric opaque", async ({ page }) => {
  await page.goto("/studio");
  await waitForRenderer(page);

  const matte = await page.evaluate(() => {
    const width = 512;
    const height = 768;
    const engine = window.__VTON_DEBUG__.engine;
    const createCanvas = (fill) => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      context.fillStyle = fill;
      context.fillRect(0, 0, width, height);
      return canvas;
    };
    const source = createCanvas("#fff");
    const sourceContext = source.getContext("2d");
    sourceContext.fillStyle = "#000";
    sourceContext.fillRect(220, 470, 40, 40);
    const reference = createCanvas("#000");
    const replacementMask = createCanvas("rgba(255,255,255,1)");
    const categories = new Uint8Array(width * height);
    for (let y = 180; y < 650; y += 1) {
      categories.fill(4, y * width + 150, y * width + 361);
    }
    for (let y = 350; y < 410; y += 1) {
      categories.fill(2, y * width + 220, y * width + 280);
    }

    engine.staticSegmenter = {
      segment: () => ({
        categoryMask: {
          width,
          height,
          getAsUint8Array: () => categories,
        },
        close() {},
      }),
    };

    const extracted = engine.extractGeneratedClothing(
      source,
      reference,
      replacementMask,
    );
    const pixels = extracted.canvas
      .getContext("2d")
      .getImageData(0, 0, width, height).data;
    const alphaAt = (x, y) => pixels[(y * width + x) * 4 + 3];
    return {
      backgroundAlpha: alphaAt(20, 20),
      changedBackgroundAlpha: alphaAt(100, 300),
      clothingAlpha: alphaAt(256, 400),
      skinHoleAlpha: alphaAt(250, 380),
      unchangedOldClothingAlpha: alphaAt(240, 490),
      changedPixels: extracted.stats.changedPixels,
    };
  });

  expect(matte.changedPixels).toBeGreaterThan(100_000);
  expect(matte.backgroundAlpha).toBe(0);
  expect(matte.changedBackgroundAlpha).toBe(0);
  expect(matte.clothingAlpha).toBe(255);
  expect(matte.skinHoleAlpha).toBe(255);
  expect(matte.unchangedOldClothingAlpha).toBe(255);
});

test("neural skinning keeps lifted sleeve independent from torso and other arm", async ({
  page,
}) => {
  await page.goto("/studio");
  await waitForRenderer(page);

  const movement = await page.evaluate(() => {
    const engine = window.__VTON_DEBUG__.engine;
    const source = {};
    const destination = Array.from({ length: 33 }, () => ({
      x: 0.5,
      y: 0.5,
      visibility: 0.99,
    }));
    const setSource = (index, x, y) => {
      source[index] = { x, y, visibility: 0.99 };
    };
    const setDestination = (index, x, y) => {
      destination[index] = {
        x: x / engine.width,
        y: y / engine.height,
        visibility: 0.99,
      };
    };

    setSource(11, 170, 250);
    setSource(12, 340, 250);
    setSource(13, 130, 430);
    setSource(14, 380, 430);
    setSource(15, 120, 600);
    setSource(16, 390, 600);
    setSource(23, 200, 520);
    setSource(24, 310, 520);
    setSource(25, 190, 700);
    setSource(26, 320, 700);

    setDestination(11, 170, 250);
    setDestination(12, 340, 250);
    setDestination(13, 90, 150);
    setDestination(14, 380, 430);
    setDestination(15, 70, 70);
    setDestination(16, 390, 600);
    setDestination(23, 200, 520);
    setDestination(24, 310, 520);
    setDestination(25, 190, 700);
    setDestination(26, 320, 700);

    engine.neuralCapturePose = source;
    const rig = engine.createNeuralSkinningRig(destination);
    const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const measure = (point) => {
      const mapped = engine.mapNeuralGarmentPoint(point, rig);
      return distance(point, mapped);
    };
    return {
      leftSleeve: measure({ x: 90, y: 520 }),
      rightSleeve: measure({ x: 380, y: 520 }),
      torso: measure({ x: 256, y: 400 }),
    };
  });

  expect(movement.leftSleeve).toBeGreaterThan(100);
  expect(movement.rightSleeve).toBeLessThan(5);
  expect(movement.torso).toBeLessThan(5);
});
