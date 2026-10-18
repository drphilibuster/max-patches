// Behavioural tests for device/padtoggle.js, run under Node:  node test/test_engine.js
//
// The engine file is loaded into a sandbox that stands in for Max: outlet()
// is captured, the clock is controllable, and notifyclients()/post() are stubs.
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = fs.readFileSync(path.join(__dirname, "..", "device", "padtoggle.js"), "utf8");

function engine() {
    const out = { midi: [], ui: [], notified: 0 };
    const sb = {
        outlet: (n, v) => (n === 0 ? out.midi : out.ui).push(Array.from(v)),
        post: () => {},
        notifyclients: () => { out.notified++; },
        Date: { now: () => sb.__now },
        Math, Array, Object,
        __now: 1000,
    };
    vm.createContext(sb);
    vm.runInContext(SRC, sb);
    const e = sb;
    e.out = out;
    e.bytes = (...bs) => bs.forEach((b) => e.midi(b));
    e.hit = (p, v = 100, ch = 9) => { e.bytes(0x90 | ch, p, v); e.__now += 1000; };
    e.release = (p, ch = 9) => e.bytes(0x80 | ch, p, 64);
    e.take = () => { const m = out.midi; out.midi = []; return m; };
    e.tick = (bar, beat, unit) => { e.beats(beat); e.units(unit); e.bars(bar); };
    e.loaded();
    out.ui = [];
    return e;
}

let failures = 0, count = 0;
function test(name, fn) {
    count++;
    try { fn(); console.log("  ok   " + name); }
    catch (err) { failures++; console.log("  FAIL " + name + "\n       " + err.message); }
}
function eq(got, want, what) {
    const g = JSON.stringify(got), w = JSON.stringify(want);
    if (g !== w) throw new Error((what ? what + ": " : "") + "got " + g + " want " + w);
}

const ON = (p, v, ch = 9) => [0x90 | ch, p, v];
const OFF = (p, ch = 9) => [0x80 | ch, p, 0];

// ------------------------------------------------------------- core toggle
test("first hit sends Note On, second sends Note Off", () => {
    const e = engine();
    e.hit(36, 110);
    eq(e.take(), [ON(36, 110)]);
    e.hit(36, 90);
    eq(e.take(), [OFF(36)]);
    e.hit(36, 70);
    eq(e.take(), [ON(36, 70)]);
});

test("incoming Note Offs are dropped (e-drum release)", () => {
    const e = engine();
    e.hit(36); e.take();
    e.release(36);
    eq(e.take(), [], "note off must not reach the Drum Rack");
    e.bytes(0x99, 36, 0);                       // Note On velocity 0 = Note Off
    eq(e.take(), []);
});

test("running status is honoured", () => {
    const e = engine();
    e.bytes(0x99, 36, 100, 38, 100);            // two Note Ons, one status byte
    eq(e.take(), [ON(36, 100), ON(38, 100)]);
});

test("pads are independent (polyphonic default)", () => {
    const e = engine();
    e.hit(36); e.hit(37); e.hit(38);
    eq(e.take(), [ON(36, 100), ON(37, 100), ON(38, 100)]);
});

test("Note Off uses the channel the pad was started on", () => {
    const e = engine();
    e.hit(40, 100, 3);
    e.hit(40, 100, 7);
    eq(e.take(), [ON(40, 100, 3), OFF(40, 3)]);
});

// ---------------------------------------------------------- pass-through
test("non-note messages pass through unchanged", () => {
    const e = engine();
    e.bytes(0xB0, 4, 90);                       // hi-hat pedal CC
    e.bytes(0xE0, 0, 64);                       // pitch bend
    e.bytes(0xD9, 33);                          // channel pressure
    e.bytes(0xA9, 46, 80);                      // poly aftertouch (choke)
    e.bytes(0xC0, 5);
    e.bytes(0xF8);                              // clock
    e.bytes(0xF0, 0x7E, 0x7F, 0x06, 0x01, 0xF7);
    eq(e.take(), [[0xB0, 4, 90], [0xE0, 0, 64], [0xD9, 33], [0xA9, 46, 80], [0xC0, 5], [0xF8],
                  [0xF0, 0x7E, 0x7F, 0x06, 0x01, 0xF7]]);
});

test("realtime byte inside a note message does not break it", () => {
    const e = engine();
    e.bytes(0x99, 36, 0xF8, 100);
    eq(e.take(), [[0xF8], ON(36, 100)]);
});

test("pitches outside Low/High pass through with their Note Offs", () => {
    const e = engine();
    e.setlo(36); e.sethi(51);
    e.hit(60, 100); e.release(60);
    e.hit(35, 90); e.release(35);
    eq(e.take(), [ON(60, 100), [0x89, 60, 64], ON(35, 90), [0x89, 35, 64]]);
    e.hit(36);
    eq(e.take(), [ON(36, 100)], "in-range pad still toggles");
});

test("Thru mode pad passes notes untouched", () => {
    const e = engine();
    e.selpad(42); e.padmode(3);
    e.hit(42, 77); e.release(42);
    eq(e.take(), [ON(42, 77), [0x89, 42, 64]]);
});

test("All Notes Off upstream clears toggle state", () => {
    const e = engine();
    e.hit(36); e.take();
    e.bytes(0xB9, 123, 0);
    eq(e.take(), [[0xB9, 123, 0]]);
    e.hit(36);
    eq(e.take(), [ON(36, 100)], "pad starts again rather than sending a stale Off");
});

// ------------------------------------------------------------- groups (M)
test("group A pads are monophonic: last hit wins", () => {
    const e = engine();
    for (const p of [36, 37, 38]) { e.selpad(p); e.padgroup(1); }
    e.hit(36); e.hit(37);
    eq(e.take(), [ON(36, 100), OFF(36), ON(37, 100)]);
    e.hit(38);
    eq(e.take(), [OFF(37), ON(38, 100)]);
});

test("pads outside the group are unaffected", () => {
    const e = engine();
    for (const p of [36, 37]) { e.selpad(p); e.padgroup(1); }
    e.hit(40); e.hit(36); e.hit(37);
    eq(e.take(), [ON(40, 100), ON(36, 100), OFF(36), ON(37, 100)]);
});

test("groups A and B are independent", () => {
    const e = engine();
    e.selpad(36); e.padgroup(1); e.selpad(37); e.padgroup(1);
    e.selpad(38); e.padgroup(2); e.selpad(39); e.padgroup(2);
    e.hit(36); e.hit(38); e.hit(37); e.hit(39);
    eq(e.take(), [ON(36, 100), ON(38, 100), OFF(36), ON(37, 100), OFF(38), ON(39, 100)]);
});

test("hitting the playing group pad toggles it off", () => {
    const e = engine();
    e.selpad(36); e.padgroup(1); e.selpad(37); e.padgroup(1);
    e.hit(36); e.hit(36);
    eq(e.take(), [ON(36, 100), OFF(36)]);
});

test("Set ALL to Mono groups every pad and keeps one playing", () => {
    const e = engine();
    e.hit(36); e.hit(40); e.take();
    e.setall(1);
    eq(e.take(), [OFF(36)], "only the highest playing pad survives");
    e.hit(50);
    eq(e.take(), [OFF(40), ON(50, 100)]);
    e.setall(0);
    e.hit(51);
    eq(e.take(), [ON(51, 100)], "back to poly");
});

// ------------------------------------------------------------ velocity
test("LiveVelo passes velocity, SetVelo forces global velocity", () => {
    const e = engine();
    e.hit(36, 33); e.hit(36);
    e.setvelmode(1); e.setglobalvel(90);
    e.hit(36, 12);
    eq(e.take(), [ON(36, 33), OFF(36), ON(36, 90)]);
});

test("per-pad V overrides live and global velocity", () => {
    const e = engine();
    e.selpad(38); e.padfix(1); e.padvel(64);
    e.hit(38, 127);
    e.setvelmode(1); e.setglobalvel(10);
    e.hit(38); e.hit(38, 1);
    eq(e.take(), [ON(38, 64), OFF(38), ON(38, 64)]);
});

// -------------------------------------------------------------- modes
test("Retrig mode restarts a playing pad instead of stopping it", () => {
    const e = engine();
    e.selpad(36); e.padmode(1);
    e.hit(36, 100); e.hit(36, 80);
    eq(e.take(), [ON(36, 100), OFF(36), ON(36, 80)]);
});

test("Gate mode follows Note On/Off (keyboards)", () => {
    const e = engine();
    e.selpad(48); e.padmode(2);
    e.hit(48, 99);
    e.release(48);
    eq(e.take(), [ON(48, 99), OFF(48)]);
});

// --------------------------------------------------------- hit guard
test("hit guard swallows double triggers inside the window", () => {
    const e = engine();
    e.setguard(30);
    e.bytes(0x99, 36, 100); e.__now += 10;
    e.bytes(0x99, 36, 100); e.__now += 25;      // 35 ms after the first
    e.bytes(0x99, 36, 100);
    eq(e.take(), [ON(36, 100), OFF(36)]);
});

test("hit guard 0 disables it", () => {
    const e = engine();
    e.setguard(0);
    e.bytes(0x99, 36, 100, 36, 100);
    eq(e.take(), [ON(36, 100), OFF(36)]);
});

// ------------------------------------------------------------ quantise
test("quantise off fires immediately even while playing", () => {
    const e = engine();
    e.transport(1);
    e.hit(36);
    eq(e.take(), [ON(36, 100)]);
});

test("quantise is bypassed while the transport is stopped", () => {
    const e = engine();
    e.setquant(5);
    e.hit(36);
    eq(e.take(), [ON(36, 100)]);
});

test("1 Bar quantise holds the hit until the next downbeat", () => {
    const e = engine();
    e.setquant(5); e.transport(1);
    e.hit(36);
    eq(e.take(), [], "nothing before the boundary");
    e.tick(1, 2, 0); e.tick(1, 3, 240); e.tick(1, 4, 360);
    eq(e.take(), []);
    e.tick(2, 1, 0);
    eq(e.take(), [ON(36, 100)]);
});

test("a hit just after the downbeat (late-hit grace) fires immediately", () => {
    const e = engine();
    e.setquant(5); e.transport(1);
    e.tick(2, 1, 0);                            // the downbeat
    e.__now += 15;
    e.bytes(0x99, 36, 100);                     // 15 ms late
    eq(e.take(), [ON(36, 100)]);
});

test("a hit well after the downbeat waits for the next one", () => {
    const e = engine();
    e.setquant(5); e.transport(1);
    e.tick(2, 1, 0);
    e.__now += 200;
    e.bytes(0x99, 36, 100);
    eq(e.take(), []);
    e.tick(3, 1, 0);
    eq(e.take(), [ON(36, 100)]);
});

test("a tick landing a hair before the bar line still counts", () => {
    const e = engine();
    e.setquant(5); e.transport(1);
    e.hit(36);
    e.tick(1, 4, 479);
    eq(e.take(), [ON(36, 100)]);
});

test("1/4 quantise fires on the next beat", () => {
    const e = engine();
    e.setquant(3); e.transport(1);
    e.hit(36);
    e.tick(1, 1, 120);
    e.tick(1, 1, 360);
    eq(e.take(), []);
    e.tick(1, 2, 0);
    eq(e.take(), [ON(36, 100)]);
});

test("2 Bars quantise only fires on odd bars", () => {
    const e = engine();
    e.setquant(6); e.transport(1);
    e.hit(36);
    e.tick(2, 1, 0);
    eq(e.take(), []);
    e.tick(3, 1, 0);
    eq(e.take(), [ON(36, 100)]);
});

test("quantise respects 3/4", () => {
    const e = engine();
    e.tsig(3, 4); e.setquant(5); e.transport(1);
    e.hit(36);
    e.tick(1, 3, 360);
    eq(e.take(), []);
    e.tick(2, 1, 0);
    eq(e.take(), [ON(36, 100)]);
});

test("quantise respects 6/8 beats", () => {
    const e = engine();
    e.tsig(6, 8); e.setquant(5); e.transport(1);
    e.hit(36);
    e.tick(1, 6, 0);                            // last eighth of the bar
    eq(e.take(), []);
    e.tick(2, 1, 0);
    eq(e.take(), [ON(36, 100)]);
});

test("a second hit before the boundary cancels the pending toggle", () => {
    const e = engine();
    e.setquant(5); e.transport(1);
    e.hit(36); e.hit(36);
    e.tick(2, 1, 0);
    eq(e.take(), []);
});

test("quantised stop of a playing loop lands on the boundary", () => {
    const e = engine();
    e.hit(36); e.take();
    e.setquant(5); e.transport(1);
    e.hit(36);
    eq(e.take(), []);
    e.tick(2, 1, 0);
    eq(e.take(), [OFF(36)]);
});

test("quantised group switch: last armed pad wins and the old one stops on the beat", () => {
    const e = engine();
    for (const p of [36, 37, 38]) { e.selpad(p); e.padgroup(1); }
    e.hit(36); e.take();
    e.setquant(5); e.transport(1);
    e.hit(37); e.hit(38);
    eq(e.take(), []);
    e.tick(2, 1, 0);
    eq(e.take(), [OFF(36), ON(38, 100)]);
});

test("pending hits fire immediately when quantise is switched off", () => {
    const e = engine();
    e.setquant(5); e.transport(1);
    e.hit(36);
    e.setquant(0);
    eq(e.take(), [ON(36, 100)]);
});

// ------------------------------------------------------------ transport
test("transport stop releases playing pads, like Live does", () => {
    const e = engine();
    e.transport(1);
    e.hit(36); e.hit(37); e.take();
    e.transport(0);
    eq(e.take(), [OFF(36), OFF(37)]);
    e.hit(36);
    eq(e.take(), [ON(36, 100)], "the next hit starts the loop again");
});

test("transport stop drops hits still waiting for a boundary", () => {
    const e = engine();
    e.setquant(5); e.transport(1);
    e.hit(36);
    e.transport(0);
    eq(e.take(), []);
    e.transport(1);
    e.tick(2, 1, 0);
    eq(e.take(), [], "nothing fires later either");
});

test("On Play = Restart retriggers playing pads so they line up", () => {
    const e = engine();
    e.setonplay(1);
    e.hit(36, 90); e.take();
    e.transport(1);
    eq(e.take(), [OFF(36), ON(36, 90)]);
});

// --------------------------------------------------------------- panic
test("panic stops every playing pad and clears pending", () => {
    const e = engine();
    e.hit(36); e.hit(99); e.take();
    e.setquant(5); e.transport(1);
    e.hit(40);
    e.panic(1);
    eq(e.take(), [OFF(36), OFF(99)]);
    e.tick(2, 1, 0);
    eq(e.take(), [], "the pending hit was cancelled");
});

test("panic button release (0) does nothing", () => {
    const e = engine();
    e.hit(36); e.take();
    e.panic(0);
    eq(e.take(), []);
});

// ------------------------------------------------------------ mouse
test("clicking a cell toggles the pad in the current view", () => {
    const e = engine();
    e.setview(9);                                // 36..51
    e.click(2, 1);
    eq(e.take(), [[0x90, 38, 100]]);
    e.click(2, 0);
    eq(e.take(), [[0x80, 38, 0]]);
});

test("hidden pads (outside the view) still toggle", () => {
    const e = engine();
    e.setview(0);
    e.hit(100);
    eq(e.take(), [ON(100, 100)]);
});

// ------------------------------------------------------------ editor
test("editor input is ignored until the device has loaded", () => {
    const e = engine();
    e.ready = 0;
    e.selpad(36); e.padgroup(3);
    e.loaded();
    e.hit(36);
    e.selpad(37); e.padgroup(3);
    e.hit(37);
    eq(e.take(), [ON(36, 100), ON(37, 100)], "pad 36 never joined a group");
});

test("follow selects the last hit pad and pushes it to the editor", () => {
    const e = engine();
    e.selpad(40); e.padgroup(2); e.out.ui = [];
    e.hit(40);
    const ed = e.out.ui.filter((m) => m[0] === "editor");
    eq(ed.find((m) => m[1] === "selpad"), ["editor", "selpad", 40]);
    eq(ed.find((m) => m[1] === "padgroup"), ["editor", "padgroup", 2]);
});

test("follow off keeps the editor on its pad", () => {
    const e = engine();
    e.setfollow(0); e.selpad(40); e.out.ui = [];
    e.hit(50);
    eq(e.out.ui.filter((m) => m[0] === "editor").length, 0);
});

test("input monitor reports pitch and velocity", () => {
    const e = engine();
    e.hit(36, 112);
    eq(e.out.ui.find((m) => m[0] === "monitor"), ["monitor", "C1", 112]);
});

test("canvas state: st carries on, pending, group, mode, fix, in-range", () => {
    const e = engine();
    e.setview(9);
    e.selpad(37); e.padgroup(1); e.padmode(1); e.padfix(1);
    const st = e.out.ui.filter((m) => m[0] === "st" && m[1] === 37).pop();
    eq(st, ["st", 37, 0, 0, 1, 1, 1, 1]);
    e.hit(37);
    eq(e.out.ui.filter((m) => m[0] === "st" && m[1] === 37).pop(), ["st", 37, 1, 0, 1, 1, 1, 1]);
});

test("canvas state: pending shows while waiting for the boundary", () => {
    const e = engine();
    e.setquant(5); e.transport(1);
    e.out.ui = [];
    e.hit(36);
    eq(e.out.ui.filter((m) => m[0] === "st" && m[1] === 36).pop(), ["st", 36, 0, 1, 0, 0, 0, 1]);
});

test("canvas only hears about visible pads", () => {
    const e = engine();
    e.setview(0); e.out.ui = [];
    e.hit(100);
    eq(e.out.ui.filter((m) => m[0] === "st").length, 0);
});

test("hit events carry ok / guarded / thru flags", () => {
    const e = engine();
    e.setguard(30); e.setlo(36); e.sethi(51); e.out.ui = [];
    e.bytes(0x99, 36, 90); e.__now += 5;
    e.bytes(0x99, 36, 80);
    e.bytes(0x99, 60, 70);
    eq(e.out.ui.filter((m) => m[0] === "hit"), [["hit", 36, 90, 0], ["hit", 36, 80, 1], ["hit", 60, 70, 2]]);
});

test("tick reports song beat and quantum progress", () => {
    const e = engine();
    e.setquant(5); e.transport(1); e.out.ui = [];
    e.tick(2, 3, 240);                          // bar 2, beat 3.5 -> song beat 6.5, 10/16 into the bar
    eq(e.out.ui.filter((m) => m[0] === "tick").pop(), ["tick", 6.5, 4, 10, 16]);
    e.tick(3, 1, 0);
    eq(e.out.ui.filter((m) => m[0] === "tick").pop(), ["tick", 8, 4, 0, 16]);
});

test("tempo is forwarded only when it changes", () => {
    const e = engine();
    e.out.ui = [];
    e.tempo(120); e.tempo(120); e.tempo(128);
    eq(e.out.ui.filter((m) => m[0] === "settempo"), [["settempo", 120], ["settempo", 128]]);
});

// --------------------------------------------------------- persistence
test("pad configuration round-trips through getvalueof/setvalueof", () => {
    const a = engine();
    a.selpad(36); a.padgroup(2); a.padmode(1); a.padfix(1); a.padvel(55);
    a.selpad(127); a.padmode(2);
    const saved = Array.from(a.getvalueof());
    eq(saved.length, 1 + 128 * 4);
    const b = engine();
    b.setvalueof.apply(null, saved);
    eq(Array.from(b.getvalueof()), saved);
    b.hit(36, 100);
    eq(b.take(), [ON(36, 55)]);
});

test("setvalueof accepts a single array argument", () => {
    const a = engine();
    a.selpad(1); a.padgroup(4);
    const saved = Array.from(a.getvalueof());
    const b = engine();
    b.setvalueof(saved);
    eq(b.group[1], 4);
});

test("setvalueof ignores malformed data", () => {
    const b = engine();
    b.setvalueof(1, 2, 3);
    eq(b.group[0], 0);
});

test("config edits notify Live so the set is marked dirty", () => {
    const e = engine();
    const n = e.out.notified;
    e.selpad(36); e.padgroup(1);
    if (e.out.notified <= n) throw new Error("notifyclients not called");
});

console.log(`\n${count - failures}/${count} passed`);
process.exit(failures ? 1 : 0);
