# Đóng góp

## Trước khi gửi thay đổi

```bash
npm run check     # cú pháp các module chính
npm run build     # sinh lại trang và release.json
npm test          # toàn bộ ca kiểm thử
```

## Quy ước

- **Không commit bí mật.** `secrets/`, `data/`, `run/`, `logs/` đã nằm trong `.gitignore`. Nếu lỡ commit, thu hồi khóa ngay rồi mới xóa lịch sử.
- **Không hard-code host.** Origin công khai lấy từ request hoặc `publicBaseUrl`; xem `dashboard/public-origin.mjs`.
- **Không bịa số liệu.** Trường usage thiếu phải là `null` và hiển thị "Không có dữ liệu".
- **Sửa `dashboard/pages/*.html` thì chạy `npm run build`.** `dashboard/public/*.html` là file sinh ra, không sửa trực tiếp.
- **Sửa file được pin hash thì cập nhật `deployment/launch-manifest.json`** trước khi restart: `server.mjs`, `adapter.mjs`, `config.json`, `usage.mjs`, `apikeys.mjs`, `cloudflared.yml`.
- **Test mới đi kèm hành vi mới.** Đặt ở `tests/` cho gateway, `dashboard/tests/` cho dashboard.

## Kiểm tra giao diện

Sau khi sửa CSS hoặc trang, kiểm ở 1440, 768 và 390 px: không tràn ngang, không lỗi console, mọi nút bấm được.

## Giấy phép đóng góp

Khi gửi thay đổi, bạn đồng ý phát hành phần đóng góp đó theo giấy phép MIT của repo này.
