/**
 * ClearNano - Gemini Nano Banana Watermark Remover
 * Uses Reverse Alpha Blending to restore original pixels
 *
 * Formula: Pixel_original = (Pixel_final - (α * Pixel_logo)) / (1 - α)
 */

class ClearNano {
  constructor() {
    // Watermark mask configurations
    // The masks are white logos with alpha transparency
    this.masks = {
      48: { path: "assets/bg_48.png", size: 48 },
      96: { path: "assets/bg_96.png", size: 96 },
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
    for (const [size, config] of Object.entries(this.masks)) {
      try {
        const img = new Image();
        img.crossOrigin = "anonymous";

        await new Promise((resolve, reject) => {
          img.onload = resolve;
          img.onerror = reject;
          img.src = config.path;
        });

        // Create canvas and get image data
        const canvas = document.createElement("canvas");
        canvas.width = config.size;
        canvas.height = config.size;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0);

        const imageData = ctx.getImageData(0, 0, config.size, config.size);
        this.loadedMasks[size] = {
          data: imageData.data,
          width: config.size,
          height: config.size,
        };

        console.log(`Loaded mask: ${size}x${size}`);
      } catch (error) {
        console.error(`Failed to load mask ${size}:`, error);
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
          const watermarkConfig = this.getWatermarkConfig(img.naturalWidth, img.naturalHeight);
          const mask = this.loadedMasks[watermarkConfig.size];

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
            canvas.toBlob(res, "image/png")
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
     * Gemini watermark positioning rules (from GeminiWatermarkTool):
     * - Large (96x96): BOTH width AND height must be > 1024px, margin = 64px
     * - Small (48x48): All other cases, margin = 32px
     */
    if (width > 1024 && height > 1024) {
      return { size: 96, margin: 64 };
    } else {
      return { size: 48, margin: 32 };
    }
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
                            ${result.maskSize}px mask
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
    link.download = `${baseName}_clean.png`;

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
