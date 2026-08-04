// Embers. The first geometry in this project since the clipmap, and built the same way:
// the vertex buffer carries an INDEX and nothing else, and where a particle actually is
// gets computed here.
//
// There is no CPU-side particle system, no allocation and no per-frame upload. A particle
// is a pure function of its index and the clock, which also means it needs no state — the
// buffer that would normally hold positions and lifetimes is replaced by a hash.
//
// Embers only exist over hot ground, so each one samples the heat field where it was born
// and collapses to nothing if that spot is cold. That is why the mesh can be static: the
// FIRE decides which of the four thousand particles are real this frame, not the CPU.

#include<substratePack>
#include<substrateTerrainField>
#include<substrateNoise>
#include<substrateAir>
#include<substrateBuffer>
#include<substrateFireBuffer>

// (particleIndex, cornerIndex, 0). Not a position.
attribute position: vec3f;

uniform viewProjection: mat4x4f;
uniform emCamRight: vec3f;
uniform emCamUp: vec3f;
/// x: seconds, y: lifetime, z: rise in m/s, w: size in metres.
uniform emParams: vec4f;
/// x: heat below which no ember is born, y: how far a particle may stray from its cell.
uniform emSpawn: vec2f;

varying vCorner: vec2f;
varying vGlow: f32;

/// How far above the surface an ember starts, in metres.
const EM_CLEARANCE: f32 = 0.06;
/// Fraction of its life spent brightening, so its bright moment is one it spends aloft.
const EM_FADE_IN: f32 = 0.12;

/// One uniform draw in 0..1 from the project's hash.
///
/// TAKE THE ANGLE, NOT THE COMPONENTS. sbHash2 returns a UNIT VECTOR — it is the gradient
/// hash Phase 1's noise is built on, so its x and y are the cosine and sine of a single
/// angle and always land on a circle. Using them as a pair of independent coordinates put
/// every ember on a ring at exactly half the window's width from its centre, which is
/// nowhere near any fire and is why none of them ever lit. The angle itself is uniform;
/// that is the number worth having.
fn emRand(index: i32, salt: i32) -> f32 {
    let v = sbHash2(vec2i(index, salt));
    return atan2(v.y, v.x) * 0.15915494 + 0.5;
}

/// Three independent draws for a particle in a given life cycle.
fn emHash3(index: f32, cycle: f32) -> vec3f {
    let i = i32(index);
    let c = i32(cycle) * 3;
    return vec3f(emRand(i, c + 1), emRand(i + 7919, c + 2), emRand(i + 104729, c + 3));
}

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
    let index = vertexInputs.position.x;
    let corner = vertexInputs.position.y;

    let life = max(uniforms.emParams.y, 0.01);
    // Each particle keeps its own phase, so four thousand of them do not all die at once.
    let offset = fract(index * 0.6180339887);
    let age = uniforms.emParams.x / life + offset;
    // The cycle index reseeds the hash, so a particle is born somewhere new each time
    // round rather than blinking on and off in the same spot forever.
    let rnd = emHash3(index, floor(age));
    let t = fract(age);

    // Born anywhere in the window, and alive only if that spot is hot.
    let birthXZ = uniforms.sbSubOrigin + rnd.xy * uniforms.sbSubExtent;
    let heat = sbFireAt(birthXZ).heat;
    let alive = step(uniforms.emSpawn.x, heat);

    // On the surface the ground actually presents — terrain less whatever has been
    // carved out of it — rather than on the undisturbed heightfield.
    let groundY = sbSampleField(birthXZ).x - sbSubstrateAt(birthXZ).depression;

    // Carried by the same wind as the smoke, and climbing out of it. The horizontal
    // drift uses the real velocity field, so an ember rounds a dune exactly as the plume
    // above it does.
    let air = sbAirAt(birthXZ, sbSampleField(birthXZ).yz);
    let drift = air.velocity.xz * (t * life);
    // Lifted clear of the surface from the moment it exists. An ember born exactly ON
    // the ground is inside the depth buffer's idea of the ground.
    let rise = EM_CLEARANCE + uniforms.emParams.z * t * life * (0.6 + 0.8 * rnd.z);

    let centre = vec3f(birthXZ.x + drift.x, groundY + rise, birthXZ.y + drift.y);

    // Corner offsets: (-1,-1), (1,-1), (-1,1), (1,1) from the two low bits.
    let cx = select(-1.0, 1.0, corner == 1.0 || corner == 3.0);
    let cy = select(-1.0, 1.0, corner >= 2.0);
    vertexOutputs.vCorner = vec2f(cx, cy);

    // Shrinking and fading as it goes, and gone entirely where the ground is cold.
    //
    // IT MUST NOT PEAK AT BIRTH. This was (1-t)^2, which is brightest at t = 0 — exactly
    // when the ember is still at ground level and therefore inside the terrain as far as
    // the depth buffer is concerned. Every particle drew, and every particle spent its
    // bright moment buried and its visible moments faded to nothing. Ramping in over the
    // first fraction of its life puts the brightness where the ember actually is.
    let fade = smoothstep(0.0, EM_FADE_IN, t) * (1.0 - t);
    // SIZE DOES NOT FOLLOW THE FADE. Tying it to brightness made a spark shrink to
    // nothing by the time it had climbed clear of the pool that launched it — so the only
    // moments it was large were the moments it was lost inside the glare. It dims as it
    // rises; it does not evaporate.
    // SIZE DOES NOT FOLLOW THE FADE. Tying it to brightness made a spark shrink to
    // nothing by the time it had climbed clear of the pool that launched it, so the only
    // moments it was large were the moments it was lost inside the glare. It dims as it
    // rises; it does not evaporate.
    let size = uniforms.emParams.w * (0.4 + 0.6 * rnd.z) * alive * (0.55 + 0.45 * (1.0 - t));
    // Not multiplied by heat. An ember carries its own fire away from the ground that
    // launched it — dimming it by the heat where it was BORN made every spark brightest
    // in the one place it could not be seen, which is inside the glare of the pool.
    // Not multiplied by heat. An ember carries its own fire away from the ground that
    // launched it, and dimming it by the heat where it was BORN would make every spark
    // faintest exactly where it can finally be seen against the sky.
    vertexOutputs.vGlow = fade * alive;

    let world = centre + (uniforms.emCamRight * cx + uniforms.emCamUp * cy) * size;
    vertexOutputs.position = uniforms.viewProjection * vec4f(world, 1.0);
}
