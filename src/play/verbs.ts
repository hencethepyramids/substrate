import type { Settings } from "../core/settings";
import type { Input } from "../core/input";

/**
 * What a verb needs of the fire, and nothing more.
 *
 * The same narrow-interface habit as Post's HeatSource: this module decides WHEN and WHERE
 * something is lit, and has no opinion about combustion.
 */
export interface Igniter {
    ignite(x: number, z: number, radius: number, rate: number): void;
}

/** Where the player is and which way they are pointed. */
export interface Actor {
    readonly position: { x: number; y: number; z: number };
    readonly facing: number;
}

/**
 * The verb layer — what the player can DO to the world, as opposed to where they can go.
 *
 * PHASE 10 OPENS WITH A GAP, NOT A FEATURE. Every simulation in this project is finished
 * and reachable only by the harness. Fire has heat, fuel, embers, smoke, a light pool and a
 * propagation model; the substrate has mass, depression, compaction and phase; the air has
 * a velocity field that all of them read. And the sum total of what a PLAYER can do to any
 * of it is leave footprints. scripts/capture.mjs can call `fire.ignite` and
 * `substrate.stamp`; the person holding the keyboard cannot. This module is the layer that
 * closes that gap, one verb at a time.
 *
 * WHY A LAYER RATHER THAN A CALL IN main.ts. The frame loop could perfectly well test a key
 * and call `fire.ignite`, and for one verb that would be shorter. It stops being shorter at
 * the second verb, because every verb shares the same three questions — is it enabled, WHERE
 * is it aimed, and did the player ask for it this frame — and answering those three in the
 * loop once per verb is how a frame loop turns into a pile of special cases. The target in
 * particular is worth having in one place: it is the same point for every verb, it is what
 * a reticle would draw, and it is the thing most likely to need a raycast later.
 *
 * AIMED AT ARM'S LENGTH, NOT AT A CURSOR. A third-person camera has no cursor, and pointer
 * lock is not available to a headless run — so the target is derived from the character
 * rather than from the mouse: a fixed reach along the facing direction, at ground level.
 * That is also the honest model for verbs that are physically done with the hands. Forward
 * is (sin, cos) of the facing angle, which is the convention gait.ts already solves the
 * stance width in, and taking it from there rather than deriving it again is deliberate —
 * two definitions of forward is how a character ends up lighting fires beside itself.
 */
export class Verbs {
    /** Where the next verb will land. Read by the harness; a reticle would draw here. */
    readonly target = { x: 0, z: 0 };
    /** Verbs performed this session, so a probe can assert one happened. */
    ignitions = 0;

    private readonly _settings: Settings;
    private readonly _fire: Igniter;

    constructor(settings: Settings, fire: Igniter) {
        this._settings = settings;
        this._fire = fire;
    }

    /**
     * One frame of intent. Allocates nothing (Rule 1).
     *
     * Called after the mover has moved, so the target is this frame's facing rather than
     * last frame's — a verb aimed one frame behind a turn lands visibly off to the side at
     * a sprint.
     */
    update(input: Input, actor: Actor): void {
        const reach = this._settings.v["play.reach"] as number;
        this.target.x = actor.position.x + Math.sin(actor.facing) * reach;
        this.target.z = actor.position.z + Math.cos(actor.facing) * reach;

        if (!(this._settings.v["sys.verbs"] as boolean)) return;

        if (input.ignite) {
            // The same radius and rate the harness has been using since Phase 6, so a fire
            // lit by hand behaves exactly like a fire lit by a script. If they ever differ,
            // every capture that verified fire verified something the player cannot do.
            this._fire.ignite(this.target.x, this.target.z, this._settings.v["fire.igniteRadius"] as number, this._settings.v["fire.igniteRate"] as number);
            this.ignitions++;
        }
    }
}
