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
    /** Volume-neutral: displaces material into a rim rather than creating it. */
    stamp(x: number, z: number, radius: number, depth: number): void;
    /** Volume-neutral and DIRECTED: takes material from here and puts it down over there. */
    shove(x: number, z: number, radius: number, dx: number, dz: number, volume: number): void;
}

/** Ground height, for a thrown projectile to land on. */
export interface Heights {
    groundAt(x: number, z: number): number;
}

/** Where the player is, which way they are pointed, and whether their feet are down. */
export interface Actor {
    readonly position: { x: number; y: number; z: number };
    readonly facing: number;
    readonly airborne: boolean;
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
/** Projectiles allowed in the air at once. A pair of hands cannot outrun this. */
const MAX_THROWN = 8;

/** Release height above the character's feet, in metres - roughly the shoulder. */
const THROW_HEIGHT = 1.35;

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
    /** Compaction applied, for a probe. Not conserved - packing moves nothing. */
    packed = 0;
    /** Metres of terrain commanded up or down. Displaced, never created. */
    bent = 0;
    /** Cubic metres carried sideways. Neither gained nor lost — see `shove`. */
    swept = 0;
    /** Thrown and landed volume, which must end equal. See _step below. */
    thrown = 0;
    landed = 0;
    landings = 0;
    /** Where the last throw came down, for a probe to check its bearing against facing. */
    readonly lastLanding = { x: 0, z: 0 };

    private readonly _settings: Settings;
    private readonly _fire: Igniter;
    private readonly _ground: Ground;
    private readonly _heights: Heights;
    /**
     * Projectiles in flight: x, y, z, vx, vy, vz, volume - seven floats each, in one flat
     * array allocated once (Rule 1). Eight is far more than a pair of hands can put in the
     * air, and a full buffer drops the throw rather than growing, so a stuck projectile can
     * never become an unbounded allocation.
     */
    private readonly _flight = new Float32Array(MAX_THROWN * 7);
    private _inFlight = 0;

    /**
     * Called whenever material reaches the ground, from a hand or from a landing throw.
     *
     * A single hook for both, because to anything downstream they are the same event —
     * which is exactly why both routes were made to go through one scoop() call. A game
     * layer that had to know which verb delivered a load would be coupled to the verbs
     * rather than to the world.
     */
    onDeposit: ((x: number, z: number, volume: number) => void) | null = null;

    /** Projectiles still in the air. Read by the overlay; see the counter in main.ts. */
    get inFlight(): number {
        return this._inFlight;
    }

    /**
     * The raw flight records, so the renderer draws the simulation rather than a copy of
     * it. Stride 7: x, y, z, vx, vy, vz, volume.
     *
     * Exposed rather than mirrored deliberately. A renderer that kept its own positions and
     * integrated them alongside would drift from these within a second of a frame-rate
     * wobble, and the ball would land somewhere other than where the impact is registered —
     * a bug that looks like a physics problem and is a bookkeeping one.
     */
    get flight(): Float32Array {
        return this._flight;
    }

    /** How many records the array holds, for a renderer sizing its buffers once. */
    static get maxThrown(): number {
        return MAX_THROWN;
    }

    constructor(settings: Settings, fire: Igniter, ground: Ground, heights: Heights) {
        this._settings = settings;
        this._fire = fire;
        this._ground = ground;
        this._heights = heights;
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

        // THROWN MATERIAL IS STILL THE PLAYER'S MATERIAL until it lands. The volume leaves
        // `carried` at the moment of release and does not reach the ground until impact, so
        // for the length of the flight it is in neither place - which is why the projectile
        // carries the number rather than the deposit being scheduled up front. It also
        // means the books balance at every instant rather than only at the end: interrupt
        // the session mid-flight and the missing volume is accounted for, in the air.
        if (input.throwIt && this.carried > 0 && this._inFlight < MAX_THROWN) {
            const speed = this._settings.v["play.throwSpeed"] as number;
            const angle = ((this._settings.v["play.throwAngle"] as number) * Math.PI) / 180;
            const fx = Math.sin(actor.facing);
            const fz = Math.cos(actor.facing);
            const i = this._inFlight * 7;
            // Released at about shoulder height, ahead of the chest rather than inside it.
            this._flight[i] = actor.position.x + fx * 0.35;
            this._flight[i + 1] = actor.position.y + THROW_HEIGHT;
            this._flight[i + 2] = actor.position.z + fz * 0.35;
            const horizontal = Math.cos(angle) * speed;
            this._flight[i + 3] = fx * horizontal;
            this._flight[i + 4] = Math.sin(angle) * speed;
            this._flight[i + 5] = fz * horizontal;
            this._flight[i + 6] = this.carried;
            this._inFlight++;
            this.thrown += this.carried;
            this.carried = 0;
        }
        this._step(dt);

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
        // BENDING, AND IT IS A DIFFERENT GRAMMAR FROM THE FOUR VERBS BELOW IT.
        //
        // Gather, place, pack and throw are manual labour: material is picked up, carried
        // in the hands, and put down somewhere else, and every one of them is bounded by
        // what a person can hold. Bending is not that. The terrain moves because it is told
        // to, the character never touches it, and there is no carry capacity because
        // nothing is being carried.
        //
        // WHICH MAKES stamp() EXACTLY THE RIGHT PRIMITIVE, and it has been sitting there
        // since Phase 3. Its kernel integrates to zero over the plane, so it DISPLACES
        // material rather than creating it, and driving it with negative depth raises a
        // mound instead of pressing a pit. No new substrate operation, no conservation
        // bookkeeping, no shader work.
        //
        // WHERE THE MATERIAL COMES FROM IS NOT WHAT I FIRST WROTE HERE, and the probe
        // caught it. The comment claimed a raised pillar leaves a scar ring around it that
        // is the evidence of where the snow came from. Measured: the centre rose 83 cm and
        // the ring did not move at all. The reason is in srStamped, which scales the rim by
        // (1 - cohesion) - and snow is cohesive, so "the fraction that packs never becomes
        // a rim". That is the line that separates a clean print in snow from a collapsing
        // crater in dry sand, and it was written in Phase 3.
        //
        // So in snow, bending draws from COMPACTION rather than from the surroundings: the
        // stamp also drives the compaction channel, and raising ground fluffs it back up -
        // air pulled back in between the crystals, the exact inverse of treading it down.
        // A pillar of snow is snow that got loftier, not snow stolen from a ring. In dry
        // sand the same call will scar, because cohesion there is low, and neither
        // behaviour is written here - both fall out of the element.
        const bendRadius = this._settings.v["play.bendRadius"] as number;
        const bend = (this._settings.v["play.bendRate"] as number) * dt;
        if (input.raise) {
            this._ground.stamp(this.target.x, this.target.z, bendRadius, -bend);
            this.bent += bend;
        } else if (input.lower) {
            this._ground.stamp(this.target.x, this.target.z, bendRadius, bend);
            this.bent += bend;
        }

        // SWEEP AND DRAW — the first two verbs with a BEARING, and the reason Phase 12
        // opened with a substrate change rather than with these.
        //
        // Raise, lower and pedestal all act on one spot: the ground in front of you goes up
        // or down and the material comes from a ring around it. Nothing in that vocabulary
        // can say "over there". A drift pushed aside is not a deeper stamp, it is material
        // that ends up somewhere it did not start, and until shove() existed there was no
        // operation in the substrate that could express it — every kernel was radially
        // symmetric about a point.
        //
        // THE TWO ARE ONE CALL WITH THE VECTOR REVERSED, which is worth keeping visible.
        // Sweeping takes the material at arm's length and carries it further out; drawing
        // takes the material one throw beyond arm's length and carries it back to arm's
        // length. Both leave the NEAR end of the transport at `reach`, so neither can dump a
        // heap inside the character, and the pair is symmetric by construction rather than
        // by two blocks of code that have to be kept agreeing.
        //
        // A RATE IN CUBIC METRES, like gather and place, and unlike raise and lower which
        // are a rate in metres of depth. That is not an inconsistency — it follows from what
        // is conserved. Bending commands a HEIGHT and the material sorts itself out; a sweep
        // commands a VOLUME and the height follows from how far it is spread. Volume is also
        // the only unit in which "the same amount arrived as left" is a statement worth
        // making, and shove() makes it exactly.
        //
        // WHAT THIS CANNOT DO, stated because it will look like a bug the first time it is
        // noticed: it sweeps bare ground exactly as willingly as it sweeps a drift. Moving
        // only the LOOSE material would be the richer verb, and the substrate does track it
        // in the mass channel — but the decision is made here, on the CPU, and nothing here
        // can see the buffer. That is a GPU-side choice and a later pass.
        const sweepDist = this._settings.v["play.sweepDistance"] as number;
        const sweepVolume = (this._settings.v["play.sweepRate"] as number) * dt;
        if (input.sweep || input.draw) {
            const fx = Math.sin(actor.facing) * sweepDist;
            const fz = Math.cos(actor.facing) * sweepDist;
            const radius = this._settings.v["play.sweepRadius"] as number;
            if (input.sweep) {
                this._ground.shove(this.target.x, this.target.z, radius, fx, fz, sweepVolume);
            } else {
                this._ground.shove(this.target.x + fx, this.target.z + fz, radius, -fx, -fz, sweepVolume);
            }
            this.swept += sweepVolume;
        }

        // THE PEDESTAL: raise the ground under your own feet and ride it up.
        //
        // This is the move the whole idea was for, and it is assembled entirely out of
        // parts that already existed. The bend above commands terrain at arm's length; this
        // is the same call aimed at the character's own position. Nothing lifts the
        // character - the mover snaps position.y to the surface every frame it is grounded,
        // so when the surface comes up, the character comes up with it, for free and
        // without a single line of code that knows a person is standing there.
        //
        // AND THE LEAP OFF THE TOP IS FREE TOO. Pass F gave the mover real vertical motion,
        // so a jump from a two-metre pedestal is a jump from two metres - the height is not
        // scripted anywhere, it is just where the feet happen to be. Two passes that were
        // built for their own reasons compose into a move neither of them mentions.
        //
        // Blocked while airborne, because a pedestal is pushed with the legs against ground
        // that is under them. In the air there is nothing to push.
        if (input.pedestal && !actor.airborne) {
            this._ground.stamp(actor.position.x, actor.position.z, this._settings.v["play.pedestalRadius"] as number, -(this._settings.v["play.bendRate"] as number) * dt);
            this.bent += (this._settings.v["play.bendRate"] as number) * dt;
        }

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
                this.onDeposit?.(this.target.x, this.target.z, give);
            }
        }
    }

    /**
     * Advance everything in the air and land whatever has arrived.
     *
     * Plain forward Euler under gravity, and it is worth saying why that is enough rather
     * than reaching for something better: the flight lasts under a second, drag is not
     * modelled, and the only quantity anything downstream reads is WHERE it lands. A
     * smarter integrator would move that by centimetres and change nothing else. The step
     * is clamped for the reason every other simulation here clamps - a hitch has to slow
     * the world, not teleport a snowball through the ground.
     *
     * Landing is a CROSSING rather than a proximity test. At 9 m/s a frame covers 15 cm, so
     * "close to the ground" would be missed outright on a fast descent and the projectile
     * would sail on underground forever, taking its volume with it and quietly breaking
     * conservation. Asking whether it is now below the surface cannot miss.
     */
    private _step(dt: number): void {
        const step = Math.min(dt, 1 / 30);
        let i = 0;
        while (i < this._inFlight) {
            const o = i * 7;
            this._flight[o + 4] -= 9.81 * step;
            this._flight[o] += this._flight[o + 3] * step;
            this._flight[o + 1] += this._flight[o + 4] * step;
            this._flight[o + 2] += this._flight[o + 5] * step;

            if (this._flight[o + 1] > this._heights.groundAt(this._flight[o], this._flight[o + 2])) {
                i++;
                continue;
            }

            // Arrived. What it was carrying becomes a heap exactly where it hit, through
            // the same scoop() the hands use run in the deposit direction - so a thrown
            // shovelful and a placed one are one operation and cannot drift apart.
            const volume = this._flight[o + 6];
            this._ground.scoop(this._flight[o], this._flight[o + 2], this._settings.v["play.throwRadius"] as number, -volume);
            this.landed += volume;
            this.landings++;
            this.onDeposit?.(this._flight[o], this._flight[o + 2], volume);
            this.lastLanding.x = this._flight[o];
            this.lastLanding.z = this._flight[o + 2];

            // Swap the last entry into this slot rather than shifting the array down. The
            // index is deliberately not advanced, so the entry just moved here is tested.
            this._inFlight--;
            const last = this._inFlight * 7;
            for (let k = 0; k < 7; k++) this._flight[o + k] = this._flight[last + k];
        }
    }
}
