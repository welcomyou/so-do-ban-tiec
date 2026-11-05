# 💒 Sơ Đồ Bàn Tiệc — PWA theo dõi ghế trống thời gian thực

Ứng dụng web cài được lên điện thoại (PWA, không cần store) giúp **MC / người dẫn khách / nhân viên** nhìn thấy sơ đồ bàn tiệc và **cập nhật – theo dõi số ghế trống tại từng bàn** trong thời gian thực.

Lấy cảm hứng từ layout tiệc cưới Topaz (32 bàn tròn): admin tải file PDF layout của nhà hàng lên, app **tự nhận diện vị trí các bàn tròn**, sau đó xuất bản cho cả đội dùng chung.

## ✨ Tính năng

### Cho mọi người (không cần đăng nhập)
- Xem sơ đồ bàn đang xuất bản: mỗi bàn là một vòng tròn hiển thị **số ghế trống to, dễ đọc** + số bàn.
- **Mã màu ngay lập tức**: 🟢 còn nhiều chỗ · 🟡 còn ít · 🔴 đầy. Bàn vừa được ai đó cập nhật sẽ **nhấp nháy viền trắng** để người dẫn khách để ý.
- **Chạm vào bàn → bảng cập nhật nhanh**: nút − / ＋ lớn, đặt nhanh 0…N, cập nhật ngay không cần bấm lưu.
- **Danh sách bàn** (lọc Còn chỗ / Đầy) — bấm vào bàn là nhảy thẳng tới vị trí trên sơ đồ.
- Tổng quan trên đầu: `84/300 ghế trống · 12/32 bàn còn chỗ`; ticker cho biết ai vừa cập nhật bàn nào.
- Thu phóng 2 ngón / kéo pan mượt, nút ⤢ về toàn cảnh, double-tap để zoom.
- Tuỳ chọn: **giữ màn hình sáng** (Wake Lock), tên hiển thị khi cập nhật, cài app lên màn hình chính (Android/iOS).
- Tự làm mới **thời gian thực qua SSE** (`/api/stream`): người vừa cập nhật xong, mọi máy khác thấy trong ~1 giây, bàn thay đổi nhấp nháy viền trắng. Mất SSE tự động chuyển sang polling dự phòng.

### Cho admin (đăng nhập)
- **Tạo sơ đồ 2 cách**:
  1. **📥 Nhập từ PDF** — render PDF bằng pdf.js rồi tự nhận diện bàn tròn (thuật toán Sobel + Hough chạy ngay trên máy). Tuỳ chỉnh độ nhạy, cỡ bàn nhỏ/lớn, số ghế mặc định; xem overlay kết quả ngay trên bản vẽ rồi bấm *Dùng kết quả*. Trên layout Topaz thật: nhận diện **31/32 bàn** chỉ sau ~1 giây.
  2. **Kéo thả thủ công** — thêm bàn, kéo di chuyển, sửa số bàn / số ghế / cỡ bàn, đánh số tự động 1,2,3… theo hàng, undo.
- **Xuất bản / Gỡ xuống** sơ đồ — mọi người thấy ngay lập tức; xuất bản sẽ đặt mọi bàn về "còn đủ chỗ".
- Tự động lưu nháp sau 2 giây.
- Bảo mật: mật khẩu băm PBKDF2, session cookie HttpOnly có chữ ký HMAC; API quản trị yêu cầu đăng nhập + header đặc biệt (chống CSRF).

## 🏗 Kiến trúc

```
public/          # PWA (index.html + JS module thuần, không framework)
  js/viewer.js     # màn hình chính cho MC/nhân viên
  js/editor.js     # admin: danh sách + editor kéo thả + import PDF
  js/detect.js     # nhận diện vòng tròn (Sobel + Hough + xác minh độ phủ)
  js/canvas-view.js# engine pan/zoom/pinch cho canvas
  sw.js            # service worker (offline + cập nhật code tự động)
src/worker.js    # Cloudflare Worker: API + auth + định tuyến assets
schema.sql       # D1 (SQLite): users, layouts, table_state, update_log
```

- **Cloudflare Workers + static assets + D1** — miễn phí cho quy mô này.
- Đồng bộ "thời gian thực": **Server-Sent Events** (server quét `state_version` mỗi 1 giây, có đổi thì đẩy gói state đầy đủ tới mọi client ngay); polling mỗi 3s chỉ là dự phòng khi SSE lỗi.
- Cập nhật ghế dùng **delta ±1 nguyên tử** trong 1 câu SQL — không mất cập nhật khi nhiều người bấm cùng lúc.

## 🚀 Chạy thử trên máy

```bash
npm install
npm run db:local     # tạo database D1 local + schema
npm run dev          # http://127.0.0.1:8787
```

Lần đầu vào `/#/admin` sẽ hỏi **khởi tạo tài khoản admin**. Muốn có dữ liệu demo:

```bash
npm run seed         # tạo layout 32 bàn mẫu (admin/admin nếu bạn tự tạo)
npm run icons        # sinh lại icon PWA nếu cần
npm run test:detect  # test thuật toán nhận diện bàn
```

## ☁️ Triển khai lên Cloudflare (miễn phí)

1. **Đăng nhập**: `npx wrangler login`
2. **Tạo database D1**:
   ```bash
   npx wrangler d1 create so-do-ban-tiec
   ```
   Copy `database_id` in được vào `wrangler.jsonc` (thay `LOCAL_DEV_PLACEHOLDER`).
3. **Tạo schema trên production**:
   ```bash
   npx wrangler d1 execute so-do-ban-tiec --remote --file=schema.sql
   ```
4. **Đặt secret session** (bắt buộc ở production):
   ```bash
   npx wrangler secret put SESSION_SECRET
   # nhập chuỗi ngẫu nhiên dài, ví dụ: openssl rand -hex 32
   ```
5. **Deploy**: `npm run deploy`
6. Mở URL `https://so-do-ban-tiec.<tên-tài-khoản>.workers.dev` — vào `/#/admin` để tạo tài khoản admin và xuất bản sơ đồ đầu tiên.

> Nên gắn domain riêng (Workers Routes) nếu có. Gửi link cho MC/nhân viên, họ bấm **☰ → 📱 Cài ứng dụng** để thêm vào màn hình chính như app thật (iPhone: Chia sẻ → Thêm vào Màn hình chính).

## 📱 Cách dùng trong tiệc cưới

| Vai trò | Cách dùng |
|---|---|
| **Admin** (org. team) | Vào `/#/admin`, nhập PDF layout, chỉnh số bàn/số ghế, **Xuất bản** trước giờ tiệc. Mỗi sự kiện một sơ đồ. |
| **Người cập nhật** (đi một vòng) | Mở app → chạm bàn → bấm − khi khách ngồi thêm / ＋ khi khách rời. Cứ 5–10 phút đi một vòng. |
| **Người dẫn khách** | Nhìn màu: tìm bàn **xanh** còn chỗ → dẫn khách tới. Bấm **☰ bàn** xem nhanh danh sách bàn còn chỗ. Chạm số bàn để nhảy tới vị trí. |
| **MC** | Xem tổng quan ghế trống đầu trang để điều phối. |

## 🛠 Khắc phục sự cố

- **Không đọc được PDF khi import**: cần mạng lần đầu (tải pdf.js từ CDN). File PDF gốc vẫn được xử lý trên máy bạn.
- **Nhận diện thiếu/thừa bàn**: kéo thanh *Độ nhạy quét* / *Bàn nhỏ nhất* và xem overlay cập nhật lại; sau đó có thể xoá/thêm/b kéo từng bàn trong editor.
- **Sơ đồ không cập nhật**: kiểm tra biểu tượng chấm ở góc phải — xám là mất mạng; app tự kết nối lại.
- **Reset toàn bộ số ghế**: admin vào sửa sơ đồ → Xuất bản lại (đặt mọi bàn về còn đủ chỗ).

## 📝 Ghi chú kỹ thuật

- Polling mỗi 3s, mỗi request chỉ vài KB — 20 người dùng đồng thời vẫn nhẹ với gói Workers free.
- Ảnh nền PDF được nén JPEG (~200–400KB), lưu trong D1, phục vụ qua `/api/bg/:id` có cache.
- Service worker: app shell cache-first cho icon/vendor, network-first cho HTML/JS/CSS (cập nhật code tự động, không kẹt bản cũ).
