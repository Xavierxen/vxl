// Finds where the real media starts inside an HLS segment response.
//
// Some hosts hand out segments behind a fake image header (optionally XOR-masked). The previous
// code only handled "PNG/WEBP signature, media right after it" and never checked the result, so
// any other layout reached the browser as garbage ("could not play this video").
//
// This version looks at the bytes themselves: MPEG-TS sync bytes (0x47 every 188 bytes) or an
// fMP4 box, plain or masked, first at the expected offset and then by scanning forward through
// the image-looking prefix. Anything it does not recognise passes through unchanged, exactly
// like before, so streams that already worked cannot regress.

const TS_PACKET = 188;
const TS_SYNC = 0x47;
const SYNC_PACKETS = 4;
const SCAN_BYTES = 64 * 1024;
const NEED_BYTES = TS_PACKET * (SYNC_PACKETS - 1) + 16;
const MASK = Uint8Array.of(157, 42, 241, 71, 179, 142, 92, 112, 166, 25, 228, 59, 216, 98, 15, 197);
const RIFF = [0x52, 0x49, 0x46, 0x46];
const WEBP = [0x57, 0x45, 0x42, 0x50];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const IMAGES = [PNG, [0xff, 0xd8, 0xff], [0x47, 0x49, 0x46, 0x38], RIFF, [0x42, 0x4d]];
// Largest plausible size field per fMP4 box (rules out random bytes that spell a box name).
const BOX_LIMIT = { ftyp: 512, styp: 512, moof: 1 << 24, moov: 1 << 24, sidx: 1 << 20 };

function matches(bytes, signature, offset = 0) {
  return signature.every((value, index) => bytes[offset + index] === value);
}

export const looksLikeImage = (bytes) => IMAGES.some((signature) => matches(bytes, signature));

// Length of the fake image header the old code knew about (0 when there is none).
export function wrapperLength(bytes) {
  if (bytes.length >= 12 && matches(bytes, RIFF) && matches(bytes, WEBP, 8)) return 12;
  if (bytes.length >= 8 && matches(bytes, PNG)) return 8;
  return 0;
}

const byteAt = (bytes, index, masked, base) =>
  masked ? bytes[index] ^ MASK[(index - base) & 15] : bytes[index];

function isTs(bytes, at, masked) {
  for (let packet = 0; packet < SYNC_PACKETS; packet++) {
    const index = at + packet * TS_PACKET;
    if (index >= bytes.length || byteAt(bytes, index, masked, at) !== TS_SYNC) return false;
  }
  return true;
}

function isFmp4(bytes, at, masked) {
  if (at + 8 > bytes.length) return false;
  let size = 0;
  for (let i = 0; i < 4; i++) size = size * 256 + byteAt(bytes, at + i, masked, at);
  let name = "";
  for (let i = 4; i < 8; i++) name += String.fromCharCode(byteAt(bytes, at + i, masked, at));
  return size >= 8 && size <= (BOX_LIMIT[name] ?? 0);
}

const isMedia = (bytes, at, masked) => isTs(bytes, at, masked) || isFmp4(bytes, at, masked);

// -> { skip, masked } when the media start is visible, otherwise null.
export function locateMedia(bytes) {
  if (isMedia(bytes, 0, false)) return { skip: 0, masked: false };
  if (!looksLikeImage(bytes)) return null;
  const known = wrapperLength(bytes);
  if (known) {
    if (isMedia(bytes, known, false)) return { skip: known, masked: false };
    if (isMedia(bytes, known, true)) return { skip: known, masked: true };
  }
  const limit = Math.min(bytes.length, SCAN_BYTES);
  for (let at = 1; at < limit; at++) {
    if (isMedia(bytes, at, false)) return { skip: at, masked: false };
    if (isMedia(bytes, at, true)) return { skip: at, masked: true };
  }
  return null;
}

// Old behaviour, used when nothing is recognised so that what worked before keeps working.
function legacyPlan(head) {
  const skip = wrapperLength(head);
  return { skip, masked: skip > 0 && head[skip] !== TS_SYNC };
}

function concat(a, b) {
  const merged = new Uint8Array(a.length + b.length);
  merged.set(a);
  merged.set(b, a.length);
  return merged;
}

// Reads just enough of the body to decide where the media starts.
// Resolves { head, skip, masked, found }; `head` holds every byte read so far.
export async function readLeadIn(reader) {
  let head = new Uint8Array(0);
  let done = false;
  let plan = null;
  while (!done && !plan && head.length < SCAN_BYTES + NEED_BYTES) {
    const chunk = await reader.read();
    done = chunk.done;
    if (chunk.value) head = concat(head, chunk.value);
    if (head.length < NEED_BYTES && !done) continue;
    plan = locateMedia(head);
    if (!plan && !looksLikeImage(head)) break; // not wrapped: do not hold the response back
  }
  return { head, found: Boolean(plan), ...(plan ?? legacyPlan(head)) };
}

// Streams the rest of the body with the prefix removed and the mask undone.
export function unwrapBody(reader, { head, skip, masked }) {
  let pending = head.subarray(skip);
  let offset = 0;
  const reveal = (chunk) => {
    if (!masked) return chunk;
    const out = new Uint8Array(chunk.length);
    for (let i = 0; i < chunk.length; i++) out[i] = chunk[i] ^ MASK[(offset + i) & 15];
    offset += chunk.length;
    return out;
  };
  return new ReadableStream({
    async pull(controller) {
      for (;;) {
        const chunk = pending ?? (await reader.read()).value;
        pending = null;
        if (!chunk) return controller.close();
        if (chunk.length) return controller.enqueue(reveal(chunk));
      }
    },
    cancel: (reason) => reader.cancel(reason),
  });
}
