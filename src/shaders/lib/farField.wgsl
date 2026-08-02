// SHARED INCLUDE — substrateFarField
//
// Terrain past the clipmap's 870 m edge, raymarched against sbTerrainD itself.
// Requires <substrateNoise>, <substrateHeightfield> and <substrateTerrainParams>.
//
// THE SAME FUNCTION, NOT AN APPROXIMATION OF IT. The clipmap draws a baked sample of
// sbTerrainD; this evaluates sbTerrainD directly. They meet at 870 m, and if the two
// disagreed the horizon would show a step exactly at the clipmap's edge — which is
// precisely the failure the heightfield's bake-orientation probe exists to rule out,
// because a Z-mirrored bake would put the near terrain and the far terrain in
// different worlds.
//
// Cost is real and is the point of the step-count setting: sbTerrainD is around a
// dozen gradient-noise evaluations, and this runs a march of them per background
// pixel. Steps are spaced GEOMETRICALLY, so near the clipmap edge they are tight and
// out at the horizon they are kilometres apart, which is the only distribution that
// makes a horizon affordable at all.

struct SbFarHit {
    hit: bool,
    dist: f32,
    world: vec3f,
    deriv: vec2f,
};

/// March `rd` from `start` to `far` metres. `ro` is the eye.
fn sbFarMarch(ro: vec3f, rd: vec3f, start: f32, far: f32, steps: i32, prm: SbTerrainParams) -> SbFarHit {
    var out: SbFarHit;
    out.hit = false;
    out.dist = far;
    out.world = ro + rd * far;
    out.deriv = vec2f(0.0);

    // Only rays heading down can meet a heightfield from above it.
    if (rd.y < -1e-4) {
        let ratio = far / max(start, 1.0);
        var tPrev = start;
        var hPrev = 0.0;
        var found = false;

        for (var i = 1; i <= steps; i = i + 1) {
            if (!found) {
                let t = start * pow(ratio, f32(i) / f32(steps));
                let p = ro + rd * t;
                let field = sbTerrainD(p.xz, prm);
                let gap = p.y - field.x;

                if (gap < 0.0) {
                    // Crossed. One linear solve between the last two samples is
                    // enough at this range — the step either side is hundreds of
                    // metres and the silhouette is a pixel wide.
                    let span = max(hPrev - gap, 1e-4);
                    let tHit = mix(tPrev, t, hPrev / span);
                    let hit = ro + rd * tHit;
                    let atHit = sbTerrainD(hit.xz, prm);

                    out.hit = true;
                    out.dist = tHit;
                    out.world = vec3f(hit.x, atHit.x, hit.z);
                    out.deriv = atHit.yz;
                    found = true;
                }

                tPrev = t;
                hPrev = gap;
            }
        }
    }

    return out;
}
