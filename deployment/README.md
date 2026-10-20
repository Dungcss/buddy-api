# Triển khai

Bộ script này chạy Buddy API như một dịch vụ trên Windows qua Task Scheduler. Trên Linux, dùng `systemd` với cùng các biến môi trường và lệnh `node server.mjs` / `node dashboard/dashboard.mjs`.

## Chuẩn bị

```powershell
Copy-Item deployment\launch-manifest.example.json deployment\launch-manifest.json
```

Điền `serviceRoot`, `hostname`, `tunnelId`, rồi thay mọi `REPLACE` bằng hash thật:

```powershell
function Hash($p) { (Get-FileHash $p -Algorithm SHA256).Hash.ToLowerInvariant() }
Hash server.mjs; Hash adapter.mjs; Hash apikeys.mjs; Hash config.json
Hash usage.mjs; Hash protocol-common.mjs; Hash messages.mjs; Hash responses.mjs
Hash cloudflared.yml; Hash deployment\Supervise-Buddy.ps1
```

`localVerified` chỉ đặt `true` sau khi `curl http://127.0.0.1:3190/healthz` trả `{"status":"ok"}`.

## Biến môi trường

| Biến | Mặc định |
|---|---|
| `BUDDY_ROOT` | thư mục cha của `deployment/` |
| `BUDDY_NODE` | `node.exe` trong `PATH` |
| `BUDDY_CLOUDFLARED` | `cloudflared.exe` trong `PATH` |
| `BUDDY_GUARDS` | `[]` — JSON `[{ "path": "...", "hash": "..." }]` cho file của dịch vụ khác cần bảo vệ |

## Chạy

```powershell
# Gateway + tunnel
.\deployment\Start-Buddy-Service.ps1

# Supervisor (giữ tiến trình sống, tự khởi động lại)
.\deployment\Install-Buddy-LogonTask.ps1

# Dashboard (task riêng)
.\deployment\Enable-Buddy-Recovery.ps1
```

## Vòng sửa → phát hành

1. Sửa mã.
2. Nếu sửa `dashboard/public` hoặc `dashboard/pages`: `npm run build`.
3. Nếu sửa file được pin: cập nhật hash trong `launch-manifest.json`.
4. Restart **chỉ thành phần cần thiết**:

```powershell
# Dashboard: dừng task, kill node mồ côi giữ cổng 3191, rồi start lại.
Stop-ScheduledTask -TaskName "TLPRO Buddy Dashboard"
Get-CimInstance Win32_Process -Filter "name='node.exe'" |
  Where-Object { $_.CommandLine -like '*dashboard.mjs*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-ScheduledTask -TaskName "TLPRO Buddy Dashboard"

# Gateway: dừng PID trong run\gateway.json; supervisor tự bật lại.
$state = Get-Content run\gateway.json -Raw | ConvertFrom-Json
Stop-Process -Id $state.ProcessId -Force
```

Không kill tunnel khi chỉ sửa dashboard: tunnel giữ nguyên PID và hostname.

## Lưu ý

- `Stop-ScheduledTask` không giết tiến trình con; phải kill `node.exe` có `dashboard.mjs` trong command line, nếu không cổng 3191 ở trạng thái LISTEN nhưng không trả lời.
- Mọi thay đổi hash phải làm **trước** khi restart, nếu không launcher từ chối khởi động.
- `cloudflared.example.yml` đặt rule `/dashboard` trước rule hostname để một tên miền phục vụ cả API và dashboard.
