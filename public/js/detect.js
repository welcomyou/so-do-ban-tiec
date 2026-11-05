// Tự nhận diện vị trí bàn tròn từ ảnh render của PDF.
// Thuật toán: Sobel gradient → vote Hough theo hướng gradient (mỗi điểm cạnh
// vote 2 điểm tâm dự kiến tại khoảng cách r theo phương gradient) → tìm đỉnh
// → xác minh lại độ phủ viền vòng tròn → NMS gộp trùng lặp.
// Chạy hoàn toàn trên máy người dùng, không cần server.

export function detectCircles(imageData, opts = {}) {
  const { width: w, height: h, data } = imageData;
  const minDim = Math.min(w, h);
  const rMin = Math.max(6, Math.round(opts.rMin ?? minDim * 0.02));
  const rMax = Math.min(Math.round(minDim * 0.35), Math.round(opts.rMax ?? minDim * 0.09));
  const sensitivity = opts.sensitivity ?? 6; // 1..10
  const pct = 0.97 - (sensitivity - 1) * 0.045;      // ngưỡng percentile độ lớn gradient
  const minCover = Math.max(0.3, 0.62 - sensitivity * 0.035); // độ phủ viền tối thiểu

  // 1. Grayscale + blur nhẹ (giảm nhiễu, tăng độ chính xác hướng gradient)
  const grayRaw = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < grayRaw.length; i++, p += 4) {
    grayRaw[i] = (data[p] * 77 + data[p + 1] * 151 + data[p + 2] * 28) >> 8;
  }
  const gray = grayRaw.slice(); // viền giữ nguyên (tránh tạo gradient giả ở rìa ảnh)
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      gray[i] = (grayRaw[i] + grayRaw[i - 1] + grayRaw[i + 1] +
        grayRaw[i - w] + grayRaw[i + w] + grayRaw[i - w - 1] + grayRaw[i - w + 1] +
        grayRaw[i + w - 1] + grayRaw[i + w + 1]) / 9 | 0;
    }
  }

  // 2. Sobel — độ lớn & hướng gradient
  const mag = new Float32Array(w * h);
  const dirX = new Float32Array(w * h);
  const dirY = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const tl = gray[i - w - 1], t = gray[i - w], tr = gray[i - w + 1];
      const l = gray[i - 1], r = gray[i + 1];
      const bl = gray[i + w - 1], b = gray[i + w], br = gray[i + w + 1];
      const gx = (tr + 2 * r + br) - (tl + 2 * l + bl);
      const gy = (bl + 2 * b + br) - (tl + 2 * t + tr);
      const m = Math.hypot(gx, gy);
      if (m > 0) { mag[i] = m; dirX[i] = gx / m; dirY[i] = gy / m; }
    }
  }

  // 3. Ngưỡng percentile
  const hist = new Uint32Array(1024);
  let nz = 0;
  for (let i = 0; i < mag.length; i++) {
    if (mag[i] > 0) { hist[Math.min(1023, mag[i] | 0)]++; nz++; }
  }
  let acc = 0, thrBin = 1023;
  const target = nz * pct;
  for (let b = 0; b < 1024; b++) {
    acc += hist[b];
    if (acc >= target) { thrBin = b; break; }
  }
  const thr = Math.max(60, thrBin);
  const thrSoft = thr * 0.65;

  // Danh sách điểm cạnh (có thể stride nếu quá nhiều)
  let edges = [];
  for (let i = 0; i < mag.length; i++) {
    if (mag[i] >= thr) edges.push(i);
  }
  const stride = edges.length > 140000 ? Math.ceil(edges.length / 140000) : 1;

  // 4. Hough theo từng bán kính — vote "smear" dọc trục gradient (r±3),
  //    rồi tìm đỉnh theo TỔNG cửa sổ 11×11 (integral image).
  // Hướng Sobel lượng tử hoá sai vài độ làm phiếu loang thành đĩa nhỏ quanh tâm,
  // nên đỉnh phải tính theo cửa sổ thay vì ô lẻ.
  const accBuf = new Int32Array(w * h);
  const integ = new Float64Array((w + 1) * (h + 1));
  const candidates = [];

  // Độ phủ viền thực tế quanh (cx, cy, rr) — dò lệch ±2px vì nét vẽ dày
  // và bán kính đã lượng tử hoá theo bước quét.
  const coverageAt = (cx, cy, rr) => {
    const K = Math.max(36, Math.round(2 * Math.PI * rr / 4));
    let cov = 0;
    for (let k = 0; k < K; k++) {
      const a = (k / K) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      let hit = false;
      for (let dr = -2; dr <= 2 && !hit; dr++) {
        const sx = Math.round(cx + ca * (rr + dr));
        const sy = Math.round(cy + sa * (rr + dr));
        if (sx < 1 || sy < 1 || sx >= w - 1 || sy >= h - 1) continue;
        if (mag[sy * w + sx] >= thrSoft) { hit = true; }
      }
      if (hit) cov++;
    }
    return cov / K;
  };

  // Nội thất bàn tròn (bản vẽ CAD) phải SÁNG & trống — loại vòng vẽ quanh chữ,
  // vòng trang trí có hình bên trong.
  const interiorOk = (cx, cy, rr) => {
    const KI = 20;
    let light = 0;
    for (let k = 0; k < KI; k++) {
      const a = (k / KI) * Math.PI * 2;
      const ix = Math.round(cx + Math.cos(a) * rr * 0.62);
      const iy = Math.round(cy + Math.sin(a) * rr * 0.62);
      if (ix < 1 || iy < 1 || ix >= w - 1 || iy >= h - 1) { light++; continue; }
      if (gray[iy * w + ix] > 165) light++;
    }
    return light / KI >= 0.8;
  };

  // Tinh chỉnh sub-pixel: quét 72 tia từ tâm, lấy trung điểm nét viền mỗi tia
  // (gộp CẢ HAI cạnh chuyển màu của nét — span ≤8px) rồi fit đường tròn
  // least-squares (Kasa). Lặp 2 lần để hội tụ đúng tâm nét vẽ.
  const fitCirclePrecise = (cx, cy, rBase) => {
    const K = 72;
    let r0 = rBase, ox = cx, oy = cy, fit = null;
    for (let iter = 0; iter < 3; iter++) {
      const pts = [];
      for (let k = 0; k < K; k++) {
        const a = (k / K) * Math.PI * 2;
        const ca = Math.cos(a), sa = Math.sin(a);
        let first = -1, last = -1;
        for (let t = r0 - 8; t <= r0 + 8; t++) {
          const sx = Math.round(ox + ca * t), sy = Math.round(oy + sa * t);
          if (sx < 1 || sy < 1 || sx >= w - 1 || sy >= h - 1) break;
          if (mag[sy * w + sx] >= thrSoft) { if (first < 0) first = t; last = t; }
        }
        // span > 8px nghĩa là tia đụng thêm nét khác (ghế, bàn cạnh) — bỏ tia này
        if (first >= 0 && last - first <= 8) {
          pts.push([ox + ca * (first + last) / 2, oy + sa * (first + last) / 2]);
        }
      }
      if (pts.length < 30) return null;
      fit = kasaFit(pts);
      if (!fit) return null;
      const kept = pts.filter(p => Math.abs(Math.hypot(p[0] - fit.x, p[1] - fit.y) - fit.r) < 2.5);
      if (kept.length >= 30 && kept.length < pts.length) {
        const f2 = kasaFit(kept);
        if (f2) fit = f2;
      }
      // vòng sau: quét lại từ tâm & bán kính vừa fit cho chuẩn xác dần
      ox = fit.x; oy = fit.y; r0 = Math.round(fit.r);
    }
    return fit;
  };

  const kasaFit = (pts) => {
    let Sxx = 0, Sxy = 0, Sx = 0, Syy = 0, Sy = 0, Sxz = 0, Syz = 0, Sz = 0;
    for (const [x, y] of pts) {
      const z = x * x + y * y;
      Sxx += x * x; Sxy += x * y; Sx += x;
      Syy += y * y; Sy += y;
      Sxz += x * z; Syz += y * z; Sz += z;
    }
    const n = pts.length;
    // Kasa: [Sxx Sxy Sx; Sxy Syy Sy; Sx Sy n]·[D,E,F] = [−Sxz,−Syz,−Sz]
    const m = [[Sxx, Sxy, Sx], [Sxy, Syy, Sy], [Sx, Sy, n]];
    const b = [-Sxz, -Syz, -Sz];
    const det3 = (M) =>
      M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) -
      M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0]) +
      M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]);
    const det = det3(m);
    if (!Number.isFinite(det) || Math.abs(det) < 1e-9) return null;
    const solveCol = (col) => {
      const M = m.map(row => row.slice());
      for (let i = 0; i < 3; i++) M[i][col] = b[i];
      return det3(M) / det;
    };
    const D = solveCol(0), E = solveCol(1), F = solveCol(2);
    const r2 = D * D / 4 + E * E / 4 - F;
    if (!(r2 > 0)) return null;
    return { x: -D / 2, y: -E / 2, r: Math.sqrt(r2) };
  };

  // Tinh chỉnh + xác minh: fit chính xác, rồi chấm điểm độ phủ tại vị trí mới
  const refineAndVerify = (c, rBase, out) => {
    let x = c.x, y = c.y, r = rBase;
    const fitted = fitCirclePrecise(c.x, c.y, rBase);
    if (fitted) { x = Math.round(fitted.x * 10) / 10; y = Math.round(fitted.y * 10) / 10; r = Math.round(fitted.r * 10) / 10; }
    const score = coverageAt(x, y, r);
    if (score >= minCover && interiorOk(x, y, r)) {
      out.push({ x, y, r, score });
    }
  };
  for (let r = rMin; r <= rMax; r += r > 60 ? 2 : 1) {
    accBuf.fill(0);
    const touchThr = 5;
    const winThr = Math.max(18, Math.round(2 * Math.PI * r * 0.15));
    const touched = [];
    for (let e = 0; e < edges.length; e += stride) {
      const i = edges[e];
      const ex = i % w, ey = (i / w) | 0;
      const ux = dirX[i], uy = dirY[i];
      if (ux === 0 && uy === 0) continue;
      for (const sign of [1, -1]) {
        for (let dr = -3; dr <= 3; dr++) {
          const rr = r + dr * sign;
          if (rr <= 0) continue;
          const cx = Math.round(ex + rr * ux);
          const cy = Math.round(ey + rr * uy);
          if (cx < 5 || cy < 5 || cx >= w - 5 || cy >= h - 5) continue;
          const ci = cy * w + cx;
          const v = ++accBuf[ci];
          if (v === touchThr) touched.push(ci);
        }
      }
    }
    if (!touched.length) continue;

    // integral image cho tổng cửa sổ
    integ.fill(0);
    for (let y = 0; y < h; y++) {
      let rowSum = 0;
      const o = (y + 1) * (w + 1), po = y * (w + 1);
      for (let x = 0; x < w; x++) {
        rowSum += accBuf[y * w + x];
        integ[o + x + 1] = integ[po + x + 1] + rowSum;
      }
    }
    const win = (cx, cy) => {
      const x0 = cx - 5, y0 = cy - 5, x1 = cx + 6, y1 = cy + 6; // ô lẻ đã chặn biên ≥5
      return integ[y1 * (w + 1) + x1] - integ[y0 * (w + 1) + x1] - integ[y1 * (w + 1) + x0] + integ[y0 * (w + 1) + x0];
    };
    const local = [];
    for (const ci of touched) {
      const cx = ci % w, cy = (ci / w) | 0;
      const ws = win(cx, cy);
      if (ws >= winThr) local.push({ x: cx, y: cy, ws });
    }
    local.sort((a, b) => b.ws - a.ws);
    const kept = [];
    for (const c of local) {
      if (!kept.some(k => Math.abs(k.x - c.x) < 8 && Math.abs(k.y - c.y) < 8)) kept.push(c);
      if (kept.length >= 40) break;
    }
    for (const c of kept) {
      refineAndVerify(c, r, candidates);
    }
  }

  // 5. NMS — chấp nhận vòng tròn tốt nhất, loại trùng tâm/gần nhau
  candidates.sort((a, b) => b.score - a.score);
  const out = [];
  for (const c of candidates) {
    let ok = true;
    for (const o of out) {
      const d = Math.hypot(c.x - o.x, c.y - o.y);
      if (d < Math.max(o.r, c.r) * 0.75) { ok = false; break; }
    }
    if (ok) out.push(c);
    if (out.length >= 400) break;
  }
  return out;
}
