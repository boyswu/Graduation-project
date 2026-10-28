import { expect, test } from "@playwright/test";

test("home opens without camera, WebGL engine or GPU traffic and links to studio", async ({ page }) => {
  const requests = [], errors = [];
  page.on("request", request => requests.push(request.url()));
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("让下一件衣服");
  await page.getByRole("link", { name: "技术设计", exact: true }).click();
  await expect(page.locator("#technology")).toBeInViewport();
  expect(requests.some(url => /:802[012]|tryon-engine|tracking-worker|full-frame-client/.test(url))).toBe(false);
  expect(await page.evaluate(() => Boolean(window.__VTON_DEBUG__))).toBe(false);
  await expect(page.locator('a[href="/studio?demo=1"]')).toHaveCount(2);
  expect(errors).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("offline demo permits camera and garment upload without inference traffic", async ({ page }) => {
  const remote = [];
  page.on("request", request => { if (/:802[012]/.test(request.url())) remote.push(request.url()); });
  await page.goto("/studio?demo=1");
  await expect(page.locator("#serviceNoticeTitle")).toHaveText("免 GPU 交互演示");
  await page.locator("#startCameraButton").click();
  await expect(page.locator("#sourceValue")).toHaveText("CAMERA");
  await expect(page.locator("#generatedCanvas")).toBeHidden();
  await expect(page.locator("#previewModeLabel")).toContainText("本地相机");
  await page.locator("#openHelp").click();
  await expect(page.locator("#helpDialog")).toBeVisible();
  await page.getByRole("button", { name: "关闭使用帮助" }).click();
  await page.locator("#garmentUpload").setInputFiles("public/garments/products/look-07.jpg");
  await expect(page.locator("#garmentUploadStatus")).toContainText("自定义衣服已选择");
  expect(remote).toEqual([]);
  expect(await page.evaluate(() => window.__VTON_DEBUG__.fullFrame.running)).toBe(false);
  await expect(page.locator("#saveGeneratedFrame")).toBeDisabled();
  await page.locator("#topCameraButton").click();
  expect(await page.evaluate(() => window.__VTON_DEBUG__.engine.cameraStream)).toBeNull();
});

test("unavailable GPU keeps local preview and avoids stream retries", async ({ page }) => {
  let checks = 0, streams = 0;
  await page.route("**/api/status", route => { checks++; return route.fulfill({ status: 503, json: { ready: false } }); });
  await page.routeWebSocket("**/api/stream", () => { streams++; });
  await page.goto("/studio");
  await expect(page.locator("#serviceNoticeTitle")).toContainText("GPU 服务暂不可用");
  await page.locator("#startCameraButton").click();
  await expect(page.locator("#sourceValue")).toHaveText("CAMERA");
  await page.waitForTimeout(350);
  expect(streams).toBe(0);
  const before = checks;
  await page.waitForTimeout(500);
  expect(checks).toBe(before);
  await page.locator("#retryService").click();
  await expect.poll(() => checks).toBeGreaterThan(before);
  await page.locator("#topCameraButton").click();
});

test("a ready service does not receive camera frames until generation is requested", async ({ page }) => {
  await page.route("**/api/status", route => route.fulfill({ json: { ready: true, output: "full-frame", engine: "FLUX.2-klein-4B / FluxRT" } }));
  let connections = 0;
  await page.routeWebSocket("**/api/stream", socket => {
    connections++;
    socket.onMessage(message => {
      if (typeof message === "string" && JSON.parse(message).type === "init") socket.send(JSON.stringify({ type: "ready" }));
    });
  });
  await page.goto("/studio");
  await expect(page.locator("#serviceNoticeTitle")).toHaveText("AI 服务已就绪");
  await page.locator("#startCameraButton").click();
  await expect(page.locator("#sourceValue")).toHaveText("CAMERA");
  await page.waitForTimeout(300);
  expect(connections).toBe(0);
  await page.locator("#fullFrameButton").click();
  await expect.poll(() => connections).toBe(1);
  await page.locator("#fullFrameButton").click();
  await page.locator("#topCameraButton").click();
});

test("raw preview skips duplicate camera frames and hidden rendering stops", async ({ page }) => {
  await page.goto("/studio?demo=1");
  await page.locator("#startCameraButton").click();
  await expect(page.locator("#sourceValue")).toHaveText("CAMERA");
  await expect.poll(() => page.evaluate(() => window.__VTON_DEBUG__.engine.video.readyState)).toBeGreaterThanOrEqual(2);
  const result = await page.evaluate(() => {
    const engine = window.__VTON_DEBUG__.engine;
    engine.setPageVisible(false);
    cancelAnimationFrame(engine.renderRequest); clearTimeout(engine.renderTimer);
    engine.pageVisible = true;
    const schedule = engine.scheduleRender; engine.scheduleRender = () => {};
    const original = engine.drawVideo; let draws = 0;
    engine.drawVideo = (...args) => { draws++; original.apply(engine, args); };
    engine.lastRawPreviewToken = null;
    for (let i = 0; i < 60; i++) engine.loop(performance.now());
    const duplicateDraws = draws;
    engine.setPageVisible(false);
    for (let i = 0; i < 60; i++) engine.loop(performance.now());
    const hiddenDraws = draws - duplicateDraws;
    engine.drawVideo = original; engine.scheduleRender = schedule;
    engine.setPageVisible(true);
    return { duplicateDraws, hiddenDraws };
  });
  expect(result.duplicateDraws).toBe(1);
  expect(result.hiddenDraws).toBe(0);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator("#topCameraButton").click();
});

test("graduation downloads resolve as real files", async ({ request }) => {
  for (const name of ["毕业论文初稿.docx", "毕设配套材料.docx", "README.md"]) {
    const response = await request.get(`/graduation/${name}`);
    expect(response.ok()).toBe(true);
    const data = await response.body();
    if (name.endsWith(".docx")) expect(data.subarray(0, 2).toString()).toBe("PK");
    else expect(data.toString()).toContain("毕设材料");
  }
});

test("wardrobe search keeps the selected reference, focus and scroll position", async ({ page }) => {
  await page.goto("/studio?demo=1");
  await page.locator("#garmentSearch").fill("polo");
  await expect(page.locator(".garment-card")).toHaveCount(1);
  await page.locator('[data-id="neural-look-07"]').click();
  await expect(page.locator("#selectedReferenceName")).toHaveText("浅蓝藏青拼色 Polo");
  await expect(page.locator('[data-id="neural-look-07"]')).toBeFocused();
  await page.locator("#garmentSearch").fill("不存在的衣服");
  await expect(page.locator("#wardrobeEmpty")).toBeVisible();
  await expect(page.locator("#selectedReferenceName")).toHaveText("浅蓝藏青拼色 Polo");
  await page.locator("#garmentSearch").fill("");
  const card = page.locator('[data-id="neural-look-08"]');
  await card.focus();
  const before = await page.locator("#garmentList").evaluate(el => el.scrollTop);
  await card.press("Enter");
  await expect(card).toHaveAttribute("aria-pressed", "true");
  await expect(card).toBeFocused();
  expect(await page.locator("#garmentList").evaluate(el => el.scrollTop)).toBe(before);
  await page.locator('[data-filter="uploaded"]').click();
  await expect(page.locator("#wardrobeEmpty")).toContainText("还没有你的衣服");
  await expect(page.locator('[data-filter="uploaded"]')).toHaveAttribute("aria-pressed", "true");
});

test("dragged garments can be selected and removed without keeping their object URL", async ({ page }) => {
  await page.goto("/studio?demo=1");
  await page.locator('[data-filter="uploaded"]').click();
  await page.evaluate(async () => {
    const blob = await (await fetch("/garments/products/look-07.jpg")).blob();
    const transfer = new DataTransfer();
    transfer.items.add(new File([blob], "shirt.jpg", { type: "image/jpeg" }));
    document.querySelector("#garmentDropZone").dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
  });
  await expect(page.locator("#garmentUploadStatus")).toContainText("自定义衣服已选择");
  await expect(page.locator(".garment-card")).toHaveCount(9);
  await expect(page.locator('[data-filter="all"]')).toHaveAttribute("aria-pressed", "true");
  const oldUrl = await page.locator("#selectedReferenceImage").getAttribute("src");
  expect(oldUrl).toMatch(/^blob:/);
  await page.locator("#garmentUpload").setInputFiles({ name: "bad.txt", mimeType: "text/plain", buffer: Buffer.from("invalid") });
  await expect(page.locator("#garmentUploadStatus")).toContainText("请选择不超过");
  await expect(page.locator("#selectedReferenceImage")).toHaveAttribute("src", oldUrl);
  await page.locator("#removeUploadedGarment").click();
  await expect(page.locator("#selectedReferenceName")).toHaveText("神经样衣 03");
  await expect(page.locator(".garment-card")).toHaveCount(8);
  await expect(page.locator("#removeUploadedGarment")).toBeHidden();
  expect(await page.evaluate(async url => { try { await fetch(url); return false; } catch { return true; } }, oldUrl)).toBe(true);
});

test("focus and pause controls retain a local camera and report their actual states", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/studio?demo=1");
  await expect(page.locator("#fullFrameButton")).toBeDisabled();
  await page.locator("#startCameraButton").click();
  await expect(page.locator("#cameraEmptyState")).toBeHidden();
  await page.locator("#toggleFocusButton").click();
  await expect(page.locator(".control-panel")).toBeHidden();
  await expect(page.locator("#toggleFocusButton")).toHaveAttribute("aria-pressed", "true");
  expect(await page.evaluate(() => window.__VTON_DEBUG__.engine.cameraStream.getVideoTracks()[0].readyState)).toBe("live");
  await page.locator("#togglePauseButton").click();
  await expect(page.getByRole("button", { name: "恢复预览", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#pauseOverlay")).toBeVisible();
  await page.locator("#togglePauseButton").click();
  await expect(page.getByRole("button", { name: "暂停预览", exact: true })).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("Escape");
  await expect(page.locator(".control-panel")).toBeVisible();
  await page.locator("#topCameraButton").click();
  await expect(page.locator("#cameraEmptyState")).toBeVisible();
  await expect(page.locator("#previewModeLabel")).toContainText("非 AI 输出");
  expect(await page.evaluate(() => window.__VTON_DEBUG__.engine.video.srcObject)).toBeNull();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("idle mode draws no hidden mannequin and simultaneous camera starts share one request", async ({ page }) => {
  await page.goto("/studio?demo=1");
  await page.waitForFunction(() => Boolean(window.__VTON_DEBUG__));
  const result = await page.evaluate(async () => {
    const debug = window.__VTON_DEBUG__, engine = debug.engine;
    engine.setPageVisible(false); engine.pageVisible = true;
    const schedule = engine.scheduleRender, draw = engine.drawVideo;
    let draws = 0;
    engine.scheduleRender = () => {};
    engine.drawVideo = () => { draws++; };
    for (let i = 0; i < 60; i++) engine.loop(performance.now());
    engine.scheduleRender = schedule; engine.drawVideo = draw;
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    let requests = 0;
    navigator.mediaDevices.getUserMedia = constraints => { requests++; return getUserMedia(constraints); };
    await Promise.all([debug.startCamera(), debug.startCamera(), debug.startCamera()]);
    const track = engine.cameraStream.getVideoTracks()[0];
    debug.stopCamera();
    return { draws, requests, track: track.readyState, stream: engine.video.srcObject };
  });
  expect(result).toEqual({ draws: 0, requests: 1, track: "ended", stream: null });
});
