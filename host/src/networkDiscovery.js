const os = require('os');
const QRCode = require('qrcode');

let bonjourInstance = null;

/**
 * Get the machine's first non-internal IPv4 address.
 */
function getLocalIP() {
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const alias of iface) {
      if (alias.family === 'IPv4' && !alias.internal) {
        return alias.address;
      }
    }
  }
  return '127.0.0.1';
}

/**
 * Start mDNS advertisement so phones on the LAN can discover the host.
 * @param {number} port — the HTTP server port
 */
function advertise(port) {
  try {
    const bonjour = require('bonjour');
    bonjourInstance = bonjour();
    bonjourInstance.publish({
      name: 'BoardGame Platform',
      type: 'boardgame',
      port,
    });
    console.log(`[NET] mDNS advertising on port ${port}`);
  } catch (err) {
    // bonjour is optional — doesn't block the app if unavailable
    console.warn('[NET] mDNS advertisement failed:', err.message);
  }
}

/**
 * Stop mDNS advertisement.
 */
function stopAdvertising() {
  if (bonjourInstance) {
    bonjourInstance.unpublishAll();
    bonjourInstance.destroy();
    bonjourInstance = null;
  }
}

/**
 * Generate the join URL and a QR code data URL for it.
 * @param {number} port — the HTTP server port
 * @returns {{ joinUrl: string, qrDataUrl: string }}
 */
async function generateJoinInfo(port) {
  const localIP = getLocalIP();
  const joinUrl = `http://${localIP}:${port}`;

  let qrDataUrl = null;
  try {
    qrDataUrl = await QRCode.toDataURL(joinUrl, {
      width: 256,
      margin: 2,
      color: { dark: '#f1f5f9', light: '#0f172a' },
    });
  } catch (err) {
    console.warn('[NET] QR code generation failed:', err.message);
  }

  return { joinUrl, qrDataUrl };
}

module.exports = { getLocalIP, advertise, stopAdvertising, generateJoinInfo };
