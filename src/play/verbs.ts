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

/** What a verb needs of the ground: the one operation that is not volume-neutral. */
export interface Ground {
    scoop(x: number, z: number, radius: number, volume: number): void;
    pack(x: number, z: number, radius: number, amount: number): void;
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
    /**
     * Material in the player's hands, in cubic metres.
     *
     * THE CONSERVED QUANTITY, and the reason gather and place are one pass rather than two
     * features. substrate.stamp() is volume-neutral by construction — a footprint pushes
     * down exactly what it heaps up — which is right for walking and useless for carrying,
     * because there is nowhere for the material to go. scoop() is the deliberate exception:
     * it takes a VOLUME and moves it across the boundary between the world and something
     * holding it. This is that something.
     *
     * Every cubic metre that leaves the ground is added here and every one placed is taken
     * off, so the books balance by construction rather than by measurement — and the amount
     * the shader actually moves follows from the kernel's closed-form integral, so the
     * number here is the number the ground loses.
     */
    carried = 0;
    /** Running totals, so a probe can check the two halves against each other. */
    gathered = 0;
    placed = 0;
    /** Compaction applied, for a probe. Not conserved — packing moves nothing. */
    packed = 0;

    private readonly _settings: Settings;
    private readonly _fire: Igniter;
    private readonly _ground: Ground;

    constructor(settings: Settings, fire: Igniter, ground: Ground) {
        this._settings = settings;
        this._fire = fire;
        this._ground = ground;
    }

    /**
     * One frame of intent. Allocates nothing (Rule 1).
     *
     * Called after the mover has moved, so the target is this frame's facing rather than
     * last frame's — a verb aimed one frame behind a turn lands visibly off to the side at
     * a sprint.
     */
    update(input: Input, actor: Actor, dt: number): void {
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

        // A RATE, NOT AN EVENT, so what moves per second does not depend on the frame rate.
        // Both directions clamp against the same two limits — the hands cannot hold more
        // than their capacity and cannot give what they do not have — which is what keeps
        // `carried` inside [0, capacity] without a separate guard, and what makes a held key
        // stop rather than run negative.
        const radius = this._settings.v["play.digRadius"] as number;
        const step = (this._settings.v["play.digRate"] as number) * dt;
        if (input.gather) {
            const take = Math.min(step, (this._settings.v["play.carryCapacity"] as number) - this.carried);
            if (take > 0) {
                this._ground.scoop(this.target.x, this.target.z, radius, take);
                this.carried += take;
                this.gathered += take;
            }
        } else if (input.pack) {
            // NOTHING TO CONSERVE HERE, which is why this sits outside the carried-volume
            // bookkeeping entirely. Packing squeezes air out from between the crystals; the
            // material stays exactly where it was and simply occupies less of it. The one
            // channel that changes is compaction — and because the terrain already reads
            // compaction for roughness, treading a patch down is what makes it reflect.
            const amount = (this._settings.v["play.packRate"] as number) * dt;
            this._ground.pack(this.target.x, this.target.z, radius, amount);
            this.packed += amount;
        } else if (input.place) {
            const give = Math.min(step, this.carried);
            if (give > 0) {
                // Negative volume is the same operation run backwards: material returns as
                // loose mass sitting proud of the surface, which is what a dropped
                // shovelful is — heaped, uncompacted, and free to slump at the angle of
                // repose on the very next relaxation step.
                this._ground.scoop(this.target.x, this.target.z, radius, -give);
                this.carried -= give;
                this.placed += give;
            }
        }
    }
}
