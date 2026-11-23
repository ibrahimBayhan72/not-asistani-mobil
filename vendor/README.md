# Üçüncü taraf kütüphaneler

Çevrimdışı çalışma ve Manifest V3 kuralları (uzak kod yasağı) gereği yerel kopyalardır. Değiştirilmemiştir.

| Dosya | Paket | Sürüm | Lisans | Kaynak |
|---|---|---|---|---|
| `qrcode-generator.js` | qrcode-generator (Kazuhiko Arase) | 1.4.4 | MIT (dosya başlığında) | registry.npmjs.org |
| `jsQR.js` | jsqr (cozmo) | 1.4.0 | Apache-2.0 (`jsQR-LICENSE.txt`) | registry.npmjs.org |

Kullanım: QR oluşturma (`qrcode`) ve kameradan QR okuma (`jsQR`). Veriler hiçbir yere gönderilmez.

## Telefon uygulaması: kâğıttan okuma (`mobil/lib/`)

Yalnızca mobil uygulamada kullanılır; Chrome eklentisi paketine girmez.

| Dosya | Paket | Sürüm | Lisans | Kaynak |
|---|---|---|---|---|
| `pdfjs/pdf.min.js`, `pdf.worker.min.js` | pdfjs-dist (Mozilla) | 6.5.438 | Apache-2.0 (`pdfjs/LICENSE.txt`) | registry.npmjs.org |
| `opencv/opencv.js` | @techstark/opencv-js (OpenCV 5.0.0) | 5.0.0-release.1 | Apache-2.0 (`opencv/LICENSE.txt`) | registry.npmjs.org |
| `digit-net.json` | onnx/models `mnist-12` ağırlıkları (`tools/onnx-to-json.mjs` ile çevrildi) | mnist-12 | Apache-2.0 | github.com/onnx/models |

pdf.js dosyalarının uzantısı `.mjs` yerine `.js` yapıldı (bazı sunucular `.mjs`'i doğru türle sunmaz); içerik değişmemiştir.
Kullanım: sınav PDF'sinden puan kutularını bulmak; öğrenci kâğıdı fotoğrafını hizalamak ve el yazısı puanları okumak.
Fotoğraflar ve öğrenci bilgileri cihazdan çıkmaz.
