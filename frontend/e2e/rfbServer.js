// A scripted RFB 3.8 server for the browser suite and the preview (ADR-0087): no security, one screen, and raw-encoded
// updates the caller supplies, written in the pixel format the client asks for. It records the type of every message
// the client sends, so a test can prove the page sent no key, pointer, or clipboard. Runs in Node and in the browser.

const VERSION = new TextEncoder().encode('RFB 003.008\n');
// Client message types and their fixed sizes (SetEncodings and ClientCutText carry a count or length).
const SET_PIXEL_FORMAT = 0;
const SET_ENCODINGS = 2;
const UPDATE_REQUEST = 3;
const KEY = 4;
const POINTER = 5;
const CUT_TEXT = 6;

/**
 * One connection's server. `screen(request)` answers each update request with `null` (nothing changed) or rects
 * `{ x, y, width, height, rgba }`. `receive(bytes)` returns what to send back, in order.
 */
export function rfbServer({ width = 1280, height = 800, name = 'Browser', screen }) {
  let state = 'version';
  let buffer = new Uint8Array();
  const format = { bigEndian: false, red: 16, green: 8, blue: 0 };
  const received = [];

  const take = (size) => {
    if (buffer.length < size) return null;
    const data = buffer.slice(0, size);
    buffer = buffer.slice(size);
    return data;
  };

  function serverInit() {
    const title = new TextEncoder().encode(name);
    const out = new Uint8Array(24 + title.length);
    const view = new DataView(out.buffer);
    view.setUint16(0, width);
    view.setUint16(2, height);
    out.set([32, 24, 0, 1], 4);
    view.setUint16(8, 255);
    view.setUint16(10, 255);
    view.setUint16(12, 255);
    out.set([16, 8, 0], 14);
    view.setUint32(20, title.length);
    out.set(title, 24);
    return out;
  }

  function update(rects) {
    const size = rects.reduce((total, rect) => total + 12 + rect.width * rect.height * 4, 4);
    const out = new Uint8Array(size);
    const view = new DataView(out.buffer);
    view.setUint16(2, rects.length);
    let at = 4;
    for (const rect of rects) {
      view.setUint16(at, rect.x);
      view.setUint16(at + 2, rect.y);
      view.setUint16(at + 4, rect.width);
      view.setUint16(at + 6, rect.height);
      view.setInt32(at + 8, 0);
      at += 12;
      for (let index = 0; index < rect.width * rect.height; index += 1) {
        const [red, green, blue] = rect.rgba.subarray(index * 4, index * 4 + 3);
        const pixel = ((red << format.red) | (green << format.green) | (blue << format.blue)) >>> 0;
        view.setUint32(at, pixel, !format.bigEndian);
        at += 4;
      }
    }
    return out;
  }

  function message() {
    const type = buffer[0];
    if (type === SET_PIXEL_FORMAT) {
      const data = take(20);
      if (!data) return null;
      Object.assign(format, { bigEndian: data[6] !== 0, red: data[14], green: data[15], blue: data[16] });
    } else if (type === SET_ENCODINGS) {
      if (buffer.length < 4) return null;
      const count = new DataView(buffer.buffer, buffer.byteOffset).getUint16(2);
      if (!take(4 + count * 4)) return null;
    } else if (type === UPDATE_REQUEST) {
      const data = take(10);
      if (!data) return null;
      received.push(type);
      const rects = screen({ incremental: data[1] !== 0 });
      return rects ? [update(rects)] : [];
    } else if (type === KEY) {
      if (!take(8)) return null;
    } else if (type === POINTER) {
      // KasmVNC's pointer event: a 16-bit button mask, the position, and two scroll deltas.
      if (!take(11)) return null;
    } else if (type === CUT_TEXT) {
      if (buffer.length < 8) return null;
      const length = new DataView(buffer.buffer, buffer.byteOffset).getUint32(4);
      if (!take(8 + length)) return null;
    } else {
      received.push(type);
      buffer = new Uint8Array();
      return null;
    }
    if (type !== UPDATE_REQUEST) received.push(type);
    return [];
  }

  return {
    greeting: VERSION,
    received,
    receive(bytes) {
      const joined = new Uint8Array(buffer.length + bytes.length);
      joined.set(buffer);
      joined.set(bytes, buffer.length);
      buffer = joined;
      const out = [];
      for (;;) {
        if (state === 'version') {
          if (!take(12)) return out;
          out.push(new Uint8Array([1, 1]));
          state = 'security';
        } else if (state === 'security') {
          if (!take(1)) return out;
          out.push(new Uint8Array(4));
          state = 'init';
        } else if (state === 'init') {
          if (!take(1)) return out;
          out.push(serverInit());
          state = 'normal';
        } else {
          if (!buffer.length) return out;
          const answers = message();
          if (answers === null) return out;
          out.push(...answers);
        }
      }
    },
  };
}

/** A whole screen of one colour, or a rect of it. */
export function solid(width, height, [red, green, blue], x = 0, y = 0) {
  const rgba = new Uint8Array(width * height * 4);
  for (let index = 0; index < width * height; index += 1) rgba.set([red, green, blue, 255], index * 4);
  return { x, y, width, height, rgba };
}

export const CLIENT_MESSAGES = Object.freeze({ KEY, POINTER, CUT_TEXT });
