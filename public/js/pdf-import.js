// Import PDF: render trang bằng pdf.js (bundle local) rồi nhận diện bàn tròn
let pdfjsLib = null;

// Nạp pdf.js + worker handler:
// 1) Ưu tiên CDN (nhanh, không qua service worker/assets — tránh lỗi định tuyến
//    file lớn của wrangler dev); 2) fallback về bundle local qua Blob URL.
const PDFJS_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/';

async function loadPdfjsFromCdn() {
  pdfjsLib = await import(PDFJS_CDN + 'pdf.min.mjs');
  globalThis.pdfjsWorker = await import(PDFJS_CDN + 'pdf.worker.min.mjs');
}

async function loadPdfjsFromLocal() {
  const mainUrl = new URL('../vendor/pdfjs/pdf.min.mjs', import.meta.url);
  const workerUrl = new URL('../vendor/pdf.worker.min.mjs', import.meta.url);

  const importAsBlob = async (url) => {
    let res = await fetch(url);
    let src = await res.text();
    // SPA fallback có thể trả về HTML — thử lại với query duy nhất (bypass HTTP cache)
    if (!res.ok || src[0] === '<' || src.length < 1000) {
      res = await fetch(url + '?cb=' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7));
      src = await res.text();
    }
    if (src[0] === '<' || src.length < 1000) {
      throw new Error('Không tải được ' + url.pathname + ' (HTTP ' + res.status + ')');
    }
    const blobUrl = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    return import(blobUrl); // module map của blob URL luôn mới
  };

  pdfjsLib = await importAsBlob(mainUrl);
  globalThis.pdfjsWorker = await importAsBlob(workerUrl);
}

export async function loadPdfjs() {
  // chỉ dùng cache khi cả lib lẫn worker handler đã sẵn sàng
  if (pdfjsLib && globalThis.pdfjsWorker) return pdfjsLib;
  pdfjsLib = null;
  globalThis.pdfjsWorker = undefined;
  try {
    await loadPdfjsFromCdn();
  } catch {
    await loadPdfjsFromLocal();
  }
  return pdfjsLib;
}

export async function openPdf(file) {
  const lib = await loadPdfjs();
  const buf = await file.arrayBuffer();
  const pdf = await lib.getDocument({ data: buf }).promise;
  return pdf;
}

export async function renderPage(pdf, pageNumber, targetWidth = 1600) {
  const page = await pdf.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(3, targetWidth / base.width);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport, background: '#fff' }).promise;
  return canvas;
}

// Nén ảnh nền để lưu lên server (data URL, giới hạn ~1MB)
export function canvasToBgDataUrl(canvas, maxW = 1500, quality = 0.68) {
  let target = canvas;
  if (canvas.width > maxW) {
    const scale = maxW / canvas.width;
    target = document.createElement('canvas');
    target.width = Math.round(canvas.width * scale);
    target.height = Math.round(canvas.height * scale);
    target.getContext('2d').drawImage(canvas, 0, 0, target.width, target.height);
  }
  let url = target.toDataURL('image/jpeg', quality);
  // giảm dần chất lượng nếu vượt giới hạn
  let q = quality;
  while (url.length > 1_300_000 && q > 0.3) {
    q -= 0.12;
    url = target.toDataURL('image/jpeg', q);
  }
  return url;
}
