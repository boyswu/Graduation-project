// Dedicated encoding avoids HTMLCanvasElement.toBlob's main-thread idle scheduling.
const canvas = new OffscreenCanvas(512, 512);
const ctx = canvas.getContext("2d", { alpha: false, willReadFrequently: true });

self.onmessage = async ({ data: { id, frame } }) => {
  const started = performance.now();
  try {
    const width = frame.displayWidth || frame.width, height = frame.displayHeight || frame.height;
    const scale = Math.min(512 / width, 512 / height);
    const content_width = width * scale, content_height = height * scale;
    const content_x = (512 - content_width) / 2, content_y = (512 - content_height) / 2;
    ctx.fillStyle = "white"; ctx.fillRect(0, 0, 512, 512);
    ctx.drawImage(frame, content_x, content_y, content_width, content_height);
    frame.close();
    const drawn = performance.now();
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.9 });
    self.postMessage({ id, blob, worker_draw_ms: drawn - started,
      input_width: canvas.width, input_height: canvas.height,
      content_x, content_y, content_width, content_height,
      worker_encode_ms: performance.now() - drawn, worker_total_ms: performance.now() - started });
  } catch { frame.close(); self.postMessage({ id, error: true }); }
};
