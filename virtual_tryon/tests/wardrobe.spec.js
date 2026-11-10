import { expect, test } from "@playwright/test";

async function openStudio(page) {
  await page.goto("/studio?demo=1");
  await page.waitForFunction(() => Boolean(window.__VTON_DEBUG__?.wardrobeReady));
  await page.evaluate(() => window.__VTON_DEBUG__.wardrobeReady);
}

test("multiple garments, names and favorites survive reload without starting camera or AI", async ({ page }) => {
  const requests = [], errors = [];
  page.on("request", request => { if (/:802[012]/.test(request.url())) requests.push(request.url()); });
  page.on("pageerror", error => errors.push(error.message));
  await openStudio(page);
  await page.locator("#garmentUpload").setInputFiles("public/garments/products/look-07.jpg");
  await expect(page.locator("#selectedReferenceMeta")).toContainText("本机衣柜");
  await page.locator("#garmentUpload").setInputFiles("public/garments/products/look-08.jpg");
  await expect(page.locator(".garment-card")).toHaveCount(10);
  await page.locator("#renameGarment").click();
  const name = '<img src=x onerror="window.injected=1">';
  await page.locator("#garmentName").fill(name);
  await page.locator("#renameForm").getByRole("button", { name: "保存名称", exact: true }).click();
  await expect(page.locator("#selectedReferenceName")).toHaveText(name);
  await page.locator("#favoriteGarment").click();
  await page.reload();
  await page.waitForFunction(() => Boolean(window.__VTON_DEBUG__?.wardrobeReady));
  await page.evaluate(() => window.__VTON_DEBUG__.wardrobeReady);
  await expect(page.locator("#selectedReferenceName")).toHaveText(name);
  await expect(page.locator("#favoriteGarment")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#wardrobeStorage")).toContainText("2/20");
  await page.locator('[data-filter="favorites"]').click();
  await expect(page.locator(".garment-card")).toHaveCount(1);
  await expect(page.locator(".garment-info strong")).toHaveText(name);
  expect(await page.evaluate(() => window.injected)).toBeUndefined();
  expect(await page.evaluate(() => window.__VTON_DEBUG__.engine.cameraStream)).toBeNull();
  expect(await page.evaluate(() => window.__VTON_DEBUG__.fullFrame.running)).toBe(false);
  expect(requests).toEqual([]); expect(errors).toEqual([]);
});

test("temporary upload can be saved later and removing a saved garment requires confirmation", async ({ page }) => {
  await openStudio(page);
  await page.locator("#saveUploads").uncheck();
  await page.locator("#garmentUpload").setInputFiles("public/garments/products/look-07.jpg");
  await expect(page.locator("#selectedReferenceMeta")).toContainText("临时上传");
  await page.reload();
  await expect(page.locator(".garment-card")).toHaveCount(8);
  await expect(page.locator("#saveUploads")).not.toBeChecked();
  await page.locator("#garmentUpload").setInputFiles("public/garments/products/look-08.jpg");
  await expect(page.locator("#saveGarment")).toBeVisible();
  await page.locator("#saveGarment").click();
  await expect(page.locator("#selectedReferenceMeta")).toContainText("本机衣柜");
  page.once("dialog", dialog => dialog.dismiss());
  await page.locator("#removeUploadedGarment").click();
  await expect(page.locator(".garment-card")).toHaveCount(9);
  page.once("dialog", dialog => dialog.accept());
  await page.locator("#removeUploadedGarment").click();
  await expect(page.locator(".garment-card")).toHaveCount(8);
  await page.reload();
  await expect(page.locator("#wardrobeStorage")).toContainText("0/20");
});

test("blocked storage retains a usable temporary garment and reports that it was not saved", async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, "indexedDB", { get() { throw new DOMException("Storage disabled", "SecurityError"); } }));
  await openStudio(page);
  await page.locator("#garmentUpload").setInputFiles("public/garments/products/look-07.jpg");
  await expect(page.locator("#selectedReferenceName")).toHaveText("look-07");
  await expect(page.locator("#selectedReferenceMeta")).toContainText("临时上传");
  await expect(page.locator("#garmentUploadStatus")).toContainText("仍可临时试穿");
  await expect(page.locator("#wardrobeStorage")).toHaveAttribute("data-error", "true");
  await page.reload();
  await expect(page.locator(".garment-card")).toHaveCount(8);
});

test("preferences persist and reset keeps garments and favorites", async ({ page }) => {
  await openStudio(page);
  await page.locator("#garmentUpload").setInputFiles("public/garments/products/look-07.jpg");
  await expect(page.locator("#selectedReferenceMeta")).toContainText("本机衣柜");
  await page.locator("#favoriteGarment").click();
  await page.locator("#fullFrameDisplay").selectOption("low-latency");
  await page.locator("#fullFrameProfile").selectOption("detail");
  await page.locator("#openPreferences").click();
  await page.locator("#rememberSelection").uncheck();
  await page.locator("#closePreferences").click();
  await page.reload();
  await expect(page.locator("#fullFrameDisplay")).toHaveValue("low-latency");
  await expect(page.locator("#fullFrameProfile")).toHaveValue("detail");
  await expect(page.locator("#selectedReferenceName")).toHaveText("神经样衣 03");
  await page.locator("#openPreferences").click();
  await expect(page.locator("#rememberSelection")).not.toBeChecked();
  await page.locator("#resetPreferences").click();
  await page.locator("#closePreferences").click();
  await expect(page.locator("#fullFrameProfile")).toHaveValue("fast");
  await expect(page.locator("#fullFrameDisplay")).toHaveValue("smooth");
  await expect(page.locator("#wardrobeStorage")).toContainText("1/20");
  await page.locator('[data-filter="favorites"]').click();
  await expect(page.locator(".garment-card")).toHaveCount(1);
});

test("camera denial has an actionable guide and mobile dialogs do not overflow", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 780 });
  await openStudio(page);
  await page.evaluate(() => { window.__VTON_DEBUG__.engine.startCamera = async () => { throw new DOMException("Denied", "NotAllowedError"); }; });
  await page.locator("#nextStepAction").click();
  await expect(page.locator("#nextStepDetail")).toContainText("网站权限");
  await expect(page.locator("#nextStepAction")).toHaveText("重试摄像头");
  await page.locator("#openPreferences").click();
  const bounds = await page.locator("#preferencesDialog").evaluate(el => ({ scroll: el.scrollWidth, client: el.clientWidth }));
  expect(bounds.scroll).toBeLessThanOrEqual(bounds.client + 1);
  await page.locator("#closePreferences").click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.evaluate(() => window.__VTON_DEBUG__.engine.cameraStream)).toBeNull();
});
