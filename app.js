/**
 * ClearNano - Gemini Nano Banana Watermark Remover
 * Uses Reverse Alpha Blending to restore original pixels
 *
 * Formula: Pixel_original = (Pixel_final - (α * Pixel_logo)) / (1 - α)
 *
 * Optimisations applied:
 *   1. Spatial-correlation (Pearson) replaces brightness heuristic for config detection
 *   2. Near-official size projection for non-catalog dimensions
 *   3. v2 small variant support (exact 36px mask plus resized 24px profile)
 *   4. Web Worker offloads reverseAlphaBlend off the main thread
 *   5. Parallel batch processing (up to 4 images concurrently)
 *   6. Output format preserved: PNG→PNG, WebP→WebP, JPEG→JPEG
 *   7. Mask load failure gracefully falls back to same-size standard mask
 *
 * Watermark size/config rules (which sizes map to which logo/margin/alpha
 * variant) are NOT hand-maintained here anymore. The upstream catalog lives
 * in vendor/geminiSizeCatalog.js, vendored verbatim from
 * https://github.com/GargantuaX/gemini-watermark-remover (src/core/geminiSizeCatalog.js).
 * See that file's header comment for upgrade instructions. app.js also keeps
 * a narrow compatibility profile for resized 1k exports not represented by
 * the upstream catalog.
 */

const VERSION = '1.1.1';
const MIN_WATERMARK_CORRELATION = 0.15;

class ClearNano {
  constructor() {
    // Watermark mask configurations.
    // bg_96_20260520.png is the updated alpha map for 2816×1536 (2k-new-margin, since 2026-05-20).
    this.masks = {
      48: { path: "assets/bg_48.png", size: 48 },
      96: { path: "assets/bg_96.png", size: 96 },
      '96_20260520': { path: "assets/bg_96_20260520.png", size: 96 },
      '36_v2': { path: "assets/bg_36_v2.png", size: 36 },
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
    const badge = document.getElementById('versionBadge');
    if (badge) badge.textContent = `v${VERSION}`;
    console.log(`ClearNano v${VERSION} initialized successfully`);
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

    // Keep a conservative fallback for older deployments missing the exact
    // upstream asset, then derive the resized profile used by 1k exports.
    if (!this.loadedMasks['36_v2'] && this.loadedMasks[48]) {
      const fallback = this.generateScaledMask(48, 36);
      if (fallback) {
        this.loadedMasks['36_v2'] = fallback;
        console.warn('Exact 36-v2 mask unavailable — using scaled 48px fallback');
      }
    }
    if (this.loadedMasks['36_v2']) {
      const resized = this.generateScaledMask('36_v2', 24);
      if (resized) this.loadedMasks['24_v2'] = resized;
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

          const detectionScore = watermarkConfig.detectionScore;
          const noWatermarkDetected =
            !Number.isFinite(detectionScore) ||
            detectionScore < MIN_WATERMARK_CORRELATION;

          if (noWatermarkDetected) {
            const outputMime = this.outputFormat;
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
              width: img.naturalWidth,
              height: img.naturalHeight,
              maskSize: null,
              margin: null,
              outputMime,
              detectionScore,
              noWatermark: true,
              error: null,
            });
            return;
          }

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

  /**
   * Map a vendored-catalog config ({logoSize, marginRight, marginBottom,
   * alphaVariant?, fixedVariant?}) onto ClearNano's own mask lookup shape
   * ({size, margin, maskKey}). This is the ONLY place that needs to know
   * about the mapping between upstream's config shape and our mask assets —
   * see vendor/geminiSizeCatalog.js for the actual watermark rules.
   */
  mapCatalogConfigToMask(config) {
    if (!config) return null;

    let maskKey;
    if (config.alphaVariant === '20260520') maskKey = '96_20260520';
    else if (config.alphaVariant === 'v2') maskKey = '36_v2';
    else if (config.alphaVariant === 'v2-resized') maskKey = '24_v2';
    else maskKey = config.logoSize; // e.g. 48, 96, or the 46px fixed-variant approximated via 48

    // The 1408x768 fixed variant reports an exact 46px logo, but we only ship
    // a 48px mask asset — approximate with the closest mask we have.
    if (config.fixedVariant && !this.loadedMasks[maskKey]) maskKey = 48;

    return { size: config.logoSize, margin: config.marginRight, maskKey };
  }

  getWatermarkConfig(width, height) {
    /**
     * Priority order:
     * 1. Exact official Gemini size catalog (vendor/geminiSizeCatalog.js)
     * 2. Historical heuristic fallback (used as the search seed for
     *    detectBestConfig's near-official projection / variant candidates)
     */
    const official = window.GeminiSizeCatalog.resolveOfficialGeminiWatermarkConfig(width, height);
    const catalogConfig = official ||
      (width > 1024 && height > 1024
        ? { logoSize: 96, marginRight: 64, marginBottom: 64 }
        : { logoSize: 48, marginRight: 32, marginBottom: 32 });

    // Keep the original upstream-shaped config attached so detectBestConfig
    // can hand it straight back to the catalog as the search seed, without
    // losing fields like alphaVariant when round-tripping through our own
    // {size, margin, maskKey} shape.
    return { ...this.mapCatalogConfigToMask(catalogConfig), catalogConfig };
  }

  /**
   * A 1376×768 export can be a resized v2 image whose 36px source mark is
   * reduced to 24px. This profile is intentionally narrow so it only wins
   * when its exact footprint is present.
   */
  getResizedWatermarkCandidates(imageWidth, imageHeight) {
    const key = `${imageWidth}x${imageHeight}`;
    if (key !== '1376x768' && key !== '768x1376') return [];
    if (!this.loadedMasks['24_v2']) return [];

    return [{
      size: 24,
      margin: 48,
      maskKey: '24_v2',
      priority: 1,
      minimumScore: 0.65,
    }];
  }

  /**
   * Build candidate watermark configs for a given image via the vendored
   * upstream catalog (vendor/geminiSizeCatalog.js), then pick the best one
   * via Pearson spatial correlation between each candidate region and its mask.
   *
   * `resolveGeminiWatermarkSearchCatalogEntries` already covers: the exact
   * catalog match (with all its known variants — large-margin, v2-small,
   * legacy, and the evidence-gated 192px new-margin anchor), near-official
   * projection for non-catalog dimensions, and unknown-size fallback
   * variants. Candidates whose logoSize doesn't match a mask asset we ship
   * (e.g. an arbitrarily-scaled projected size) are simply skipped below —
   * this keeps upgrades to the vendored catalog safe without touching this
   * detection logic.
   *
   * Candidates are ranked by spatial-correlation score, with a small bias
   * toward each candidate's upstream `sourcePriority` (lower = more
   * canonical/preferred), so a secondary/variant anchor only wins when it
   * shows clearly stronger evidence than the canonical one.
   */
  detectBestConfig(ctx, imageWidth, imageHeight) {
    const defaultConfig = this.getWatermarkConfig(imageWidth, imageHeight);

    const entries = window.GeminiSizeCatalog.resolveGeminiWatermarkSearchCatalogEntries(
      imageWidth, imageHeight, defaultConfig.catalogConfig
    );

    const candidates = [];
    const seen = new Set();
    for (const entry of entries) {
      const candidate = this.mapCatalogConfigToMask(entry.config);
      if (!candidate) continue;

      const mask = this.loadedMasks[candidate.maskKey];
      if (!mask) continue; // no matching mask asset for this candidate — skip

      const sx = imageWidth  - candidate.margin - candidate.size;
      const sy = imageHeight - candidate.margin - candidate.size;
      if (sx < 0 || sy < 0) continue;

      const key = `${candidate.size}:${candidate.margin}:${candidate.maskKey}`;
      if (seen.has(key)) continue;
      seen.add(key);

      candidates.push({ ...candidate, priority: entry.metadata?.sourcePriority ?? 9 });
    }
    for (const candidate of this.getResizedWatermarkCandidates(imageWidth, imageHeight)) {
      const mask = this.loadedMasks[candidate.maskKey];
      if (!mask) continue;

      const sx = imageWidth - candidate.margin - candidate.size;
      const sy = imageHeight - candidate.margin - candidate.size;
      if (sx < 0 || sy < 0) continue;

      const key = `${candidate.size}:${candidate.margin}:${candidate.maskKey}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(candidate);
    }

    if (candidates.length === 0) {
      return { ...defaultConfig, detectionScore: null };
    }

    const PRIORITY_BIAS = 0.03;
    let bestConfig = null;
    let bestEffectiveScore = -Infinity;
    let bestScore = null;

    for (const candidate of candidates) {
      const mask = this.loadedMasks[candidate.maskKey];
      const sx = imageWidth  - candidate.margin - candidate.size;
      const sy = imageHeight - candidate.margin - candidate.size;

      const region = ctx.getImageData(sx, sy, candidate.size, candidate.size);
      const score  = this.computeSpatialCorrelation(region.data, mask.data);
      if (candidate.minimumScore != null && score < candidate.minimumScore) {
        continue;
      }
      const effectiveScore = score - candidate.priority * PRIORITY_BIAS;

      if (effectiveScore > bestEffectiveScore) {
        bestEffectiveScore = effectiveScore;
        bestConfig = { ...candidate, detectionScore: score };
        bestScore = score;
      }
    }

    return bestConfig || { ...defaultConfig, detectionScore: bestScore };
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
                        ${
                          result.noWatermark
                            ? `
                        <span class="result-status">
                            未偵測到浮水印，已保留原圖
                        </span>
                    `
                            : `
                        <span class="result-status success">
                            <svg viewBox="0 0 24 24" fill="none" width="14" height="14" xmlns="http://www.w3.org/2000/svg">
                                <path d="M20 6L9 17L4 12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                            </svg>
                            ${result.maskSize}px / ${result.margin}px margin
                        </span>
                    `
                        }
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
