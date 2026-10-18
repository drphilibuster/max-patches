// Tests for device/ptliveinfo.js under Node:  node test/test_liveinfo.js
// A small fake of the Live Object Model stands in for LiveAPI, and a fake
// Buffer for the waveform reader.
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = fs.readFileSync(path.join(__dirname, "..", "device", "ptliveinfo.js"), "utf8");

// id -> props. Children are ["id", n, ...] lists, as LiveAPI returns them.
function lom() {
    const o = {};
    o[1] = { class_name: ["MxDeviceMidiEffect"], canonical_parent: ["id", 2] };   // this device
    o[2] = { devices: ["id", 1, "id", 3] };                                       // track
    const pads = [];
    for (let n = 0; n < 128; n++) { pads.push("id", 1000 + n); o[1000 + n] = { note: [n], name: [""], chains: [] }; }
    o[3] = { class_name: ["DrumGroupDevice"], drum_pads: pads };
    // pad 36: a warped 8-beat loop at 120 bpm, red chain
    o[1036] = { note: [36], name: ["Funk", "122"], chains: ["id", 5000] };
    o[5000] = { color: [0xFF2010], devices: ["id", 6000] };
    o[6000] = { class_name: ["OriginalSimpler"], sample: ["id", 7000] };
    o[7000] = { file_path: ["/loops/funk 122 bpm.aif"], sample_rate: [44100], length: [176400],
        start_marker: [0], end_marker: [176400], warping: [1],
        warp_markers: [JSON.stringify({ warp_markers: [{ sample_time: 0, beat_time: 0 }, { sample_time: 1, beat_time: 2 }] })] };
    // pad 37: unwarped 2 s one-shot loop, no markers
    o[1037] = { note: [37], name: ["Hat"], chains: ["id", 5001] };
    o[5001] = { color: [0x00FF00], devices: ["id", 6001] };
    o[6001] = { class_name: ["OriginalSimpler"], sample: ["id", 7001] };
    o[7001] = { file_path: ["/loops/hat.wav"], sample_rate: [48000], length: [96000],
        start_marker: [0], end_marker: [96000], warping: [0], warp_markers: [""] };
    // pad 38: same file as 36 (waveform cache)
    o[1038] = { note: [38], name: ["Funk copy"], chains: ["id", 5002] };
    o[5002] = { color: [0x0000FF], devices: ["id", 6002] };
    o[6002] = { class_name: ["OriginalSimpler"], sample: ["id", 7000] };
    // pad 39: chain with a non-sample instrument
    o[1039] = { note: [39], name: ["Synth"], chains: ["id", 5003] };
    o[5003] = { color: [0x808080], devices: ["id", 6003] };
    o[6003] = { class_name: ["Operator"], sample: ["id", 0] };
    return o;
}

function liveinfo() {
    const objs = lom();
    const out = { canvas: [], buffer: [] };
    const gets = { n: 0 };
    // Like Live's: goto() takes a path (not "id N"), and setting .id retargets.
    class LiveAPI {
        constructor(cb, p) { this.goto(p); }
        goto(p) {
            if (p === "this_device") this.cur = 1;
            else if (/^id /.test(String(p))) this.cur = -1;          // what Live does: no object
            else throw new Error("unknown path " + p);
        }
        set id(v) { this.cur = +v; }
        get id() { return String(this.cur); }
        get(prop) { gets.n++; const v = (objs[this.cur] || {})[prop]; return v === undefined ? 1 : v; }
    }
    class Buffer {
        constructor(name) { this.name = name; }
        framecount() { return 4000; }
        channelcount() { return 2; }
        peek(ch, f) { return Math.sin(f / 50) * (f < 2000 ? 1 : 0.25); }
    }
    const sb = {
        LiveAPI, Buffer, post: () => {}, Math, Array, Object, String, JSON,
        outlet: (n, ...v) => (n === 0 ? out.canvas : out.buffer).push(v.length === 1 && Array.isArray(v[0]) ? v[0] : v),
    };
    vm.createContext(sb);
    vm.runInContext(SRC, sb);
    sb.objs = objs; sb.out = out; sb.gets = gets;
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
function ok(c, what) { if (!c) throw new Error(what); }
const pinfo = (li, p) => li.out.canvas.filter((m) => m[0] === "pinfo" && m[1] === p).pop();

test("finds the Drum Rack next to the device and reports visible pads", () => {
    const li = liveinfo();
    li.setbufname("123ptwave"); li.setview(9); li.init();
    eq(li.rackId, 3);
    eq(pinfo(li, 36), ["pinfo", 36, 255, 32, 16, 8, 0, "Funk 122"]);
});

test("warped loop length comes from the warp markers (8 beats)", () => {
    const li = liveinfo();
    li.setview(9); li.init();
    eq(pinfo(li, 36)[5], 8);
});

test("unwarped sample reports its length in ms", () => {
    const li = liveinfo();
    li.setview(9); li.init();
    eq(pinfo(li, 37).slice(5, 7), [0, 2000]);
});

test("warped without readable markers falls back to the bpm in the file name", () => {
    const li = liveinfo();
    li.objs[7000].warp_markers = ["garbage"];
    li.setview(9); li.init();
    eq(pinfo(li, 36)[5], 8, "4 s at 122 bpm rounds to 8 beats");
});

test("pads without a sample still get name and colour", () => {
    const li = liveinfo();
    li.setview(9); li.init();
    eq(pinfo(li, 39), ["pinfo", 39, 128, 128, 128, 0, 0, "Synth"]);
});

test("empty pads report no colour", () => {
    const li = liveinfo();
    li.setview(9); li.init();
    eq(pinfo(li, 40), ["pinfo", 40, -1, -1, -1, 0, 0]);
});

test("polling sends nothing when nothing changed, and only the changed pad when one does", () => {
    const li = liveinfo();
    li.setview(9); li.init();
    li.out.canvas = [];
    li.poll();
    eq(li.out.canvas.filter((m) => m[0] === "pinfo").length, 0);
    li.objs[1037].name = ["Hat", "Open"];
    li.poll();
    eq(li.out.canvas.filter((m) => m[0] === "pinfo").map((m) => m[1]), [37]);
});

test("one waveform load at a time; each file summarised once and shared", () => {
    const li = liveinfo();
    li.setbufname("123ptwave"); li.setview(9); li.init();
    eq(li.out.buffer, [["replace", "/loops/funk 122 bpm.aif"]], "first file requested");
    li.bufloaded();
    eq(li.out.buffer[1], ["replace", "/loops/hat.wav"], "second file requested after the first loaded");
    const waves = li.out.canvas.filter((m) => m[0] === "wave" && m.length > 2);
    eq(waves.map((m) => m[1]).sort(), [36, 38], "both pads using the file get it");
    eq(waves[0].length, 2 + 40);
    ok(Math.max(...waves[0].slice(2)) === 99, "normalised to 99");
    li.bufloaded();
    eq(li.out.buffer.length, 2, "no more loads: pad 38's file was cached");
});

test("no buffer name, no loads (stays quiet rather than erroring)", () => {
    const li = liveinfo();
    li.setview(9); li.init();
    eq(li.out.buffer, []);
});

test("a vanished Drum Rack is looked for again", () => {
    const li = liveinfo();
    li.setview(9); li.init();
    li.objs[3].class_name = ["Reverb"];
    li.objs[2].devices = ["id", 1];
    li.out.canvas = [];
    li.poll();
    eq(li.rackId, 0);
    eq(li.out.canvas, []);
});

test("a poll reads only the 16 visible pads (bounded Live API work)", () => {
    const li = liveinfo();
    li.setview(9); li.init();
    li.gets.n = 0;
    li.poll();
    ok(li.gets.n < 16 * 12, `${li.gets.n} gets for one poll`);
});

console.log(`\n${count - failures}/${count} passed`);
process.exit(failures ? 1 : 0);
