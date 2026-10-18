// Pad Toggle -- Live info (v8.codebox).
//
// Reads, through the Live API, what the canvas shows about each visible pad:
// the Drum Rack pad's name, its chain colour, and from the pad's Simpler the
// loop length (so the progress ring turns once per loop) and a 40-column
// waveform summary.
//
// Kept cheap: only the 16 visible pads are read, every 2 s or when the view
// changes; the canvas is told only about what changed; each sample file is
// summarised once and cached.

inlets = 1;
outlets = 2;            // 0: to canvases (pinfo / wave)   1: to buffer~ (replace <path>)

var VIEW_PADS = 16;
var WAVE_N = 40;
var PEEKS_PER_COL = 48;

var ready = 0;
var view = 36;
var tempo = 120;
var bufname = "";
var cur = null;                     // one reusable LiveAPI cursor
var rackId = 0;
var padIds = [];                    // by note
var sig = {};                       // pad -> last info signature sent
var padPath = {};                   // pad -> sample file path
var waveCache = {};                 // path -> [ints 0..99]
var queue = [];                     // paths waiting for a summary
var loading = "";

// Each distinct problem is posted to the Max console once, never per poll.
var warned = {};
function warn(where, e) {
    var msg = where + ": " + (e && e.message ? e.message : e);
    if (warned[msg]) return;
    warned[msg] = 1;
    post("Pad Toggle (Live info) " + msg + "\n");
}

function init() {
    ready = 1;
    try { cur = new LiveAPI(null, "this_device"); } catch (e) { cur = null; warn("LiveAPI", e); }
    findRack();
    refresh(1);
    if (verbose) dump();
}

var verbose = 0;
function setverbose(v) { verbose = v ? 1 : 0; }

function setbufname(n) { bufname = String(n); }
function setview(i) { view = (i | 0) * 4; if (ready) refresh(1); }
function settempo(t) { if (t > 0) tempo = +t; }
function poll() { if (ready) refresh(0); }

// ---------------------------------------------------------------- Live API
function idOf(v) {
    // get() returns ["id", n] (or a flat list of them)
    if (!v || v.length < 2) return 0;
    return +v[1] || 0;
}

function idList(v) {
    var out = [];
    if (!v) return out;
    for (var i = 0; i + 1 < v.length; i += 2) if (v[i] === "id") out.push(+v[i + 1]);
    return out;
}

// Retarget the one cursor by id. (goto("id N") is not accepted -- verified in
// Live 12.4 / Max 9 -- so the id property is set instead.)
function at(id) { cur.id = id; return cur; }

function getOne(id, prop) {
    var v = at(id).get(prop);
    return v && v.length ? v[0] : null;
}

function getText(id, prop) {
    var v = at(id).get(prop);
    return v ? Array.prototype.join.call(v, " ") : "";
}

var dbg = {};
function raw(v) {
    try { return { type: typeof v, isArray: Array.isArray(v), str: String(v), json: JSON.stringify(v) }; }
    catch (e) { return String(e); }
}

function findRack() {
    rackId = 0; padIds = [];
    if (!cur) return;
    try {
        cur.goto("this_device");
        dbg.path = raw(cur.path); dbg.id = raw(cur.id);
        dbg.parent = raw(cur.get("canonical_parent"));
        var parent = idOf(cur.get("canonical_parent"));
        if (!parent) return;
        dbg.devices = raw(at(parent).get("devices"));
        var devs = idList(at(parent).get("devices"));
        dbg.devClasses = devs.map(function (d) { return raw(at(d).get("class_name")); });
        for (var i = 0; i < devs.length; i++) {
            if (getOne(devs[i], "class_name") === "DrumGroupDevice") { rackId = devs[i]; break; }
        }
        if (!rackId) return;
        var pads = idList(at(rackId).get("drum_pads"));
        for (var j = 0; j < pads.length; j++) {
            var note = getOne(pads[j], "note");
            padIds[note === null ? j : (note | 0)] = pads[j];
        }
    } catch (e) {
        rackId = 0;
        warn("findRack", e);
    }
}

function refresh(force) {
    if (!cur) return;
    if (!rackId) { findRack(); if (!rackId) return; }
    try {
        // The rack may have been deleted or replaced since the last look.
        if (getOne(rackId, "class_name") !== "DrumGroupDevice") { findRack(); force = 1; }
    } catch (e) { findRack(); force = 1; }
    for (var c = 0; c < VIEW_PADS; c++) {
        var p = view + c;
        if (p > 127 || !padIds[p]) continue;
        try { readPad(p, force); } catch (e) { warn("readPad " + p, e); }
    }
    pump();
}

function readPad(p, force) {
    var pid = padIds[p];
    var name = getText(pid, "name");
    var chains = idList(at(pid).get("chains"));
    var col = -1, path = "", loopBeats = 0, loopMs = 0;
    if (chains.length) {
        col = getOne(chains[0], "color");
        var devs = idList(at(chains[0]).get("devices"));
        var sid = 0;
        for (var i = 0; i < devs.length && !sid; i++) {
            sid = idOf(at(devs[i]).get("sample"));       // Simpler (and Drum Sampler) expose .sample
        }
        if (sid) {
            path = getText(sid, "file_path");
            var lm = loopLength(sid, path);
            loopBeats = lm[0]; loopMs = lm[1];
        }
    } else {
        name = "";
    }
    var s = [name, col, path, loopBeats, loopMs].join("|");
    if (!force && sig[p] === s) return;
    sig[p] = s;
    var r = -1, g = -1, b = -1;
    if (col !== null && col >= 0) { r = (col >> 16) & 255; g = (col >> 8) & 255; b = col & 255; }
    outlet(0, ["pinfo", p, r, g, b, loopBeats, loopMs].concat(name ? [name] : []));
    if (padPath[p] !== path || force) {
        padPath[p] = path;
        if (!path) outlet(0, ["wave", p]);
        else if (waveCache[path]) outlet(0, ["wave", p].concat(waveCache[path]));
        else if (queue.indexOf(path) < 0 && loading !== path) queue.push(path);
    }
}

// Loop length of a pad's sample: in beats when warped (it then follows the
// tempo), in ms when not.
function loopLength(sid, path) {
    var rate = +getOne(sid, "sample_rate") || 44100;
    var len = +getOne(sid, "length") || 0;
    var startF = +getOne(sid, "start_marker") || 0;
    var endF = +getOne(sid, "end_marker") || len;
    if (endF <= startF) endF = len;
    var startS = startF / rate, endS = endF / rate;
    var warped = +getOne(sid, "warping") ? 1 : 0;
    if (!warped) return [0, Math.max(0, (endS - startS) * 1000)];
    var m = warpMarkers(sid);
    if (m.length >= 2) {
        var beats = beatAt(m, endS) - beatAt(m, startS);
        if (beats > 0) return [Math.round(beats * 16) / 16, 0];
    }
    var bpm = /(\d+(?:\.\d+)?)\s*bpm/i.exec(path);
    if (bpm) return [Math.max(1, Math.round((endS - startS) * (+bpm[1]) / 60)), 0];
    return [0, 0];
}

function warpMarkers(sid) {
    var raw = getText(sid, "warp_markers");
    var out = [];
    try {
        var j = JSON.parse(raw);
        var list = j.warp_markers || j;
        for (var i = 0; i < list.length; i++) out.push([+list[i].sample_time, +list[i].beat_time]);
    } catch (e) { /* older Live or unreadable: fall back */ }
    out.sort(function (a, b) { return a[0] - b[0]; });
    return out;
}

function beatAt(m, sec) {
    // linear through the warp markers, extrapolated past the ends
    var i = 1;
    while (i < m.length - 1 && m[i][0] < sec) i++;
    var a = m[i - 1], b = m[i];
    var ds = b[0] - a[0];
    if (ds <= 0) return a[1];
    return a[1] + (sec - a[0]) * (b[1] - a[1]) / ds;
}

// ------------------------------------------------------------ waveforms
function pump() {
    if (loading || !queue.length || !bufname) return;
    loading = queue.shift();
    outlet(1, "replace", loading);
}

// buffer~ bangs its right outlet when a file has loaded
function bufloaded() {
    var path = loading;
    loading = "";
    if (!path) return;
    var v = [];
    try { v = summarise(new Buffer(bufname)); } catch (e) { v = []; warn("waveform", e); }
    waveCache[path] = v;
    for (var p in padPath) if (padPath[p] === path) outlet(0, ["wave", +p].concat(v));
    pump();
}

function summarise(buf) {
    var frames = buf.framecount();
    if (!(frames > 0)) return [];
    var cols = [], peak = 0, chans = Math.min(2, buf.channelcount() || 1);
    var colLen = frames / WAVE_N;
    for (var c = 0; c < WAVE_N; c++) {
        var m = 0;
        for (var k = 0; k < PEEKS_PER_COL; k++) {
            var f = Math.floor(c * colLen + k * colLen / PEEKS_PER_COL);
            for (var ch = 1; ch <= chans; ch++) {
                var s = buf.peek(ch, f, 1);
                var x = Math.abs(typeof s === "number" ? s : s[0]);
                if (x > m) m = x;
            }
        }
        cols.push(m);
        if (m > peak) peak = m;
    }
    var out = [];
    for (var i = 0; i < WAVE_N; i++) out.push(peak > 0 ? Math.round(cols[i] / peak * 99) : 0);
    return out;
}

function dump() {
    post("rack " + rackId + " pads " + padIds.length + " view " + view + " queue " + queue.length + " loading " + loading + "\n");
}

// Diagnostics for test builds: the same state as dump(), written as JSON.
function dumpfile(path) {
    var d = new Dict();
    d.set("info", JSON.stringify({
        ready: ready, haveApi: !!cur, rackId: rackId, pads: padIds.length, view: view,
        bufname: bufname, queue: queue.length, loading: loading,
        warned: Object.keys(warned), sig: sig, dbg: dbg
    }));
    d.export_json(String(path));
}
