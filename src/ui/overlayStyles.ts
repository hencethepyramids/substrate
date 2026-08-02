/** Injected once. Kept out of overlay.ts so the DOM building code stays readable. */
export const OVERLAY_CSS = `
.sb-root{position:fixed;inset:0;pointer-events:none;z-index:40;font-family:var(--ui-font);
  font-size:calc(11px * var(--sb-scale,1));line-height:1.45;color:#c8d4e0}
.sb-root[hidden]{display:none}

.sb-panel{position:absolute;pointer-events:auto;background:rgba(8,12,18,.86);
  border:1px solid #1b2733;border-radius:6px;backdrop-filter:blur(9px)}

.sb-perf{top:12px;left:12px;width:calc(260px * var(--sb-scale,1));padding:9px 11px 10px}
.sb-settings{top:12px;right:12px;bottom:12px;width:calc(300px * var(--sb-scale,1));
  display:flex;flex-direction:column}
/* Pointer locked: keep the frame graph, drop the controls you cannot click. */
.sb-root[data-locked="1"] .sb-settings{display:none}

.sb-hdr{display:flex;align-items:center;gap:8px;padding:9px 11px;border-bottom:1px solid #1b2733;flex:0 0 auto}
.sb-title{flex:1;letter-spacing:.28em;font-size:calc(10px * var(--sb-scale,1));color:#7d8ea0;font-weight:600}
.sb-scroll{flex:1 1 auto;overflow-y:auto;overflow-x:hidden;padding:4px 0 10px;scrollbar-width:thin;
  scrollbar-color:#243343 transparent}
.sb-foot{flex:0 0 auto;padding:7px 11px;border-top:1px solid #1b2733;color:#4a5866;
  font-size:calc(10px * var(--sb-scale,1))}

.sb-big{display:flex;align-items:baseline;gap:7px;margin-bottom:5px}
.sb-fps{font-size:calc(23px * var(--sb-scale,1));font-weight:600;color:#e6edf3;
  font-variant-numeric:tabular-nums;letter-spacing:-.01em}
.sb-fps-unit{font-size:calc(10px * var(--sb-scale,1));color:#4a5866}
.sb-ms{margin-left:auto;font-variant-numeric:tabular-nums;color:#8a9bab}

.sb-graph{display:block;width:100%;height:calc(46px * var(--sb-scale,1));
  border:1px solid #16202b;border-radius:3px;background:#070b10}

.sb-kv{display:flex;gap:8px;font-variant-numeric:tabular-nums}
.sb-kv > span:first-child{flex:1;color:#6c7d8f;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sb-kv > span:last-child{color:#c8d4e0}
.sb-sec{margin-top:7px;padding-top:6px;border-top:1px solid #16202b}
.sb-sec-title{color:#4a5866;letter-spacing:.2em;font-size:calc(9px * var(--sb-scale,1));
  text-transform:uppercase;margin-bottom:3px}
.sb-warn{color:#c98a4b}

.sb-group{border-bottom:1px solid #131c25}
.sb-group-hdr{display:flex;align-items:center;gap:6px;padding:6px 11px;cursor:pointer;
  color:#7d8ea0;letter-spacing:.14em;font-size:calc(10px * var(--sb-scale,1));
  text-transform:uppercase;user-select:none}
.sb-group-hdr:hover{color:#c8d4e0;background:rgba(255,255,255,.028)}
.sb-caret{width:8px;color:#3d4a58;transition:transform .12s ease}
.sb-group[data-open="0"] .sb-caret{transform:rotate(-90deg)}
.sb-group[data-open="0"] .sb-body{display:none}
.sb-body{padding:2px 11px 7px}
.sb-reset{margin-left:auto;color:#3d4a58;font-size:calc(9px * var(--sb-scale,1));
  letter-spacing:.06em;text-transform:none}
.sb-reset:hover{color:#9ec9f0}

.sb-row{display:flex;align-items:center;gap:7px;min-height:calc(20px * var(--sb-scale,1))}
.sb-row-label{flex:1;color:#93a3b4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sb-row:hover .sb-row-label{color:#e6edf3}
.sb-adv{display:none}
.sb-root[data-adv="1"] .sb-adv{display:flex}
.sb-root:not([data-adv="1"]) .sb-group-adv{display:none}
.sb-hint{color:#3d4a58;font-size:calc(9.5px * var(--sb-scale,1));padding:0 0 3px;line-height:1.4}

.sb-num{display:flex;align-items:center;gap:6px;flex:0 0 calc(132px * var(--sb-scale,1))}
input[type=range].sb-range{-webkit-appearance:none;appearance:none;flex:1;height:2px;
  background:#243343;border-radius:1px;outline:none;margin:0}
input[type=range].sb-range::-webkit-slider-thumb{-webkit-appearance:none;width:9px;height:9px;
  border-radius:50%;background:#9ec9f0;cursor:pointer}
input[type=range].sb-range::-moz-range-thumb{width:9px;height:9px;border:0;border-radius:50%;
  background:#9ec9f0;cursor:pointer}
.sb-val{width:calc(46px * var(--sb-scale,1));background:#0d141c;border:1px solid #1b2733;
  border-radius:3px;color:#c8d4e0;font:inherit;font-variant-numeric:tabular-nums;
  padding:1px 4px;text-align:right;-moz-appearance:textfield}
.sb-val::-webkit-outer-spin-button,.sb-val::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
.sb-val:focus{outline:none;border-color:#4a7fb5}

.sb-check{appearance:none;width:14px;height:14px;flex:0 0 auto;border:1px solid #2b3a4a;
  border-radius:3px;background:#0d141c;cursor:pointer;position:relative}
.sb-check:checked{background:#4a7fb5;border-color:#5f96cc}
.sb-check:checked::after{content:"";position:absolute;left:4px;top:1px;width:3px;height:7px;
  border:solid #08111a;border-width:0 2px 2px 0;transform:rotate(42deg)}

.sb-select{flex:0 0 calc(132px * var(--sb-scale,1));background:#0d141c;border:1px solid #1b2733;
  border-radius:3px;color:#c8d4e0;font:inherit;padding:2px 4px;cursor:pointer}
.sb-select:focus{outline:none;border-color:#4a7fb5}

.sb-btn{background:#121c26;border:1px solid #223142;border-radius:3px;color:#a8bccf;
  font:inherit;padding:3px 8px;cursor:pointer}
.sb-btn:hover{background:#1a2836;color:#e6edf3;border-color:#33465b}
.sb-actions{display:flex;flex-wrap:wrap;gap:5px}

.sb-toast{position:absolute;left:50%;bottom:22px;transform:translateX(-50%);pointer-events:none;
  background:rgba(8,12,18,.9);border:1px solid #1b2733;border-radius:5px;padding:6px 13px;
  color:#c8d4e0;opacity:0;transition:opacity .2s ease}
.sb-toast[data-on="1"]{opacity:1}
`;
