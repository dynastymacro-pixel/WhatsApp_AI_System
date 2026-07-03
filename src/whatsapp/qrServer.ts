// src/whatsapp/qrServer.ts
// Lightweight HTTP server that serves the WhatsApp pairing QR code as a
// scannable image in a browser.
//
// Why this exists:
//   Railway logs render in a web dashboard — ASCII QR codes printed to stdout
//   frequently have spacing/font issues that make them unscannable. This server
//   exposes a /qr endpoint returning an HTML page with the QR as a base64
//   PNG <img> you can open on any device and scan directly.
//
// Lifecycle:
//   - Server starts at boot on QR_SERVER_PORT (default 3001).
//   - GET /qr        → HTML page with scannable QR image (while waiting to pair)
//   - GET /qr        → "Connected ✅" page (after successful pairing)
//   - GET /health    → 200 OK always (for Railway healthcheck when HTTP added)
//   - Server stays up indefinitely; it's cheap and useful for reconnection events.

import http from 'http';
import QRCode from 'qrcode';
import { logger } from '../utils/logger';
import { config } from '../config';

// Current QR data string — null means either not yet received or already paired
let currentQrData: string | null = null;
let isPaired = false;

/** Called by BaileysAdapter when a new QR is received from WhatsApp. */
export function setQrData(qr: string): void {
  currentQrData = qr;
  isPaired = false;
}

/** Called by BaileysAdapter when the connection is successfully opened. */
export function markPaired(): void {
  isPaired = true;
  currentQrData = null;
}

/** Called by BaileysAdapter when connection closes (resets paired state). */
export function resetPaired(): void {
  isPaired = false;
}

async function buildQrPage(qrData: string): Promise<string> {
  const dataUrl = await QRCode.toDataURL(qrData, {
    errorCorrectionLevel: 'M',
    width: 350,
    margin: 2,
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>ZapSell — Scan to Connect WhatsApp</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      display: flex; flex-direction: column; align-items: center;
      justify-content: center; min-height: 100vh; margin: 0;
      background: #0f172a; color: #f1f5f9;
    }
    h1 { font-size: 1.4rem; margin-bottom: 0.5rem; }
    p  { color: #94a3b8; margin-bottom: 1.5rem; font-size: 0.9rem; }
    img {
      border-radius: 16px; padding: 16px; background: #fff;
      box-shadow: 0 0 0 4px #1e293b;
    }
    .note { margin-top: 1.5rem; font-size: 0.8rem; color: #64748b; }
    .refresh { margin-top: 1rem; }
    .refresh a {
      color: #38bdf8; text-decoration: none; font-size: 0.85rem;
    }
  </style>
  <meta http-equiv="refresh" content="30" />
</head>
<body>
  <h1>📱 ZapSell — WhatsApp Pairing</h1>
  <p>Open WhatsApp → Linked Devices → Link a Device → scan this code</p>
  <img src="${dataUrl}" alt="WhatsApp QR Code" width="350" height="350" />
  <div class="note">This page auto-refreshes every 30 seconds. QR codes expire after ~60s.</div>
  <div class="refresh"><a href="/qr">↻ Refresh now</a></div>
</body>
</html>`;
}

const connectedPage = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>ZapSell — Connected</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      display: flex; flex-direction: column; align-items: center;
      justify-content: center; min-height: 100vh; margin: 0;
      background: #0f172a; color: #f1f5f9;
    }
    h1 { font-size: 1.8rem; }
    p  { color: #4ade80; font-size: 1rem; }
  </style>
</head>
<body>
  <h1>✅ WhatsApp Connected</h1>
  <p>Your WhatsApp number is paired and active. No further action needed.</p>
</body>
</html>`;

const waitingPage = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>ZapSell — Waiting for QR</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      display: flex; flex-direction: column; align-items: center;
      justify-content: center; min-height: 100vh; margin: 0;
      background: #0f172a; color: #f1f5f9;
    }
    p { color: #94a3b8; }
  </style>
  <meta http-equiv="refresh" content="3" />
</head>
<body>
  <h1>⏳ Waiting for QR code...</h1>
  <p>This page auto-refreshes every 3 seconds.</p>
</body>
</html>`;

let server: http.Server | null = null;

export function startQrServer(): void {
  // Railway injects $PORT and routes public traffic exclusively to that port.
  // Any other port is not publicly reachable on Railway.
  // Locally, fall back to QR_SERVER_PORT (default 3001) so we don't conflict
  // with other local services.
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : config.qrServerPort;

  server = http.createServer(async (req, res) => {
    const url = req.url ?? '/';

    if (url === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('OK');
      return;
    }

    if (url === '/qr' || url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });

      if (isPaired) {
        res.end(connectedPage);
        return;
      }

      if (!currentQrData) {
        res.end(waitingPage);
        return;
      }

      try {
        const html = await buildQrPage(currentQrData);
        res.end(html);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Error generating QR image');
        logger.error({ err }, '[QRServer] Failed to generate QR image');
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  });

  server.listen(port, () => {
    const isRailway = !!process.env.PORT;
    const hint = isRailway
      ? `your Railway public domain + /qr`
      : `http://localhost:${port}/qr`;
    logger.info(
      { port, hint },
      `[QRServer] QR pairing server listening — open ${hint} to scan`,
    );
  });

  server.on('error', (err) => {
    logger.error({ err: err.message }, '[QRServer] Server error');
  });
}

export function stopQrServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!server) { resolve(); return; }
    server.close(() => resolve());
  });
}
