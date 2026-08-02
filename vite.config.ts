import { defineConfig } from "vite";

export default defineConfig({
    // GitHub Pages serves a project site under /<repo>/, so the deploy workflow sets
    // VITE_BASE. Left as "/" for local dev and for any future custom domain.
    base: process.env.VITE_BASE ?? "/",
    server: { port: 5173, strictPort: false },
    build: {
        target: "esnext",
        sourcemap: true,
        // Babylon is ~1.2 MB minified and is its own chunk on purpose. The default
        // 500 kB warning is noise here, and noise in CI logs gets ignored.
        chunkSizeWarningLimit: 1500,
        rollupOptions: {
            output: {
                manualChunks: (id) => (id.includes("@babylonjs") ? "babylon" : undefined),
            },
        },
    },
    // WGSL is authored by hand and imported as source text.
    assetsInclude: ["**/*.wgsl"],
});
