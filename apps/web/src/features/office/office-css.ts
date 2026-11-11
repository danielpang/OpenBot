// The office's look, after openbots-www's download-welcome.css: warm light
// furniture, a darker set for dark mode. Inline, so the self-hosted and the
// managed builds both get it with the component.

export const OFFICE_CSS = `
.office { position: relative; display: block; width: 100%; height: 100%; overflow: visible; touch-action: none; user-select: none;
  --o-top: #f3f1eb; --o-left: #d6d4ce; --o-right: #c3c3bd; --o-edge: #a7aaa3; }
.office-block { stroke: var(--o-edge); stroke-width: 1; }
.office-top { fill: var(--o-top); } .office-left { fill: var(--o-left); } .office-right { fill: var(--o-right); }
.office-wall { --o-top: #efeee9; --o-left: #e5e6e0; --o-right: #d3d8d1; }
.office-floor { --o-top: #eeede7; --o-left: #c6c5bc; --o-right: #b9beb5; }
.office-partition { --o-top: #d8dfd5; --o-left: #c5cec1; --o-right: #b6c1b2; }
.office-desk { --o-top: #e7d6b8; --o-left: #c9b697; --o-right: #bba88c; }
.office-monitor { --o-top: #646f6d; --o-left: #465351; --o-right: #374340; }
.office-keyboard { --o-top: #b5bdb5; }
.office-mug { --o-top: #d8b394; --o-left: #be9678; --o-right: #a97d60; }
.office-water { --o-top: #bddde2; --o-left: #8dbac5; --o-right: #78a5b2; }
.office-pot { --o-top: #d7bca8; --o-left: #c4a38b; --o-right: #ad8c74; }
.office-screen { fill: #8b9a95; }
.office-screen-busy { fill: #a4c3b7; animation: office-glow 3.2s ease-in-out infinite; }
.office-note { fill: #e7cd83; }
.office-sofa { --o-top: #9fb7c9; --o-left: #7f9aaf; --o-right: #6d879c; }
.office-book { --o-top: #c46b5a; --o-left: #a85849; --o-right: #934b3e; }
.office-rug { fill: #d9c6a5; opacity: .55; }
.office-board { fill: #b8aa91; stroke: #d7cbb6; stroke-width: 4; }
.office { cursor: grab; }
.office[data-dragging] { cursor: grabbing; }
.office[data-dragging='move'] { cursor: move; }
.office-labels { pointer-events: none; }
.office-leaves { fill: #70a995; stroke: #4e8775; stroke-width: 2; }
.office-tiles { stroke: var(--o-edge); stroke-width: .65; opacity: .25; }
.office-window { fill: #c4dce0; stroke: #fcfcf7; stroke-width: 5; }
.office-window-frame { fill: none; stroke: #fcfcf7; stroke-width: 4; }
.office-shadow { fill: #33453c; opacity: .15; }
.office-tag { fill: var(--card); stroke: var(--o-edge); stroke-width: .75; }
.office-name { fill: var(--foreground); font-size: 8px; font-weight: 500; }
.office-bot { cursor: pointer; outline: none; }
.office-hit { fill: transparent; stroke: transparent; stroke-width: 2; }
.office-bot:hover .office-hit { fill: color-mix(in oklab, var(--foreground) 5%, transparent); }
.office-bot:focus-visible .office-hit { stroke: var(--foreground); stroke-dasharray: 4 4; }
.office-bubbles { pointer-events: none; }
.office-bubble rect, .office-bubble path { fill: var(--popover); stroke: var(--o-edge); }
.office-bubble text { fill: var(--popover-foreground); font-size: 11px; }
.office-say { opacity: 0; }
.office-bubble-urgent rect, .office-bubble-urgent path { stroke: #d99a2b; stroke-width: 1.5; }
.office-bubble-urgent { animation: office-nudge 2.4s ease-in-out infinite; }
@keyframes office-glow { 50% { fill: #b9d6ca; } }
@keyframes office-nudge { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-3px); } }

/* The city. Light by day whatever the system's appearance; a lit skyline at night. */
.office-sky { position: absolute; inset: 0; overflow: hidden; pointer-events: none;
  background: linear-gradient(#a9d6f2, #dff0f8 60%, #f3f6ee); }
.office-sky[data-time='night'] { background: linear-gradient(#0b1230, #1c2550 55%, #34355e); }
.office-sun { position: absolute; pointer-events: none; right: 9%; top: 7%; width: 64px; height: 64px; border-radius: 50%;
  background: radial-gradient(circle, #fff6c8 0 45%, #ffd866 70%); box-shadow: 0 0 60px 20px rgb(255 220 120 / .45); }
.office-cloud { position: absolute; width: 120px; height: 34px; border-radius: 999px; background: #fff; opacity: .85;
  box-shadow: 30px -14px 0 4px #fff, 64px -6px 0 0 #fff; animation: office-drift 90s linear infinite alternate; }
.office-cloud-small { scale: .7; animation-duration: 120s; }
@keyframes office-drift { to { translate: 60px 0; } }
.office-moon { position: absolute; pointer-events: none; right: 10%; top: 8%; width: 52px; height: 52px; border-radius: 50%;
  box-shadow: inset -14px 6px 0 0 #f4ecc8; filter: drop-shadow(0 0 18px rgb(244 236 200 / .35)); }
.office-stars { position: absolute; inset: 0; width: 100%; height: 100%; }
.office-star { fill: #fff; opacity: .85; }
.office-star-twinkle { animation: office-twinkle 4s ease-in-out infinite alternate; }
@keyframes office-twinkle { to { opacity: .25; } }
.office-ground-stop { stop-color: #d4d9d2; }
.office-frame[data-time='night'] .office-ground-stop { stop-color: #252a3c; }
.office-block.office-tower { stroke: #b9bfc3; stroke-width: .8; }
.office-tower-0 { --o-top: #f1ece2; --o-left: #ded7ca; --o-right: #cfc7b8; }
.office-tower-1 { --o-top: #e4ecf2; --o-left: #cdd9e3; --o-right: #bccad6; }
.office-tower-2 { --o-top: #efe4de; --o-left: #dccdc4; --o-right: #cbbab0; }
.office-windows { stroke: #9cc3da; stroke-width: 7; opacity: .8; }
.office-glass { --o-top: #cfe6f1; --o-left: #a9cfe2; --o-right: #8dbcd4; }
.office-mullions { stroke: #e9f5fb; stroke-width: 1.4; opacity: .9; }
.office-brick { --o-top: #d9a58c; --o-left: #c4876c; --o-right: #ad735a; }
.office-tank { --o-top: #b98b64; --o-left: #9c724f; --o-right: #865f40; }
.office-unit { --o-top: #d6dadb; --o-left: #b9bfc1; --o-right: #a6adb0; }
.office-antenna { --o-top: #9aa0a6; --o-left: #868c92; --o-right: #74797f; }
.office-roof { --o-left: #8e9fae; --o-right: #7a8b9a; }
.office-frame[data-time='night'] .office-block.office-tower { stroke: #3b4363; }
.office-frame[data-time='night'] .office-tower-0 { --o-top: #353c5c; --o-left: #2a3050; --o-right: #222843; }
.office-frame[data-time='night'] .office-tower-1 { --o-top: #313a58; --o-left: #262e4a; --o-right: #1e253e; }
.office-frame[data-time='night'] .office-tower-2 { --o-top: #3a3a58; --o-left: #2d2d4a; --o-right: #24243e; }
.office-frame[data-time='night'] .office-windows { stroke: #ffd77a; opacity: var(--lit); }
.office-frame[data-time='night'] .office-glass { --o-top: #24395a; --o-left: #1d3150; --o-right: #172843; }
.office-frame[data-time='night'] .office-mullions { stroke: #7fb4e0; opacity: calc(var(--lit) * .8); }
.office-frame[data-time='night'] .office-brick { --o-top: #4b3440; --o-left: #3e2b36; --o-right: #33232c; }
.office-frame[data-time='night'] .office-tank { --o-top: #3a2f32; --o-left: #2f2629; --o-right: #261f22; }
.office-frame[data-time='night'] .office-unit { --o-top: #3c4258; --o-left: #31364a; --o-right: #282c3d; }
.office-frame[data-time='night'] .office-roof { --o-left: #2c3550; --o-right: #232b43; }
.office-frame[data-time='night'] .office-antenna { --o-top: #ff6b6b; animation: office-beacon 2s steps(1) infinite; }
@keyframes office-beacon { 50% { --o-top: #5a2b33; } }

@media (prefers-color-scheme: dark) {
  .office { --o-top: #585858; --o-left: #444444; --o-right: #363636; --o-edge: #777777; }
  .office-wall { --o-top: #666666; --o-left: #505050; --o-right: #424242; }
  .office-floor { --o-top: #383838; --o-left: #2b2b2b; --o-right: #242424; }
  .office-partition { --o-top: #797979; --o-left: #626262; --o-right: #525252; }
  .office-desk { --o-top: #a18d6e; --o-left: #827458; --o-right: #6c614b; }
  .office-window { fill: #59666e; stroke: #929292; }
  .office-window-frame { stroke: #929292; }
  .office-screen { fill: #4d5a56; }
  .office-sofa { --o-top: #5d6f7e; --o-left: #4b5b68; --o-right: #3f4d58; }
  .office-rug { fill: #6e6250; }
  .office-board { fill: #6d6352; stroke: #8a806e; }
}
/*
 * While the office shows, the sidebar floats over the city as frosted glass
 * (above the full window scene), in the Mac app and in a browser.
 */
[data-slot='shell']:has([data-slot='office']) [data-slot='sidebar'] {
  position: relative; z-index: 10;
  background: color-mix(in oklab, var(--sidebar) 55%, transparent);
  -webkit-backdrop-filter: blur(24px) saturate(160%); backdrop-filter: blur(24px) saturate(160%);
}
html[data-glass] [data-slot='shell']:has([data-slot='office']) [data-slot='sidebar'] {
  background: color-mix(in oklab, var(--sidebar) 45%, transparent);
  box-shadow: inset 0 1px 0 var(--glass-edge), inset 0 0 0 1px var(--glass-rim), var(--glass-shadow);
}
@media (prefers-reduced-transparency: reduce) {
  [data-slot='shell']:has([data-slot='office']) [data-slot='sidebar'] { background: var(--sidebar); backdrop-filter: none; }
}
@media (prefers-reduced-motion: reduce) {
  .office * { animation: none !important; }
  .office-say { opacity: 0; }
}
`;
