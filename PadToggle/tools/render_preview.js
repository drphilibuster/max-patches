// Render the canvas views to SVG without Live, for design review:
//   node tools/render_preview.js [outdir]
// Uses the same ptcanvas.js the device embeds, driven into a busy
// mid-performance state with the demo kit's pad names.
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const fake = require("../test/fake_mgraphics");

const SRC = fs.readFileSync(path.join(__dirname, "..", "device", "ptcanvas.js"), "utf8");
const out = process.argv[2] || path.join(__dirname, "..", "build", "preview");
fs.mkdirSync(out, { recursive: true });

const NAMES = ["Minimal House", "House Live", "Deep House", "Funk 122",
    "Hihat Techno", "Hihat Off", "Hihat Reverse", "EDM Jeans",
    "Conga Tamb", "Triangle", "Clapping", "Shaker 134",
    "Chugged Arp", "Stutter Fmin", "Reptile F", "Pluck Pad"];
// Live's default chain colours by row
const ROWCOL = [[255, 140, 60], [80, 200, 255], [130, 220, 90], [230, 110, 220]];

function wave(seed) {
    const v = [];
    for (let i = 0; i < 40; i++) {
        const beat = (i % 10) < 2 ? 1 : 0.35;
        v.push(Math.round(99 * Math.min(1, beat * (0.55 + 0.45 * Math.abs(Math.sin(i * 1.7 + seed))))));
    }
    return v;
}

function render(mode, w, h, scale, file) {
    const g = fake.make(w, h);
    const sb = {
        jsarguments: ["ptcanvas.js", mode], mgraphics: g, outlet: () => {}, post: () => {},
        box: { message: () => {} }, patcher: { wind: { size: [w, h] } },
        Date: { now: () => sb.__now }, Math, Array, Object, String, JSON, __now: 1e6,
    };
    vm.createContext(sb);
    vm.runInContext(SRC, sb);
    sb.setview(36); sb.settempo(124); sb.transport(1); sb.setquant(5);
    for (let c = 0; c < 16; c++) {
        const p = 36 + c, col = ROWCOL[Math.floor(c / 4)];
        sb.pinfo(p, col[0], col[1], col[2], c < 12 ? 8 : 16, 0, ...NAMES[c].split(" "));
        sb.wave(p, ...wave(c));
    }
    // history for the timeline: a few loops started and stopped over 4 bars
    const start = sb.__now;
    const events = [[0, 36, 1], [300, 40, 1], [2400, 44, 1], [3900, 36, 0], [3900, 37, 1],
        [5200, 48, 1], [6100, 44, 0], [6600, 45, 1]];
    for (const [t, p, on] of events) {
        sb.__now = start + t;
        sb.hit(p, 70 + (p % 5) * 10, 0);
        sb.st(p, on, 0, Math.floor((p - 36) / 4) + 1, 0, 0, 1);
    }
    sb.__now = start + 6650; sb.hit(45, 60, 1);                  // a guarded double hit
    sb.__now = start + 7200; sb.hit(41, 110, 0);
    sb.st(41, 0, 1, 2, 0, 0, 1);                                 // pending, counting down
    sb.st(42, 0, 0, 2, 1, 1, 1);                                 // retrig + V tags
    sb.st(50, 0, 0, 3, 3, 0, 1);                                 // thru
    sb.__now = start + 7500;
    sb.tick(30.5, 4, 10, 16);
    sb.__now = start + 7560;
    g.clear(); sb.paint();
    fs.writeFileSync(path.join(out, file), g.svg(scale));
    return path.join(out, file);
}

console.log(render("grid", 206, 142, 3, "grid.svg"));
console.log(render("timeline", 170, 142, 3, "timeline.svg"));
console.log(render("stage", 1100, 700, 1, "stage.svg"));
