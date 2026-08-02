import { BIOME_IDS } from "../elements/registry";

/**
 * The single source of truth.
 *
 * Every art parameter and every subsystem toggle in this project lives in SCHEMA below.
 * Adding a slider or a toggle is exactly one line here — the overlay builds itself from
 * this table, values are typed at the call site, and persistence comes free.
 *
 * Nothing in this file allocates once constructed. `settings.v['key']` is a plain
 * property read and is safe on the hot path.
 */

interface CtrlBase {
    group: string;
    label: string;
    hint?: string;
    /** Hidden behind the overlay's "advanced" reveal. */
    advanced?: boolean;
}

export interface BoolCtrl extends CtrlBase {
    kind: "bool";
    def: boolean;
}
export interface NumCtrl extends CtrlBase {
    kind: "num";
    def: number;
    min: number;
    max: number;
    step: number;
    unit?: string;
}
export interface EnumCtrl<T extends string = string> extends CtrlBase {
    kind: "enum";
    def: T;
    options: readonly T[];
    /** Optional pretty labels, parallel to `options`. */
    optionLabels?: readonly string[];
}
export type AnyCtrl = BoolCtrl | NumCtrl | EnumCtrl;

const bool = (d: Omit<BoolCtrl, "kind">): BoolCtrl => ({ kind: "bool", ...d });
const num = (d: Omit<NumCtrl, "kind">): NumCtrl => ({ kind: "num", ...d });
const enm = <T extends string>(d: Omit<EnumCtrl<T>, "kind">): EnumCtrl<T> => ({ kind: "enum", ...d });

/** Rule 6: debug views are first-class. Each phase adds its entries here. */
export const DEBUG_VIEWS = [
    "off",
    "normals",
    "linearDepth",
    "terrain.rings",
    "terrain.morph",
    "terrain.slope",
    "sky.irradiance",
    "sky.aerial",
    "cascades",
    "shadowMap",
    "substrate.depression",
    "substrate.mass",
    "substrate.compaction",
    "substrate.phase",
    "wind",
    "fuel",
    "heat",
    "overdraw",
] as const;

export const TONEMAPS = ["agx", "aces", "none"] as const;

// ---------------------------------------------------------------------------
// The schema. One line per control.
// ---------------------------------------------------------------------------

export const SCHEMA = {
    // -- World ---------------------------------------------------------------
    "world.biome": enm({ group: "World", label: "Biome", def: "snow", options: BIOME_IDS, hint: "Switches live. No reload." }),
    "world.applyBiomePresets": bool({ group: "World", label: "Apply biome presets", def: true, hint: "Biome switch overwrites sun + wind with its defaults." }),
    "world.seed": num({ group: "World", label: "Seed", def: 1337, min: 0, max: 99999, step: 1 }),
    "world.sunElevation": num({ group: "World", label: "Sun elevation", def: 12, min: -6, max: 90, step: 0.5, unit: "deg" }),
    "world.sunAzimuth": num({ group: "World", label: "Sun azimuth", def: 135, min: 0, max: 360, step: 1, unit: "deg" }),
    "world.windStrength": num({ group: "World", label: "Wind strength", def: 0.25, min: 0, max: 1, step: 0.01, hint: "Calm to whiteout on one slider." }),
    "world.windBearing": num({ group: "World", label: "Wind bearing", def: 290, min: 0, max: 360, step: 1, unit: "deg" }),
    "world.timeScale": num({ group: "World", label: "Time scale", def: 1, min: 0, max: 4, step: 0.05 }),
    "world.paused": bool({ group: "World", label: "Pause simulation", def: false }),

    // -- Systems: a toggle for every subsystem that will ever exist -----------
    "sys.terrain": bool({ group: "Systems", label: "Terrain clipmap", def: true }),
    "sys.farRange": bool({ group: "Systems", label: "Far range raymarch", def: true }),
    "sys.sky": bool({ group: "Systems", label: "Sky + IBL", def: true }),
    "sys.shadows": bool({ group: "Systems", label: "Shadow cascades", def: true }),
    "sys.depthPrepass": bool({ group: "Systems", label: "Depth prepass", def: true }),
    "sys.substrate": bool({ group: "Systems", label: "Substrate buffer", def: true }),
    "sys.air": bool({ group: "Systems", label: "Air velocity field", def: true }),
    "sys.airborne": bool({ group: "Systems", label: "Airborne material", def: true }),
    "sys.fire": bool({ group: "Systems", label: "Fire propagation", def: true }),
    "sys.smoke": bool({ group: "Systems", label: "Volumetric smoke", def: true }),
    "sys.embers": bool({ group: "Systems", label: "Embers", def: true }),
    "sys.lightPool": bool({ group: "Systems", label: "Dynamic light pool", def: true }),
    "sys.character": bool({ group: "Systems", label: "Character", def: true }),
    "sys.cloth": bool({ group: "Systems", label: "Cloth solver", def: true }),
    "sys.wake": bool({ group: "Systems", label: "Swept wake", def: true }),
    "sys.spray": bool({ group: "Systems", label: "Spray + particles", def: true }),
    "sys.post": bool({ group: "Systems", label: "Post chain", def: true }),

    // -- Terrain -------------------------------------------------------------
    "terrain.heightScale": num({ group: "Terrain", label: "Height scale", def: 1, min: 0.05, max: 2.5, step: 0.01, hint: "Applied when the field is read, so it is live with no rebake." }),
    "terrain.morph": bool({ group: "Terrain", label: "CDLOD morphing", def: true, hint: "Turn off to see exactly where the LOD seams are." }),
    "terrain.followCamera": bool({ group: "Terrain", label: "Clipmap follows camera", def: true, hint: "Freeze to walk out of the clipmap and inspect the rings." }),

    // -- Sky -----------------------------------------------------------------
    // Every control here rebakes the sky-view LUT and the SH irradiance behind it.
    // Two textures, ~0.3 ms, only when one of these moves.
    "sky.multiScatter": num({
        group: "Sky",
        label: "Multiple scattering",
        def: 0.5,
        min: 0,
        max: 0.9,
        step: 0.01,
        hint: "Per-order gain of the scattering series. 0 is single-scatter only, which reads as a flat navy card.",
    }),
    "sky.groundBounce": num({ group: "Sky", label: "Ground bounce", def: 1, min: 0, max: 3, step: 0.01, hint: "Multiplies the element's own bounce gain. Drop to 0 to see how much of snow's white is bounce." }),
    "sky.aerialScale": num({ group: "Sky", label: "Aerial perspective", def: 1.5, min: 0, max: 6, step: 0.05, hint: "Scales distance extinction only, not the sky. Above 1 while the clipmap still stops at 870 m." }),
    "sky.sunDisc": bool({ group: "Sky", label: "Sun disc", def: true }),
    "sky.skyVisibility": num({ group: "Sky", label: "Sky visibility", def: 0.88, min: 0.2, max: 1, step: 0.01, advanced: true, hint: "Fraction of the sky an average ground point sees. Drives the bounce solve." }),
    "sky.steps": num({ group: "Sky", label: "LUT raymarch steps", def: 24, min: 8, max: 64, step: 1, advanced: true, hint: "Per direction, in the sky-view bake. Costs nothing per frame — only per rebake." }),

    // -- Shadows -------------------------------------------------------------
    "shadow.resolution": num({ group: "Shadows", label: "Cascade resolution", def: 2048, min: 512, max: 4096, step: 512, hint: "Per cascade. The atlas is three of these wide." }),
    "shadow.distance": num({ group: "Shadows", label: "Shadow distance", def: 320, min: 50, max: 1000, step: 10, unit: "m", hint: "Past this the sun is unoccluded. The clipmap still draws to 870 m." }),
    "shadow.softness": num({ group: "Shadows", label: "Softness", def: 1, min: 0, max: 3, step: 0.05, hint: "Scales the PCSS penumbra. 0 gives hard shadows at one texel." }),
    "shadow.lightSize": num({ group: "Shadows", label: "Sun angular size", def: 0.012, min: 0, max: 0.1, step: 0.001, hint: "As a fraction of a cascade. The real sun is about half a degree, which is very small — this is a look control." }),
    "shadow.blend": num({ group: "Shadows", label: "Cascade blend", def: 6, min: 0, max: 30, step: 0.5, unit: "m", advanced: true, hint: "Cross-fade band at each cascade edge." }),
    "shadow.bias": num({ group: "Shadows", label: "Depth bias", def: 0.0012, min: 0, max: 0.01, step: 0.0001, advanced: true }),
    "shadow.normalBias": num({ group: "Shadows", label: "Normal offset", def: 1.5, min: 0, max: 8, step: 0.1, unit: "texels", advanced: true, hint: "Offsets the lookup along the normal instead of biasing depth. This is what keeps steep slopes free of acne." }),
    "shadow.pcfTaps": num({ group: "Shadows", label: "PCF taps", def: 16, min: 4, max: 64, step: 4, advanced: true }),
    "shadow.blockerTaps": num({ group: "Shadows", label: "Blocker search taps", def: 12, min: 4, max: 32, step: 4, advanced: true }),
    "shadow.depthRange": num({ group: "Shadows", label: "Caster depth range", def: 200, min: 20, max: 800, step: 10, unit: "m", advanced: true, hint: "How far above a cascade a caster can be and still be included." }),

    // -- Render --------------------------------------------------------------
    "render.resolutionScale": num({ group: "Render", label: "Resolution scale", def: 1, min: 0.5, max: 2, step: 0.05 }),
    "render.fpsCap": num({ group: "Render", label: "FPS cap", def: 0, min: 0, max: 360, step: 10, hint: "0 = uncapped." }),
    "render.exposure": num({ group: "Render", label: "Exposure", def: 0, min: -4, max: 4, step: 0.05, unit: "EV" }),
    "render.fov": num({ group: "Render", label: "Field of view", def: 62, min: 40, max: 110, step: 1, unit: "deg" }),

    // -- Post ----------------------------------------------------------------
    "post.tonemap": enm({ group: "Post", label: "Tonemap", def: "agx", options: TONEMAPS }),
    "post.taa": bool({ group: "Post", label: "TAA", def: true }),
    "post.bloom": bool({ group: "Post", label: "Bloom", def: true }),
    "post.godrays": bool({ group: "Post", label: "Light shafts", def: true }),
    "post.dof": bool({ group: "Post", label: "Depth of field", def: true }),
    "post.ssr": bool({ group: "Post", label: "Screen-space reflections", def: true }),
    "post.heatDistortion": bool({ group: "Post", label: "Heat distortion", def: true }),
    "post.sharpen": bool({ group: "Post", label: "Contrast-adaptive sharpen", def: true }),
    "post.grain": bool({ group: "Post", label: "Grain", def: true }),
    "post.vignette": bool({ group: "Post", label: "Vignette", def: true }),
    "post.bloomIntensity": num({ group: "Post", label: "Bloom intensity", def: 0.6, min: 0, max: 3, step: 0.01, advanced: true }),
    "post.grainAmount": num({ group: "Post", label: "Grain amount", def: 0.35, min: 0, max: 2, step: 0.01, advanced: true }),
    "post.vignetteAmount": num({ group: "Post", label: "Vignette amount", def: 0.4, min: 0, max: 2, step: 0.01, advanced: true }),
    "post.sharpenAmount": num({ group: "Post", label: "Sharpen amount", def: 0.35, min: 0, max: 1, step: 0.01, advanced: true }),

    // -- Camera --------------------------------------------------------------
    "cam.armLength": num({ group: "Camera", label: "Arm length", def: 5.5, min: 1.5, max: 14, step: 0.1, unit: "m" }),
    "cam.height": num({ group: "Camera", label: "Pivot height", def: 1.6, min: 0, max: 3, step: 0.05, unit: "m" }),
    "cam.sensitivity": num({ group: "Camera", label: "Look sensitivity", def: 0.22, min: 0.02, max: 1, step: 0.01 }),
    "cam.invertY": bool({ group: "Camera", label: "Invert Y", def: false }),
    "cam.smoothing": num({ group: "Camera", label: "Arm smoothing", def: 0.82, min: 0, max: 0.99, step: 0.01 }),
    "cam.pitchMin": num({ group: "Camera", label: "Pitch min", def: -72, min: -89, max: 0, step: 1, unit: "deg", advanced: true }),
    "cam.pitchMax": num({ group: "Camera", label: "Pitch max", def: 74, min: 0, max: 89, step: 1, unit: "deg", advanced: true }),
    "cam.shake": num({ group: "Camera", label: "Shake scale", def: 1, min: 0, max: 2, step: 0.05 }),

    // -- Character -----------------------------------------------------------
    "char.walkSpeed": num({ group: "Character", label: "Walk speed", def: 3.2, min: 0.5, max: 10, step: 0.1, unit: "m/s" }),
    "char.sprintMultiplier": num({ group: "Character", label: "Sprint multiplier", def: 2.4, min: 1, max: 4, step: 0.05 }),
    "char.acceleration": num({ group: "Character", label: "Acceleration", def: 22, min: 2, max: 80, step: 1, unit: "m/s2", advanced: true }),
    "char.turnRate": num({ group: "Character", label: "Turn rate", def: 540, min: 90, max: 1440, step: 10, unit: "deg/s", advanced: true }),

    // -- Debug ---------------------------------------------------------------
    "debug.view": enm({ group: "Debug", label: "Debug view", def: "off", options: DEBUG_VIEWS }),
    "debug.wireframe": bool({ group: "Debug", label: "Wireframe", def: false }),
    "debug.freezeCulling": bool({ group: "Debug", label: "Freeze culling", def: false }),
    "debug.showSubstrateWindow": bool({ group: "Debug", label: "Show substrate window", def: false }),

    // -- Perf ----------------------------------------------------------------
    "perf.gpuTiming": bool({ group: "Perf", label: "GPU timestamp queries", def: true, hint: "Requires the timestamp-query feature." }),
    "perf.graphRangeMs": num({ group: "Perf", label: "Graph range", def: 12, min: 4, max: 64, step: 1, unit: "ms" }),
    "perf.targetFps": num({ group: "Perf", label: "Target FPS line", def: 90, min: 30, max: 360, step: 10 }),
    "perf.overlayScale": num({ group: "Perf", label: "Overlay scale", def: 1, min: 0.75, max: 1.6, step: 0.05 }),

    // -- UI state (persisted here so there is exactly one source of truth) ----
    "ui.overlayOpen": bool({ group: "UI", label: "Overlay open", def: true, advanced: true }),
    "ui.showAdvanced": bool({ group: "UI", label: "Show advanced controls", def: false, advanced: true }),
} satisfies Record<string, AnyCtrl>;

export type Schema = typeof SCHEMA;
export type SettingKey = keyof Schema & string;

type ValOf<C> = C extends BoolCtrl ? boolean : C extends NumCtrl ? number : C extends EnumCtrl<infer T> ? T : never;
export type SettingValue<K extends SettingKey> = ValOf<Schema[K]>;
export type SettingsValues = { [K in SettingKey]: SettingValue<K> };

export type SettingListener<K extends SettingKey = SettingKey> = (value: SettingValue<K>, key: K) => void;

/**
 * Bumped whenever the schema changes materially. Phase 1 added the Terrain group and
 * new debug views; Phase 2 added the Sky group. More importantly, a stale persisted
 * `ui.overlayOpen: false` from an earlier build would hide the overlay on first run
 * with no obvious way to know why.
 */
const STORAGE_KEY = "substrate.settings.v3";

export class Settings {
    /** Direct value access for the hot path: `settings.v["sys.terrain"]`. */
    readonly v: SettingsValues;

    readonly keys: readonly SettingKey[];
    readonly groups: readonly string[];

    private readonly _perKey = new Map<string, SettingListener<never>[]>();
    private readonly _any: ((key: SettingKey) => void)[] = [];
    private _saveTimer = 0;
    private _muted = false;

    constructor() {
        const values = {} as Record<string, unknown>;
        const keys: SettingKey[] = [];
        const groups: string[] = [];
        for (const key of Object.keys(SCHEMA) as SettingKey[]) {
            const ctrl = SCHEMA[key] as AnyCtrl;
            values[key] = ctrl.def;
            keys.push(key);
            if (!groups.includes(ctrl.group)) groups.push(ctrl.group);
        }
        this.v = values as SettingsValues;
        this.keys = keys;
        this.groups = groups;
        this._loadPersisted();
    }

    ctrl(key: SettingKey): AnyCtrl {
        return SCHEMA[key] as AnyCtrl;
    }

    get<K extends SettingKey>(key: K): SettingValue<K> {
        return this.v[key];
    }

    set<K extends SettingKey>(key: K, value: SettingValue<K>): void {
        const next = this._coerce(key, value);
        if (this.v[key] === next) return;
        (this.v as Record<string, unknown>)[key] = next;
        if (!this._muted) this._emit(key);
        this._scheduleSave();
    }

    /** Apply many values, emitting each change. Used by biome presets and reset. */
    apply(patch: Partial<SettingsValues>): void {
        for (const key of Object.keys(patch) as SettingKey[]) {
            const value = patch[key];
            if (value !== undefined) this.set(key, value as never);
        }
    }

    on<K extends SettingKey>(key: K, fn: SettingListener<K>): () => void {
        let list = this._perKey.get(key);
        if (!list) {
            list = [];
            this._perKey.set(key, list);
        }
        list.push(fn as SettingListener<never>);
        return () => {
            const i = list!.indexOf(fn as SettingListener<never>);
            if (i >= 0) list!.splice(i, 1);
        };
    }

    /** Fires for every change. The overlay uses this to stay in sync with code-side writes. */
    onAny(fn: (key: SettingKey) => void): () => void {
        this._any.push(fn);
        return () => {
            const i = this._any.indexOf(fn);
            if (i >= 0) this._any.splice(i, 1);
        };
    }

    reset(): void {
        for (const key of this.keys) this.set(key, (SCHEMA[key] as AnyCtrl).def as never);
    }

    resetGroup(group: string): void {
        for (const key of this.keys) {
            const ctrl = SCHEMA[key] as AnyCtrl;
            if (ctrl.group === group) this.set(key, ctrl.def as never);
        }
    }

    private _emit(key: SettingKey): void {
        const list = this._perKey.get(key);
        if (list !== undefined) {
            for (let i = 0; i < list.length; i++) {
                (list[i] as SettingListener)(this.v[key], key);
            }
        }
        for (let i = 0; i < this._any.length; i++) this._any[i](key);
    }

    private _coerce<K extends SettingKey>(key: K, value: SettingValue<K>): SettingValue<K> {
        const ctrl = SCHEMA[key] as AnyCtrl;
        if (ctrl.kind === "num") {
            let n = typeof value === "number" ? value : Number(value);
            if (!Number.isFinite(n)) n = ctrl.def;
            n = Math.min(ctrl.max, Math.max(ctrl.min, n));
            // Snap to step so slider and code-side writes agree exactly.
            if (ctrl.step > 0) {
                n = ctrl.min + Math.round((n - ctrl.min) / ctrl.step) * ctrl.step;
                n = Math.min(ctrl.max, Math.max(ctrl.min, n));
                // Kill float dust from the snap (0.30000000000000004 -> 0.3).
                n = Number(n.toFixed(6));
            }
            return n as SettingValue<K>;
        }
        if (ctrl.kind === "bool") return !!value as SettingValue<K>;
        return (ctrl.options.includes(value as string) ? value : ctrl.def) as SettingValue<K>;
    }

    // -- persistence ---------------------------------------------------------

    private _loadPersisted(): void {
        let raw: string | null = null;
        try {
            raw = localStorage.getItem(STORAGE_KEY);
        } catch {
            return; // Private mode / blocked storage: defaults are fine.
        }
        if (!raw) return;
        try {
            const parsed = JSON.parse(raw) as Record<string, unknown>;
            this._muted = true;
            for (const key of this.keys) {
                if (Object.hasOwn(parsed, key)) this.set(key, parsed[key] as never);
            }
        } catch {
            /* Corrupt blob: ignore and keep defaults. */
        } finally {
            this._muted = false;
        }
    }

    /** Debounced so a slider drag writes storage once, never per frame. */
    private _scheduleSave(): void {
        if (this._saveTimer !== 0) return;
        this._saveTimer = window.setTimeout(() => {
            this._saveTimer = 0;
            try {
                localStorage.setItem(STORAGE_KEY, JSON.stringify(this.v));
            } catch {
                /* Storage unavailable: settings simply do not persist. */
            }
        }, 400);
    }
}
