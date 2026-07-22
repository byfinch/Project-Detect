# VPS'ye Taşıma (Ubuntu 22.04+)

## 1. Kurulum

```bash
# Node 20+
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt install -y nodejs git nginx certbot python3-certbot-nginx

# Kullanıcı + dizin
sudo useradd -r -m -d /opt/project-detect detect || true
sudo mkdir -p /opt/project-detect && sudo chown detect:detect /opt/project-detect
```

## 2. Uygulama

```bash
sudo -u detect git clone <repo> /opt/project-detect/app || true
# veya scp ile: dist/, node_modules/, config/, .env, data/detect.sqlite kopyala
cd /opt/project-detect
npm ci --omit=dev
npm run build
```

## 3. AdsPower (Linux)

- AdsPower Linux client kur + Local API aç (port 50325).
- Profiller hesap-senkron gelir; `.env` aynen taşınır (ADSPOWER_*, TWOCAPTCHA_API_KEY, CAPSOLVER_API_KEY).
- Headless sunucuda sandbox sorunları için resmi AdsPower Linux notlarına bak.

## 4. systemd

```bash
sudo cp deploy/detect.service /etc/systemd/system/detect.service
sudo systemctl daemon-reload
sudo systemctl enable --now detect
journalctl -u detect -f
```

## 5. nginx + HTTPS

```bash
sudo cp deploy/nginx-detect.conf /etc/nginx/sites-available/detect
sudo ln -s /etc/nginx/sites-available/detect /etc/nginx/sites-enabled/
sudo certbot --nginx -d detect.ornek-domain.com
sudo nginx -t && sudo systemctl reload nginx
```

## 6. Panel güvenliği

- Panel login'i (session cookie) zaten zorunlu — PANEL_USER/PANEL_PASSWORD .env'de güçlü olsun.
- nginx'te `allow/deny` ile IP kısıtı ekleyebilirsin (conf'ta hazır yorum satırı).

## Notlar

- RAM: 10 paralel tarayıcı ≈ 7-10 GB → 12 GB VPS yeterli (Magnetar).
- data/detect.sqlite tek dosya — tüm geçmiş (tık, şikayet, mail havuzu, ip_trust) onunla taşınır.
- mail.tm yeni VPS IP'sinden de çalışır (hesaplar mail.tm tarafında, şifreler sqlite'ta).
