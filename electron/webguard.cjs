// Pure web-fetch guards shared by the Electron main-process fetcher.
// No network, no deps. Node/CommonJS so main.cjs can require it directly and
// tests can unit-test it.
'use strict';

function ipv4Int(host) {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = value * 256 + n;
  }
  return value >>> 0;
}

/** Best-effort classification of host strings that are private/loopback/link-local. */
function isPrivateHost(host) {
  if (!host) return false;
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === 'localhost' || normalized.endsWith('.localhost') || normalized.endsWith('.local')) return true;
  if (normalized.includes(':')) {
    // IPv6 (basic): loopback, unspecified, unique-local fc00::/7, link-local fe80::/10
    if (normalized === '::1' || normalized === '::' || normalized === '0:0:0:0:0:0:0:1') return true;
    if (/^f[cd]/i.test(normalized.replace(/::.*$/, '')) || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) return true;
    return false;
  }
  const int = ipv4Int(normalized);
  if (int === null) return false;
  if (int === 0) return true; // 0.0.0.0
  if ((int >>> 24) === 127) return true; // 127.0.0.0/8
  if ((int >>> 24) === 10) return true; // 10.0.0.0/8
  if (int >= 0xac100000 && int <= 0xac1fffff) return true; // 172.16.0.0/12
  if ((int >>> 16) === 0xc0a8) return true; // 192.168.0.0/16
  if ((int >>> 16) === 0xa9fe) return true; // 169.254.0.0/16
  return false;
}

function hasUserinfo(url) {
  return Boolean(url.username || url.password);
}

/**
 * Validate that following a redirect from `fromUrl` to `toUrl` is permitted.
 * Direct loopback/private destinations are allowed (user explicitly analyses
 * local servers); a public page redirecting to a private/local destination is
 * blocked (SSRF via redirect).
 */
function validateRedirectTarget(fromUrl, toUrl) {
  if (toUrl.protocol !== 'http:' && toUrl.protocol !== 'https:') {
    return { ok: false, reason: 'Redirect used a non-http(s) scheme.' };
  }
  if (hasUserinfo(toUrl)) {
    return { ok: false, reason: 'Redirect URL contains embedded credentials.' };
  }
  const fromPrivate = isPrivateHost(fromUrl.hostname);
  const toPrivate = isPrivateHost(toUrl.hostname);
  if (!fromPrivate && toPrivate) {
    return { ok: false, reason: 'Redirect to a private/local address was blocked.' };
  }
  return { ok: true };
}

module.exports = { isPrivateHost, hasUserinfo, validateRedirectTarget };