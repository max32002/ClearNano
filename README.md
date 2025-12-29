# ClearNano - Gemini Nano Banana 浮水印移除工具

ClearNano 是一個輕量、高效且介面現代化的純前端網頁工具，專門用於移除 Gemini 生成圖片中的 Nano 系列浮水印（Banana 浮水印）。本工具完全在瀏覽器端運行，確保您的圖片隱私安全，並使用數學精確的反向 Alpha 混合算法還原影像。

## 特性 (Features)

- **🔒 純本地處理 (100% Client-side)**：所有影像運算都在您的瀏覽器中完成，圖片**絕不會**上傳到任何伺服器，確保數據隱私。
- **📐 數學精確還原 (Mathematically Precise)**：不同於 AI 補圖（Inpainting），本工具使用反向 Alpha 混合算法 (Reverse Alpha Blending)，基於已知的浮水印遮罩，精確計算並還原被覆蓋的原始像素色彩。
- **⚡ 自動偵測 (Auto-detection)**：智能識別圖片解析度，自動應用對應尺寸（48px 或 96px）的浮水印遮罩。
- **🎨 現代化介面 (Modern UI)**：
  - 支援深色模式 (Dark Mode) 與玻璃態特效 (Glassmorphism)。
  - 直觀的拖放 (Drag & Drop) 上傳區。
  - 即時處理進度顯示。
- **🚀 批次處理 (Batch Processing)**：支援一次上傳多張圖片，並提供「全部下載」功能。
- **👁️ 即時預覽 (Live Preview)**：內建強大的對比預覽功能，可快速切換查看處理前後的差異。

## 使用方式 (How to Use)

由於瀏覽器的安全策略，建議使用本地網頁伺服器運行以獲得最佳體驗。

1.  **下載專案**：
    選取所有檔案並下載到本地目錄。

2.  **啟動伺服器**：
    確保您已安裝 Node.js，然後在專案目錄下執行：

    ```
    npx -y http-server -p 8080 -c-1
    ```

3.  **開啟應用**：
    打開瀏覽器訪問 `http://127.0.0.1:8080`。

4.  **開始使用**：
    - 將帶有浮水印的圖片拖入上傳區。
    - 等待處理完成（通常只需幾毫秒）。
    - 點擊圖片查看預覽，或直接點擊「下載」保存還原後的圖片。

## 技術原理 (Technical Details)

本工具針對 Gemini 的浮水印實作方式進行逆向工程。浮水印本質上是一個特定透明度（Alpha）的白色圖層覆蓋在原始影像右下角。

我們使用以下公式進行反向還原：

```math
Pixel_original = (Pixel_final - (α * Pixel_logo)) / (1 - α)
```

其中：

- `Pixel_final`: 帶有浮水印的最終像素值（我們看到的）。
- `Pixel_logo`: 浮水印本身的顏色（此案例中為純白 RGB(255, 255, 255)）。
- `α` (Alpha): 浮水印遮罩的透明度值 (0.0 - 1.0)。
- `Pixel_original`: 我們要求解的原始像素值。

程式會根據圖片的解析度（是否大於等於 1024px）自動選擇 `48x48` 或 `96x96` 的遮罩圖進行運算。


## 浮水印位置規則 (Detection Rules)

| Image Dimension Condition | Watermark Size | Right Margin | Bottom Margin |
| :--- | :--- | :--- | :--- |
| Width > 1024 **AND** Height > 1024 | 96×96 | 64px | 64px |
| Otherwise | 48×48 | 32px | 32px |


## 免責聲明 (Disclaimer)

** ⚠️ 使用風險請自負 (USE AT YOUR OWN RISK)**

本工具會修改您的圖檔像素。雖然我們追求數學上的精確還原，但仍可能因為以下原因產生非預期結果：

- 原生圖片已被壓縮導致像素值失真 (JPEG Artifacts)。
- Gemini 浮水印實作方式的變動。
- 非標準的圖片格式。

作者對於任何數據遺失、圖片損壞或非預期的修改不承擔任何責任。


## 授權 (License)

本專案採用 [MIT License](LICENSE) 授權。

## 致謝 (Credits)

- [journey-ad/gemini-watermark-remover](https://github.com/journey-ad/gemini-watermark-remover) - 算法啟發與參考
