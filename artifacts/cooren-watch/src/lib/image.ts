// Shrinks a picked image in the browser before upload: avatars become 320x320, banners 1500x500 (3:1), both JPEG.
// This keeps uploads small (tens of KB) and also drops any metadata the photo carried.
const SIZES = { avatar: { w: 320, h: 320 }, banner: { w: 1500, h: 500 } } as const;
export type ImageKind = keyof typeof SIZES;

async function load(file: File): Promise<{ source: CanvasImageSource; width: number; height: number; close: () => void }> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file);
      return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
    } catch { /* fall back to <img> below */ }
  }
  const url = URL.createObjectURL(file);
  const img = new Image();
  await new Promise<void>((resolve, reject) => { img.onload = () => resolve(); img.onerror = () => reject(new Error('That file could not be read as an image.')); img.src = url; });
  return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
}

export async function fileToDataUrl(file: File, kind: ImageKind): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('Choose an image file (JPEG, PNG or WebP).');
  if (file.size > 25_000_000) throw new Error('That image is too large. Pick one under 25 MB.');
  const { w, h } = SIZES[kind];
  const img = await load(file);
  try {
    if (!img.width || !img.height) throw new Error('That file could not be read as an image.');
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Your browser cannot process images.');
    ctx.fillStyle = '#14141a'; ctx.fillRect(0, 0, w, h); // transparent PNGs get the site's surface colour
    const scale = Math.max(w / img.width, h / img.height); // "cover": fill the frame, crop the overflow
    const dw = img.width * scale, dh = img.height * scale;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img.source, (w - dw) / 2, (h - dh) / 2, dw, dh);
    let quality = 0.86, out = canvas.toDataURL('image/jpeg', quality);
    while (out.length > (kind === 'avatar' ? 700_000 : 1_900_000) && quality > 0.5) { quality -= 0.1; out = canvas.toDataURL('image/jpeg', quality); }
    return out;
  } finally { img.close(); }
}

// ---- Chat helpers ----

const blobToDataUrl = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result));
  r.onerror = () => reject(new Error('Could not read that image.'));
  r.readAsDataURL(blob);
});
const canvasBlob = (c: HTMLCanvasElement, type: string, quality: number) => new Promise<Blob | null>(res => c.toBlob(res, type, quality));

// A photo for the chat: longest side 1280 px, JPEG. (Animated GIFs become a still frame.)
export async function fileToChatImage(file: Blob): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('Choose an image file (JPEG, PNG or WebP).');
  if (file.size > 25_000_000) throw new Error('That image is too large. Pick one under 25 MB.');
  const img = await load(file as File);
  try {
    if (!img.width || !img.height) throw new Error('That file could not be read as an image.');
    const scale = Math.min(1, 1280 / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale)), h = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Your browser cannot process images.');
    ctx.fillStyle = '#14141a'; ctx.fillRect(0, 0, w, h);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img.source, 0, 0, w, h);
    let quality = 0.84, out = canvas.toDataURL('image/jpeg', quality);
    while (out.length > 1_800_000 && quality > 0.45) { quality -= 0.1; out = canvas.toDataURL('image/jpeg', quality); }
    return out;
  } finally { img.close(); }
}

// Turns any image into a sticker: fitted into a square, a white outline that follows its shape, a soft shadow,
// rounded corners for photos (images that already have transparency keep their own silhouette). WebP when the
// browser can encode it, otherwise PNG, shrunk until it is small enough to upload.
export async function makeSticker(file: Blob): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('Choose an image file.');
  const img = await load(file as File);
  try {
    if (!img.width || !img.height) throw new Error('That file could not be read as an image.');
    for (const S of [512, 384, 256]) {
      const PAD = Math.round(S * 0.05), OUT = Math.max(4, Math.round(S * 0.018));
      const box = S - PAD * 2 - OUT * 2;
      const scale = Math.min(box / img.width, box / img.height);
      const dw = img.width * scale, dh = img.height * scale, x = (S - dw) / 2, y = (S - dh) / 2;
      const mk = () => { const c = document.createElement('canvas'); c.width = S; c.height = S; const g = c.getContext('2d'); if (!g) throw new Error('Your browser cannot process images.'); g.imageSmoothingQuality = 'high'; return [c, g] as const; };

      const [art, a] = mk();
      a.drawImage(img.source, x, y, dw, dh);
      // Does the picture already have see-through areas? Sample a small copy of the whole image.
      const probe = document.createElement('canvas'); probe.width = probe.height = 48;
      const pg = probe.getContext('2d', { willReadFrequently: true });
      let hasAlpha = false;
      if (pg) { pg.drawImage(img.source, 0, 0, 48, 48); const d = pg.getImageData(0, 0, 48, 48).data; let clear = 0; for (let i = 3; i < d.length; i += 4) if (d[i] < 250) clear++; hasAlpha = clear / (48 * 48) > 0.01; }
      if (!hasAlpha) { // opaque photo: round the corners
        a.clearRect(0, 0, S, S);
        const r = Math.min(dw, dh) * 0.14;
        a.save(); a.beginPath(); a.roundRect(x, y, dw, dh, r); a.clip(); a.drawImage(img.source, x, y, dw, dh); a.restore();
      }
      const [sil, s] = mk();
      for (let i = 0; i < 28; i++) { const ang = (i / 28) * Math.PI * 2; s.drawImage(art, Math.cos(ang) * OUT, Math.sin(ang) * OUT); }
      s.globalCompositeOperation = 'source-in'; s.fillStyle = '#fff'; s.fillRect(0, 0, S, S);
      const [fin, f] = mk();
      f.shadowColor = 'rgba(0,0,0,.35)'; f.shadowBlur = S * 0.015; f.shadowOffsetY = S * 0.006;
      f.drawImage(sil, 0, 0);
      f.shadowColor = 'transparent';
      f.drawImage(art, 0, 0);

      for (const q of [0.9, 0.75, 0.6]) {
        const blob = (await canvasBlob(fin, 'image/webp', q)) ?? (await canvasBlob(fin, 'image/png', 1));
        if (blob && blob.size <= 420_000) return blobToDataUrl(blob);
        if (blob && blob.type === 'image/png') break; // PNG ignores quality: go straight to a smaller size
      }
    }
    throw new Error('That image is too detailed to make a sticker. Try a simpler one.');
  } finally { img.close(); }
}
