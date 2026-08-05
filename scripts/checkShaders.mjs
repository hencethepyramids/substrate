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

/**
 * WGSL's reserved word list, trimmed to the ones a person would plausibly reach for as a
 * variable name. The full list runs to hundreds and most of them (`reinterpret_cast`,
 * `pixelfragment`) nobody is going to type by accident; these are the traps.
 *
 * `input` and `output` are deliberately NOT here despite reading like keywords: sixteen
 * shipping shaders in this project name their entry-point parameter `input`, which is
 * Babylon's own convention, and every one of them compiles. A checker that cries wolf
 * about working code gets switched off.
 */
const WGSL_RESERVED = new Set([
    "target", "sample", "filter", "binding", "buffer", "texture", "shared", "common", "handle", "resource", "select", "typedef", "template", "union", "using", "where", "with", "match", "mat", "vec", "get", "set", "new", "null", "nullptr", "namespace", "package", "premerge", "regardless", "require", "restrict", "self", "signed", "sizeof", "smooth", "snorm", "static", "std", "subroutine", "super", "unless", "unorm", "virtual", "yield", "asm", "auto", "become", "cast", "class", "compile", "do", "enum", "explicit", "export", "extern", "final", "friend", "goto", "inline", "macro", "module", "operator", "private", "protected", "public", "pub", "ref", "typename", "unsafe", "unsized", "wgsl",
]);

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

    // WGSL reserved keywords used as identifiers
    //
    // WGSL reserves a long list of words it does not currently use, against future
    // grammar. They read as perfectly ordinary variable names -- `target`, `sample`,
    // `filter`, `binding` -- and nothing but the driver objects. `let target = ...` in
    // the Phase 6 heat pass compiled clean through tsc, vite and every other check here,
    // and failed with "'target' is a reserved keyword" the first time a GPU saw it.
    for (const m of src.matchAll(/\b(?:let|var|const)\s+(\w+)\s*[:=]/g)) {
        if (WGSL_RESERVED.has(m[1])) err(where, `"${m[1]}" is a reserved keyword in WGSL and cannot be an identifier — the driver rejects the whole shader`);
    }
    for (const m of src.matchAll(/^\s*fn\s+(\w+)\s*\(([^)]*)\)/gm)) {
        if (WGSL_RESERVED.has(m[1])) err(where, `"${m[1]}" is a reserved keyword in WGSL and cannot name a function`);
        for (const p of m[2].split(",")) {
            const name = p.trim().split(":")[0].trim();
            if (name && WGSL_RESERVED.has(name)) err(where, `"${name}" is a reserved keyword in WGSL and cannot name a parameter`);
        }
    }

    // mixing bitwise and arithmetic operators without parentheses
    //
    // WGSL declines to guess a precedence here and rejects the whole shader with
    // "mixing '*' and '^' requires parenthesis". Nothing upstream of the driver knows:
    // the expression is well-formed by every other measure, so a green build, a green
    // typecheck and every other check in this file all pass, and the terrain renders
    // black. The rule is narrow — an operand directly between an arithmetic operator and
    // a bitwise one, with no bracket in between — so it does not fire on the parenthesised
    // form that WGSL actually wants.
    // The leading class must allow `)` — `u32(q.x) * K ^ ...` is the exact shape that
    // caused this, and an operand very often ends in a closing bracket.
    // The operand between the two operators must NOT contain a bracket: a `)` sitting
    // there is precisely the parenthesis WGSL is asking for, so `(a * b) ^ c` is fine
    // while `a * b ^ c` is not.
    const MIXED = /[^\s({;,]\s*[*/%+-]\s*[\w.]+\s*(\^|\||&|<<|>>)(?![|&=])/g;
    for (const line of src.split("\n")) {
        // `->` and `>>=` are not bitwise shifts, and a comparison is not a mix.
        const cleaned = line.replace(/->/g, "  ").replace(/[<>]=/g, "  ");
        const m = MIXED.exec(cleaned);
        MIXED.lastIndex = 0;
        if (m) err(where, `mixing arithmetic with "${m[1]}" without parentheses — WGSL rejects this outright: ${line.trim()}`);
    }

    // bare return in an entry point
    for (const m of src.matchAll(/@(fragment|vertex)\s+fn\s+(\w+)[\s\S]*?\n\}/g)) {
        if (/\breturn\s*;/.test(m[0])) {
            err(where, `bare "return;" inside @${m[1]} fn ${m[2]} — Babylon appends its own "return ...Outputs;", so this is invalid WGSL and the shader will not compile`);
        }
    }

    // textures pulled in by an include the entry point never actually uses
    checkReachableTextures(where, src, textures);

    // declaration order
    checkOrder(where, src);
}

/**
 * A texture this shader must BIND but can never READ.
 *
 * An include that declares a texture obliges every shader including it to bind that
 * texture — the oldest gotcha in this project, written up in the README since Phase 2.
 * Include a header for one helper you want and you silently inherit a binding
 * requirement for a texture you will never touch, and the failure arrives as a wall of
 * Babylon bind-group errors at boot rather than as anything pointing at the include.
 *
 * So: walk the call graph out from the entry point, and any declared texture that no
 * reachable function mentions is an include that should not be there.
 */
function checkReachableTextures(where, src, textures) {
    if (textures.size === 0) return;

    // Function bodies, approximately: from each `fn name(` to the next one. Everything in
    // this project is a top-level function, so that is exact enough.
    const bodies = new Map();
    const decls = [...src.matchAll(/^\s*fn\s+(\w+)\s*\(/gm)];
    for (let i = 0; i < decls.length; i++) {
        const start = decls[i].index;
        const end = i + 1 < decls.length ? decls[i + 1].index : src.length;
        bodies.set(decls[i][1], src.slice(start, end));
    }

    const entry = [...src.matchAll(/@(?:fragment|vertex|compute)[\s\S]*?fn\s+(\w+)\s*\(/g)].map((m) => m[1]);
    if (entry.length === 0) return;

    const reachable = new Set();
    const queue = [...entry];
    while (queue.length > 0) {
        const name = queue.pop();
        if (reachable.has(name)) continue;
        reachable.add(name);
        const body = bodies.get(name);
        if (body === undefined) continue;
        for (const m of body.matchAll(/\b(\w+)\s*\(/g)) {
            if (bodies.has(m[1]) && !reachable.has(m[1])) queue.push(m[1]);
        }
    }

    // The entry point's own body counts too, and it is already in `reachable`.
    let text = "";
    for (const name of reachable) text += bodies.get(name) ?? "";

    for (const t of textures) {
        if (!new RegExp(`\\b${t}\\b`).test(text)) {
            err(where, `texture ${t} is declared but nothing this entry point can reach ever reads it — an #include is pulling in a binding requirement for a texture this pass will never touch`);
        }
    }
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

// The one texture nobody binds: a PostProcess's input. Babylon names it `textureSampler`
// by convention and wires the previous pass's output — or the scene target — to it. The
// rule above is right for everything else and would be a false positive exactly here.
const BUILT_IN_TEXTURES = new Set(["textureSampler"]);

for (const n of declaredUniforms) {
    if (BUILT_IN.has(n)) continue;
    if (!listedInTs.has(n)) err("wgsl/ts", `uniform ${n} is declared in WGSL but never named in TypeScript — it will silently read as zero`);
    else if (!setInTs.has(n)) warn("wgsl/ts", `uniform ${n} is listed in TypeScript but never set — it will read as zero`);
}
for (const n of declaredTextures) {
    if (BUILT_IN_TEXTURES.has(n)) continue;
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
