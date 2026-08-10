// Measures how antialiased an image is, by counting partial coverage.
//
// WHAT ALIASING ACTUALLY IS. A pixel is an area, not a point. Where a high-contrast edge
// crosses a pixel, the honest value is the average over that area — some fraction of the
// bright side and the rest of the dark side — so the edge should be surrounded by pixels
// holding INTERMEDIATE values. Point-sampling cannot produce those: every pixel takes one
// side or the other, the intermediate values are missing, and what is left is a staircase.
//
// So this counts them. For every pixel whose 3x3 neighbourhood spans a big luminance range,
// it asks whether the centre sits meaningfully between the extremes or is pinned to one of
// them. That fraction is the measurement, and it has a direction that cannot be argued
// with: more partial-coverage pixels along the same edges means less aliasing.
//
// WHY NOT JUST DIFF THE TWO IMAGES. A pixel diff says the frames differ and says nothing
// about which is better — a diff cannot tell antialiasing from a blur, and both would show
// up as "changed near edges". This can: a blur raises partial coverage everywhere, while
// antialiasing raises it only where there is an edge to resolve. Reported separately below
// for that reason.
//
// Usage:
//   node scripts/probeEdges.mjs shots/a.png shots/b.png
//
// Grain and sharpening must be off in both captures or this measures those instead: grain
// puts an intermediate value in every pixel, and sharpening deliberately pushes pixels back
// toward the extremes.

import { readPNG } from "./lib/png.mjs";

const argv = new Map();
const files = [];
for (const a of process.argv.slice(2)) {
    const m = a.match(/^--([\w]+)(?:=(.*))?$/);
    if (m) argv.set(m[1], m[2] ?? "true");
    else files.push(a);
}

/** Luminance span across a 3x3 that counts as an edge worth resolving, in 0..255. */
const CONTRAST = Number(argv.get("contrast") ?? 48);
/** How far inside the local range a value must sit to count as partial rather than pinned. */
const MARGIN = 0.2;

for (const path of files) {
    const { w, h, ch, data } = readPNG(path);
    const lum = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
        lum[i] = 0.2126 * data[i * ch] + 0.7152 * data[i * ch + 1] + 0.0722 * data[i * ch + 2];
    }

    let edges = 0;
    let partial = 0;
    // The same question asked of the flat regions, as a control: a genuine antialiaser
    // leaves them alone, a blur does not.
    let flat = 0;
    let flatSpread = 0;
    for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
            let lo = 1e9;
            let hi = -1e9;
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const v = lum[(y + dy) * w + (x + dx)];
                    if (v < lo) lo = v;
                    if (v > hi) hi = v;
                }
            }
            const span = hi - lo;
            const c = lum[y * w + x];
            if (span >= CONTRAST) {
                edges++;
                if (c > lo + span * MARGIN && c < hi - span * MARGIN) partial++;
            } else if (span < 8) {
                flat++;
                flatSpread += span;
            }
        }
    }
    console.log(`${path}  ${w}x${h}`);
    console.log(`  edge pixels (3x3 span >= ${CONTRAST}): ${edges}  (${((edges / (w * h)) * 100).toFixed(2)}% of frame)`);
    console.log(`  partial coverage among them: ${((partial / Math.max(edges, 1)) * 100).toFixed(2)}%   <-- higher is less aliased`);
    console.log(`  flat regions: ${((flat / (w * h)) * 100).toFixed(2)}% of frame, mean local span ${(flatSpread / Math.max(flat, 1)).toFixed(3)}`);
}
