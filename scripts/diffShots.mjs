#!/usr/bin/env node
//
// Pixel diff between two captures.
//
// WHY THIS EXISTS. Phase 9 is a chain of passes whose success condition is frequently
// "the picture does not change" — moving the tonemap into a composite, adding a target
// format, reordering a blend. Those are exactly the changes an eye cannot audit: a frame
// that is two levels darker everywhere looks like the same frame, and a frame where only
// the sky moved looks like the same frame too. "Looks identical" has already been wrong
// enough times in this project to stop being evidence.
//
// So this reports a histogram rather than a verdict. A max of 1 across a whole frame is
// dither; a max of 40 over 0.2% of pixels is one object having moved; a mean of 3 over
// everything is a transfer that did not round-trip. Those are different bugs and they are
// only distinguishable by shape.
//
// Usage:
//   node scripts/diffShots.mjs a.png b.png [more-a.png more-b.png ...]
//   node scripts/diffShots.mjs --dir=DIR --pairs=beauty,none,spec   (base-X.png vs new-X.png)
//   ... --write=DIR   also writes an amplified difference image per pair.
//
// Exits 1 if any pair differs by more than --tol (default 1) on more than --tolPct
// (default 0.05) of pixels, so it can gate a pass rather than just describe one.

import { join, basename } from "node:path";
import { readPNG, writePNG } from "./lib/png.mjs";

const argv = new Map();
const positional = [];
for (const a of process.argv.slice(2)) {
    const m = a.match(/^--([\w]+)(?:=(.*))?$/);
    if (m) argv.set(m[1], m[2] ?? "true");
    else positional.push(a);
}

const tol = Number(argv.get("tol") ?? 1);
const tolPct = Number(argv.get("tolPct") ?? 0.05);


const pairs = [];
if (argv.has("dir")) {
    const dir = argv.get("dir");
    for (const name of (argv.get("pairs") ?? "beauty").split(",")) {
        pairs.push([join(dir, `base-${name}.png`), join(dir, `new-${name}.png`), name]);
    }
} else {
    for (let i = 0; i + 1 < positional.length; i += 2) pairs.push([positional[i], positional[i + 1], basename(positional[i]).replace(/\.png$/i, "")]);
}
if (pairs.length === 0) {
    console.error("usage: diffShots.mjs a.png b.png | --dir=DIR --pairs=a,b,c");
    process.exit(2);
}

let failed = false;
for (const [pa, pb, label] of pairs) {
    let A, B;
    try {
        A = readPNG(pa);
        B = readPNG(pb);
    } catch (e) {
        console.log(`${label.padEnd(10)} ERROR ${e.message}`);
        failed = true;
        continue;
    }
    if (A.w !== B.w || A.h !== B.h) {
        console.log(`${label.padEnd(10)} SIZE MISMATCH ${A.w}x${A.h} vs ${B.w}x${B.h}`);
        failed = true;
        continue;
    }
    const N = A.w * A.h;
    const bands = [0, 0, 0, 0]; // <=1, 2..4, 5..16, >16
    let over = 0;
    let sum = 0;
    let max = 0;
    let maxAt = 0;
    const diffImg = argv.has("write") ? Buffer.alloc(N * 3) : null;
    for (let i = 0; i < N; i++) {
        let d = 0;
        for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(A.data[i * A.ch + c] - B.data[i * B.ch + c]));
        sum += d;
        if (d > max) {
            max = d;
            maxAt = i;
        }
        if (d <= 1) bands[0]++;
        else if (d <= 4) bands[1]++;
        else if (d <= 16) bands[2]++;
        else bands[3]++;
        if (d > tol) over++;
        if (diffImg) {
            // x8, so a two-level difference is visible rather than theoretically present.
            const v = Math.min(255, d * 8);
            diffImg[i * 3] = v;
            diffImg[i * 3 + 1] = v;
            diffImg[i * 3 + 2] = v;
        }
    }
    const pct = (over / N) * 100;
    const ok = pct <= tolPct;
    if (!ok) failed = true;
    console.log(
        `${label.padEnd(10)} ${ok ? "same " : "DIFF "} >${tol}: ${pct.toFixed(3).padStart(7)}%  mean ${(sum / N).toFixed(3).padStart(6)}  max ${String(max).padStart(3)} at (${maxAt % A.w},${Math.floor(maxAt / A.w)})   ` +
            `[<=1 ${((100 * bands[0]) / N).toFixed(1)}% | 2-4 ${((100 * bands[1]) / N).toFixed(1)}% | 5-16 ${((100 * bands[2]) / N).toFixed(1)}% | >16 ${((100 * bands[3]) / N).toFixed(2)}%]`,
    );
    if (diffImg) {
        const out = join(argv.get("write"), `diff-${label}.png`);
        writePNG(out, A.w, A.h, diffImg);
        console.log(`           -> ${out}`);
    }
}

process.exit(failed ? 1 : 0);
