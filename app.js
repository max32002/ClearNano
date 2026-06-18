/**
 * ClearNano - Gemini Nano Banana Watermark Remover
 * Uses Reverse Alpha Blending to restore original pixels
 *
 * Formula: Pixel_original = (Pixel_final - (α * Pixel_logo)) / (1 - α)
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

    // Loaded mask data
    this.loadedMasks = {};

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
    // Load masks
    await this.loadMasks();

    // Setup event listeners
    this.setupEventListeners();

    console.log("ClearNano initialized successfully");
  }

  async loadMasks() {
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
        this.loadedMasks[key] = {
          data: imageData.data,
          width: config.size,
          height: config.size,
        };

        console.log(`Loaded mask: ${key} (${config.size}x${config.size})`);
      } catch (error) {
        console.error(`Failed to load mask ${key}:`, error);
      }
    }
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

  async processFiles(files) {
    this.showStatus(`處理中... (0/${files.length})`);

    for (let i = 0; i < files.length; i++) {
      this.updateStatus(`處理中... (${i + 1}/${files.length})`);

      try {
        const result = await this.processImage(files[i]);
        this.processedImages.push(result);
        this.addResultCard(result);
      } catch (error) {
        console.error(`Failed to process ${files[i].name}:`, error);
        this.addResultCard({
          filename: files[i].name,
          error: error.message,
          originalUrl: null,
          processedUrl: null,
        });
      }
    }

    this.hideStatus();
    this.showResults();
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

          // Create canvas
          const canvas = document.createElement("canvas");
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0);

          // Determine watermark config based on image resolution
          let watermarkConfig = this.getWatermarkConfig(img.naturalWidth, img.naturalHeight);

          // For 1k-tier images (48px/32px default), also detect the large-margin
          // variant (48px at 96px margin) introduced in 2026-06 for some Gemini outputs.
          if (watermarkConfig.size === 48 && watermarkConfig.margin === 32) {
            watermarkConfig = this.detectBestMarginConfig(
              ctx, img.naturalWidth, img.naturalHeight, watermarkConfig
            );
          }

          const mask = this.loadedMasks[watermarkConfig.maskKey || watermarkConfig.size];

          if (!mask) {
            throw new Error(
              `No suitable mask found for image size ${img.naturalWidth}x${img.naturalHeight}`
            );
          }

          // Get the watermark region position (with margin offset from corner)
          // Gemini watermarks are NOT flush with the corner - they have margins
          const startX = img.naturalWidth - watermarkConfig.margin - watermarkConfig.size;
          const startY = img.naturalHeight - watermarkConfig.margin - watermarkConfig.size;

          // Get image data for the watermark region
          const imageData = ctx.getImageData(
            startX,
            startY,
            mask.width,
            mask.height
          );

          // Apply reverse alpha blending
          this.reverseAlphaBlend(imageData, mask);

          // Put the processed data back
          ctx.putImageData(imageData, startX, startY);

          // Convert to blob
          const blob = await new Promise((res) =>
            canvas.toBlob(res, "image/jpeg", 0.92)
          );
          const processedUrl = URL.createObjectURL(blob);

          resolve({
            filename: file.name,
            originalUrl: e.target.result,
            processedUrl: processedUrl,
            blob: blob,
            width: img.naturalWidth,
            height: img.naturalHeight,
            maskSize: watermarkConfig.size,
            margin: watermarkConfig.margin,
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

  getWatermarkConfig(width, height) {
    /**
     * Watermark positioning rules (updated 2026-06):
     *
     * 1. Exact official Gemini sizes are looked up from OFFICIAL_SIZE_CONFIGS.
     *    - gemini-3.x 1k tier  (e.g. 1024×1024, 1376×768) → 48px / margin 32px
     *    - gemini-3.x 2k tier  (e.g. 2048×2048)            → 96px / margin 64px
     *    - 2816×1536 (2k-new-margin, since 2026-05-20)      → 96px / margin 192px
     *    - gemini-2.5-flash 1k (e.g. 1344×768)             → 48px / margin 32px
     *
     * 2. Non-catalog sizes fall back to the historical heuristic:
     *    - Both dims > 1024 → 96px / margin 64px
     *    - Otherwise        → 48px / margin 32px
     *
     * Note: For 1k images, an additional large-margin variant (48px / margin 96px)
     * exists in newer Gemini outputs (since 2026-06-07). It is auto-detected via
     * detectBestMarginConfig() after this method returns.
     */
    const key = `${width}x${height}`;
    const official = OFFICIAL_SIZE_CONFIGS.get(key);
    if (official) return { ...official };

    if (width > 1024 && height > 1024) {
      return { size: 96, margin: 64, maskKey: 96 };
    }
    return { size: 48, margin: 32, maskKey: 48 };
  }

  /**
   * For 1k-tier images, Gemini sometimes places the 48px watermark at a 96px
   * margin instead of 32px (observed since 2026-06-07).
   * Detect the better position by comparing mask-weighted mean brightness:
   * the region with the watermark will be brighter on average.
   */
  detectBestMarginConfig(ctx, imageWidth, imageHeight, defaultConfig) {
    const largeMarginConfig = { ...defaultConfig, margin: 96 };
    const candidates = [defaultConfig, largeMarginConfig];

    const mask = this.loadedMasks[defaultConfig.maskKey || defaultConfig.size];
    if (!mask) return defaultConfig;

    let bestConfig = defaultConfig;
    let bestScore = -Infinity;

    for (const candidate of candidates) {
      const startX = imageWidth - candidate.margin - candidate.size;
      const startY = imageHeight - candidate.margin - candidate.size;
      if (startX < 0 || startY < 0) continue;

      const region = ctx.getImageData(startX, startY, candidate.size, candidate.size);
      let weightedSum = 0;
      let totalWeight = 0;

      for (let i = 0; i < region.data.length; i += 4) {
        const maskAlpha = Math.max(mask.data[i], mask.data[i + 1], mask.data[i + 2]) / 255;
        if (maskAlpha < 0.1) continue;
        const brightness = (region.data[i] + region.data[i + 1] + region.data[i + 2]) / 3;
        weightedSum += brightness * maskAlpha;
        totalWeight += maskAlpha;
      }

      const score = totalWeight > 0 ? weightedSum / totalWeight : 0;
      if (score > bestScore) {
        bestScore = score;
        bestConfig = candidate;
      }
    }

    return bestConfig;
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

    // Generate filename with _clean suffix
    const nameParts = result.filename.split(".");
    const ext = nameParts.pop();
    const baseName = nameParts.join(".");
    link.download = `${baseName}_clean.jpg`;

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
