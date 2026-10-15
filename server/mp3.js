// Minimal MPEG-1 Layer III frame splitter.
//
// The broadcaster paces audio in whole frames so every chunk a listener receives (including
// the replay buffer sent on join) starts on a frame boundary. Browsers detect an MP3 stream
// that starts mid-frame only after buffering seconds of extra data.

const BITRATES_KBPS = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const SAMPLE_RATES = [44100, 48000, 32000, 0];

/** Byte length of the MPEG-1 Layer III frame whose header starts at `offset`, or 0 if invalid. */
export function frameLength(buf, offset) {
  if (offset + 4 > buf.length) return 0;
  // Sync word (11 bits), MPEG-1 (0b11), Layer III (0b01).
  if (buf[offset] !== 0xff || (buf[offset + 1] & 0xfe) !== 0xfa) return 0;
  const bitrate = BITRATES_KBPS[buf[offset + 2] >> 4];
  const sampleRate = SAMPLE_RATES[(buf[offset + 2] >> 2) & 0x03];
  if (!bitrate || !sampleRate) return 0;
  const padding = (buf[offset + 2] >> 1) & 0x01;
  return Math.floor((144_000 * bitrate) / sampleRate) + padding;
}

/** Splits an MP3 byte stream into whole frames; push() any chunking, get frames back. */
export class FrameSplitter {
  #pending = Buffer.alloc(0);

  /** @returns {Buffer[]} complete frames found so far */
  push(chunk) {
    const buf = this.#pending.length ? Buffer.concat([this.#pending, chunk]) : chunk;
    const frames = [];
    let offset = 0;
    while (offset + 4 <= buf.length) {
      const length = frameLength(buf, offset);
      if (length === 0) {
        offset++; // not a frame header: resync
        continue;
      }
      if (offset + length > buf.length) break; // incomplete frame, wait for more
      frames.push(buf.subarray(offset, offset + length));
      offset += length;
    }
    this.#pending = Buffer.from(buf.subarray(offset));
    return frames;
  }
}
