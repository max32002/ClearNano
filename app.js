/**
 * ClearNano - Gemini Nano Banana Watermark Remover
 * Uses Reverse Alpha Blending to restore original pixels
 *
 * Formula: Pixel_original = (Pixel_final - (α * Pixel_logo)) / (1 - α)
 *
 * Optimisations applied:
 *   1. Spatial-correlation (Pearson) replaces brightness heuristic for config detection
 *   2. Near-official size projection for non-catalog dimensions
 *   3. v2 small variant support (36px logo) — mask generated at runtime
 *   4. Web Worker offloads reverseAlphaBlend off the main thread
 *   5. Parallel batch processing (up to 4 images concurrently)
 *   6. Output format preserved: PNG→PNG, WebP→WebP, JPEG→JPEG
 *   7. Mask load failure gracefully falls back to same-size standard mask
 */

/**
 * Official Gemini image size catalog mapped to watermark configs.
 * Updated to reflect changes as of 2026-06 (v1.0.15–v1.0.17):
 *   - gemini-3.x-image 1k tier  → 48px logo, 32px margin
 *   - gemini-3.x-image 2k tier  → 96px logo, 64px margin
 *   - 2816×1536 (2k-new-margin)  → 96px logo, 192px margin, new alpha map
 *   - 1408×768 (fixed variant)   → 48px logo, 32px margin (46px actual, approximate)
 *   - gemini-2.5-flash-image 1k  → 48px logo, 32px margin
 */
const OFFICIAL_SIZE_CONFIGS = (() => {
  const m = new Map();
  const add = (w, h, size, margin, maskKey) =>
    m.set(`${w}x${h}`, { size, margin, maskKey: maskKey || size });

  // 0.5k tier — 48px logo, margin 32
  for (const [w, h] of [
    [512,512],[256,1024],[192,1536],[424,632],[632,424],
    [448,600],[1024,256],[600,448],[464,576],[576,464],
    [1536,192],[384,688],[688,384],[792,168]
  ]) add(w, h, 48, 32);

  // 1k tier — 48px logo, margin 32
  for (const [w, h] of [
    [1024,1024],[512,2048],[384,3072],[848,1264],[1264,848],
    [896,1200],[1200,896],[928,1152],[1152,928],[3072,384],
    [768,1376],[1376,768],[1584,672]
  ]) add(w, h, 48, 32);
  add(1408, 768, 48, 32); // fixed: exact logo is 46px, 48px mask used as approximation

  // 2k tier — 96px logo, margin 64
  for (const [w, h] of [
    [2048,2048],[1024,4096],[768,6144],[1696,2528],[2528,1696],
    [1792,2400],[4096,1024],[2400,1792],[1856,2304],[2304,1856],
    [6144,768],[1536,2752],[2752,1536],[3168,1344]
  ]) add(w, h, 96, 64);
  // 2k-new-margin: 2816×1536 uses 192px margin and updated alpha map (since 2026-05-20)
  add(2816, 1536, 96, 192, '96_20260520');

  // 4k tier — 96px logo, margin 64
  for (const [w, h] of [
    [4096,4096],[2048,8192],[1536,12288],[3392,5056],[5056,3392],
    [3584,4800],[8192,2048],[4800,3584],[3712,4608],[4608,3712],
    [12288,1536],[3072,5504],[5504,3072],[6336,2688]
  ]) add(w, h, 96, 64);

  // gemini-2.5-flash-image 1k — 48px logo, margin 32
  for (const [w, h] of [
    [832,1248],[1248,832],[864,1184],[1184,864],
    [768,1344],[1344,768],[1536,672]
  ]) add(w, h, 48, 32);

  return m;
})();

class ClearNano {
  constructor() {
    // Watermark mask configurations.
    // bg_96_20260520.png is the updated alpha map for 2816×1536 (2k-new-margin, since 2026-05-20).
    this.masks = {
      48: { path: "assets/bg_48.png", size: 48 },
      96: { path: "assets/bg_96.png", size: 96 },
      '96_20260520': { path: "assets/bg_96_20260520.png", size: 96 },
    };

    // Loaded mask data (keyed by maskKey string/number)
    this.loadedMasks = {};

    // Web Worker for off-thread pixel processing (null = fallback to main thread)
    this.worker = null;
    this.workerCallId = 0;

    // Output format: 'image/jpeg' (default) or 'image/png'
    this.outputFormat = "image/jpeg";

    // Theme: 'auto' | 'light' | 'dark'
    this.currentTheme = 'auto';

    // Processed images storage
    this.processedImages = [];

    // DOM Elements
    this.dropZone = document.getElementById("dropZone");
    this.fileInput = document.getElementById("fileInput");
    this.statusSection = document.getElementById("statusSection");
    this.statusText = document.getElementById("statusText");
    this.resultsSection = document.getElementById("resultsSection");
    this.resultsGrid = document.getElementById("resultsGrid");
    this.clearAllBtn = document.getElementById("clearAllBtn");
    this.downloadAllBtn = document.getElementById("downloadAllBtn");
    this.previewModal = document.getElementById("previewModal");
    this.modalOverlay = document.getElementById("modalOverlay");
    this.modalClose = document.getElementById("modalClose");
    this.modalViewport = document.getElementById("modalViewport");
    this.previewImage = document.getElementById("previewImage");
    this.modalTabs = document.querySelectorAll(".modal-tab");

    this.currentPreview = null;
    this.isZoomed = false;

    this.init();
  }

  async init() {
    this.initTheme();
    await this.loadMasks();
    this.initWorker();
    this.setupEventListeners();
    console.log("ClearNano initialized successfully");
  }

  // ---------------------------------------------------------------------------
  // Theme management
  // ---------------------------------------------------------------------------

  initTheme() {
    const saved = localStorage.getItem('cn-theme');
    this.setTheme(saved || 'auto', false);

    // Listen for system preference changes (only matters in 'auto' mode)
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (this.currentTheme === 'auto') this.applyThemeClass('auto');
    });
  }

  setTheme(value, save = true) {
    this.currentTheme = value;
    if (save) localStorage.setItem('cn-theme', value);
    this.applyThemeClass(value);
    document.querySelectorAll('.theme-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.themeValue === value);
    });
  }

  applyThemeClass(value) {
    const root = document.documentElement;
    root.classList.remove('light-theme', 'dark-theme');
    if (value === 'light') root.classList.add('light-theme');
    if (value === 'dark')  root.classList.add('dark-theme');
    // 'auto' → no class; CSS media query handles it
  }

  // ---------------------------------------------------------------------------
  // Mask loading
  // ---------------------------------------------------------------------------

  async loadMasks() {
    // If a variant mask fails, fall back to the standard mask of the same size.
    const FALLBACKS = { '96_20260520': 96 };

    for (const [key, config] of Object.entries(this.masks)) {
      try {
        const img = new Image();
        img.crossOrigin = "anonymous";
        await new Promise((resolve, reject) => {
          img.onload = resolve;
          img.onerror = reject;
          img.src = config.path;
        });

        const canvas = document.createElement("canvas");
        canvas.width = config.size;
        canvas.height = config.size;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0);

        const imageData = ctx.getImageData(0, 0, config.size, config.size);
        this.loadedMasks[key] = { data: imageData.data, width: config.size, height: config.size };
        console.log(`Loaded mask: ${key} (${config.size}x${config.size})`);
      } catch (error) {
        const fallbackKey = FALLBACKS[key];
        if (fallbackKey != null && this.loadedMasks[fallbackKey]) {
          this.loadedMasks[key] = this.loadedMasks[fallbackKey];
          console.warn(`Mask ${key} failed to load — using fallback mask ${fallbackKey}`);
        } else {
          console.error(`Failed to load mask ${key}:`, error);
        }
      }
    }

    // Generate 36px v2 mask at runtime by scaling down the 48px mask.
    // Used for the v2-small watermark variant (logoSize 36, margin ~96px).
    if (this.loadedMasks[48]) {
      const scaled = this.generateScaledMask(48, 36);
      if (scaled) this.loadedMasks['36_v2'] = scaled;
    }
  }

  generateScaledMask(fromKey, toSize) {
    const source = this.loadedMasks[fromKey];
    if (!source) return null;

    // Draw the source mask into a temporary canvas, then scale it down.
    const srcCanvas = document.createElement("canvas");
    srcCanvas.width = source.width;
    srcCanvas.height = source.height;
    const srcCtx = srcCanvas.getContext("2d");
    srcCtx.putImageData(
      new ImageData(new Uint8ClampedArray(source.data), source.width, source.height),
      0, 0
    );

    const dstCanvas = document.createElement("canvas");
    dstCanvas.width = toSize;
    dstCanvas.height = toSize;
    const dstCtx = dstCanvas.getContext("2d");
    dstCtx.imageSmoothingEnabled = true;
    dstCtx.imageSmoothingQuality = "high";
    dstCtx.drawImage(srcCanvas, 0, 0, toSize, toSize);

    const imageData = dstCtx.getImageData(0, 0, toSize, toSize);
    return { data: imageData.data, width: toSize, height: toSize };
  }

  // ---------------------------------------------------------------------------
  // Web Worker
  // ---------------------------------------------------------------------------

  initWorker() {
    if (typeof Worker === "undefined") return;
    try {
      this.worker = new Worker("workers/watermark-worker.js");
      this.worker.onerror = (e) => {
        console.warn("Watermark worker error — falling back to main thread:", e);
        this.worker = null;
      };
    } catch (e) {
      console.warn("Could not initialize watermark worker:", e);
      this.worker = null;
    }
  }

  async processWithWorker(imageData, mask) {
    return new Promise((resolve, reject) => {
      const callId = ++this.workerCallId;
      // Copy buffers — originals must not be detached before putImageData
      const pixelsBuf = new Uint8ClampedArray(imageData.data).buffer;
      const maskBuf   = new Uint8ClampedArray(mask.data).buffer;

      const onMessage = (e) => {
        if (e.data.id !== callId) return;
        this.worker.removeEventListener("message", onMessage);
        this.worker.removeEventListener("error",   onError);
        if (e.data.error) {
          reject(new Error(e.data.error));
        } else {
          imageData.data.set(new Uint8ClampedArray(e.data.pixels));
          resolve();
        }
      };
      const onError = (e) => {
        this.worker.removeEventListener("message", onMessage);
        this.worker.removeEventListener("error",   onError);
        reject(new Error(`Worker error: ${e.message}`));
      };

      this.worker.addEventListener("message", onMessage);
      this.worker.addEventListener("error",   onError);
      this.worker.postMessage(
        { id: callId, pixels: pixelsBuf, maskPixels: maskBuf },
        [pixelsBuf, maskBuf]
      );
    });
  }

  setupEventListeners() {
    // Drop zone events
    this.dropZone.addEventListener("click", () => this.fileInput.click());
    this.dropZone.addEventListener("dragover", (e) => this.handleDragOver(e));
    this.dropZone.addEventListener("dragleave", (e) => this.handleDragLeave(e));
    this.dropZone.addEventListener("drop", (e) => this.handleDrop(e));

    // File input change
    this.fileInput.addEventListener("change", (e) => this.handleFileSelect(e));

    // Clear all button
    this.clearAllBtn.addEventListener("click", () => this.clearAll());

    // Download all button
    this.downloadAllBtn.addEventListener("click", () => this.downloadAll());

    // Modal events
    this.modalOverlay.addEventListener("click", () => this.closeModal());
    this.modalClose.addEventListener("click", () => this.closeModal());
    this.modalViewport.addEventListener("click", (e) => this.toggleZoom(e));

    // Modal tabs
    this.modalTabs.forEach((tab) => {
      tab.addEventListener("click", (e) => this.handleTabClick(e));
    });

    // Keyboard events
    document.addEventListener("keydown", (e) => {
      if (
        e.key === "Escape" &&
        this.previewModal.classList.contains("active")
      ) {
        this.closeModal();
      }
    });

    // Output format toggle
    document.getElementById("formatToggle").addEventListener("click", (e) => {
      const btn = e.target.closest(".format-btn");
      if (!btn) return;
      document.querySelectorAll(".format-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      this.outputFormat = btn.dataset.format;
    });

    // Theme toggle
    document.getElementById("themeToggle").addEventListener("click", (e) => {
      const btn = e.target.closest(".theme-btn");
      if (!btn) return;
      this.setTheme(btn.dataset.themeValue);
    });
  }

  handleDragOver(e) {
    e.preventDefault();
    e.stopPropagation();
    this.dropZone.classList.add("drag-over");
  }

  handleDragLeave(e) {
    e.preventDefault();
    e.stopPropagation();
    this.dropZone.classList.remove("drag-over");
  }

  handleDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    this.dropZone.classList.remove("drag-over");

    const files = Array.from(e.dataTransfer.files).filter((file) =>
      file.type.startsWith("image/")
    );

    if (files.length > 0) {
      this.processFiles(files);
    }
  }

  handleFileSelect(e) {
    const files = Array.from(e.target.files);
    if (files.length > 0) {
      this.processFiles(files);
    }
    // Reset input
    e.target.value = "";
  }

  // ---------------------------------------------------------------------------
  // File processing
  // ---------------------------------------------------------------------------

  async processFiles(files) {
    this.showStatus(`處理中... (0/${files.length})`);
    let completed = 0;
    const CONCURRENCY = 4;

    const processOne = async (file) => {
      try {
        const result = await this.processImage(file);
        completed++;
        this.updateStatus(`處理中... (${completed}/${files.length})`);
        return result;
      } catch (error) {
        completed++;
        this.updateStatus(`處理中... (${completed}/${files.length})`);
        console.error(`Failed to process ${file.name}:`, error);
        return { filename: file.name, error: error.message, originalUrl: null, processedUrl: null };
      }
    };

    // Process in batches of CONCURRENCY; display results as each batch finishes.
    for (let i = 0; i < files.length; i += CONCURRENCY) {
      const batch = files.slice(i, i + CONCURRENCY);
      const batchResults = await Promise.all(batch.map(processOne));

      for (const result of batchResults) {
        if (!result.error) this.processedImages.push(result);
        this.addResultCard(result);
      }
      if (i === 0) this.showResults();
    }

    this.hideStatus();
  }

  async processImage(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();

      reader.onload = async (e) => {
        try {
          const img = new Image();
          await new Promise((res, rej) => {
            img.onload = res;
            img.onerror = rej;
            img.src = e.target.result;
          });

          const canvas = document.createElement("canvas");
          canvas.width  = img.naturalWidth;
          canvas.height = img.naturalHeight;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0);

          // Resolve best watermark config using spatial correlation
          const watermarkConfig = this.detectBestConfig(ctx, img.naturalWidth, img.naturalHeight);

          const mask = this.loadedMasks[watermarkConfig.maskKey || watermarkConfig.size];
          if (!mask) {
            throw new Error(
              `No suitable mask found for image size ${img.naturalWidth}x${img.naturalHeight}`
            );
          }

          const startX = img.naturalWidth  - watermarkConfig.margin - watermarkConfig.size;
          const startY = img.naturalHeight - watermarkConfig.margin - watermarkConfig.size;

          const imageData = ctx.getImageData(startX, startY, mask.width, mask.height);

          // Use Worker when available, fall back to main thread
          if (this.worker) {
            try {
              await this.processWithWorker(imageData, mask);
            } catch (workerErr) {
              console.warn("Worker failed, falling back to main thread:", workerErr);
              this.worker = null;
              this.reverseAlphaBlend(imageData, mask);
            }
          } else {
            this.reverseAlphaBlend(imageData, mask);
          }

          ctx.putImageData(imageData, startX, startY);

          // Use the user-selected output format; JPEG uses 0.92 quality
          const outputMime    = this.outputFormat;
          const outputQuality = outputMime === "image/jpeg" ? 0.92 : undefined;
          const blob = await new Promise((res) =>
            canvas.toBlob(res, outputMime, outputQuality)
          );
          const processedUrl = URL.createObjectURL(blob);

          resolve({
            filename: file.name,
            originalUrl: e.target.result,
            processedUrl,
            blob,
            width:      img.naturalWidth,
            height:     img.naturalHeight,
            maskSize:   watermarkConfig.size,
            margin:     watermarkConfig.margin,
            outputMime,
            error: null,
          });
        } catch (error) {
          reject(error);
        }
      };

      reader.onerror = () => reject(new Error("Failed to read file"));
      reader.readAsDataURL(file);
    });
  }

  // ---------------------------------------------------------------------------
  // Watermark config detection
  // ---------------------------------------------------------------------------

  getWatermarkConfig(width, height) {
    /**
     * Priority order:
     * 1. Exact official Gemini size catalog
     * 2. Near-official projection (scaled non-catalog dimensions)
     * 3. Historical heuristic fallback
     */
    const official = OFFICIAL_SIZE_CONFIGS.get(`${width}x${height}`);
    if (official) return { ...official };

    const projected = this.projectNearOfficialConfig(width, height);
    if (projected) return projected;

    if (width > 1024 && height > 1024) return { size: 96, margin: 64,  maskKey: 96 };
    return                                       { size: 48, margin: 32,  maskKey: 48 };
  }

  /**
   * For non-catalog sizes (screenshots, compressed exports, etc.), find the
   * closest official size by aspect ratio and project the margin proportionally.
   * Mirrors the near-official projection logic in upstream geminiSizeCatalog.js.
   */
  projectNearOfficialConfig(width, height) {
    const targetRatio   = width / height;
    const MAX_RATIO_DELTA  = 0.02;
    const MAX_SCALE_MISMATCH = 0.12;

    let best = null;
    let bestScore = Infinity;

    for (const [key, config] of OFFICIAL_SIZE_CONFIGS) {
      const [ow, oh]    = key.split("x").map(Number);
      const entryRatio  = ow / oh;
      const ratioDelta  = Math.abs(targetRatio - entryRatio) / entryRatio;
      if (ratioDelta > MAX_RATIO_DELTA) continue;

      const scaleX       = width  / ow;
      const scaleY       = height / oh;
      const scaleMismatch = Math.abs(scaleX - scaleY) / Math.max(scaleX, scaleY);
      if (scaleMismatch > MAX_SCALE_MISMATCH) continue;

      const avgScale = (scaleX + scaleY) / 2;
      const score    = ratioDelta * 100 + scaleMismatch * 20
                     + Math.abs(Math.log2(Math.max(avgScale, 1e-6)));
      if (score < bestScore) {
        bestScore = score;
        best = { config, scaleX, scaleY };
      }
    }

    if (!best) return null;

    const { config, scaleX, scaleY } = best;
    const margin = Math.max(8, Math.round(config.margin * (scaleX + scaleY) / 2));
    return { size: config.size, margin, maskKey: config.maskKey || config.size };
  }

  /**
   * Build candidate watermark configs for a given image, then pick the best one
   * via Pearson spatial correlation between the candidate region and the mask.
   *
   * Candidates tested (for 48px-tier images):
   *   a) Standard:      48px logo, 32px margin
   *   b) Large-margin:  48px logo, 96px margin  (observed since 2026-06-07)
   *   c) v2-small:      36px logo, 96px margin  (v2 variant)
   */
  detectBestConfig(ctx, imageWidth, imageHeight) {
    const defaultConfig = this.getWatermarkConfig(imageWidth, imageHeight);
    if (defaultConfig.size > 48) return defaultConfig; // 96px configs are exact-match only

    const candidates = [defaultConfig];

    // Large-margin variant
    const largeMargin = { size: 48, margin: 96, maskKey: 48 };
    if (imageWidth - 96 - 48 >= 0 && imageHeight - 96 - 48 >= 0) {
      candidates.push(largeMargin);
    }

    // v2-small variant (36px mask generated from 48px at runtime)
    if (this.loadedMasks["36_v2"]) {
      const v2Small = { size: 36, margin: 96, maskKey: "36_v2" };
      if (imageWidth - 96 - 36 >= 0 && imageHeight - 96 - 36 >= 0) {
        candidates.push(v2Small);
      }
    }

    if (candidates.length === 1) return defaultConfig;

    let bestConfig = defaultConfig;
    let bestScore  = -Infinity;

    for (const candidate of candidates) {
      const mask = this.loadedMasks[candidate.maskKey || candidate.size];
      if (!mask) continue;

      const sx = imageWidth  - candidate.margin - candidate.size;
      const sy = imageHeight - candidate.margin - candidate.size;
      if (sx < 0 || sy < 0) continue;

      const region = ctx.getImageData(sx, sy, candidate.size, candidate.size);
      const score  = this.computeSpatialCorrelation(region.data, mask.data);

      if (score > bestScore) {
        bestScore  = score;
        bestConfig = candidate;
      }
    }

    return bestConfig;
  }

  /**
   * Pearson correlation between image-region brightness and mask alpha.
   * A high value (→ 1) means the bright pixels align with the mask shape,
   * indicating the watermark is present at this position.
   * Avoids false positives on uniformly bright backgrounds.
   */
  computeSpatialCorrelation(regionData, maskData) {
    let sumX = 0, sumY = 0, sumXX = 0, sumYY = 0, sumXY = 0, n = 0;

    for (let i = 0; i < regionData.length; i += 4) {
      const maskAlpha = Math.max(maskData[i], maskData[i + 1], maskData[i + 2]) / 255;
      if (maskAlpha < 0.05) continue; // ignore fully-transparent mask pixels

      const brightness = (regionData[i] + regionData[i + 1] + regionData[i + 2]) / (3 * 255);
      sumX  += brightness;
      sumY  += maskAlpha;
      sumXX += brightness * brightness;
      sumYY += maskAlpha  * maskAlpha;
      sumXY += brightness * maskAlpha;
      n++;
    }

    if (n < 10) return 0;

    const meanX = sumX / n;
    const meanY = sumY / n;
    const varX  = sumXX / n - meanX * meanX;
    const varY  = sumYY / n - meanY * meanY;

    if (varX < 1e-10 || varY < 1e-10) return 0; // constant region — can't correlate

    return (sumXY / n - meanX * meanY) / Math.sqrt(varX * varY);
  }

  reverseAlphaBlend(imageData, mask) {
    /**
     * Reverse Alpha Blending Formula:
     * Pixel_original = (Pixel_final - (α * 255)) / (1 - α)
     *
     * Where:
     * - Pixel_final: The watermarked pixel (what we have)
     * - α: The alpha value calculated from mask's RGB grayscale
     * - Pixel_original: What we want to recover
     *
     * IMPORTANT: The mask stores alpha as RGB grayscale values, NOT in the alpha channel.
     * Alpha = max(R, G, B) / 255
     */

    const data = imageData.data;
    const maskData = mask.data;

    // Maximum alpha threshold to prevent artifacts (based on reference implementation)
    const MAX_ALPHA = 0.99;

    for (let i = 0; i < data.length; i += 4) {
      // Calculate alpha from mask's RGB channels (grayscale value)
      // The mask uses RGB to store the alpha map, not the alpha channel
      const maskR = maskData[i];
      const maskG = maskData[i + 1];
      const maskB = maskData[i + 2];
      const maxChannel = Math.max(maskR, maskG, maskB);
      
      // Normalize to 0-1 range
      let alpha = maxChannel / 255.0;

      // Skip if mask is fully transparent (black)
      if (alpha === 0) continue;

      // Clamp alpha to prevent division issues
      alpha = Math.min(alpha, MAX_ALPHA);

      // Current (watermarked) pixel values
      const finalR = data[i];
      const finalG = data[i + 1];
      const finalB = data[i + 2];

      // Reverse alpha blending
      // Formula: original = (watermarked - α × 255) / (1 - α)
      const oneMinusAlpha = 1.0 - alpha;

      data[i] = this.clamp(Math.round((finalR - alpha * 255) / oneMinusAlpha));
      data[i + 1] = this.clamp(Math.round((finalG - alpha * 255) / oneMinusAlpha));
      data[i + 2] = this.clamp(Math.round((finalB - alpha * 255) / oneMinusAlpha));
      // Alpha channel remains unchanged
    }
  }

  clamp(value) {
    return Math.max(0, Math.min(255, value));
  }

  addResultCard(result) {
    const card = document.createElement("div");
    card.className = "result-card";
    card.style.animationDelay = `${this.processedImages.length * 0.05}s`;

    const isError = !!result.error;
    const displayImage = isError ? "" : result.processedUrl;

    card.innerHTML = `
            <div class="result-image-container" ${
              !isError
                ? 'data-index="' + (this.processedImages.length - 1) + '"'
                : ""
            }>
                ${
                  !isError
                    ? `
                    <img src="${displayImage}" alt="${result.filename}" class="result-image">
                    <div class="result-overlay">
                        <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <circle cx="11" cy="11" r="8" stroke="currentColor" stroke-width="2"/>
                            <path d="M21 21L16.65 16.65" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                            <path d="M11 8V14M8 11H14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                        </svg>
                    </div>
                `
                    : `
                    <div style="display: flex; align-items: center; justify-content: center; height: 100%; background: var(--color-bg-secondary);">
                        <svg viewBox="0 0 24 24" fill="none" width="48" height="48" xmlns="http://www.w3.org/2000/svg">
                            <circle cx="12" cy="12" r="10" stroke="var(--color-error)" stroke-width="2"/>
                            <path d="M15 9L9 15M9 9L15 15" stroke="var(--color-error)" stroke-width="2" stroke-linecap="round"/>
                        </svg>
                    </div>
                `
                }
            </div>
            <div class="result-info">
                <p class="result-filename" title="${result.filename}">${
      result.filename
    }</p>
                <div class="result-meta">
                    ${
                      !isError
                        ? `
                        <span>${result.width} × ${result.height}</span>
                        <span class="result-status success">
                            <svg viewBox="0 0 24 24" fill="none" width="14" height="14" xmlns="http://www.w3.org/2000/svg">
                                <path d="M20 6L9 17L4 12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                            </svg>
                            ${result.maskSize}px / ${result.margin}px margin
                        </span>
                    `
                        : `
                        <span class="result-status error">
                            <svg viewBox="0 0 24 24" fill="none" width="14" height="14" xmlns="http://www.w3.org/2000/svg">
                                <path d="M18 6L6 18M6 6L18 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                            </svg>
                            處理失敗
                        </span>
                    `
                    }
                </div>
            </div>
            ${
              !isError
                ? `
                <div class="result-actions">
                    <button class="btn btn-secondary download-btn" data-index="${
                      this.processedImages.length - 1
                    }">
                        <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                            <path d="M21 15V19C21 19.5304 20.7893 20.0391 20.4142 20.4142C20.0391 20.7893 19.5304 21 19 21H5C4.46957 21 3.96086 20.7893 3.58579 20.4142C3.21071 20.0391 3 19.5304 3 19V15" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                            <polyline points="7,10 12,15 17,10" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                            <line x1="12" y1="15" x2="12" y2="3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                        </svg>
                        下載
                    </button>
                </div>
            `
                : ""
            }
        `;

    // Add event listeners
    if (!isError) {
      const imageContainer = card.querySelector(".result-image-container");
      imageContainer.addEventListener("click", () =>
        this.openPreview(this.processedImages.length - 1)
      );

      const downloadBtn = card.querySelector(".download-btn");
      downloadBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.downloadImage(parseInt(e.currentTarget.dataset.index));
      });
    }

    this.resultsGrid.appendChild(card);
  }

  openPreview(index) {
    const result = this.processedImages[index];
    if (!result) return;

    this.currentPreview = result;
    this.previewImage.src = result.processedUrl;

    // Reset zoom
    this.isZoomed = false;
    this.modalViewport.classList.remove("zoomed");

    // Reset tabs
    this.modalTabs.forEach((tab) => tab.classList.remove("active"));
    this.modalTabs[1].classList.add("active"); // Default to "After"

    this.previewModal.classList.add("active");
  }

  toggleZoom(e) {
    if (!this.currentPreview) return;

    this.isZoomed = !this.isZoomed;
    this.modalViewport.classList.toggle("zoomed", this.isZoomed);
  }

  closeModal() {
    this.previewModal.classList.remove("active");
    this.currentPreview = null;
  }

  handleTabClick(e) {
    const tab = e.currentTarget;
    const tabType = tab.dataset.tab;

    this.modalTabs.forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");

    if (this.currentPreview) {
      this.previewImage.src =
        tabType === "before"
          ? this.currentPreview.originalUrl
          : this.currentPreview.processedUrl;
    }
  }

  downloadImage(index) {
    const result = this.processedImages[index];
    if (!result || !result.blob) return;

    const link = document.createElement("a");
    link.href = result.processedUrl;

    const baseName = result.filename.replace(/\.[^.]+$/, "");
    const ext      = result.outputMime === "image/png" ? "png" : "jpg";
    link.download  = `${baseName}_clean.${ext}`;

    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  downloadAll() {
    this.processedImages.forEach((_, index) => {
      setTimeout(() => this.downloadImage(index), index * 200);
    });
  }

  clearAll() {
    // Revoke object URLs
    this.processedImages.forEach((result) => {
      if (result.processedUrl) {
        URL.revokeObjectURL(result.processedUrl);
      }
    });

    this.processedImages = [];
    this.resultsGrid.innerHTML = "";
    this.hideResults();
  }

  showStatus(text) {
    this.statusText.textContent = text;
    this.statusSection.style.display = "block";
  }

  updateStatus(text) {
    this.statusText.textContent = text;
  }

  hideStatus() {
    this.statusSection.style.display = "none";
  }

  showResults() {
    this.resultsSection.style.display = "block";
  }

  hideResults() {
    this.resultsSection.style.display = "none";
  }
}

// Initialize the application
document.addEventListener("DOMContentLoaded", () => {
  window.clearNano = new ClearNano();
});
