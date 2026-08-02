import type { Settings } from "./settings";
import type { BiomeId, ElementDef } from "../elements/types";
import { getElement } from "../elements/registry";

/**
 * The biome switch, wired from day one.
 *
 * Every system that cares about which element is active subscribes here rather than
 * reading the setting directly, so a switch is one notification and never a reload.
 * Retrofitting this later is how the codebase forks into four demos.
 */
export class BiomeState {
    private readonly _settings: Settings;
    private readonly _listeners: ((def: ElementDef, previous: ElementDef) => void)[] = [];
    private _current: ElementDef;

    constructor(settings: Settings) {
        this._settings = settings;
        this._current = getElement(settings.get("world.biome") as BiomeId);
        settings.on("world.biome", (id) => this._switch(id as BiomeId));
    }

    get current(): ElementDef {
        return this._current;
    }

    get id(): BiomeId {
        return this._current.id;
    }

    /**
     * Subscribe to switches. Fires immediately with the current element so callers do
     * not need a separate "apply once at startup" path.
     */
    onChange(fn: (def: ElementDef, previous: ElementDef) => void): () => void {
        this._listeners.push(fn);
        fn(this._current, this._current);
        return () => {
            const i = this._listeners.indexOf(fn);
            if (i >= 0) this._listeners.splice(i, 1);
        };
    }

    private _switch(id: BiomeId): void {
        const previous = this._current;
        const next = getElement(id);
        if (next === previous) return;
        this._current = next;

        // Presets are settings writes, so they show up on the sliders rather than
        // silently diverging from what the overlay claims is true.
        if (this._settings.get("world.applyBiomePresets")) {
            this._settings.set("world.sunElevation", next.sunElevation);
            this._settings.set("world.windStrength", next.windStrength);
        }

        for (let i = 0; i < this._listeners.length; i++) this._listeners[i](next, previous);
    }
}
