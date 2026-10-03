// Chrome native messaging framing: each message is a 4-byte little-endian
// length prefix followed by UTF-8 JSON. Chrome caps host->browser messages
// at 1 MB, so large payloads are split into ordered "chunk" frames that the
// extension reassembles (see extension/lib/native-port.js).

export const MAX_FRAME_BYTES = 1024 * 1024;
// Leave headroom for the chunk envelope itself.
export const CHUNK_BYTES = 768 * 1024;

export function encodeFrame(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

/**
 * Encode a message, splitting it into chunk frames if it exceeds Chrome's
 * 1 MB limit. Returns an array of frame Buffers.
 */
let chunkSeq = 0;
export function encodeMessage(obj) {
  const json = JSON.stringify(obj);
  if (Buffer.byteLength(json, 'utf8') < MAX_FRAME_BYTES - 64) {
    return [encodeFrame(obj)];
  }
  const id = ++chunkSeq;
  const frames = [];
  // Slice by characters; each slice is well under the byte cap even for
  // 4-byte UTF-8 code points (CHUNK_BYTES / 4 chars).
  const step = Math.floor(CHUNK_BYTES / 4);
  let i = 0;
  while (i < json.length) {
    let end = Math.min(i + step, json.length);
    // Avoid splitting a UTF-16 surrogate pair.
    const code = json.charCodeAt(end - 1);
    if (end < json.length && code >= 0xd800 && code <= 0xdbff) end -= 1;
    frames.push(encodeFrame({ type: 'chunk', id, data: json.slice(i, end), done: end >= json.length }));
    i = end;
  }
  return frames;
}

/** Incremental decoder for length-prefixed frames arriving on a stream. */
export class FrameDecoder {
  constructor(onMessage, onError = () => {}) {
    this.buf = Buffer.alloc(0);
    this.onMessage = onMessage;
    this.onError = onError;
  }

  push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32LE(0);
      if (this.buf.length < 4 + len) return;
      const body = this.buf.subarray(4, 4 + len).toString('utf8');
      this.buf = this.buf.subarray(4 + len);
      try {
        this.onMessage(JSON.parse(body));
      } catch (err) {
        this.onError(err);
      }
    }
  }
}

/** Split a byte stream into newline-delimited lines (ACP stdio transport). */
export class LineDecoder {
  constructor(onLine) {
    this.buf = '';
    this.onLine = onLine;
  }

  push(chunk) {
    this.buf += chunk.toString('utf8');
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, '');
      this.buf = this.buf.slice(i + 1);
      if (line.trim()) this.onLine(line);
    }
  }
}
