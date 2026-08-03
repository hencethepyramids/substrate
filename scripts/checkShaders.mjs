#!/usr/bin/env node
//
// Static checks over the hand-written WGSL.
//
// `tsc --noEmit` and `vite build` never look inside a .wgsl file — shaders are opaque
// strings until a driver sees them, and two phases of this project shipped green and
// rendered nothing. This does not compile WGSL. It catches the specific ways a
// Babylon WGSL shader goes wrong silently:
//
//   - an #include name that is not registered
//   - `uniforms.x` with no `uniform x:` behind it, in this shader or its includes
//   - a uniform or sampler the WGSL declares that no TypeScript ever sets, and the
//     reverse: a set*() call naming something no shader declares
//   - a texture without its paired sampler declaration
//   - a bare `return;` inside an entry point, which Babylon's processor turns into
//     invalid WGSL by appending its own `return fragmentOutputs;`
//   - an identifier used above the line that declares it
//
// Exit code 1 on any error. Warnings do not fail.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHADERS = join(root, "src", "shaders");
const LIB = join(SHADERS, "lib");

const errors = [];
const warnings = [];
const err = (where, msg) => errors.push(`${where}: ${msg}`);
const warn = (where, msg) => warnings.push(`${where}: ${msg}`);

// -- sources -----------------------------------------------------------------

function walk(dir, out = []) {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p, out);
        else out.push(p);
    }
    return out;
}

const tsFiles = walk(join(root, "src")).filter((p) => p.endsWith(".ts"));
const tsSource = tsFiles.map((p) => readFileSync(p, "utf8")).join("\n");

/** Include name -> resolved wgsl path, read out of the registry itself. */
function readRegistry() {
    const src = readFileSync(join(LIB, "register.ts"), "utf8");
    const imports = new Map();
    for (const m of src.matchAll(/import\s+(\w+)\s+from\s+"(.+?)\?raw"/g)) {
        imports.set(m[1], join(LIB, m[2].replace(/^\.\//, "")));
    }
    const registry = new Map();
    for (const m of src.matchAll(/store\["(\w+)"\]\s*=\s*(\w+);/g)) {
        const path = imports.get(m[2]);
        if (!path) err("lib/register.ts", `store["${m[1]}"] = ${m[2]}, but ${m[2]} is not imported`);
        else registry.set(m[1], path);
    }
    return registry;
}

const registry = readRegistry();

/** Strip comments so they cannot produce phantom declarations or references. */
function strip(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/**
 * Resolve #include recursively, keeping source order — WGSL wants a declaration
 * above its use, and the include order is what decides that.
 */
function resolve(raw, where, seen = new Set()) {
    let out = "";
    for (const line of raw.split("\n")) {
        const inc = line.match(/^\s*#include<(\w+)>/);
        if (!inc) {
            out += line + "\n";
            continue;
        }
        const name = inc[1];
        const target = registry.get(name);
        if (!target) {
            err(where, `#include<${name}> is not registered in lib/register.ts`);
            continue;
        }
        if (seen.has(name)) continue; // already pulled in by an earlier include
        seen.add(name);
        out += resolve(readFileSync(target, "utf8"), where, seen);
    }
    return out;
}

// -- the checks --------------------------------------------------------------

const declaredUniforms = new Set();
const declaredTextures = new Set();

function checkEntry(path) {
    const where = relative(root, path);
    check(where, readFileSync(path, "utf8"));
}

function checkInline(where, text) {
    check(where, text);
}

function check(where, raw) {
    const src = strip(resolve(raw, where));

    // uniforms
    const declared = new Set();
    for (const m of src.matchAll(/^\s*uniform\s+(\w+)\s*:/gm)) declared.add(m[1]);
    for (const n of declared) declaredUniforms.add(n);

    const used = new Set();
    for (const m of src.matchAll(/\buniforms\.(\w+)/g)) used.add(m[1]);

    for (const n of used) if (!declared.has(n)) err(where, `uniforms.${n} is used but no "uniform ${n}:" is declared here or in its includes`);
    for (const n of declared) if (!used.has(n)) warn(where, `uniform ${n} is declared but never read — it still costs a slot in the UBO`);

    // textures and their samplers
    const textures = new Set();
    for (const m of src.matchAll(/^\s*var\s+(\w+)\s*:\s*texture_2d</gm)) textures.add(m[1]);
    const samplers = new Set();
    for (const m of src.matchAll(/^\s*var\s+(\w+)\s*:\s*sampler\s*;/gm)) samplers.add(m[1]);
    for (const t of textures) {
        declaredTextures.add(t);
        if (!samplers.has(`${t}Sampler`)) err(where, `texture ${t} has no "var ${t}Sampler: sampler;" — Babylon pairs them by name`);
    }
    for (const s of samplers) if (!textures.has(s.replace(/Sampler$/, ""))) warn(where, `sampler ${s} has no matching texture`);

    // attributes and varyings
    for (const m of src.matchAll(/\bvertexInputs\.(\w+)/g)) {
        if (!new RegExp(`^\\s*attribute\\s+${m[1]}\\s*:`, "m").test(src)) err(where, `vertexInputs.${m[1]} is used but not declared as an attribute`);
    }
    const varyings = new Set();
    for (const m of src.matchAll(/^\s*varying\s+(\w+)\s*:/gm)) varyings.add(m[1]);
    for (const m of src.matchAll(/\bvertexOutputs\.(\w+)/g)) {
        if (m[1] !== "position" && !varyings.has(m[1])) err(where, `vertexOutputs.${m[1]} is written but not declared as a varying`);
    }

    // calls to project functions nothing declares — i.e. a missing #include
    //
    // This is the one that a green `vite build` hides most convincingly: a shader can
    // call sbDisplay(), compile in TypeScript's eyes, pass every other check here, and
    // then fail on the driver because the include that defines it was never added. The
    // prefix filter is what makes it safe — no WGSL builtin is named sbX or shX.
    const declaredFns = new Set();
    for (const m of src.matchAll(/^\s*fn\s+(\w+)\s*\(/gm)) declaredFns.add(m[1]);
    for (const m of src.matchAll(/\b((?:sb|sd|sk|sl|sa|sp|sr|sh)[A-Z]\w*)\s*\(/g)) {
        if (!declaredFns.has(m[1])) err(where, `${m[1]}(...) is called but no "fn ${m[1]}" is declared here or in its includes — the #include that defines it is missing`);
    }

    // bare return in an entry point
    for (const m of src.matchAll(/@(fragment|vertex)\s+fn\s+(\w+)[\s\S]*?\n\}/g)) {
        if (/\breturn\s*;/.test(m[0])) {
            err(where, `bare "return;" inside @${m[1]} fn ${m[2]} — Babylon appends its own "return ...Outputs;", so this is invalid WGSL and the shader will not compile`);
        }
    }

    // declaration order
    checkOrder(where, src);
}

/**
 * WGSL wants a module-scope declaration above its use, and #include order is what
 * decides that. Only project identifiers are checked — the prefixes make a local
 * variable colliding with a global vanishingly unlikely.
 */
function checkOrder(where, src) {
    const declAt = new Map();
    const patterns = [/^\s*fn\s+(\w+)\s*\(/gm, /^\s*const\s+(\w+)\s*[:=]/gm, /^\s*struct\s+(\w+)\s*\{/gm, /^\s*var\s+(\w+)\s*:/gm, /^\s*uniform\s+(\w+)\s*:/gm];
    for (const re of patterns) {
        for (const m of src.matchAll(re)) {
            if (!declAt.has(m[1])) declAt.set(m[1], m.index);
        }
    }
    for (const [name, at] of declAt) {
        if (!/^(sb|sd|sk|sp|sr|SB_|SD_|SK_|SP_|SR_)/.test(name)) continue;
        const use = new RegExp(`\\b${name}\\b`, "g");
        let m;
        while ((m = use.exec(src)) !== null) {
            if (m.index >= at) break;
            // skip the declaration line itself and any earlier declaration keyword
            const lineStart = src.lastIndexOf("\n", m.index) + 1;
            const line = src.slice(lineStart, src.indexOf("\n", m.index));
            if (/^\s*(fn|const|struct|var|uniform)\s/.test(line)) continue;
            err(where, `${name} is used at offset ${m.index} but declared at ${at} — put its #include above the one that uses it`);
            break;
        }
    }
}

const entries = readdirSync(SHADERS)
    .filter((f) => f.endsWith(".wgsl"))
    .map((f) => join(SHADERS, f));

for (const e of entries) checkEntry(e);

// Shaders written inline in TypeScript — the heightfield's orientation probes are
// the current pair. They are entry points like any other and go wrong the same ways.
let inlineCount = 0;
for (const path of tsFiles) {
    const src = readFileSync(path, "utf8");
    for (const m of src.matchAll(/`([^`]*@(?:fragment|vertex)[^`]*)`/g)) {
        inlineCount++;
        checkInline(`${relative(root, path)} (inline #${inlineCount})`, m[1]);
    }
}

// -- WGSL against TypeScript -------------------------------------------------

/** Names TS actually sets, via a ShaderMaterial/ProceduralTexture setter. */
const setInTs = new Set();
for (const m of tsSource.matchAll(/\.set(?:Float|Floats|Int|Vector2|Vector3|Vector4|Color3|Color4|Matrix|Texture|Array3|Array4)\("(\w+)"/g)) setInTs.add(m[1]);
/** Names TS declares in a uniforms/samplers list. Literals only — good enough, and it is what the lists are. */
const listedInTs = new Set();
for (const m of tsSource.matchAll(/"(\w+)"/g)) listedInTs.add(m[1]);

// Uniforms Babylon supplies itself; never set by hand.
const BUILT_IN = new Set(["world", "viewProjection", "view", "projection", "worldView", "worldViewProjection"]);

for (const n of declaredUniforms) {
    if (BUILT_IN.has(n)) continue;
    if (!listedInTs.has(n)) err("wgsl/ts", `uniform ${n} is declared in WGSL but never named in TypeScript — it will silently read as zero`);
    else if (!setInTs.has(n)) warn("wgsl/ts", `uniform ${n} is listed in TypeScript but never set — it will read as zero`);
}
for (const n of declaredTextures) {
    if (!setInTs.has(n)) err("wgsl/ts", `texture ${n} is declared in WGSL but no setTexture("${n}", ...) exists — the binding will be missing`);
}
for (const n of setInTs) {
    if (!declaredUniforms.has(n) && !declaredTextures.has(n)) {
        warn("wgsl/ts", `set*("${n}") has no matching WGSL declaration — dead call, or a typo that is costing you the real one`);
    }
}

// -- report ------------------------------------------------------------------

for (const w of warnings) console.log(`  warn  ${w}`);
for (const e of errors) console.error(`  ERROR ${e}`);

const scanned = entries.length;
if (errors.length > 0) {
    console.error(`\nshader check: ${errors.length} error(s), ${warnings.length} warning(s) across ${scanned} entry points`);
    process.exit(1);
}
console.log(`\nshader check: ok — ${scanned} entry points, ${warnings.length} warning(s)`);
