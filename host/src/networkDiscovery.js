const os = require('os');
const { exec } = require('child_process');
const QRCode = require('qrcode');

let bonjourInstance = null;

// ─── IP Detection ─────────────────────────────────────────────────────────────

// Adapter name patterns that indicate virtual / VPN interfaces (lower score)
const VIRTUAL_PATTERNS = [
  /vmware/i, /virtualbox/i, /vbox/i,
  /hyper-v/i, /hyper_v/i, /vethernet/i,
  /wsl/i, /loopback/i, /pseudo/i,
  /tap/i, /tun/i,
  /tailscale/i, /hamachi/i, /radmin/i,
  /nordvpn/i, /expressvpn/i, /openvpn/i,
  /docker/i, /container/i,
  /bluetooth/i,
];

// Adapter name patterns that indicate a real LAN interface (higher score)
const PREFERRED_PATTERNS = [
  /wi.?fi/i, /wlan/i, /wireless/i,
  /ethernet/i, /local area/i, /realtek/i, /intel/i,
];

/**
 * Score a network interface name. Higher = more likely to be the LAN adapter.
 */
function scoreInterface(name) {
  if (!name) return 0;
  for (const pat of VIRTUAL_PATTERNS) {
    if (pat.test(name)) return -100;
  }
  for (const pat of PREFERRED_PATTERNS) {
    if (pat.test(name)) return 10;
  }
  return 1; // Unknown but real — weakly preferred over virtual
}

/**
 * Return all non-loopback IPv4 addresses with interface names, sorted best-first.
 * @returns {Array<{ iface: string, address: string }>}
 */
function getAllLocalIPs() {
  const candidates = [];
  for (const [name, aliases] of Object.entries(os.networkInterfaces())) {
    for (const alias of aliases) {
      if (alias.family === 'IPv4' && !alias.internal) {
        candidates.push({ iface: name, address: alias.address, score: scoreInterface(name) });
      }
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates.map(({ iface, address }) => ({ iface, address }));
}

/**
 * Get the best-guess LAN IPv4 address for the QR code / join URL.
 * Prefers real WiFi/Ethernet adapters over virtual and VPN adapters.
 */
function getLocalIP() {
  const candidates = getAllLocalIPs();
  return candidates.length > 0 ? candidates[0].address : '127.0.0.1';
}

// ─── Windows Firewall ─────────────────────────────────────────────────────────

/**
 * On Windows, add an inbound firewall rule allowing TCP traffic on the given port.
 * No-op on other platforms.
 * @param {number} port
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
function ensureFirewallRule(port) {
  if (process.platform !== 'win32') {
    return Promise.resolve({ ok: true });
  }

  const ruleName = `BoardGame Platform Port ${port}`;
  // netsh requires elevated privileges; errors gracefully if not admin
  const cmd = `netsh advfirewall firewall add rule name="${ruleName}" dir=in action=allow protocol=TCP localport=${port}`;

  return new Promise((resolve) => {
    exec(cmd, (err, _stdout, stderr) => {
      if (err) {
        const reason = stderr?.trim() || err.message;
        console.warn(`[NET] Could not add firewall rule: ${reason}`);
        resolve({ ok: false, reason });
      } else {
        console.log(`[NET] Windows Firewall: inbound rule added for port ${port}`);
        resolve({ ok: true });
      }
    });
  });
}

// ─── mDNS ─────────────────────────────────────────────────────────────────────

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

// ─── Join Info ────────────────────────────────────────────────────────────────

/**
 * Generate the primary join URL and a QR code data URL for it.
 * @param {number} port — the HTTP server port
 * @returns {{ joinUrl: string, qrDataUrl: string|null, allIPs: Array<{iface,address}> }}
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

  return { joinUrl, qrDataUrl, allIPs: getAllLocalIPs() };
}

module.exports = {
  getLocalIP,
  getAllLocalIPs,
  ensureFirewallRule,
  advertise,
  stopAdvertising,
  generateJoinInfo,
};
