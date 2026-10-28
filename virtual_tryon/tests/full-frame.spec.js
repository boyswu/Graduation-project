import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/telemetry", (route) => route.fulfill({ json: { accepted: 128 } }));
});

test("full-frame generation bypasses pose, preserves all camera pixels and never queues frames", async ({ page }) => {
  await page.route("**/api/status", (route) => route.fulfill({ json: {
    ready: true, engine: "FLUX.2-klein-4B / FluxRT", output: "full-frame", gpu: "test GPU",
  } }));
  let connection, header;
  let sentFrames = 0;
  let init;
  await page.routeWebSocket("**/api/stream", (socket) => {
    connection = socket;
    socket.onMessage((message) => {
      if (typeof message === "string") {
        const data = JSON.parse(message);
        if (data.type === "init") {
          init = data;
          socket.send(JSON.stringify({ type: "ready", width: 512, height: 512, steps: 2 }));
        } else header = data;
      } else sentFrames += 1;
    });
  });
  await page.goto("/studio");
  await expect(page.locator("#tryonPipeline")).toHaveValue("full-frame");
  await expect(page.locator("#neuralRunbar")).toBeHidden();
  await expect(page.locator("#widthRange")).toBeHidden();
  await page.evaluate(() => {
    const { engine } = window.__VTON_DEBUG__;
    engine.setNeuralGarmentLayer = () => { throw new Error("Full frames must never enter garment extraction"); };
    engine.captureTryOnInput = () => { throw new Error("Must not crop camera input using landmarks"); };
    engine.loadModels = () => { throw new Error("Full-frame mode must not require pose model loading"); };
    HTMLCanvasElement.prototype.toBlob = () => { throw new Error("Camera encoding must use the dedicated worker, not main-thread toBlob"); };
  });
  await page.locator("#fullFrameButton").click();
  await expect.poll(() => sentFrames).toBe(1);
  await page.waitForTimeout(400);
  expect(sentFrames).toBe(1); // No second sample can queue behind slow inference.
  expect(init.garment_id).toBe("neural-look-03");
  expect(init.cache_policy).toBe("motion-priority");
  const encoded = await page.evaluate(() => {
    const c = document.createElement("canvas"); c.width = c.height = 512;
    const ctx = c.getContext("2d"); ctx.fillStyle = "#2040ff"; ctx.fillRect(0, 0, 512, 512);
    ctx.fillStyle = "#ff0000"; ctx.fillRect(0, 0, 20, 512);
    return c.toDataURL().split(",")[1];
  });
  connection.send(JSON.stringify({ type: "frame", id: header.id, inference_ms: 240, service_ms: 250 }));
  connection.send(Buffer.from(encoded, "base64"));
  await expect(page.locator("#generatedCanvas")).toBeVisible();
  await expect(page.locator("#generatedCanvas")).toHaveAttribute("data-frame-id", "1");
  const pixels = await page.locator("#generatedCanvas").evaluate((canvas) => {
    const ctx = canvas.getContext("2d");
    return [Array.from(ctx.getImageData(canvas.width - 1, 0, 1, 1).data), Array.from(ctx.getImageData(0, canvas.height - 1, 1, 1).data)];
  });
  expect(pixels).toEqual([[255, 0, 0, 255], [32, 64, 255, 255]]);
  await expect.poll(() => sentFrames).toBe(2);
  const capture = await page.evaluate(() => window.__VTON_DEBUG__.fullFrame.log.events.find((event) => event.event === "client_display")?.metrics);
  expect(capture.capture_mode).toBe(2);
  expect(capture.worker_encode_ms).toBeGreaterThanOrEqual(0);
  await page.evaluate(() => {
    const engine = window.__VTON_DEBUG__.engine, draw = engine.drawVideo.bind(engine);
    window.rawPreviewDraws = 0;
    engine.drawVideo = (...args) => { window.rawPreviewDraws += 1; return draw(...args); };
  });
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => window.rawPreviewDraws)).toBe(0);
  await expect(page.locator("#aiLatencyValue")).toHaveText("0.24");
  await expect(page.locator("#stagePipelineTag")).toContainText("FULL-FRAME AI");
  await page.locator("#fullFrameButton").click();
  await expect(page.locator("#generatedCanvas")).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.rawPreviewDraws)).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.__VTON_DEBUG__.fullFrame.pending)).toBeNull();
  expect(await page.evaluate(() => window.__VTON_DEBUG__.fullFrame.captureWorker)).toBeNull();
  await page.locator("#topCameraButton").click();
});

test("capture geometry matches the actual snapshot in worker and main-thread fallback", async ({ page }) => {
  await page.goto("/studio?demo=1");
  await page.waitForFunction(() => Boolean(window.__VTON_DEBUG__));
  const results = await page.evaluate(async () => {
    const worker = new Worker("/src/capture-worker.js", { type: "module" });
    const client = window.__VTON_DEBUG__.fullFrame, original = client.video;
    const fields = ["input_width", "input_height", "content_x", "content_y", "content_width", "content_height"];
    const pick = value => Object.fromEntries(fields.map(key => [key, value[key]]));
    const rows = [];
    try {
      for (const [width, height] of [[960, 720], [720, 960], [1920, 1080], [512, 512]]) {
        const source = document.createElement("canvas"); source.width = width; source.height = height;
        source.getContext("2d").fillStyle = "green"; source.getContext("2d").fillRect(0, 0, width, height);
        Object.defineProperties(source, { videoWidth: { value: width }, videoHeight: { value: height } });
        const frame = await createImageBitmap(source);
        const encoded = await new Promise((resolve, reject) => {
          worker.onmessage = event => resolve(event.data); worker.onerror = reject;
          worker.postMessage({ id: rows.length, frame }, [frame]);
        });
        client.video = source;
        const fallback = await client.encodeFrame(client.epoch);
        rows.push({ worker: pick(encoded), fallback: pick(fallback) });
      }
    } finally { worker.terminate(); client.video = original; }
    return rows;
  });
  const rectangles = [[0, 64, 512, 384], [64, 0, 384, 512], [0, 112, 512, 288], [0, 0, 512, 512]];
  results.forEach((row, index) => {
    const [content_x, content_y, content_width, content_height] = rectangles[index];
    const expected = { input_width: 512, input_height: 512, content_x, content_y, content_width, content_height };
    expect(row.worker).toEqual(expected); expect(row.fallback).toEqual(expected);
  });
});

test("generated padding never appears at camera edges across frame aspect and model size changes", async ({ page }) => {
  await page.route("**/api/status", route => route.fulfill({ json: { ready: true, output: "full-frame", engine: "FLUX.2-klein-4B / FluxRT" } }));
  let socket, frameId;
  await page.routeWebSocket("**/api/stream", connection => {
    socket = connection;
    connection.onMessage(message => {
      if (typeof message !== "string") return;
      const meta = JSON.parse(message);
      if (meta.type === "init") connection.send(JSON.stringify({ type: "ready", flow_control: "serial" }));
      if (meta.type === "frame") frameId = meta.id;
    });
  });
  await page.goto("/studio");
  await page.locator("#fullFrameButton").click();
  const cases = [
    { x: 0, y: .125, width: 1, height: .75, size: 320 },
    { x: .125, y: 0, width: .75, height: 1, size: 384 },
    { x: 0, y: 0, width: 1, height: 1, size: 512 },
    { x: 0, y: .21875, width: 1, height: .5625, size: 320 },
  ];
  for (let i = 0; i < cases.length; i++) {
    const id = i + 1, rect = cases[i];
    await expect.poll(() => frameId).toBe(id);
    const encoded = await page.evaluate(({ id, rect }) => {
      const client = window.__VTON_DEBUG__.fullFrame;
      client.records.get(id).contentRect = rect; // This sampled frame's geometry, not the current video's.
      const c = document.createElement("canvas"); c.width = c.height = rect.size;
      const ctx = c.getContext("2d"), x = rect.x * c.width, y = rect.y * c.height, w = rect.width * c.width, h = rect.height * c.height;
      ctx.fillStyle = "magenta"; ctx.fillRect(0, 0, c.width, c.height); // Sentinel for hallucinated padding.
      ctx.fillStyle = "green"; ctx.fillRect(x, y, w, h);
      ctx.fillStyle = "yellow"; ctx.fillRect(x, y, w, 2);
      ctx.fillStyle = "blue"; ctx.fillRect(x, y + h - 2, w, 2);
      ctx.fillStyle = "red"; ctx.fillRect(x, y + 2, 2, h - 4);
      ctx.fillStyle = "cyan"; ctx.fillRect(x + w - 2, y + 2, 2, h - 4);
      return c.toDataURL().split(",")[1];
    }, { id, rect });
    socket.send(JSON.stringify({ type: "frame", id })); socket.send(Buffer.from(encoded, "base64"));
    await expect(page.locator("#generatedCanvas")).toHaveAttribute("data-frame-id", String(id));
    const visible = await page.locator("#generatedCanvas").evaluate(c => {
      const ctx = c.getContext("2d"), pixel = (x, y) => [...ctx.getImageData(x, y, 1, 1).data];
      const bytes = ctx.getImageData(0, 0, c.width, c.height).data; let paddingPixels = 0;
      for (let i = 0; i < bytes.length; i += 4) if (bytes[i] === 255 && bytes[i + 1] === 0 && bytes[i + 2] === 255) paddingPixels++;
      return { width: c.width, height: c.height, top: pixel(c.width / 2, 0), bottom: pixel(c.width / 2, c.height - 1),
        left: pixel(0, c.height / 2), right: pixel(c.width - 1, c.height / 2), paddingPixels,
        desynchronized: ctx.getContextAttributes().desynchronized };
    });
    expect(visible).toEqual({ width: rect.width * rect.size, height: rect.height * rect.size, top: [255, 255, 0, 255],
      bottom: [0, 0, 255, 255], left: [0, 255, 255, 255], right: [255, 0, 0, 255], paddingPixels: 0, desynchronized: true });
  }
  await page.locator("#fullFrameButton").click(); await page.locator("#topCameraButton").click();
});

test("disconnect discards stale output and changing garment cancels the old session", async ({ page }) => {
  await page.route("**/api/status", (route) => route.fulfill({ json: {
    ready: true, engine: "FLUX.2-klein-4B / FluxRT", output: "full-frame", gpu: "test GPU",
  } }));
  const connections = [];
  const initIds = [];
  await page.routeWebSocket("**/api/stream", (socket) => {
    connections.push(socket);
    socket.onMessage((message) => {
      if (typeof message !== "string") return;
      const data = JSON.parse(message);
      if (data.type === "init") {
        initIds.push(data.garment_id);
        socket.send(JSON.stringify({ type: "ready", width: 512, height: 512, steps: 2 }));
      }
    });
  });
  await page.goto("/studio");
  await page.locator("#fullFrameButton").click();
  await expect.poll(() => initIds.length).toBe(1);
  await page.locator('[data-id="neural-look-02"]').click();
  await expect.poll(() => initIds.length).toBe(2);
  expect(initIds).toEqual(["neural-look-03", "neural-look-02"]);
  await expect(page.locator("#generatedCanvas")).toBeHidden();
  connections[1].close({ code: 1011 });
  await expect(page.locator("#fullFrameTitle")).toContainText("连接已关闭");
  await expect(page.locator("#generatedCanvas")).toBeHidden();
  await expect(page.locator("#fullFrameButton")).toHaveText("开始连续生成");
  expect(await page.evaluate(() => window.__VTON_DEBUG__.fullFrame.running)).toBe(false);
  await page.locator("#topCameraButton").click();
});

test("latest-frame protocol overlaps uploads with generation and accepts skipped input IDs", async ({ page }) => {
  await page.route("**/api/status", (route) => route.fulfill({ json: {
    ready: true, engine: "FLUX.2-klein-4B / FluxRT", output: "full-frame", gpu: "test GPU",
  } }));
  let socket, header;
  const uploads = [];
  await page.routeWebSocket("**/api/stream", (connection) => {
    socket = connection;
    connection.onMessage((message) => {
      if (typeof message === "string") {
        const data = JSON.parse(message);
        if (data.type === "init") connection.send(JSON.stringify({ type: "ready", flow_control: "latest-frame", capture_fps: 12 }));
        else header = data;
      } else uploads.push(header.id);
    });
  });
  await page.goto("/studio");
  await page.locator("#fullFrameButton").click();
  await expect.poll(() => uploads.length).toBe(1);
  await page.waitForTimeout(250);
  expect(uploads).toEqual([1]); // Upload backpressure persists until server acceptance.
  socket.send(JSON.stringify({ type: "accepted", id: 1, dropped_id: null }));
  await expect.poll(() => uploads.length).toBe(2); // GPU has produced no result yet.
  socket.send(JSON.stringify({ type: "accepted", id: 2, dropped_id: 1 }));
  await expect.poll(() => uploads.length).toBe(3);
  expect(await page.evaluate(() => window.__VTON_DEBUG__.fullFrame.records.has(1))).toBe(false);
  const encoded = await page.evaluate(() => {
    const c = document.createElement("canvas"); c.width = c.height = 512;
    const ctx = c.getContext("2d"); ctx.fillStyle = "green"; ctx.fillRect(0, 0, 512, 512);
    return c.toDataURL().split(",")[1];
  });
  socket.send(JSON.stringify({ type: "frame", id: 3, inference_ms: 220, service_ms: 225 }));
  socket.send(Buffer.from(encoded, "base64"));
  await expect(page.locator("#generatedCanvas")).toHaveAttribute("data-frame-id", "3");
  await expect(page.locator("#aiLatencyValue")).toHaveText("0.22");
  await page.locator("#fullFrameButton").click();
  expect(await page.evaluate(() => window.__VTON_DEBUG__.fullFrame.records.size)).toBe(0);
  await expect(page.locator("#generatedCanvas")).toBeHidden();
  await page.locator("#topCameraButton").click();
});

test("bounded upload window continues through delayed ACKs without a FIFO backlog or timer leaks", async ({ page }) => {
  await page.route("**/api/status", route => route.fulfill({json:{ready:true,output:"full-frame",engine:"FLUX.2-klein-4B / FluxRT"}}));
  let connection, header;
  const uploads=[];
  await page.routeWebSocket("**/api/stream", socket => {
    connection=socket;
    socket.onMessage(message => {
      if(typeof message==="string") {
        const meta=JSON.parse(message);
        if(meta.type==="init") socket.send(JSON.stringify({type:"ready",flow_control:"latest-frame",capture_fps:12,upload_window:4,input_width:512}));
        else if(meta.type==="frame") header=meta;
      } else uploads.push(header.id);
    });
  });
  await page.goto("/studio");
  await page.locator("#fullFrameButton").click();
  // An oversized advertised window is clamped to three fresh uploads.
  await expect.poll(()=>uploads.length).toBe(3);
  await page.waitForTimeout(180);
  expect(uploads).toEqual([1,2,3]);
  expect(await page.evaluate(()=>window.__VTON_DEBUG__.fullFrame.uploads.size)).toBe(3);
  expect(await page.evaluate(()=>window.__VTON_DEBUG__.fullFrame.log.events.find(e=>e.event==="client_capture").metrics.input_width)).toBe(512);
  // ACKs are matched by ID, independent of which frame is being encoded.
  await page.evaluate(()=>Object.defineProperty(window.__VTON_DEBUG__.fullFrame.socket,"bufferedAmount",{configurable:true,get:()=>256*1024}));
  connection.send(JSON.stringify({type:"accepted",id:2,dropped_id:1}));
  await page.waitForTimeout(120);
  expect(uploads.length).toBe(3); // TCP backpressure overrides the free ACK slot.
  await page.evaluate(()=>delete window.__VTON_DEBUG__.fullFrame.socket.bufferedAmount);
  await expect.poll(()=>uploads.length).toBe(4);
  expect(await page.evaluate(()=>window.__VTON_DEBUG__.fullFrame.records.has(1))).toBe(false);
  expect(await page.evaluate(()=>window.__VTON_DEBUG__.fullFrame.uploads.size)).toBe(3);
  connection.send(JSON.stringify({type:"accepted",id:1}));
  await expect.poll(()=>uploads.length).toBe(5);
  await page.locator("#fullFrameButton").click();
  expect(await page.evaluate(()=>window.__VTON_DEBUG__.fullFrame.uploads.size)).toBe(0);
  const stoppedAt=uploads.length;
  await page.waitForTimeout(180);
  expect(uploads.length).toBe(stoppedAt);
  await expect(page.locator("#generatedCanvas")).toBeHidden();
  await page.locator("#topCameraButton").click();
});

test("smooth playback presents full-frame intermediates, preserves original and cancels on stop", async ({ page }) => {
  await page.route("**/api/status", (route) => route.fulfill({ json: {
    ready: true, engine: "FLUX.2-klein-4B / FluxRT", output: "full-frame", gpu: "test GPU",
  } }));
  let socket, header;
  const uploads = [];
  await page.routeWebSocket("**/api/stream", (connection) => {
    socket = connection;
    connection.onMessage((message) => {
      if (typeof message === "string") {
        const data = JSON.parse(message);
        if (data.type === "init") connection.send(JSON.stringify({ type: "ready", flow_control: "latest-frame", smoothing: true, capture_fps: 12 }));
        else header = data;
      } else uploads.push(header.id);
    });
  });
  await page.goto("/studio");
  const parts = (await page.evaluate(() => ["red", "orange", "green", "blue"].map((color) => {
    const c = document.createElement("canvas"); c.width = c.height = 512;
    const ctx = c.getContext("2d"); ctx.fillStyle = color; ctx.fillRect(0, 0, 512, 512);
    return c.toDataURL().split(",")[1];
  }))).map((encoded) => Buffer.from(encoded, "base64"));
  await page.locator("#fullFrameButton").click();
  await expect.poll(() => uploads.length).toBe(1);
  socket.send(JSON.stringify({ type: "accepted", id: 1 }));
  socket.send(JSON.stringify({ type: "frame", id: 1, inference_ms: 230, service_ms: 250,
    image_lengths: parts.map((part) => part.length), interpolated_frames: 3, display_span_ms: 160 }));
  socket.send(Buffer.concat(parts));
  await expect(page.locator("#generatedCanvas")).toHaveAttribute("data-frame-id", "1");
  expect(await page.evaluate(() => window.__VTON_DEBUG__.fullFrame.displayFrames)).toBe(4);
  expect(await page.locator("#generatedCanvas").evaluate((c) => Array.from(c.getContext("2d").getImageData(0, 0, 1, 1).data)))
    .toEqual([0, 0, 255, 255]);
  await expect(page.locator("#fpsLabel")).toHaveText("显示帧率（含补帧）");
  await expect.poll(() => uploads.length).toBe(2);
  socket.send(JSON.stringify({ type: "frame", id: 2, inference_ms: 230, service_ms: 250,
    image_lengths: parts.map((part) => part.length), interpolated_frames: 3, display_span_ms: 240 }));
  socket.send(Buffer.concat(parts));
  await expect.poll(() => page.evaluate(() => window.__VTON_DEBUG__.fullFrame.displayFrames)).toBeGreaterThan(4);
  await page.locator("#fullFrameButton").click();
  await page.waitForTimeout(300);
  await expect(page.locator("#generatedCanvas")).toBeHidden();
  expect(await page.evaluate(() => window.__VTON_DEBUG__.fullFrame.records.size)).toBe(0);
  await page.locator("#topCameraButton").click();
});

test("generation profile switches restart the session with the same garment and persist independently of display mode", async ({ page }) => {
  await page.route("**/api/status", route => route.fulfill({json:{ready:true,output:"full-frame",engine:"FLUX.2-klein-4B / FluxRT"}}));
  const inits=[];
  await page.routeWebSocket("**/api/stream", socket => {
    socket.onMessage(message => {
      if(typeof message!=="string") return;
      const meta=JSON.parse(message);
      if(meta.type==="init") {
        inits.push(meta);
        socket.send(JSON.stringify({type:"ready",flow_control:"latest-frame",width:meta.generation_profile==="fast"?320:512,height:meta.generation_profile==="fast"?320:512}));
      }
    });
  });
  await page.goto("/studio");
  await expect(page.locator("#fullFrameProfile")).toHaveValue("fast");
  await page.locator("#fullFrameDisplay").selectOption("low-latency");
  await page.locator("#fullFrameProfile").selectOption("detail");
  await page.locator("#fullFrameButton").click();
  await expect.poll(()=>inits.length).toBe(1);
  expect(inits[0].generation_profile).toBe("detail");
  await page.locator("#fullFrameProfile").selectOption("fast");
  await expect.poll(()=>inits.length).toBe(2);
  expect(inits[1].generation_profile).toBe("fast");
  expect(inits[1].garment_id).toBe(inits[0].garment_id);
  expect(inits[1].smoothing).toBe(false);
  await page.locator("#fullFrameButton").click();
  await page.locator("#topCameraButton").click();
  await page.reload();
  await expect(page.locator("#fullFrameProfile")).toHaveValue("fast");
  await expect(page.locator("#fullFrameDisplay")).toHaveValue("low-latency");
});

test("late smooth batches skip obsolete intermediate poses and immediately preserve the newest model frame", async ({ page }) => {
  await page.route("**/api/status", (route) => route.fulfill({ json: { ready: true, output: "full-frame", engine: "FLUX.2-klein-4B / FluxRT" } }));
  let socket, frameId;
  await page.routeWebSocket("**/api/stream", (connection) => {
    socket = connection;
    connection.onMessage((message) => {
      if (typeof message !== "string") return;
      const meta = JSON.parse(message);
      if (meta.type === "init") connection.send(JSON.stringify({ type: "ready", smoothing: true }));
      if (meta.type === "frame") frameId = meta.id;
    });
  });
  await page.goto("/studio");
  await page.locator("#fullFrameButton").click();
  await expect.poll(() => frameId).toBe(1);
  const parts = (await page.evaluate(() => ["red", "orange", "green", "blue"].map((color) => {
    const c = document.createElement("canvas"); c.width = c.height = 512;
    c.getContext("2d").fillStyle = color; c.getContext("2d").fillRect(0, 0, 512, 512);
    return c.toDataURL().split(",")[1];
  }))).map((encoded) => Buffer.from(encoded, "base64"));
  await page.waitForTimeout(500);
  socket.send(JSON.stringify({ type: "frame", id: 1, image_lengths: parts.map((part) => part.length), display_span_ms: 240 }));
  socket.send(Buffer.concat(parts));
  await expect(page.locator("#generatedCanvas")).toHaveAttribute("data-frame-id", "1");
  const metrics = await page.evaluate(() => window.__VTON_DEBUG__.fullFrame.log.events.find((e) => e.event === "client_display").metrics);
  expect(metrics.skipped_intermediates).toBe(3);
  expect(metrics.playback_budget_ms).toBe(0);
  expect(metrics.playback_ms).toBeLessThan(50);
  expect(await page.locator("#generatedCanvas").evaluate((c) => Array.from(c.getContext("2d").getImageData(0, 0, 1, 1).data)))
    .toEqual([0, 0, 255, 255]);
  await page.locator("#fullFrameButton").click();
  await page.locator("#topCameraButton").click();
});

test("arrival of a newer frame cancels old interpolation before its slow decode finishes", async ({ page }) => {
  await page.route("**/api/status", route => route.fulfill({ json: { ready: true, output: "full-frame", engine: "FLUX.2-klein-4B / FluxRT" } }));
  let socket;
  const uploads = [];
  await page.routeWebSocket("**/api/stream", connection => {
    socket = connection;
    connection.onMessage(message => {
      if (typeof message !== "string") return;
      const meta = JSON.parse(message);
      if (meta.type === "init") connection.send(JSON.stringify({ type: "ready", flow_control: "latest-frame", smoothing: true, upload_window: 3 }));
      if (meta.type === "frame") {
        uploads.push(meta.id);
        connection.send(JSON.stringify({ type: "accepted", id: meta.id }));
      }
    });
  });
  await page.goto("/studio");
  await page.locator("#fullFrameButton").click();
  await expect.poll(() => uploads.length).toBeGreaterThanOrEqual(2);
  const parts = await page.evaluate(async () => {
    const client = window.__VTON_DEBUG__.fullFrame;
    client.records.get(1).capturedAt = client.records.get(2).capturedAt = performance.now();
    const encoded = ["red", "orange", "green", "yellow", "blue"].map(color => {
      const c = document.createElement("canvas"); c.width = c.height = 32;
      const ctx = c.getContext("2d"); ctx.fillStyle = color; ctx.fillRect(0, 0, 32, 32);
      return c.toDataURL().split(",")[1];
    });
    const newest = await fetch(`data:image/png;base64,${encoded[4]}`).then(r => r.blob());
    const decode = window.createImageBitmap.bind(window); let calls = 0;
    window.createImageBitmap = async (...args) => {
      if (++calls === 5) await new Promise(resolve => { window.releaseNewestDecode = resolve; });
      return decode(...args);
    };
    const record = client.log.record.bind(client.log); let sent = false;
    client.log.record = (event, id, metrics) => {
      record(event, id, metrics);
      if (!sent && event === "client_paint" && id === 1 && metrics.batch_index === 0) {
        sent = true;
        client.socket.onmessage({ data: JSON.stringify({ type: "frame", id: 2, image_lengths: [newest.size] }) });
        void client.socket.onmessage({ data: newest });
      }
    };
    return encoded.slice(0, 4);
  });
  const buffers = parts.map(part => Buffer.from(part, "base64"));
  socket.send(JSON.stringify({ type: "frame", id: 1, image_lengths: buffers.map(part => part.length), display_span_ms: 240 }));
  socket.send(Buffer.concat(buffers));
  await page.waitForFunction(() => Boolean(window.releaseNewestDecode));
  await page.waitForTimeout(150);
  const paints = await page.evaluate(() => window.__VTON_DEBUG__.fullFrame.log.events.filter(e => e.event === "client_paint" && e.frame_id === 1));
  expect(paints).toHaveLength(1);
  await page.evaluate(() => window.releaseNewestDecode());
  await expect(page.locator("#generatedCanvas")).toHaveAttribute("data-frame-id", "2");
  expect(await page.locator("#generatedCanvas").evaluate(c => [...c.getContext("2d").getImageData(0, 0, 1, 1).data])).toEqual([0, 0, 255, 255]);
  await page.locator("#fullFrameButton").click();
  await page.locator("#topCameraButton").click();
});

test("expired network payload is skipped before decode and the next fresh output still displays", async ({ page }) => {
  await page.route("**/api/status", route => route.fulfill({ json: { ready: true, output: "full-frame", engine: "FLUX.2-klein-4B / FluxRT" } }));
  let socket;
  const uploads = [];
  await page.routeWebSocket("**/api/stream", connection => {
    socket = connection;
    connection.onMessage(message => {
      if (typeof message !== "string") return;
      const meta = JSON.parse(message);
      if (meta.type === "init") connection.send(JSON.stringify({ type: "ready", flow_control: "latest-frame", upload_window: 1 }));
      if (meta.type === "frame") uploads.push(meta.id);
    });
  });
  await page.goto("/studio");
  await page.locator("#fullFrameButton").click();
  await expect.poll(() => uploads.length).toBe(1);
  socket.send(JSON.stringify({ type: "accepted", id: 1 }));
  await expect.poll(() => uploads.length).toBe(2);
  const encoded = await page.evaluate(() => {
    const c = document.createElement("canvas"); c.width = c.height = 32;
    c.getContext("2d").fillStyle = "blue"; c.getContext("2d").fillRect(0, 0, 32, 32);
    window.__VTON_DEBUG__.fullFrame.records.get(1).capturedAt = performance.now() - 2500;
    const decode = window.createImageBitmap.bind(window); window.outputDecodes = 0;
    window.createImageBitmap = (...args) => { window.outputDecodes++; return decode(...args); };
    return c.toDataURL().split(",")[1];
  });
  socket.send(JSON.stringify({ type: "frame", id: 1 }));
  socket.send(Buffer.from(encoded, "base64"));
  await expect.poll(() => page.evaluate(() => window.__VTON_DEBUG__.fullFrame.log.events.some(e => e.event === "client_output_dropped" && e.metrics.expired))).toBe(true);
  expect(await page.evaluate(() => window.outputDecodes)).toBe(0);
  await expect(page.locator("#generatedCanvas")).toBeHidden();
  await page.evaluate(() => { window.__VTON_DEBUG__.fullFrame.records.get(2).capturedAt = performance.now(); });
  socket.send(JSON.stringify({ type: "frame", id: 2 }));
  socket.send(Buffer.from(encoded, "base64"));
  await expect(page.locator("#generatedCanvas")).toHaveAttribute("data-frame-id", "2");
  await page.locator("#fullFrameButton").click();
  await page.locator("#topCameraButton").click();
});

test("wardrobe accepts uploaded reference garments and heartbeat stays outside frame sequencing", async ({ page }) => {
  await page.route("**/api/status", (route) => route.fulfill({ json: {
    ready: true, engine: "FLUX.2-klein-4B / FluxRT", output: "full-frame", gpu: "test GPU",
  } }));
  const initializations = [];
  let heartbeats = 0;
  await page.routeWebSocket("**/api/stream", (socket) => {
    socket.onMessage((message) => {
      if (typeof message !== "string") return;
      const data = JSON.parse(message);
      if (data.type === "init") {
        initializations.push(data);
        socket.send(JSON.stringify({ type: "ready", flow_control: "latest-frame", heartbeat: true }));
      } else if (data.type === "ping") {
        heartbeats += 1;
        socket.send(JSON.stringify({ type: "pong", id: data.id }));
      }
    });
  });
  await page.goto("/studio");
  await expect(page.locator(".garment-card")).toHaveCount(8);
  await page.locator("#garmentUpload").setInputFiles("public/garments/products/look-05.jpg");
  await expect(page.locator(".garment-card")).toHaveCount(9);
  await expect(page.locator("#activeGarmentName")).toHaveText("Custom Garment");
  await expect(page.locator("#wardrobeCount")).toHaveText("09");
  await page.locator("#fullFrameButton").click();
  await expect.poll(() => initializations.length).toBe(1);
  expect(initializations[0].garment_id).toMatch(/^uploaded-[a-z0-9-]+$/);
  expect(initializations[0].garment_image).toMatch(/^data:image\/jpeg;base64,/);
  await expect.poll(() => heartbeats).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => window.__VTON_DEBUG__.fullFrame.rttSamples.length)).toBeGreaterThan(0);
  const originalId = initializations[0].garment_id;
  await page.locator("#garmentUpload").setInputFiles("public/garments/products/look-08.jpg");
  await expect.poll(() => initializations.length).toBe(2);
  expect(initializations[1].garment_id).not.toBe(originalId);
  await expect(page.locator(".garment-card")).toHaveCount(9);
  await page.locator("#fullFrameButton").click();
  await page.locator("#topCameraButton").click();
  await page.reload();
  await expect(page.locator(".garment-card")).toHaveCount(8);
  await expect(page.locator("#activeGarmentName")).toHaveText("Neural Look 03");
});

test("runtime journal locates delayed image delivery, exports numeric-only traces and survives reload", async ({ page }) => {
  await page.route("**/api/status", (route) => route.fulfill({ json: {
    ready: true, engine: "FLUX.2-klein-4B / FluxRT", output: "full-frame", gpu: "test GPU",
  } }));
  await page.route("**/api/diagnostics?**", (route) => route.fulfill({ json: { version: 1, events: [] } }));
  let socket, header;
  await page.routeWebSocket("**/api/stream", (connection) => {
    socket = connection;
    connection.onMessage((message) => {
      if (typeof message !== "string") return;
      const data = JSON.parse(message);
      if (data.type === "init") connection.send(JSON.stringify({ type: "ready", flow_control: "serial" }));
      else if (data.type === "frame") header = data;
    });
  });
  await page.goto("/studio");
  await page.locator("#fullFrameButton").click();
  await expect.poll(() => header?.id).toBe(1);
  const encoded = await page.evaluate(() => {
    const c = document.createElement("canvas"); c.width = c.height = 512;
    const ctx = c.getContext("2d"); ctx.fillStyle = "purple"; ctx.fillRect(0, 0, 512, 512);
    return c.toDataURL().split(",")[1];
  });
  socket.send(JSON.stringify({ type: "frame", id: 1, inference_ms: 100, service_ms: 120, queue_ms: 5 }));
  await page.waitForTimeout(1250);
  socket.send(Buffer.from(encoded, "base64"));
  await expect(page.locator("#generatedCanvas")).toHaveAttribute("data-frame-id", "1");
  await expect.poll(() => page.evaluate(() => window.__VTON_DEBUG__.fullFrame.log.events.some(event => event.event === "client_display"))).toBe(true);
  const snapshot = await page.evaluate(() => window.__VTON_DEBUG__.fullFrame.log.snapshot());
  const record = snapshot.events.find((event) => event.event === "client_display");
  expect(record.metrics.total_ms).toBeGreaterThan(1200);
  expect(record.metrics.header_to_payload_ms).toBeGreaterThan(1100);
  expect(record.metrics.inference_ms).toBe(100);
  expect(snapshot.summary.slow_frames).toBe(1);
  expect(JSON.stringify(snapshot)).not.toContain("data:image");
  expect(JSON.stringify(snapshot)).not.toContain("garment_image");
  for (const event of snapshot.events) for (const value of Object.values(event.metrics)) expect(["number", "boolean"]).toContain(typeof value);
  await expect(page.locator("#runtimeLogSummary")).toContainText("超1秒 1/1");
  await page.locator("#runtimeLogSummary").click();
  await expect(page.locator("#runtimeLogRows tr")).toHaveCount(1);
  const download = page.waitForEvent("download");
  await page.locator("#exportRuntimeLog").click();
  expect((await download).suggestedFilename()).toMatch(/^vton-runtime-.*\.json$/);
  await page.locator("#fullFrameButton").click();
  await page.reload();
  await expect(page.locator("#runtimeLogSummary")).toContainText("超1秒 1/1");
  await page.locator("#runtimeLogSummary").click();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
