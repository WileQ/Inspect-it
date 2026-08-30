import type { AnalysisResult, AnalysisSection, Evidence, Finding, InspectionFile } from './types.ts';
import { digestHex, formatNumber, shortFingerprint } from './utils.ts';
import { evidence, finding, ensureNotAborted, extension, readBytes } from './analysis-utils.ts';

function identity(file: InspectionFile, format: string, fingerprint: string) {
  return {
    name: file.name,
    type: format,
    format,
    mimeType: file.mimeType,
    size: file.size,
    location: file.path,
    created: new Date(file.lastModified).toLocaleString(),
    modified: new Date(file.lastModified).toLocaleString(),
    fingerprint: shortFingerprint(fingerprint)
  };
}

interface MediaInfo {
  format: string;
  codec?: string;
  duration?: number;
  bitrate?: number;
  sampleRate?: number;
  channels?: number;
  bitsPerSample?: number;
  brand?: string;
  width?: number;
  height?: number;
  timescale?: number;
}

function readString(bytes: Uint8Array, start: number, end: number): string {
  return new TextDecoder('latin1').decode(bytes.slice(start, end)).replace(/\0.*$/, '');
}

function readUInt32BE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function readUInt32LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function parseWav(bytes: Uint8Array): MediaInfo | null {
  if (readString(bytes, 0, 4) !== 'RIFF' || readString(bytes, 8, 12) !== 'WAVE') return null;
  let offset = 12;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let byteRate = 0;
  let dataSize = 0;
  while (offset + 8 <= bytes.length) {
    const id = readString(bytes, offset, offset + 4);
    const size = readUInt32LE(bytes, offset + 4);
    if (id === 'fmt ') {
      channels = bytes[offset + 10] | (bytes[offset + 11] << 8);
      sampleRate = readUInt32LE(bytes, offset + 12);
      byteRate = readUInt32LE(bytes, offset + 16);
      bitsPerSample = bytes[offset + 22] | (bytes[offset + 23] << 8);
    }
    if (id === 'data') {
      dataSize = size;
      break;
    }
    offset += 8 + size + (size % 2);
  }
  const duration = byteRate ? dataSize / byteRate : 0;
  return { format: 'WAV', channels, sampleRate, bitsPerSample, duration, codec: 'PCM' };
}

function parseId3Text(bytes: Uint8Array): Record<string, string> {
  const tags: Record<string, string> = {};
  if (readString(bytes, 0, 3) !== 'ID3') return tags;
  let offset = 10;
  const size = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
  while (offset + 10 <= 10 + size && offset + 10 <= bytes.length) {
    const id = readString(bytes, offset, offset + 4);
    const frameSize = readUInt32BE(bytes, offset + 4);
    if (!id.trim() || frameSize <= 0) break;
    const payload = bytes.slice(offset + 10, offset + 10 + frameSize);
    if (payload.length) {
      const text = new TextDecoder('utf-8', { fatal: false }).decode(payload.slice(1)).replace(/\0.*$/, '').trim();
      if (['TIT2', 'TPE1', 'TALB', 'TCON', 'TRCK'].includes(id)) tags[id] = text;
    }
    offset += 10 + frameSize;
  }
  return tags;
}

function parseMp3(bytes: Uint8Array): MediaInfo | null {
  let offset = 0;
  if (readString(bytes, 0, 3) === 'ID3') {
    offset = 10 + (((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f));
  }
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] === 0xff && (bytes[offset + 1] & 0xe0) === 0xe0) {
      const versionBits = (bytes[offset + 1] >> 3) & 0x03;
      const layerBits = (bytes[offset + 1] >> 1) & 0x03;
      const bitrateIndex = (bytes[offset + 2] >> 4) & 0x0f;
      const sampleRateIndex = (bytes[offset + 2] >> 2) & 0x03;
      const channelMode = (bytes[offset + 3] >> 6) & 0x03;
      const bitrateTable = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
      const sampleRateTable = [44100, 48000, 32000, 0];
      const bitrate = bitrateTable[bitrateIndex] || 0;
      const sampleRate = sampleRateTable[sampleRateIndex] || 0;
      const duration = bitrate ? (bytes.length * 8) / (bitrate * 1000) : 0;
      return { format: 'MP3', bitrate, sampleRate, channels: channelMode === 3 ? 1 : 2, duration, codec: `MPEG ${versionBits}/${layerBits}` };
    }
    offset += 1;
  }
  return null;
}

function parseFlac(bytes: Uint8Array): MediaInfo | null {
  if (readString(bytes, 0, 4) !== 'fLaC') return null;
  if (bytes.length < 42) return { format: 'FLAC', codec: 'FLAC' };
  const sampleRate = (bytes[18] << 12) | (bytes[19] << 4) | (bytes[20] >> 4);
  const channels = ((bytes[20] >> 1) & 0x07) + 1;
  const bitsPerSample = (((bytes[20] & 0x01) << 4) | (bytes[21] >> 4)) + 1;
  const totalSamples = ((bytes[21] & 0x0f) * 2 ** 32) | (bytes[22] << 24) | (bytes[23] << 16) | (bytes[24] << 8) | bytes[25];
  const duration = sampleRate ? totalSamples / sampleRate : 0;
  return { format: 'FLAC', sampleRate, channels, bitsPerSample, duration, codec: 'FLAC' };
}

function parseOgg(bytes: Uint8Array): MediaInfo | null {
  if (readString(bytes, 0, 4) !== 'OggS') return null;
  const codec = readString(bytes, 28, 36).includes('Opus') ? 'Opus' : 'Vorbis';
  const channels = bytes[37] ?? 0;
  const sampleRate = readUInt32LE(bytes, 40);
  return { format: 'OGG', channels, sampleRate, codec, duration: 0 };
}

/**
 * Parse the ISO-BMFF (MP4/MOV/M4A) box structure for duration (mvhd) and
 * display size (tkhd). Only container metadata is read; no frames are decoded.
 */
function parseMp4(bytes: Uint8Array): MediaInfo | null {
  if (readString(bytes, 4, 8) !== 'ftyp') {
    return null;
  }
  const brand = readString(bytes, 8, 12);
  let timescale = 0;
  let duration = 0;
  let width = 0;
  let height = 0;
  const containerTypes = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'udta', 'mvex', 'moof', 'traf', 'edts']);
  const walk = (start: number, end: number): void => {
    let offset = start;
    let guard = 0;
    while (offset + 8 <= end && guard < 8000) {
      guard += 1;
      let size = readUInt32BE(bytes, offset);
      const type = readString(bytes, offset + 4, offset + 8);
      if (size === 1 && offset + 16 <= end) {
        const hi = readUInt32BE(bytes, offset + 8);
        const lo = readUInt32BE(bytes, offset + 12);
        size = hi > 0x1fffff ? end - offset : hi * 2 ** 32 + lo;
      }
      if (size < 8 || offset + size > end) {
        break;
      }
      if (type === 'mvhd') {
        const version = bytes[offset + 8];
        if (version === 1) {
          timescale = readUInt32BE(bytes, offset + 28);
          duration = readUInt32BE(bytes, offset + 32) * 2 ** 32 + readUInt32BE(bytes, offset + 36);
        } else {
          timescale = readUInt32BE(bytes, offset + 20);
          duration = readUInt32BE(bytes, offset + 24);
        }
      }
      if (type === 'tkhd') {
        const version = bytes[offset + 8];
        const trackOffset = version === 1 ? offset + 88 : offset + 84;
        if (trackOffset + 8 <= offset + size) {
          width = readUInt32BE(bytes, trackOffset) / 65536;
          height = readUInt32BE(bytes, trackOffset + 4) / 65536;
        }
      }
      if (containerTypes.has(type)) {
        walk(offset + 8, offset + size);
      }
      offset += size;
    }
  };
  walk(0, bytes.length);
  return {
    format: 'MP4',
    brand,
    codec: 'MPEG-4',
    duration: timescale ? duration / timescale : 0,
    sampleRate: 0,
    channels: 0,
    width,
    height,
    timescale
  };
}

function parseEbmlContainer(bytes: Uint8Array): MediaInfo | null {
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    const text = new TextDecoder('latin1').decode(bytes.slice(0, 4 * 1024));
    if (text.includes('webm')) return { format: 'WebM', codec: 'WebM (VP8/VP9/AV1 container)' };
    if (text.includes('matroska')) return { format: 'MKV', codec: 'Matroska container' };
    return { format: 'EBML', codec: 'Unknown EBML container' };
  }
  return null;
}

function parseAvi(bytes: Uint8Array): MediaInfo | null {
  if (readString(bytes, 0, 4) !== 'RIFF' || readString(bytes, 8, 12) !== 'AVI ') return null;
  const text = new TextDecoder('latin1').decode(bytes.slice(0, 2 * 1024 * 1024));
  const widthMatch = text.match(/avih.{20}(.{4})/s);
  const microSecPerFrame = widthMatch ? readUInt32LE(new Uint8Array([...widthMatch[1]].map((c) => c.charCodeAt(0))), 0) : 0;
  const duration = microSecPerFrame ? (bytes.length / 1024 / 1024) / 2 : 0;
  return { format: 'AVI', codec: 'AVI container', duration, sampleRate: 0, channels: 0, width: 0, height: 0 };
}

export async function analyzeMediaFile(file: InspectionFile, options: { signal: AbortSignal }): Promise<AnalysisResult | null> {
  ensureNotAborted(options.signal);
  const ext = extension(file.name);
  if (!['wav', 'mp3', 'flac', 'ogg', 'm4a', 'mp4', 'mov', 'mkv', 'webm', 'avi'].includes(ext) && !/^audio\//.test(file.mimeType) && !/^video\//.test(file.mimeType)) {
    return null;
  }
  const bytes = await readBytes(file, 32 * 1024 * 1024);
  const fingerprint = await digestHex(bytes);
  const tags = parseId3Text(bytes);
  const parsed: MediaInfo = parseWav(bytes) || parseMp3(bytes) || parseFlac(bytes) || parseOgg(bytes) || parseMp4(bytes) || parseEbmlContainer(bytes) || parseAvi(bytes) || { format: ext.toUpperCase() || 'MEDIA', codec: 'Unknown' };
  const duration = parsed.duration ?? 0;
  const bitrate = parsed.bitrate ?? (duration ? Math.round((bytes.length * 8) / duration / 1000) : 0);
  const evidenceList: Evidence[] = [
    evidence('media-format', 'Format', parsed.format),
    evidence('media-duration', 'Duration', duration ? `${duration.toFixed(2)} s` : 'Unknown'),
    evidence('media-bitrate', 'Bitrate', bitrate ? `${formatNumber(bitrate)} kbps` : 'Unknown'),
    evidence('media-sample-rate', 'Sample rate', parsed.sampleRate ? `${formatNumber(parsed.sampleRate)} Hz` : 'Unknown'),
    evidence('media-channels', 'Channels', parsed.channels ? formatNumber(parsed.channels) : 'Unknown'),
    evidence('media-codec', 'Codec', parsed.codec || 'Unknown')
  ];
  if (parsed.width && parsed.height) {
    evidenceList.push(evidence('media-resolution', 'Resolution', `${Math.round(parsed.width)} x ${Math.round(parsed.height)}`));
  }
  if (parsed.brand) {
    evidenceList.push(evidence('media-brand', 'MP4 brand', parsed.brand));
  }
  Object.entries(tags).forEach(([key, value]) => evidenceList.push(evidence(`media-tag-${key}`, key, value)));
  const sections: AnalysisSection[] = [
    { id: 'media-facts', title: 'Facts', items: evidenceList.slice(0, 8) },
    { id: 'media-tags', title: 'Structure', items: Object.entries(tags).length ? Object.entries(tags).map(([key, value]) => evidence(`media-tag-${key}`, key, value)) : [evidence('media-tags-none', 'Metadata tags', 'No embedded tags detected')] }
  ];
  const unusual: Finding[] = [];
  if (!duration && (ext === 'mp4' || ext === 'mov' || ext === 'm4a')) unusual.push(finding('media-unknown-duration', 'Duration unavailable', 'The container format was recognized, but duration could not be estimated safely.', 'low', ['media-duration']));
  const summary = `${parsed.format} ${duration ? `${duration.toFixed(2)} s` : 'unknown duration'}`;
  return {
    objectKind: 'file',
    analyzerId: 'media',
    analyzerName: 'Media analyzer',
    capabilities: ['metadata', 'duration', 'codec', 'tags', 'stream-structure'],
    limitations: ['Metadata and stream structure only; no full decode'],
    targetName: file.name,
    identity: identity(file, parsed.format, fingerprint),
    sections,
    important: [],
    unusual,
    recommendations: [],
    evidence: evidenceList,
    progressLabel: 'Media analysis complete',
    cacheKey: fingerprint,
    generatedAt: new Date().toISOString(),
    sourceSummary: summary
  };
}
