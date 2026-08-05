// Spray. Material thrown into the air by something moving through it fast.
//
// Built exactly as the embers are, and for the same reasons: the vertex buffer carries an
// INDEX and nothing else, a particle is a pure function of its index and the clock, and
// there is no CPU-side particle system, no per-frame upload and no state.
//
// WHAT DECIDES A PARTICLE IS REAL IS THE SUBSTRATE'S LOOSE MASS, not the CPU. The wake
// carves, the relaxation turns that carve into loose material, and this reads the mass
// channel and throws what it finds. So spray appears where the ground has actually been
// broken and nowhere else — a track through deep snow throws a great deal, the same track
// over packed ground throws almost nothing, and neither case needed a rule written for it.

#include<substratePack>
#include<substrateTerrainField>
#include<substrateNoise>
#include<substrateAir>
#include<substrateBuffer>

// (particleIndex, cornerIndex, 0). Not a position.
attribute position: vec3f;

uniform viewProjection: mat4x4f;
uniform spCamRight: vec3f;
uniform spCamUp: vec3f;
/// x: seconds, y: lifetime, z: launch speed in m/s, w: size in metres.
uniform spParams: vec4f;
/// xy: where the character is, z: how fast it is going, w: how far spray is thrown from it.
uniform spSource: vec4f;
/// xy: the character's travel direction, z: loose mass below which nothing is thrown,
/// w: speed below which nothing is thrown.
uniform spThrow: vec4f;
uniform spCameraPos: vec3f;

varying vCorner: vec2f;
varying vGlow: f32;
varying vDist: f32;
varying vView: vec3f;

/// Gravity. Spray is ballistic — it is thrown, and then it is just falling.
const SP_GRAVITY: f32 = -9.81;
/// How far above the surface a particle starts, so it is not born inside the ground.
const SP_CLEARANCE: f32 = 0.05;

/// One uniform draw in 0..1 from the project's hash.
///
/// TAKE THE ANGLE, NOT THE COMPONENTS — sbHash2 returns a unit vector, so its x and y are
/// the cosine and sine of one angle and always land on a circle. The embers spent three
/// debugging rounds on exactly this, in this exact spot.
fn spRand(index: i32, salt: i32) -> f32 {
    let v = sbHash2(vec2i(index, salt));
    return atan2(v.y, v.x) * 0.15915494 + 0.5;
}

fn spHash3(index: f32, cycle: f32) -> vec3f {
    let i = i32(index);
    let c = i32(cycle) * 3;
    return vec3f(spRand(i, c + 1), spRand(i + 6151, c + 2), spRand(i + 99991, c + 3));
}

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
    let index = vertexInputs.position.x;
    let corner = vertexInputs.position.y;

    let life = max(uniforms.spParams.y, 0.01);
    let offset = fract(index * 0.6180339887);
    let age = uniforms.spParams.x / life + offset;
    let rnd = spHash3(index, floor(age));
    let t = fract(age);

    // Born in a disc around the character, with sqrt on the radius so the area is covered
    // evenly rather than crowding the middle.
    let ang = rnd.x * 6.2831853;
    let rad = sqrt(rnd.y) * uniforms.spSource.w;
    let birthXZ = uniforms.spSource.xy + vec2f(cos(ang), sin(ang)) * rad;

    // Only where the ground is actually broken, and only while something is breaking it.
    let sub = sbSubstrateAt(birthXZ);
    let alive = step(uniforms.spThrow.z, sub.mass) * step(uniforms.spThrow.w, uniforms.spSource.z);

    let groundY = sbSampleField(birthXZ).x - sub.depression;

    // Thrown up and out to the side of the track — a wake throws material sideways,
    // because sideways is where the material it displaced has to go.
    let side = vec2f(-uniforms.spThrow.y, uniforms.spThrow.x);
    let lateral = side * (rnd.z - 0.5) * 2.0;
    let launch = uniforms.spParams.z * (0.55 + 0.9 * rnd.z);
    let secs = t * life;

    // Ballistic, plus the wind. The same wind the smoke and the cloak read, so a plume of
    // thrown snow drifts the way everything else in the air drifts.
    let air = sbAirAt(birthXZ, sbSampleField(birthXZ).yz);
    let drift = air.velocity.xz * secs * 0.55;
    let x = birthXZ.x + lateral.x * launch * 0.35 * secs + drift.x;
    let z = birthXZ.y + lateral.y * launch * 0.35 * secs + drift.y;
    let y = groundY + SP_CLEARANCE + launch * secs + 0.5 * SP_GRAVITY * secs * secs;

    let cx = select(-1.0, 1.0, corner == 1.0 || corner == 3.0);
    let cy = select(-1.0, 1.0, corner >= 2.0);
    vertexOutputs.vCorner = vec2f(cx, cy);

    // Fades in off the ground and out as it falls. Never brightest at birth, which is the
    // moment it is inside the surface as far as the depth buffer is concerned.
    let fade = smoothstep(0.0, 0.12, t) * (1.0 - t) * alive;
    vertexOutputs.vGlow = fade;

    // Collapses to nothing once it has fallen back below the ground it came from.
    let landed = step(groundY, y);
    let size = uniforms.spParams.w * (0.5 + 0.5 * rnd.z) * alive * landed;

    let world = vec3f(x, y, z) + (uniforms.spCamRight * cx + uniforms.spCamUp * cy) * size;
    // Thrown material is air like anything else at range: forty metres of it between the
    // eye and a grain of snow does the same thing it does to the dune behind it.
    let toEye = world - uniforms.spCameraPos;
    vertexOutputs.vDist = length(toEye);
    vertexOutputs.vView = toEye / max(vertexOutputs.vDist, 1e-4);
    vertexOutputs.position = uniforms.viewProjection * vec4f(world, 1.0);
}
