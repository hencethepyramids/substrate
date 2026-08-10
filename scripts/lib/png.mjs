// PNG in and out, for the capture instruments.
//
// Minimal on purpose: 8-bit, non-interlaced, RGB or RGBA, which is what Playwright and
// every capture in this repo writes. Pulling in a dependency to read four files would be
// the larger sin. Anything else is rejected loudly rather than misread — a decoder that
// quietly returns the wrong pixels would undermine every measurement built on top of it,
// and the measurements are the point.
//
// Extracted from diffShots.mjs when a second instrument needed it. There is exactly one
// copy of this logic and there should stay exactly one: two decoders that disagree about a
// row filter would make two scripts disagree about the same image, which is the worst
// possible failure for a pair of tools whose whole job is to be believed.

import { readFileSync, writeFileSync } from "node:fs";
import { inflateSync, deflateSync } from "node:zlib";

export function readPNG(path) {
    const b = readFileSync(path);
    if (b.readUInt32BE(0) !== 0x89504e47) throw new Error(`${path}: not a PNG`);
    let o = 8;
    let w = 0;
    let h = 0;
    let bitDepth = 0;
    let colorType = 0;
    let interlace = 0;
    const idat = [];
    while (o < b.length) {
        const len = b.readUInt32BE(o);
        const type = b.toString("ascii", o + 4, o + 8);
        const data = b.subarray(o + 8, o + 8 + len);
        if (type === "IHDR") {
            w = data.readUInt32BE(0);
            h = data.readUInt32BE(4);
            bitDepth = data[8];
            colorType = data[9];
            interlace = data[12];
        } else if (type === "IDAT") idat.push(data);
        else if (type === "IEND") break;
        o += 12 + len;
    }
    if (bitDepth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) {
        throw new Error(`${path}: unsupported PNG (depth ${bitDepth}, colour type ${colorType}, interlace ${interlace})`);
    }
    const ch = colorType === 6 ? 4 : 3;
    const raw = inflateSync(Buffer.concat(idat));
    const stride = w * ch;
    const out = Buffer.alloc(h * stride);
    let prev = Buffer.alloc(stride);
    for (let y = 0; y < h; y++) {
        const filter = raw[y * (stride + 1)];
        const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
        const cur = Buffer.alloc(stride);
        for (let x = 0; x < stride; x++) {
            const a = x >= ch ? cur[x - ch] : 0;
            const up = prev[x];
            const ul = x >= ch ? prev[x - ch] : 0;
            let v = line[x];
            if (filter === 1) v += a;
            else if (filter === 2) v += up;
            else if (filter === 3) v += (a + up) >> 1;
            else if (filter === 4) {
                // Paeth.
                const p = a + up - ul;
                const pa = Math.abs(p - a);
                const pb = Math.abs(p - up);
                const pc = Math.abs(p - ul);
                v += pa <= pb && pa <= pc ? a : pb <= pc ? up : ul;
            }
            cur[x] = v & 255;
        }
        cur.copy(out, y * stride);
        prev = cur;
    }
    return { w, h, ch, data: out };
}

/** Write an 8-bit RGB PNG, filter 0 throughout. Only used for the difference images. */
export function writePNG(path, w, h, rgb) {
    const stride = w * 3;
    const raw = Buffer.alloc(h * (stride + 1));
    for (let y = 0; y < h; y++) rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
    const chunk = (type, data) => {
        const out = Buffer.alloc(12 + data.length);
        out.writeUInt32BE(data.length, 0);
        out.write(type, 4, "ascii");
        data.copy(out, 8);
        // CRC over type+data.
        let c = ~0;
        const span = out.subarray(4, 8 + data.length);
        for (let i = 0; i < span.length; i++) {
            c ^= span[i];
            for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
        }
        out.writeInt32BE(~c, 8 + data.length);
        return out;
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    writeFileSync(path, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
}
