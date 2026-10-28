class LowPassFilter {
  constructor() {
    this.value = null;
  }

  filter(value, alpha) {
    this.value = this.value === null ? value : this.value + alpha * (value - this.value);
    return this.value;
  }
}

class ScalarOneEuro {
  constructor({ minCutoff = 2.3, beta = 6, derivativeCutoff = 1 } = {}) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.derivativeCutoff = derivativeCutoff;
    this.x = new LowPassFilter();
    this.dx = new LowPassFilter();
    this.lastTime = null;
    this.lastValue = null;
  }

  setResponse(response) {
    const normalized = Math.max(0, Math.min(1, response));
    this.minCutoff = 4.5 - normalized * 3.8;
    // Landmarks are normalized to 0..1. Pixel-scale beta values kept the
    // cutoff nearly constant even on large movements, adding visible lag.
    this.beta = 11 - normalized * 8.5;
  }

  filter(value, timestampMs) {
    if (!Number.isFinite(value)) return 0;

    if (this.lastTime === null) {
      this.lastTime = timestampMs;
      this.lastValue = value;
      this.x.filter(value, 1);
      return value;
    }

    const dt = Math.max(0.001, (timestampMs - this.lastTime) / 1000);
    const derivative = (value - this.lastValue) / dt;
    const edx = this.dx.filter(derivative, this.alpha(this.derivativeCutoff, dt));
    const cutoff = this.minCutoff + this.beta * Math.abs(edx);
    const result = this.x.filter(value, this.alpha(cutoff, dt));

    this.lastTime = timestampMs;
    this.lastValue = value;
    return result;
  }

  alpha(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }
}

export class LandmarkSmoother {
  constructor(landmarkCount = 33) {
    this.filters = Array.from({ length: landmarkCount }, () => ({
      x: new ScalarOneEuro(),
      y: new ScalarOneEuro(),
      z: new ScalarOneEuro(),
      visibility: new LowPassFilter(),
    }));
  }

  setResponse(response) {
    for (const point of this.filters) {
      point.x.setResponse(response);
      point.y.setResponse(response);
      point.z.setResponse(response);
    }
  }

  filter(landmarks, timestampMs) {
    if (!landmarks?.length) return null;

    return landmarks.map((landmark, index) => {
      const point = this.filters[index];
      if (!point) return { ...landmark };
      return {
        x: point.x.filter(landmark.x, timestampMs),
        y: point.y.filter(landmark.y, timestampMs),
        z: point.z.filter(landmark.z ?? 0, timestampMs),
        visibility: point.visibility.filter(landmark.visibility ?? 1, 0.35) ?? 1,
      };
    });
  }
}
