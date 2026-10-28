const DEFAULT_API_URL = "http://127.0.0.1:8020";
const SETTINGS_KEY = "vton-catvton-api-url";

function normalizeImageDataUrl(value) {
  const encoded = String(value || "");
  if (!encoded) return null;
  if (encoded.startsWith("data:")) return encoded;
  return `data:image/png;base64,${encoded}`;
}

async function imageUrlToDataUrl(url, signal) {
  const response = await fetch(url, { signal, cache: "force-cache" });
  if (!response.ok) {
    throw new Error(`服装图片读取失败：HTTP ${response.status}`);
  }
  const blob = await response.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("服装图片编码失败"));
    reader.readAsDataURL(blob);
  });
}

export class CatVTONClient {
  constructor({ apiUrl } = {}) {
    this.apiUrl = (
      apiUrl ||
      localStorage.getItem(SETTINGS_KEY) ||
      import.meta.env.VITE_CATVTON_API_URL ||
      DEFAULT_API_URL
    ).replace(/\/+$/, "");
    this.garmentCache = new Map();
  }

  setApiUrl(value) {
    this.apiUrl = String(value || DEFAULT_API_URL).replace(/\/+$/, "");
    localStorage.setItem(SETTINGS_KEY, this.apiUrl);
  }

  async status({ signal } = {}) {
    const response = await fetch(`${this.apiUrl}/api/status`, {
      signal,
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(`CatVTON 状态异常：HTTP ${response.status}`);
    }
    return response.json();
  }

  async tryOn({
    personImage,
    garmentAsset,
    maskImage,
    steps = 8,
    guidanceScale = 2.5,
    seed = 42,
    responseFormat = "compact",
    signal,
  }) {
    if (!personImage || !maskImage) {
      throw new Error("缺少摄像头关键帧或服装掩码");
    }
    const startedAt = performance.now();
    let garmentImage = this.garmentCache.get(garmentAsset);
    if (!garmentImage) {
      garmentImage = await imageUrlToDataUrl(garmentAsset, signal);
      if (this.garmentCache.size >= 3) this.garmentCache.clear();
      this.garmentCache.set(garmentAsset, garmentImage);
    }
    const body = JSON.stringify({
      person_image: personImage, garment_image: garmentImage, mask_image: maskImage,
      width: 512, height: 768, steps, guidance_scale: guidanceScale, seed,
      response_format: responseFormat,
    });
    const response = await fetch(`${this.apiUrl}/api/tryon`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body,
    });
    if (!response.ok) {
      const errorText = await response.text();
      let detail = errorText;
      try {
        const payload = JSON.parse(errorText);
        detail =
          typeof payload.detail === "string"
            ? payload.detail
            : JSON.stringify(payload.detail ?? payload);
      } catch {}
      throw new Error(`CatVTON 推理失败：HTTP ${response.status} ${detail}`);
    }
    const responseText = await response.text();
    const result = JSON.parse(responseText);
    return {
      ...result,
      image: result.image ? normalizeImageDataUrl(result.image) : null,
      garment_layer: normalizeImageDataUrl(result.garment_layer),
      roundTripMs: performance.now() - startedAt,
      requestBytes: new TextEncoder().encode(body).byteLength,
      responseBytes: new TextEncoder().encode(responseText).byteLength,
    };
  }
}
