// The bone palette, and skinning.
//
// Three vec4s per bone, holding the ROWS of a 3x4 affine transform. The fourth row of a
// rigid transform is always (0,0,0,1), so storing it would be storing a constant 18
// times; what is here is the whole of the information and none of the padding.
//
// The transform maps a vertex authored in the REST pose — character space, feet at the
// origin — straight to world space. The CPU side builds it as
//
//     root . translate(head) . R . translate(-restHead)
//
// which is only that short because the rig's rest orientations are all the identity, so
// a bone's inverse bind matrix degenerates to a translation. See skeleton.ts.
//
// Declares no texture and binds nothing, so the beauty pass and the shadow cast can both
// take it and skin from exactly the same lines. That matters more here than anywhere
// else in the project: a character whose shadow is computed from a second copy of the
// skinning is a character that casts the shadow of a pose it is not in.

// 18 bones x 3 rows. THE LENGTH MUST STAY A LITERAL — Babylon's WGSL processor reads it
// straight out of this declaration to size the uniform buffer, so a named constant here
// would leave the buffer sized zero and every bone reading garbage.
uniform skBones: array<vec4f, 54>;

/// A rest-pose point through bone `b`.
fn skBonePoint(b: i32, p: vec3f) -> vec3f {
    let q = vec4f(p, 1.0);
    let i = b * 3;
    return vec3f(dot(uniforms.skBones[i], q), dot(uniforms.skBones[i + 1], q), dot(uniforms.skBones[i + 2], q));
}

/// A rest-pose direction through bone `b`. No translation, so w is zero.
fn skBoneAxis(b: i32, v: vec3f) -> vec3f {
    let q = vec4f(v, 0.0);
    let i = b * 3;
    return vec3f(dot(uniforms.skBones[i], q), dot(uniforms.skBones[i + 1], q), dot(uniforms.skBones[i + 2], q));
}

/// Skin a point. `s` is the vertex's (boneA, boneB, weightB, material) attribute.
///
/// Two influences, not four. Every vertex in this figure sits on a limb or across one
/// joint, and a joint has exactly two bones — a third weight would be a slot that is
/// always zero, uploaded once per vertex forever.
fn skSkinPoint(s: vec4f, p: vec3f) -> vec3f {
    let a = skBonePoint(i32(s.x), p);
    let b = skBonePoint(i32(s.y), p);
    return mix(a, b, s.z);
}

/// Skin a direction. Rigid bones, so this is a rotation and the result stays unit.
fn skSkinAxis(s: vec4f, v: vec3f) -> vec3f {
    let a = skBoneAxis(i32(s.x), v);
    let b = skBoneAxis(i32(s.y), v);
    return normalize(mix(a, b, s.z));
}
