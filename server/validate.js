export class ValidationError extends Error {}

/**
 * Finds the first http(s) link in pasted text, e.g. an app's share message like
 * "Listen to X on #SoundCloud https://on.soundcloud.com/abc". Returns the trimmed input
 * unchanged when it contains no link.
 * @param {string} text
 */
export function extractUrl(text) {
  const match = text.match(/https?:\/\/[^\s<>"']+/i);
  // Drop punctuation that ends the sentence rather than the link.
  return match ? match[0].replace(/[.,;:!?)\]]+$/, '') : text.trim();
}

/**
 * Checks a user-submitted URL before it is handed to yt-dlp.
 * @param {unknown} input
 * @param {string[]} allowedDomains lowercase hostnames; ["*"] allows any host
 * @returns {string} normalized URL
 */
export function parseTrackUrl(input, allowedDomains) {
  if (typeof input !== 'string' || input.length === 0 || input.length > 2048) {
    throw new ValidationError('Please paste a link.');
  }

  let url;
  try {
    url = new URL(extractUrl(input));
  } catch {
    throw new ValidationError('That does not look like a valid link.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ValidationError('Only http(s) links are supported.');
  }

  const host = url.hostname.toLowerCase();
  const allowed =
    allowedDomains.includes('*') ||
    allowedDomains.some((domain) => host === domain || host.endsWith(`.${domain}`));
  if (!allowed) {
    throw new ValidationError(`Links from ${host} are not allowed here.`);
  }

  return url.toString();
}

/** True if `input` is an http(s) URL on an allowed host. Used for playlist entries. */
export function isAllowedUrl(input, allowedDomains) {
  try {
    parseTrackUrl(input, allowedDomains);
    return true;
  } catch {
    return false;
  }
}

/** Trims an optional display name; returns null when empty. */
export function parseName(input) {
  if (typeof input !== 'string') return null;
  const name = input.trim().slice(0, 32);
  return name || null;
}
