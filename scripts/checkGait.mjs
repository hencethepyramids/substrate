#!/usr/bin/env node
//
// Ask the running gait the one question the whole of Phase 7 pass A rests on:
//
//   DOES A PLANTED FOOT STAY WHERE IT WAS PLANTED?
//
// A screenshot cannot answer this. Foot sliding is a few centimetres per frame against
// a body moving three metres a second, it is invisible in a still, and in motion it
// reads as "something is slightly off" rather than as a number. So this walks the
// character with real key events, samples the world-space ankle positions every frame,
// and reports the largest distance a foot moved while it was supposed to be in contact.
//
// It also checks the two claims that hang off that one: that the prints the carve pass
// stamps land under the feet that made them, and that the figure is standing ON the
// ground rather than through it or above it.
//
//   node scripts/checkGait.mjs --seconds=6
//
// Needs the dev server up, same as capture.mjs.

import { chromium } from "playwright-core";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const URL = process.env.SUBSTRATE_URL ?? "http://localhost:5173/";
const argv = new Map();
for (const a of process.argv.slice(2)) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) argv.set(m[1], m[2] ?? "true");
}
const seconds = Number(argv.get("seconds") ?? 6);
const sprint = argv.get("sprint") === "true";
// Look input per frame, to walk a circle. The mouse feeds exactly this field, so from
// here on it is the shipping path — a turn driven by poking the rig would not be.
const turn = (Number(argv.get("turn") ?? 0) * Math.PI) / 180;

function findChromium() {
    if (process.env.SUBSTRATE_CHROME) return process.env.SUBSTRATE_CHROME;
    const root = join(process.env.LOCALAPPDATA ?? "", "ms-playwright");
    if (!existsSync(root)) return null;
    for (const d of readdirSync(root)
        .filter((x) => /^chromium-\d+$/.test(x))
        .sort()
        .reverse()) {
        const exe = join(root, d, "chrome-win64", "chrome.exe");
        if (existsSync(exe)) return exe;
    }
    return null;
}

const exe = findChromium();
if (!exe) {
    console.error("no full chromium found — set SUBSTRATE_CHROME to a chrome.exe");
    process.exit(1);
}

const browser = await chromium.launch({
    executablePath: exe,
    headless: true,
    args: ["--headless=new", "--enable-unsafe-webgpu", "--enable-features=Vulkan,WebGPU", "--use-angle=d3d11", "--no-sandbox", "--no-first-run"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForFunction(() => (window.__substrateDispose ?? null) !== null, null, { timeout: 90000 });

// Start recording before the first step, so the very first plant is sampled too.
await page.evaluate(() => {
    const app = window.__substrate;
    const g = app.gait;
    window.__gaitLog = [];
    const sample = () => {
        // The ankles as the GPU will draw them: the bone's rest joint pushed through the
        // baked palette. Reading the gait's own plant array would only prove it agrees
        // with itself; this goes through the pose, the shortest-arc rotation and the root
        // transform, so it is the whole chain that has to be right.
        //
        // NOT the matrix's translation column. That is where the bone's rest ORIGIN
        // lands, which for every bone but the pelvis is somewhere else entirely.
        const pal = g.skeleton.palette;
        const rest = g.skeleton.restHead;
        const at = (bone) => {
            const p = bone * 12;
            const i = bone * 3;
            const x = rest[i];
            const y = rest[i + 1];
            const z = rest[i + 2];
            return [
                pal[p] * x + pal[p + 1] * y + pal[p + 2] * z + pal[p + 3],
                pal[p + 4] * x + pal[p + 5] * y + pal[p + 6] * z + pal[p + 7],
                pal[p + 8] * x + pal[p + 9] * y + pal[p + 10] * z + pal[p + 11],
            ];
        };
        // footR is bone 7, footL bone 10 — the ankle is each foot bone's head.
        const r = at(7);
        const l = at(10);
        // Hips are the thigh heads: bone 5 right, bone 8 left. How far a leg is extended
        // is the thing that decides whether a gait reads as walking or as stilts, and it
        // is invisible in a still because a fully straight leg is a perfectly ordinary
        // pose for one frame.
        const hipR = at(5);
        const hipL = at(8);
        const legR = Math.hypot(r[0] - hipR[0], r[1] - hipR[1], r[2] - hipR[2]);
        const legL = Math.hypot(l[0] - hipL[0], l[1] - hipL[1], l[2] - hipL[2]);
        window.__gaitLog.push({
            t: performance.now(),
            r,
            l,
            // The ground UNDER EACH FOOT, not under the body. On any slope the two feet
            // stand at different heights, and measuring both against the body's own
            // ground is how you convince yourself a correct figure is sinking.
            //
            // Both surfaces: the undisturbed heightfield, and the one that is actually
            // DRAWN once the substrate has been carved out of it. A foot standing on the
            // first and floating over the second is exactly the gap pass C closed, so the
            // check has to be able to tell them apart.
            rg: app.gait.groundAt(r[0], r[2]),
            lg: app.gait.groundAt(l[0], l[2]),
            rgRaw: app.terrain.field.sampleHeight(r[0], r[2]),
            lgRaw: app.terrain.field.sampleHeight(l[0], l[2]),
            body: [app.mover.position.x, app.mover.position.y, app.mover.position.z],
            speed: app.mover.speed,
            distance: app.mover.distance,
            // What the gait itself believes. Not used to decide pass or fail — that
            // would only prove it agrees with itself — but it is what says WHERE a
            // failure is in the cycle, which is the whole of the diagnosis.
            pr: app.gait.phaseOf(0),
            pl: app.gait.phaseOf(1),
            duty: app.gait.duty,
            legR,
            legL,
            vertR: hipR[1] - r[1],
            flatR: Math.hypot(hipR[0] - r[0], hipR[2] - r[2]),
            facing: app.mover.facing,
            stand: app.gait.standing,
            // Cloth stretch EVERY FRAME, not once at the end. A solver that is losing it
            // does so while the anchors are moving fastest, which is exactly the instant a
            // single end-of-run sample is least likely to catch.
            stretch: (() => {
                const c = app.cloak;
                const COLS = 9, ROWS = 13, q = c._pos;
                const dd = (a, b) => Math.hypot(q[a] - q[b], q[a+1] - q[b+1], q[a+2] - q[b+2]);
                let w = 0;
                for (let r = 0; r < ROWS; r++) for (let k = 0; k < COLS; k++) {
                    const i = (r * COLS + k) * 3;
                    if (r + 1 < ROWS) w = Math.max(w, Math.abs(dd(i, i + COLS * 3) / c._restRow - 1));
                    if (k + 1 < COLS) w = Math.max(w, Math.abs(dd(i, i + 3) / c._restCol - 1));
                }
                return w;
            })(),
            // The wind the CLOTH is reading, against the ambient it is modulated from.
            // If these never differ, the probe is echoing the base wind and the whole
            // point of sampling through sbAirAt is lost.
            wind: [app.airProbe.velocity.x, app.airProbe.velocity.y, app.airProbe.vertical],
            base: [app.air.base.x, app.air.base.y],
        });
        // Turn the rig at a controlled rate. Driven directly rather than through lookX
        // because the thing under test is the GAIT under a turn, not the look input, and
        // the frame ordering swallows most of what an out-of-loop injection adds.
        if (window.__turn) {
            const now = performance.now();
            const dt = window.__turnAt ? (now - window.__turnAt) / 1000 : 0;
            window.__turnAt = now;
            app.rig.yaw += window.__turn * dt;
        }
        window.__gaitRaf = requestAnimationFrame(sample);
    };
    sample();
});

// Also record every stamp the carve pass makes, by wrapping the one entry point it uses.
await page.evaluate(() => {
    const app = window.__substrate;
    window.__stamps = [];
    const inner = app.substrate.stamp.bind(app.substrate);
    app.substrate.stamp = (x, z, r, d) => {
        window.__stamps.push({ x, z, r, d, t: performance.now() });
        return inner(x, z, r, d);
    };
});

await page.evaluate((t) => {
    window.__turn = t;
    // The look path is gated on pointer lock, which a headless run never gets. Everything
    // downstream of this flag is the shipping path.

}, turn);
await page.keyboard.down("w");
if (sprint) await page.keyboard.down("Shift");
await page.waitForTimeout(seconds * 1000);
await page.keyboard.up("w");
if (sprint) await page.keyboard.up("Shift");
await page.waitForTimeout(400);

const result = await page.evaluate(() => {
    cancelAnimationFrame(window.__gaitRaf);
    const app = window.__substrate;
    return {
        log: window.__gaitLog,
        stamps: window.__stamps,
        stride: app.settings.get("char.strideLength"),
        stance: app.settings.get("char.stanceWidth"),
        walkSpeed: app.settings.get("char.walkSpeed"),
        probeLatency: app.groundProbe.latencyMs,
        // The cloth, measured against its own rest lengths. A Verlet solver that is not
        // converging shows up here long before it shows up as anything you would notice
        // in a still — and the first version of this cloak was 76% stretched along its
        // top edge while looking merely a bit crumpled.
        cloth: (() => {
            const c = app.cloak;
            const COLS = 9;
            const ROWS = 13;
            const pos = c._pos;
            const at = (r, k) => { const i = (r * COLS + k) * 3; return [pos[i], pos[i + 1], pos[i + 2]]; };
            const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
            let worst = 0;
            let hang = 0;
            for (let r = 0; r < ROWS; r++) {
                for (let k = 0; k < COLS; k++) {
                    if (r + 1 < ROWS) worst = Math.max(worst, Math.abs(d(at(r, k), at(r + 1, k)) / c._restRow - 1));
                    if (k + 1 < COLS) worst = Math.max(worst, Math.abs(d(at(r, k), at(r, k + 1)) / c._restCol - 1));
                }
            }
            for (let r = 0; r < ROWS - 1; r++) hang += d(at(r, 4), at(r + 1, 4));
            return { worst, hang, ideal: c._restRow * (ROWS - 1) };
        })(),
        // Ground height under each recorded stamp, so a print can be checked against the
        // surface rather than against the body's own idea of where it is.
        stampGround: window.__stamps.map((s) => app.terrain.field.sampleHeight(s.x, s.z)),
    };
});

await browser.close();

const { log, stamps, stride, stance, walkSpeed, probeLatency, cloth } = result;
if (log.length < 30) {
    console.error(`only ${log.length} frames captured — did the page run?`);
    process.exit(1);
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const horiz = (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2]);

// --- 1. does a planted foot stay put --------------------------------------
//
// Measured as DRIFT ACROSS A WHOLE CONTACT, not as motion between two frames. A foot
// that creeps a third of a millimetre per frame is sliding just as surely as one that
// jumps, and only the total says which.
//
// The gait's phase says WHEN a contact starts and ends; the palette says WHERE the foot
// is. That is not circular — the phase is a scalar the gait computes and the position
// comes out of the matrix the GPU draws, so everything between the two is under test.
// The frames either side of each boundary are skipped: one frame straddles the
// transition, and its motion belongs to neither state.
const EDGE = 0.06;
const contacts = [];
for (const foot of ["r", "l"]) {
    const key = foot === "r" ? "pr" : "pl";
    let current = null;
    for (let i = 1; i < log.length; i++) {
        const cur = log[i];
        const wrapped = cur[key] < log[i - 1][key];
        if (wrapped) {
            if (current !== null && current.n > 2) contacts.push(current);
            current = null;
        }
        if (cur.speed < 0.5) {
            current = null;
            continue;
        }
        if (cur[key] < EDGE || cur[key] > cur.duty - EDGE) continue;
        if (current === null) current = { foot, from: i, n: 0, ref: cur[foot], drift: 0 };
        current.n++;
        const d = horiz(cur[foot], current.ref);
        if (d > current.drift) current.drift = d;
    }
    if (current !== null && current.n > 2) contacts.push(current);
}
contacts.sort((a, b) => a.drift - b.drift);
const worst = contacts[contacts.length - 1] ?? { drift: 0, from: 0, n: 0, foot: "-" };
const worstSlide = worst.drift;
const worstAt = worst.from;
const worstPhase = log[worstAt] ? (worst.foot === "r" ? log[worstAt].pr : log[worstAt].pl) : 0;
const stanceFrames = contacts.reduce((a, c) => a + c.n, 0);
const p = (q) => contacts[Math.min(contacts.length - 1, Math.floor(q * contacts.length))]?.drift ?? 0;

// What the body travelled in one frame, for scale. A foot that "slides" by less than
// this is not sliding at all; a foot that slides by this much is fully carried along.
// Median rather than maximum: the first frames after boot are long, and one 100 ms
// hitch would otherwise set the yardstick for everything.
const steps = [];
for (let i = 1; i < log.length; i++) {
    if (log[i].speed < 0.5) continue;
    steps.push(horiz(log[i].body, log[i - 1].body));
}
steps.sort((a, b) => a - b);
const bodyStep = steps[Math.floor(steps.length * 0.5)] ?? 0;

// --- 2. do the prints land under the feet ---------------------------------
let worstPrint = 0;
let printsChecked = 0;
for (const s of stamps) {
    // Only the footfalls: the carve button is not held here, so every stamp of foot
    // radius is a print. Find the frame it landed on and the nearer ankle.
    let best = null;
    for (const f of log) if (best === null || Math.abs(f.t - s.t) < Math.abs(best.t - s.t)) best = f;
    if (best === null) continue;
    const d = Math.min(Math.hypot(s.x - best.r[0], s.z - best.r[2]), Math.hypot(s.x - best.l[0], s.z - best.l[2]));
    printsChecked++;
    if (d > worstPrint) worstPrint = d;
}

// --- 3. is it standing on the ground --------------------------------------
// Milliseconds since each foot's contact began. A foot cannot be standing on ground the
// readback has not delivered yet, so 'has it settled' has to be asked on a clock rather
// than on a fraction of a stance whose length changes by four times between walk and
// sprint.
const since = { r: [], l: [] };
for (const foot of ['r', 'l']) {
    const key = foot === 'r' ? 'pr' : 'pl';
    let start = log[0].t;
    for (let i = 0; i < log.length; i++) {
        if (i > 0 && log[i][key] < log[i - 1][key]) start = log[i].t;
        since[foot].push(log[i].t - start);
    }
}
// The foot is chasing a target it learns about one round trip late, and then follows with
// a ten millisecond time constant. Four of those plus the measured latency is when it
// should be there; before that, nothing is being claimed.
const settleBy = probeLatency + 40;
let worstFloat = 0;
let worstSink = 0;
let groundChecked = 0;
// The same measurement against the UNDISTURBED heightfield. If the character is standing
// on the drawn surface, this one should show it floating — by however deep its own prints
// are. A run where both numbers are zero means the substrate never got carved and the
// check proved nothing.
const rawClears = [];
let deepestPrint = 0;
const floats = [];
const floatsLate = [];
for (let fi = 0; fi < log.length; fi++) {
    const f = log[fi];
    if (f.speed < 0.5 || f.stand > 0.05) continue;
    for (const foot of ["r", "l"]) {
        // WHICH foot is in contact comes from the phase; WHETHER it is touching comes
        // from the terrain. Picking the lower of the two instead looks independent and
        // is not: on a downslope the swinging foot is often the lower one, and grading
        // its mid-swing clearance as float says nothing about anything.
        const phase = foot === "r" ? f.pr : f.pl;
        if (phase < EDGE || phase > f.duty - EDGE) continue;
        groundChecked++;
        // An ankle sits P.ankle = 0.09 m above the sole of the foot under it.
        const drawn = foot === "r" ? f.rg : f.lg;
        const raw = foot === "r" ? f.rgRaw : f.lgRaw;
        const clearance = f[foot][1] - 0.09 - drawn;
        floats.push(clearance);
        // Late stance only. A boot landing on snow compresses it, so the first slice of
        // every contact is the ground giving way underneath a foot that is already on it.
        // Whether it SETTLES is a different question from how long settling takes, and
        // conflating the two makes both unanswerable.
        if (since[foot][fi] > settleBy) floatsLate.push(clearance);
        if (clearance > worstFloat) worstFloat = clearance;
        if (-clearance > worstSink) worstSink = -clearance;
        rawClears.push(f[foot][1] - 0.09 - raw);
        if (raw - drawn > deepestPrint) deepestPrint = raw - drawn;
    }
}
floats.sort((a, b) => a - b);
floatsLate.sort((a, b) => a - b);
const lq = (q) => floatsLate[Math.min(floatsLate.length - 1, Math.floor(q * floatsLate.length))] ?? 0;
const fq = (q) => floats[Math.min(floats.length - 1, Math.floor(q * floats.length))] ?? 0;
// Fraction of contact spent more than a couple of centimetres off the surface. The peak
// is not the interesting number: a print is stamped on the same frame the foot lands, so
// the ground drops ten centimetres out from under a boot that is already on it and the
// foot spends a few milliseconds catching up. That is the snow compressing, and it is
// meant to be there. What would be a bug is the foot STAYING up.
const offGround = floats.filter((v) => v > 0.02).length / Math.max(floats.length, 1);

// --- 4. stride length actually walked -------------------------------------
//
// Measured off the GROUND, between successive prints of the SAME foot, which is the
// claim the README makes: stride length is a distance you can pace out by walking past
// your own prints. Dividing total travel by the number of prints would instead measure
// the acceleration at either end of the run, since no print is laid below walking pace.
const travelled = log[log.length - 1].distance - log[0].distance;
const gaps = [];
for (let i = 2; i < stamps.length; i++) gaps.push(Math.hypot(stamps[i].x - stamps[i - 2].x, stamps[i].z - stamps[i - 2].z) * 0.5);
gaps.sort((a, b) => a - b);
const measured = gaps[Math.floor(gaps.length * 0.5)] ?? 0;

const pct = (v) => `${(v * 100).toFixed(1)} cm`;
console.log(`frames            ${log.length}  (${contacts.length} contacts, ${stanceFrames} foot-frames in stance)`);
console.log(`walked            ${travelled.toFixed(2)} m at up to ${Math.max(...log.map((f) => f.speed)).toFixed(2)} m/s (walk ${walkSpeed})`);
if (turn !== 0) {
    let swept = 0;
    for (let i = 1; i < log.length; i++) {
        let d = log[i].facing - log[i - 1].facing;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        swept += d;
    }
    const secs = (log[log.length - 1].t - log[0].t) / 1000;
    console.log(`turned            ${((swept * 180) / Math.PI).toFixed(0)} deg total, ${((swept * 180) / Math.PI / secs).toFixed(0)} deg/s average`);
}
console.log("");
console.log(`stance drift worst ${pct(worstSlide)}   ${worst.foot} foot, frame ${worstAt}, ${worst.n} frames`);
console.log(`stance drift p50/p90 ${pct(p(0.5))} / ${pct(p(0.9))}`);
console.log(`body travel/frame  ${pct(bodyStep)}   <- a foot carried along would move this much every frame`);
console.log(`prints             ${printsChecked}, worst distance to nearest ankle ${pct(worstPrint)}`);
console.log(`stride measured    ${measured.toFixed(3)} m   (setting ${stride}, stance width ${stance})`);
console.log(`contact foot vs drawn ground   float p50 ${pct(fq(0.5))}, p90 ${pct(fq(0.9))}, peak ${pct(worstFloat)}; sink ${pct(worstSink)}`);
console.log(`  ${settleBy.toFixed(0)} ms after contact onward     float p50 ${pct(lq(0.5))}, p90 ${pct(lq(0.9))}  <- has it settled`);
console.log(`  off the surface by >2 cm        ${(offGround * 100).toFixed(1)}% of contact (${groundChecked} samples)  <- the snow compressing`);
rawClears.sort((a, b) => a - b);
const medianRaw = rawClears[Math.floor(rawClears.length / 2)] ?? 0;
console.log(`  vs the UNDISTURBED heightfield  ${pct(-medianRaw)} below it  <- where the foot would have floated`);
console.log(`  deepest print stood in          ${pct(deepestPrint)}`);
console.log(`  ground probe round trip         ${probeLatency.toFixed(1)} ms  <- the age of what it is standing on`);
{
    const ratios = log.filter((f) => Math.hypot(f.base[0], f.base[1]) > 0.01).map((f) => Math.hypot(f.wind[0], f.wind[1]) / Math.hypot(f.base[0], f.base[1]));
    if (ratios.length > 0) {
        ratios.sort((a, b) => a - b);
        const lo = ratios[Math.floor(ratios.length * 0.05)];
        const hi = ratios[Math.floor(ratios.length * 0.95)];
        const vert = Math.max(...log.map((f) => Math.abs(f.wind[2])));
        console.log(`  wind at the cloak / ambient     ${lo.toFixed(2)} to ${hi.toFixed(2)} over the walk, vertical up to ${vert.toFixed(2)} m/s`);
        console.log(`     ${hi - lo > 0.05 ? "terrain IS modulating it" : "FLAT — the probe is echoing the ambient wind"}`);
    }
}
if (errors.length > 0) console.log(`page errors: ${errors.join(" | ")}`);

// A planted foot may move by the numerical noise of the terrain sample under it and no
// more. One centimetre is generous; a sliding foot moves by the body's step, which at a
// walk is five to ten times that.
const slideOk = worstSlide < 0.01;
const printOk = worstPrint < 0.25;
const strideOk = printsChecked > 2 && Math.abs(measured - stride) < 0.08;
// The foot must REST on the drawn surface, judged over the whole contact rather than at
// its peak: the peak is the compression transient on the frame the print is stamped.
const groundOk = lq(0.9) < 0.025 && worstSink < 0.05;
// The point of pass C: the foot must be on the DRAWN surface, and that has to be a
// different surface from the undisturbed one, or the run carved nothing and proved
// nothing. Snow at the default foot depth prints about 5 cm.
// Only while actually walking, which also drops the first frames after boot where dt is
// enormous and the accumulator clamps.
const walking = log.filter((f) => f.speed > 0.5);
const stretches = walking.map((f) => f.stretch).sort((a, b) => a - b);
const worstStretchAt = log.reduce((a, f, i) => (f.stretch > log[a].stretch ? i : a), 0);
console.log(`  worst stretch frame             #${worstStretchAt} of ${log.length}, speed ${log[worstStretchAt].speed.toFixed(2)} m/s, ${((log[worstStretchAt].t - log[0].t) / 1000).toFixed(2)} s in`);
const stretchP99 = stretches[Math.floor(stretches.length * 0.99)] ?? 0;
const printOk2 = deepestPrint > 0.015;
// A cloth solver that is converging keeps every edge within a few percent of its rest
// length. Ten percent is loose; the failure this catches was seventy-six.
const clothOk = stretchP99 < 0.08;

console.log("");
{
    // LEG is 0.86 m in skeleton.ts. Anything at 100% is the IK clamping, which means the
    // foot is drawn somewhere the leg cannot actually reach.
    const LEG = 0.86;
    const ext = [];
    for (const f of log) {
        if (f.speed < 0.5) continue;
        for (const k of ["legR", "legL"]) ext.push(f[k] / LEG);
    }
    ext.sort((a, b) => a - b);
    const eq = (q) => ext[Math.min(ext.length - 1, Math.floor(q * ext.length))] ?? 0;
    const st = log.filter((f) => f.speed > 0.5).map((f) => f.stand).sort((a,b)=>a-b);
  console.log(`  stand blend while walking       p50 ${(st[Math.floor(st.length/2)] ?? -1).toFixed(3)}, max ${(st[st.length-1] ?? -1).toFixed(3)}  (0 = fully walking)`);
  const hips = log.filter((f) => f.speed > 0.5).map((f) => (f.r[1] + f.l[1]) / 2);
  const clamped = ext.filter((v) => v > 0.985).length / Math.max(ext.length, 1);
    {
    const w = log.filter((f) => f.speed > 0.5);
    const vs = w.map((f) => f.vertR).sort((a,b)=>a-b);
    const fl = w.map((f) => f.flatR).sort((a,b)=>a-b);
    const md = (a) => a[Math.floor(a.length/2)] ?? 0;
    console.log(`  hip above ankle p50/max         ${md(vs).toFixed(3)} / ${(vs[vs.length-1] ?? 0).toFixed(3)} m   (leg is 0.860)`);
    console.log(`  foot fore-aft from hip p50/max  ${md(fl).toFixed(3)} / ${(fl[fl.length-1] ?? 0).toFixed(3)} m`);
  }
  console.log(`  leg extension p50/p90/max       ${(eq(0.5) * 100).toFixed(0)}% / ${(eq(0.9) * 100).toFixed(0)}% / ${(eq(1) * 100).toFixed(0)}% of leg length`);
    console.log(`  at full stretch (IK clamping)   ${(clamped * 100).toFixed(1)}% of walking frames`);
}
console.log(`  cloth edge stretch              p50 ${(stretches[Math.floor(stretches.length / 2)] * 100).toFixed(1)}%, p99 ${(stretchP99 * 100).toFixed(1)}%, peak ${(stretches[stretches.length - 1] * 100).toFixed(1)}%`);
console.log(`  cloth hanging                   ${cloth.hang.toFixed(3)} m of ${cloth.ideal.toFixed(3)} m`);
console.log(`planted foot holds     ${slideOk ? "PASS" : "FAIL"}`);
console.log(`prints under the feet  ${printOk ? "PASS" : "FAIL"}`);
console.log(`stride is the setting  ${strideOk ? "PASS" : "FAIL"}`);
console.log(`stands on the surface  ${groundOk ? "PASS" : "FAIL"}`);
console.log(`stands in its own print ${printOk2 ? "PASS" : "FAIL"}`);
console.log(`cloth is converging     ${clothOk ? "PASS" : "FAIL"}`);

process.exit(slideOk && printOk && strideOk && groundOk && printOk2 && clothOk ? 0 : 1);
