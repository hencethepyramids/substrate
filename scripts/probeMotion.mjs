// Reads the `reprojection` debug view and reports it in pixels.
//
// WHAT THIS IS FOR. TAA reprojects the history by reconstructing each pixel's world
// position from the depth buffer and pushing it through the previous frame's
// view-projection. That chain has a camera basis, a linear depth, a matrix convention and
// a UV-versus-NDC flip in it, and EVERY ONE of those can be wrong in a way that still
// produces a plausible, slightly soft image. A flipped V does not crash; it just makes the
// antialiasing quietly worse and gets blamed on the blend factor for a week.
//
// So the reprojection is a debug view, and this reads it back as a number. The claim it
// checks is exact and has no tuning in it: WITH THE CAMERA STILL, EVERY PIXEL'S SURFACE IS
// WHERE IT WAS, so every motion vector must be zero. Not "small" — zero, to within the
// 0.078 px that one 8-bit step of the encoding is worth.
//
// Usage:
//   node scripts/capture.mjs --view=reprojection --freeze --out=shots/repro.png
//   node scripts/probeMotion.mjs shots/repro.png --expect=still
//
//   --expect=still   every pixel must be stationary; exits 1 otherwise
//   --expect=moving  requires real motion, so a "still" pass cannot be faked by a
//                    reprojection that returns the input UV whatever it is handed
//
// The two modes together are the point. `still` alone would pass if the shader ignored the
// matrix entirely and returned vUV, which is precisely the bug a broken matrix causes.

import { readPNG } from "./lib/png.mjs";

const argv = new Map();
const files = [];
for (const a of process.argv.slice(2)) {
    const m = a.match(/^--([\w]+)(?:=(.*))?$/);
    if (m) argv.set(m[1], m[2] ?? "true");
    else files.push(a);
}

/** The shader's encoding: 0.5 + pixels * 0.05, so this inverts it. */
const SCALE = 0.05;
/** One 8-bit step, in pixels of motion. Nothing below this is measurable. */
const STEP = 1 / 255 / SCALE;

const expect = argv.get("expect") ?? "still";
let failed = false;

for (const path of files) {
    const img = readPNG(path);
    const { w, h, ch, data } = img;
    let sum = 0;
    let max = 0;
    let maxAt = [0, 0];
    let behind = 0;
    // Motion large enough that a person would see the history land on the wrong surface.
    let overHalf = 0;
    const n = w * h;
    for (let i = 0; i < n; i++) {
        const o = i * ch;
        const mx = (data[o] / 255 - 0.5) / SCALE;
        const my = (data[o + 1] / 255 - 0.5) / SCALE;
        // Blue is the flag for "behind the previous camera", where there is no history.
        if (data[o + 2] > 200) behind++;
        const m = Math.hypot(mx, my);
        sum += m;
        if (m > 0.5) overHalf++;
        if (m > max) {
            max = m;
            maxAt = [i % w, Math.floor(i / w)];
        }
    }
    const mean = sum / n;
    console.log(`${path}  ${w}x${h}`);
    console.log(`  motion   mean ${mean.toFixed(3)} px   max ${max.toFixed(3)} px at (${maxAt[0]},${maxAt[1]})`);
    console.log(`  over 0.5 px: ${((overHalf / n) * 100).toFixed(3)}%   behind camera: ${((behind / n) * 100).toFixed(3)}%`);
    console.log(`  (one 8-bit step of the encoding is ${STEP.toFixed(3)} px, so that is the floor)`);

    if (expect === "still") {
        // One step of slack, and one step only. A correct reprojection of a still camera
        // lands on the same pixel; anything beyond quantisation is a real disagreement
        // between the depth buffer and the matrix that is supposed to describe it.
        const ok = max <= STEP * 1.5;
        console.log(`  expect=still: ${ok ? "PASS" : "FAIL"} — max ${max.toFixed(3)} px vs ${(STEP * 1.5).toFixed(3)} allowed`);
        if (!ok) failed = true;
    } else if (expect === "moving") {
        // A tenth of the frame has to have actually moved, or the "still" test above is
        // measuring a shader that ignores its inputs.
        const ok = overHalf / n > 0.1;
        console.log(`  expect=moving: ${ok ? "PASS" : "FAIL"} — ${((overHalf / n) * 100).toFixed(2)}% moved over 0.5 px, needs >10%`);
        if (!ok) failed = true;
    }
}

process.exit(failed ? 1 : 0);
