# Buddy API

Cổng tương thích **OpenAI** và **Anthropic** cho tài khoản WorkBuddy AI, kèm dashboard quản trị đa tài khoản: chọn tài khoản đang dùng, xoay vòng khi bị 429, xem token thực tế theo từng request, tạo và phân quyền khóa API.

Chạy bằng Node.js thuần, không phụ thuộc framework, không có bước build frontend.

## Tính năng

- **Ba giao thức**: `/v1/chat/completions`, `/v1/messages`, `/v1/responses` — chuyển đổi không trạng thái, không lưu nội dung.
- **Đa tài khoản**: mỗi tài khoản là một snapshot xác thực riêng; chuyển tài khoản tại chỗ, không cần khởi động lại.
- **Xoay vòng và cooldown**: 429 nghỉ 1 → 2 → 4 → 8 → tối đa 15 phút, ưu tiên `Retry-After`, tự bỏ qua tài khoản đang nghỉ.
- **Retry có giới hạn**: tối đa 5 lần sau lần gọi đầu, chỉ trước khi đã gửi byte nào về client.
- **Đo usage thật**: input, output, cache write, cache read lấy nguyên từ upstream; thiếu trường thì hiển thị "Không có dữ liệu", không điền 0.
- **Khóa API**: tạo/thu hồi, chỉ lưu SHA-256, phân quyền model theo từng khóa, hiệu lực ngay không cần restart.
- **Dashboard**: tổng quan, danh mục model, tài khoản, sử dụng token, nhật ký request, khóa API. Sáng/tối, chạy được trên điện thoại.
- **Release gate**: dashboard từ chối khởi động nếu asset không khớp hash trong `dashboard/release.json`.

## Yêu cầu

- Node.js **22 trở lên** (dùng `fetch`, `AbortSignal.timeout`, `node:test`).
- Windows để dùng tính năng chụp tài khoản từ app desktop; các phần còn lại chạy trên macOS/Linux.
- App **WorkBuddy AI** đã cài và đã đăng nhập (để lấy snapshot đầu tiên), hoặc dùng luồng đăng nhập web trong dashboard.
- Gói `dsh-workbuddy-connect` 0.7.6 và hai peer `@deepseek-ai/dsh-atomic-write`, `@deepseek-ai/dsh-home-paths` — xem [Phụ thuộc ngoài](#phụ-thuộc-ngoài).

## Cài đặt

```bash
git clone <repo-url> buddy-api
cd buddy-api
cp config.example.json config.json
npm run build          # sinh dashboard/public/*.html và release.json
```

Tạo khóa:

```bash
node -e "const {randomUUID}=require('crypto');const fs=require('fs');fs.mkdirSync('secrets',{recursive:true});fs.writeFileSync('secrets/api-key.txt',randomUUID().replaceAll('-','')+randomUUID().replaceAll('-','')+'\n')"
```

Khóa dashboard tự sinh ở lần chạy đầu và ghi vào `secrets/dashboard-key.txt` (quyền 600). Đọc nó bằng:

```bash
cat secrets/dashboard-key.txt
```

## Chạy

```bash
npm start          # gateway  -> http://127.0.0.1:3190
npm run dashboard  # dashboard -> http://127.0.0.1:3191/dashboard
```

Kiểm tra:

```bash
curl http://127.0.0.1:3190/healthz
curl http://127.0.0.1:3190/v1/models -H "x-api-key: $(cat secrets/api-key.txt)"
```

## Cấu hình

`config.json` (xem `config.example.json`):

| Trường | Ý nghĩa |
|---|---|
| `port` | Cổng gateway, mặc định `3190`. |
| `allowedHosts` | Host header được chấp nhận, ngoài loopback. Để trống nếu chạy nội bộ. |
| `publicBaseUrl` | Origin công khai mà dashboard in ra cho client. `null` = suy ra từ request. |
| `apiKeyFile` | Đường dẫn khóa chính, mặc định `secrets/api-key.txt`. |
| `qaApiKeyFile` | Khóa phụ cho kiểm thử; để trống nếu không cần. |
| `accounts.entries` | Danh sách tài khoản; `desktopAuthFile` trỏ tới snapshot. |
| `accounts.rotation` | `round-robin` hoặc `manual`. |
| `limits.concurrency` | Số request xử lý đồng thời. |
| `limits.requestsPerMinute` | Cửa sổ trượt 60 giây. |
| `limits.bodyBytes` | Trần kích thước body, mặc định 24 MiB. |
| `limits.deadlineMs` | Hạn toàn bộ request, mặc định 10 phút. |
| `limits.nonStreamDeadlineMs` | Hạn riêng cho request không stream. |
| `limits.upstreamRetries` | Số lần retry, tối đa 5. |
| `limits.queueSize` / `queueWaitMs` | Hàng chờ khi đủ tải. |

Biến môi trường:

| Biến | Dùng cho |
|---|---|
| `BUDDY_ROOT` | Đặt thư mục dữ liệu khác với thư mục mã nguồn. |
| `BUDDY_PUBLIC_ORIGIN` | Ghi đè origin công khai mà dashboard hiển thị. |
| `BUDDY_GATEWAY_URL` / `BUDDY_GATEWAY_PORT` | Địa chỉ dashboard gọi tới gateway. |
| `BUDDY_DASHBOARD_PORT` | Cổng dashboard, mặc định `3191`. |
| `BUDDY_WORKBUDDY_HELPER` | Đường dẫn `host-heartbeat-*.js` của `dsh-workbuddy-connect`. |
| `BUDDY_WORKBUDDY_HELPER_SHA256` | Hash của file trên, nếu bản cài khác phiên bản. |
| `BUDDY_DSH_NODE_MODULES` | Thư mục `node_modules` chứa hai peer của DSH. |
| `BUDDY_DSH_ATOMIC_WRITE_SHA256` / `BUDDY_DSH_HOME_PATHS_SHA256` | Hash hai peer. |
| `WORKBUDDY_AI_AUTH_FILE` / `WORKBUDDY_AI_ELECTRON_BIN` | Đường dẫn file auth và app desktop khi chụp tài khoản. |

## API

### Xác thực

```http
x-api-key: buddy_sk_...
```

hoặc

```http
Authorization: Bearer buddy_sk_...
```

Nếu gửi cả hai, cả hai phải cùng một khóa hợp lệ. `GET /healthz` là endpoint duy nhất không cần khóa.

### Endpoint

| Method | Path | Ghi chú |
|---|---|---|
| `GET` | `/v1/models` | Danh mục model, kèm `billing`, `max_context_window`. Khóa bị giới hạn chỉ thấy model được cấp. |
| `GET` | `/v1/status` | Uptime, tải, giới hạn, trạng thái upstream. Không lộ khóa hay tài khoản. |
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions, hỗ trợ `stream`. |
| `POST` | `/v1/messages` | Anthropic Messages. |
| `POST` | `/v1/responses` | OpenAI Responses. |
| `POST` | `/v1/account` | Chọn tài khoản đang dùng. |
| `POST` | `/v1/account/rotation` | Đổi chế độ `manual` / `round-robin`. |
| `POST` | `/v1/account/register` | Nạp snapshot mới vào cổng. |
| `GET` | `/healthz` | Kiểm tra tiến trình, không kiểm tra quota. |

### Ví dụ

```bash
curl https://your-host/v1/chat/completions \
  -H "x-api-key: buddy_sk_..." \
  -H "content-type: application/json" \
  -d '{
    "model": "deepseek-v4.1-flash",
    "messages": [{"role": "user", "content": "Xin chào"}],
    "stream": false
  }'
```

```python
from openai import OpenAI

client = OpenAI(base_url="https://your-host/v1", api_key="buddy_sk_...")
reply = client.chat.completions.create(
    model="deepseek-v4.1-flash",
    messages=[{"role": "user", "content": "Xin chào"}],
)
print(reply.choices[0].message.content)
```

### Mã lỗi

| Mã | HTTP | Nghĩa |
|---|---|---|
| `unauthorized` | 401 | Thiếu hoặc sai khóa. |
| `model_not_found` | 404 | Model không có trong catalog. |
| `model_not_allowed` | 403 | Model có thật nhưng khóa không được cấp. |
| `context_too_large` | 400 | Hội thoại vượt ngữ cảnh model. |
| `body_too_large` | 413 | Body vượt trần byte. |
| `upstream_rate_limited` | 429 | Upstream trả 429 sau khi đã retry. |
| `accounts_cooling_down` | 429 | Mọi tài khoản đang cooldown. |
| `busy` | 429 | Hàng chờ đầy. |
| `timeout` | 504 | Quá hạn request. |

## Dashboard

`http://127.0.0.1:3191/dashboard`, đăng nhập bằng `secrets/dashboard-key.txt`. Một lần đăng nhập giữ 12 giờ (cookie `HttpOnly`, `SameSite=Lax`, `Secure` sau proxy).

| Trang | Nội dung |
|---|---|
| `/dashboard/` | Request hôm nay, tỷ lệ lỗi thật, tỷ lệ nghẽn 429, p50/p95, biểu đồ 60 phút, 14 ngày. |
| `/dashboard/models` | 19 model, tách miễn phí/trả phí, ngữ cảnh max, tìm kiếm, lọc, ẩn/hiện cột. |
| `/dashboard/accounts` | Đăng nhập WorkBuddy qua web, chọn tài khoản, xoay vòng, cảnh báo trùng địa chỉ. |
| `/dashboard/usage` | Input/Output/Cache write/Cache read, tổng hợp theo tài khoản và model, bảng từng request. |
| `/dashboard/logs` | Lọc theo kết quả/tài khoản/model/giao thức, xem JSON, xuất CSV. |
| `/dashboard/keys` | Base URL, hướng dẫn, tạo khóa, phân quyền model, thu hồi. |

### Đọc số liệu token

- `input_tokens` = `prompt_tokens` của upstream, **đã bao gồm** cache read (chứng minh bằng `prompt_cache_hit_tokens + prompt_cache_miss_tokens === prompt_tokens`).
- `output_tokens` = `completion_tokens`.
- `cache_write_tokens` chỉ lấy từ `prompt_cache_write_tokens` hoặc `cache_creation_input_tokens`; không suy ra từ input.
- `cache_read_tokens` chỉ lấy từ `prompt_cache_hit_tokens`, `prompt_tokens_details.cached_tokens` hoặc `cache_read_input_tokens`.
- Trường vắng mặt là `null` → "Không có dữ liệu", khác với `0`.
- Retry cộng usage thực nhận của từng lần gọi, không nhân usage của phản hồi cuối.

## Bảo mật

- Khóa API lưu dưới dạng SHA-256, so sánh bằng `timingSafeEqual` trên toàn bộ khóa đang hoạt động.
- Snapshot tài khoản và file khóa có ACL chỉ tài khoản service (Windows) hoặc mode `600`.
- Token đăng nhập, API key và cookie không bao giờ vào log, HTML hay JSON trả về trình duyệt.
- Dashboard chặn người chưa xác thực ở cả trang và API; ghi dữ liệu phải cùng origin.
- `secrets/`, `data/`, `run/`, `logs/` nằm trong `.gitignore`.

## Kiểm thử

```bash
npm test
```

66+ ca, gồm: mapping usage cho streaming và non-streaming, cache có/không/thiếu, retry không nhân usage, cooldown và `Retry-After`, giới hạn 5 lần retry, phân quyền model ở gateway, vòng đời khóa, phiên đăng nhập, và hợp đồng các trang dashboard.

## Triển khai

Thư mục `deployment/` chứa bộ chạy Windows qua Task Scheduler:

- `Supervise-Buddy.ps1` giữ gateway và tunnel, tự khởi động lại khi tiến trình chết.
- `launch-manifest.json` pin SHA-256 của các file quan trọng; sửa file phải cập nhật hash trước khi restart.
- `Start-Buddy-Service.ps1`, `Start-Buddy-Gateway.ps1`, `Start-Buddy-Tunnel.ps1` khởi động từng phần.
- `cloudflared.yml` là cấu hình tunnel mẫu; thay `tunnel`, `credentials-file` và hostname bằng của bạn.

Sau khi sửa `dashboard/public`:

```bash
npm run build
```

Sau khi sửa `server.mjs`, `adapter.mjs`, `config.json`, `usage.mjs`, `apikeys.mjs` hoặc `cloudflared.yml`: cập nhật hash trong `deployment/launch-manifest.json` **trước khi** restart.

## Phụ thuộc ngoài

`adapter.mjs` dùng lại helper MIT `dsh-workbuddy-connect` (không chép mã vào repo) và hai peer của DSH. Cả ba được kiểm hash trước khi nạp. Nếu bản cài của bạn khác phiên bản, đặt biến môi trường tương ứng thay vì sửa mã:

```bash
# Đặt trong .env.local rồi export, hoặc cấu hình trong process manager.
export BUDDY_WORKBUDDY_HELPER=/path/to/host-heartbeat-XXXX.js
export BUDDY_WORKBUDDY_HELPER_SHA256=<sha256>
export BUDDY_DSH_NODE_MODULES=/path/to/node_modules
```

Thiếu phụ thuộc, gateway trả `503 adapter_dependency_unavailable` thay vì chạy với mã chưa kiểm.

Nếu không đặt biến, adapter tự tìm: cạnh package, đi ngược các thư mục cha, rồi từng profile trong `~/.dsh/profiles/*/node_modules`.

## Giấy phép

Mã nguồn trong repo này: xem `LICENSE`. Helper và peer bên thứ ba giữ giấy phép gốc của chúng.
