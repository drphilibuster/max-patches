// Tests for device/ptcanvas.js under Node:  node test/test_canvas.js
//
// The canvas is loaded into a sandbox standing in for a v8ui: a recording
// mgraphics, captured outlets and a controllable clock. These tests pin the
// CPU contract (no frames when nothing moves), the click mapping, and that
// every view paints a full state without throwing and within a call budget.
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const fake = require("./fake_mgraphics");

const SRC = fs.readFileSync(path.join(__dirname, "..", "device", "ptcanvas.js"), "utf8");

function canvas(mode, w, h) {
    const g = fake.make(w, h);
    const out = { engine: [], clock: [], win: [] };
    const sb = {
        jsarguments: ["ptcanvas.js", mode],
        mgraphics: g,
        outlet: (n, ...v) => [out.engine, out.clock, out.win][n].push(v.length === 1 && Array.isArray(v[0]) ? v[0] : v),
        post: () => {},
        box: { message: () => {} },
        patcher: { wind: { size: [w, h] } },
        Date: { now: () => sb.__now },
        Math, Array, Object, String, JSON,
        __now: 100000,
    };
    vm.createContext(sb);
    vm.runInContext(SRC, sb);
    sb.g = g; sb.out = out;
    sb.advance = (ms) => { sb.__now += ms; };
    sb.lastClock = () => out.clock.length ? out.clock[out.clock.length - 1][0] : 0;
    sb.paintNow = () => { g.clear(); sb.paint(); return g.calls; };
    return sb;
}

let failures = 0, count = 0;
function test(name, fn) {
    count++;
    try { fn(); console.log("  ok   " + name); }
    catch (err) { failures++; console.log("  FAIL " + name + "\n       " + err.message); }
}
function eq(got, want, what) {
    const a = JSON.stringify(got), b = JSON.stringify(want);
    if (a !== b) throw new Error((what ? what + ": " : "") + "got " + a + " want " + b);
}
function ok(cond, what) { if (!cond) throw new Error(what); }

// a pad that is on and has a loop length keeps the ring turning
test("idle grid requests no frames", () => {
    const c = canvas("grid", 206, 142);
    c.setview(36);
    c.st(36, 0, 0, 0, 0, 0, 1);
    eq(c.lastClock(), 0);
});

test("a playing loop with a known length animates; stopping it goes idle after the fade", () => {
    const c = canvas("grid", 206, 142);
    c.pinfo(36, 200, 100, 50, 8, 0, "Funk", "122");
    c.st(36, 1, 0, 0, 0, 0, 1);
    eq(c.lastClock(), 1, "frames on");
    c.advance(1000); c.frame();
    eq(c.lastClock(), 1, "still turning");
    c.st(36, 0, 0, 0, 0, 0, 1);
    c.advance(50); c.frame();
    eq(c.lastClock(), 1, "fading out");
    c.advance(200); c.frame();
    eq(c.lastClock(), 0, "idle once the fade is done");
});

test("a playing pad with no loop info does not animate once its fade-in ends", () => {
    const c = canvas("grid", 206, 142);
    c.st(36, 1, 0, 0, 0, 0, 1);
    c.advance(300); c.frame();
    eq(c.lastClock(), 0);
});

test("pending pads animate the countdown until resolved", () => {
    const c = canvas("grid", 206, 142);
    c.st(37, 0, 1, 1, 0, 0, 1);
    eq(c.lastClock(), 1);
    c.st(37, 1, 0, 1, 0, 0, 1);
    c.advance(300); c.frame();
    eq(c.lastClock(), 0);
});

test("a hit ripple animates briefly", () => {
    const c = canvas("grid", 206, 142);
    c.hit(38, 120, 0);
    eq(c.lastClock(), 1);
    c.advance(500); c.frame();
    eq(c.lastClock(), 0);
});

test("pads outside the view never keep frames running", () => {
    const c = canvas("grid", 206, 142);
    c.setview(0);
    c.pinfo(90, 1, 2, 3, 4, 0);
    c.st(90, 1, 0, 0, 0, 0, 1);
    c.advance(300); c.frame();
    eq(c.lastClock(), 0);
});

test("timeline scrolls while playing and goes idle once its window is empty", () => {
    const c = canvas("timeline", 170, 140);
    c.settempo(120);
    c.transport(1);
    eq(c.lastClock(), 1);
    c.hit(36, 100, 0);
    c.transport(0);
    c.advance(4000); c.frame();
    eq(c.lastClock(), 1, "hit still on screen (8 of 16 beats)");
    c.advance(5000); c.frame();
    eq(c.lastClock(), 0, "hit scrolled off");
});

test("clicks map to cells with the lowest note bottom-left", () => {
    const c = canvas("grid", 206, 142);
    c.paintNow();
    c.onclick(5, 140); c.onclick(200, 140); c.onclick(5, 3); c.onclick(200, 3);
    eq(c.out.engine, [["click", 0, 1], ["click", 3, 1], ["click", 12, 1], ["click", 15, 1]]);
});

test("timeline ignores clicks", () => {
    const c = canvas("timeline", 170, 140);
    c.paintNow();
    c.onclick(50, 50);
    eq(c.out.engine, []);
});

test("stage: fullscreen corner toggles the window, pads below are clickable", () => {
    const c = canvas("stage", 900, 600);
    c.paintNow();
    c.onclick(890, 10);
    eq(c.out.win, [["fullscreen", 1]]);
    c.onclick(20, 400);
    eq(c.out.engine.length, 1);
    eq(c.out.engine[0][0], "click");
});

function fullState(c) {
    c.setview(36); c.settempo(124); c.transport(1); c.setquant(5);
    c.tick(12.5, 4, 8, 16);
    for (let p = 36; p < 52; p++) {
        c.pinfo(p, 40 + p * 3, 120, 200 - p * 2, p % 3 ? 8 : 0, p % 3 ? 0 : 2000, "Loop", "number", String(p));
        c.wave(p, ...Array.from({ length: 40 }, (_, i) => (i * 7 + p) % 100));
        c.st(p, p % 2, p % 5 === 0 ? 1 : 0, p % 5, p % 4, p % 7 === 0 ? 1 : 0, p === 51 ? 0 : 1);
        c.hit(p, 60 + p, p % 6 === 0 ? 1 : 0);
    }
    c.advance(60);
}

for (const [mode, w, h, budget] of [["grid", 206, 142, 1800], ["timeline", 170, 140, 600], ["stage", 1200, 800, 2600]]) {
    test(`${mode}: paints a full state without throwing, within ${budget} draw calls`, () => {
        const c = canvas(mode, w, h);
        fullState(c);
        const calls = c.paintNow();
        ok(calls > 20, "drew something");
        ok(calls < budget, `drew ${calls} calls`);
    });
}

test("label fitting is cached: repainting does not re-measure text", () => {
    const c = canvas("grid", 206, 142);
    c.pinfo(36, 1, 2, 3, 0, 0, "A very long loop name that will not fit");
    let measures = 0;
    const orig = c.g.text_measure;
    c.g.text_measure = (s) => { measures++; return orig(s); };
    c.paintNow();
    const first = measures;
    c.paintNow();
    ok(first > 0, "measured the first time");
    eq(measures, first, "no measuring on repaint");
});

test("names and tags reach the screen", () => {
    const c = canvas("grid", 206, 142);
    c.setview(36);
    c.pinfo(36, 255, 0, 0, 8, 0, "Funk 122");
    c.st(36, 1, 0, 1, 1, 1, 1);
    c.paintNow();
    ok(c.g.texts.includes("Funk") && c.g.texts.includes("122"), "name drawn on two lines: " + c.g.texts.join(" | "));
    ok(c.g.texts.includes("C1 R v"), "note + tags drawn: " + c.g.texts.join(" | "));
    ok(c.g.texts.includes("A"), "group letter drawn");
});

test("loop phase follows the beat clock and the tempo", () => {
    const c = canvas("grid", 206, 142);
    c.settempo(120);
    c.pinfo(36, 1, 2, 3, 4, 0);
    c.st(36, 1, 0, 0, 0, 0, 1);
    const d = c.pads[36];
    c.advance(1000);                         // 2 beats at 120
    ok(Math.abs(c.loopPhase(d, c.__now) - 0.5) < 1e-9, "half way round a 4-beat loop");
    c.settempo(60);
    c.advance(1000);                         // 1 more beat at 60
    ok(Math.abs(c.loopPhase(d, c.__now) - 0.75) < 1e-9, "tempo change does not jump");
});

console.log(`\n${count - failures}/${count} passed`);
process.exit(failures ? 1 : 0);
