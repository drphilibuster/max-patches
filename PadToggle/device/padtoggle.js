// Pad Toggle -- toggle engine.
//
// Embedded verbatim in the device's [v8.codebox] by tools/build_device.py and
// loaded unchanged by the Node tests in test/, so this file is the single
// source of truth for the device's behaviour.
//
// Every MIDI byte the track receives arrives here. Note messages are turned
// into toggles; everything else (CCs, pitch bend, aftertouch, sysex, clock)
// is passed straight through so the device never swallows a controller.

inlets = 1;
outlets = 2;            // 0: MIDI bytes (list) -> midiout   1: UI messages

// ------------------------------------------------------------------ constants
var GROUPS = ["-", "A", "B", "C", "D"];
var MODES = ["Toggle", "Retrig", "Gate", "Thru"];
var MODE_TAG = ["", "R", "G", "T"];
var TOGGLE = 0, RETRIG = 1, GATE = 2, THRU = 3;
// Quantise menu entries, in sixteenths. Negative = whole bars.
var QUANT = [0, 1, 2, 4, 8, -1, -2, -4];
var QUANT_NAMES = ["Off", "1/16", "1/8", "1/4", "1/2", "1 Bar", "2 Bars", "4 Bars"];
var NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
var CELLS = 16;
var CLICK_VELOCITY = 100;
// A hit landing this soon after a boundary is a hit *on* it, played a touch
// late -- a drummer hitting the one, or a clip note on the downbeat that
// arrives just after the clock tick. It fires now instead of a whole bar on.
var LATE_GRACE_MS = 40;

// Hit flags for the canvas: how a Note On was treated.
var HIT_OK = 0, HIT_GUARDED = 1, HIT_THRU = 2;

// ---------------------------------------------------------------------- state
// Per-pad configuration (persisted with the Live set via getvalueof/setvalueof).
var group = [], mode = [], fixVel = [], padVel = [];
// Per-pad runtime state (not persisted: nothing is sounding when a set loads).
var on = [], onCh = [], onVel = [], pending = [], lastHit = [];

// Globals, driven by the device's live.* parameters.
var quant = 0;          // index into QUANT
var guardMs = 20;
var velMode = 0;        // 0 LiveVelo, 1 SetVelo
var globalVel = 100;
var onPlay = 0;         // 0 keep, 1 restart playing pads
var lo = 0, hi = 127;   // pads outside this range pass through untouched
var view = 36;          // first pitch shown in the 16-cell grid
var follow = 1;         // editor follows the last pad hit
var selected = 36;
var ready = 0;          // editor input ignored until Live has restored params

var playing = 0;
var tsNum = 4, tsDen = 4, posBeats = 1, posUnits = 0;
var tempoNow = 0;
var lastBoundaryAt = -1e9;

// MIDI parser state.
var status = 0, need = 0, data = [], sysex = null;

function resetConfig() {
    for (var p = 0; p < 128; p++) {
        group[p] = 0; mode[p] = TOGGLE; fixVel[p] = 0; padVel[p] = 100;
    }
}

function resetRuntime() {
    for (var p = 0; p < 128; p++) {
        on[p] = 0; onCh[p] = 0; onVel[p] = 0; pending[p] = null; lastHit[p] = -1e9;
    }
}

resetConfig();
resetRuntime();

function nowMs() { return Date.now(); }

// --------------------------------------------------------------- MIDI parsing
function dataLength(st) {
    var hiNib = st & 0xF0;
    if (hiNib === 0xC0 || hiNib === 0xD0) return 1;
    if (hiNib >= 0x80 && hiNib <= 0xE0) return 2;
    if (st === 0xF1 || st === 0xF3) return 1;
    if (st === 0xF2) return 2;
    return 0;
}

function midi(b) {
    b = b | 0;
    if (b >= 0xF8) { send([b]); return; }               // realtime: never breaks a message
    if (sysex !== null) {
        if (b === 0xF7) { sysex.push(b); send(sysex); sysex = null; return; }
        if (b < 0x80) { sysex.push(b); return; }
        sysex = null;                                   // aborted sysex: fall through
    }
    if (b === 0xF0) { sysex = [b]; status = 0; return; }
    if (b >= 0x80) {
        status = b; need = dataLength(b); data = [];
        if (need === 0) { send([b]); if (b >= 0xF0) status = 0; }
        return;
    }
    if (!status) return;                                // stray data byte
    data.push(b);
    if (data.length < need) return;
    var msg = [status].concat(data);
    data = [];
    if (status >= 0xF0) status = 0;                     // system common: no running status
    handle(msg);
}

function handle(msg) {
    var kind = msg[0] & 0xF0, ch = msg[0] & 0x0F;
    if (kind === 0x90 && msg[2] > 0) { noteOn(ch, msg[1], msg[2], msg); return; }
    if (kind === 0x80 || kind === 0x90) { noteOff(ch, msg[1], msg); return; }
    if (kind === 0xB0 && (msg[1] === 120 || msg[1] === 123)) {
        // Live sends All Notes Off down the chain whenever the transport
        // stops; whatever we started is silenced, so our state follows suit.
        send(msg);
        resetRuntime();
        refreshCells();
        return;
    }
    send(msg);
}

function managed(p) { return p >= lo && p <= hi && mode[p] !== THRU; }

// ------------------------------------------------------------------ note logic
function noteOn(ch, p, v, raw) {
    ui("monitor", noteName(p), v);
    if (!managed(p)) { send(raw); ui("hit", p, v, HIT_THRU); return; }
    var t = nowMs();
    if (t - lastHit[p] < guardMs) { ui("hit", p, v, HIT_GUARDED); return; }   // e-drum double trigger
    lastHit[p] = t;
    ui("hit", p, v, HIT_OK);
    if (follow) select(p);
    if (mode[p] === GATE) { startPad(p, ch, v); refreshCell(p); return; }
    trigger(p, ch, v);
}

function noteOff(ch, p, raw) {
    if (!managed(p)) { send(raw); return; }
    // The whole point of the device: a pad's Note Off (which an e-drum sends
    // anywhere from a few ms to seconds after the hit) is dropped. Only a
    // Gate pad lets go when the key is released.
    if (mode[p] === GATE && on[p]) { stopPad(p); refreshCell(p); }
}

function trigger(p, ch, v) {
    if (pending[p]) {                                   // second hit before the boundary cancels
        pending[p] = null;
        refreshCell(p);
        return;
    }
    var action = on[p] ? (mode[p] === RETRIG ? "retrig" : "off") : "on";
    if (QUANT[quant] !== 0 && playing && nowMs() - lastBoundaryAt > LATE_GRACE_MS) {
        if (action !== "off" && group[p] > 0) {
            // Only one pad per group can win the boundary: the last one armed.
            for (var q = 0; q < 128; q++) {
                if (q !== p && group[q] === group[p] && pending[q] && pending[q].action !== "off") {
                    pending[q] = null;
                    refreshCell(q);
                }
            }
        }
        pending[p] = { action: action, ch: ch, vel: v };
        refreshCell(p);
        return;
    }
    perform(p, action, ch, v);
}

function perform(p, action, ch, v) {
    if (action === "off") stopPad(p);
    else if (action === "retrig") { stopPad(p); startPad(p, ch, v); }
    else startPad(p, ch, v);
    refreshCell(p);
}

function outVelocity(p, v) {
    if (fixVel[p]) return padVel[p];
    if (velMode) return globalVel;
    return v;
}

function startPad(p, ch, v) {
    if (group[p] > 0) {
        for (var q = 0; q < 128; q++) {
            if (q !== p && on[q] && group[q] === group[p]) { stopPad(q); refreshCell(q); }
        }
    }
    if (on[p]) stopPad(p);                              // never stack two Note Ons
    var vel = clamp(outVelocity(p, v), 1, 127);
    send([0x90 | ch, p, vel]);
    on[p] = 1; onCh[p] = ch; onVel[p] = v;
}

function stopPad(p) {
    if (!on[p]) return;
    send([0x80 | onCh[p], p, 0]);
    on[p] = 0;
}

// ------------------------------------------------------- transport & quantise
function transport(state) {
    state = state ? 1 : 0;
    if (state === playing) return;
    playing = state;
    var p;
    if (playing) {
        if (onPlay) {
            for (p = 0; p < 128; p++) {
                if (on[p] && mode[p] !== GATE) { var ch = onCh[p], v = onVel[p]; stopPad(p); startPad(p, ch, v); }
            }
        }
    }
    ui("transport", playing);
    if (!playing) {
        // Live itself releases every note a device left sounding when the
        // transport stops (it injects the Note Offs after this device, so
        // nothing here can keep a loop alive through a stop). Follow it: drop
        // anything still waiting for a boundary and mark every pad off, so the
        // next hit starts its loop instead of "stopping" a silent one.
        allOff();
    }
    refreshCells();
}

function tsig(num, den) { tsNum = num > 0 ? num : 4; tsDen = den > 0 ? den : 4; }
function tempo(t) {
    if (t > 0 && Math.abs(t - tempoNow) > 1e-6) { tempoNow = +t; ui("settempo", tempoNow); }
}
function beats(b) { posBeats = b; }
function units(u) { posUnits = u; }

// Called once per 1/16 from a transport-locked metro, after [transport] has
// reported beats/units/tsig; `bars` arrives last and triggers the check.
function bars(bar) {
    var boundary = isBoundary(bar, posBeats, posUnits);
    if (boundary) {
        lastBoundaryAt = nowMs();
        flushPending();
    }
    canvasTick(bar, boundary);
}

// Tell the canvases where the song is and how far the current quantum has
// run, so they can draw bar lines and count pending pads down.
function canvasTick(bar, boundary) {
    var tpb = 480 * 4 / tsDen, barSix = tsNum * 16 / tsDen;
    var pos = Math.round(((posBeats - 1) * tpb + posUnits) / 120);
    if (pos >= barSix) { pos -= barSix; bar += 1; }
    var song = ((bar - 1) * barSix + pos) / 4;          // quarter-note beats
    var q = QUANT[quant], k = 0, n = 0;
    if (q > 0) { n = q; k = pos % q; }
    else if (q < 0) { n = barSix * -q; k = ((bar - 1) % -q) * barSix + pos; }
    if (boundary) k = 0;
    ui("tick", song, barSix / 4, k, n);
}

function isBoundary(bar, beat, unit) {
    var q = QUANT[quant];
    if (q === 0) return true;
    var tpb = 480 * 4 / tsDen;                          // ticks per beat (480 PPQ)
    var barSix = tsNum * 16 / tsDen;                    // sixteenths per bar
    var pos = Math.round(((beat - 1) * tpb + unit) / 120);
    if (pos >= barSix) { pos -= barSix; bar += 1; }     // a tick that lands a hair early
    if (q > 0) return pos % q === 0;
    return pos === 0 && ((bar - 1) % (-q)) === 0;
}

function flushPending() {
    for (var p = 0; p < 128; p++) {
        if (pending[p]) {
            var e = pending[p];
            pending[p] = null;
            perform(p, e.action, e.ch, e.vel);
        }
    }
}

// ----------------------------------------------------------------- panic etc.
function allOff() {
    for (var p = 0; p < 128; p++) {
        pending[p] = null;
        if (on[p]) stopPad(p);
    }
    refreshCells();
}

function panic(v) {
    if (v === undefined || v) allOff();
}

// --------------------------------------------------------------- UI and setup
function click(cell, v) {
    var p = view + cell;
    if (p < 0 || p > 127) { refreshCells(); return; }
    select(p);
    if (mode[p] === GATE) {
        if (on[p]) stopPad(p); else startPad(p, 0, CLICK_VELOCITY);
        refreshCell(p);
        return;
    }
    if (mode[p] === THRU || p < lo || p > hi) {        // a click on a thru pad plays a short hit
        send([0x90, p, CLICK_VELOCITY]);
        send([0x80, p, 0]);
        ui("hit", p, CLICK_VELOCITY, HIT_THRU);
        refreshCell(p);
        return;
    }
    ui("hit", p, CLICK_VELOCITY, HIT_OK);
    trigger(p, 0, CLICK_VELOCITY);
    refreshCell(p);
}

function setview(i) { view = clamp(i | 0, 0, 28) * 4; ui("setview", view); refreshCells(); }
function setfollow(v) { follow = v ? 1 : 0; }
function setquant(i) {
    quant = clamp(i | 0, 0, QUANT.length - 1);
    ui("setquant", quant);
    if (QUANT[quant] === 0) flushPending();
}
function setguard(ms) { guardMs = Math.max(0, +ms); }
function setvelmode(v) { velMode = v ? 1 : 0; }
function setglobalvel(v) { globalVel = clamp(v | 0, 1, 127); }
function setonplay(v) { onPlay = v ? 1 : 0; }
function setlo(v) { lo = clamp(v | 0, 0, 127); refreshCells(); }
function sethi(v) { hi = clamp(v | 0, 0, 127); refreshCells(); }

function select(p) {
    selected = clamp(p | 0, 0, 127);
    pushEditor();
}

function selpad(p) { select(p); }

// Editor controls. Ignored until `ready`: when a set loads, Live replays every
// parameter's stored value, and the editor's would otherwise be written over
// whichever pad happened to be selected.
function padgroup(g) { if (!ready) return; setGroup(selected, g); }
function padmode(m) { if (!ready) return; setMode(selected, m); }
function padfix(f) { if (!ready) return; fixVel[selected] = f ? 1 : 0; changed(selected); }
function padvel(v) { if (!ready) return; padVel[selected] = clamp(v | 0, 1, 127); changed(selected); }

function setGroup(p, g) {
    g = clamp(g | 0, 0, 4);
    if (group[p] === g) return;
    group[p] = g;
    // Joining a group with a pad already playing in it would break the
    // one-at-a-time rule; the newcomer stops.
    if (g > 0 && on[p]) {
        for (var q = 0; q < 128; q++) {
            if (q !== p && on[q] && group[q] === g) { stopPad(p); break; }
        }
    }
    changed(p);
}

function setMode(p, m) {
    m = clamp(m | 0, 0, 3);
    if (mode[p] === m) return;
    if (m === THRU) { pending[p] = null; stopPad(p); }
    mode[p] = m;
    changed(p);
}

// "Set ALL to": overwrites every pad's group, as the original's
// Monophonic/Polyphonic switch does.
function setall(g) {
    if (!ready) return;
    g = clamp(g | 0, 0, 4);
    for (var p = 0; p < 128; p++) group[p] = g;
    if (g > 0) {
        var keep = -1;
        for (p = 127; p >= 0; p--) {
            if (on[p]) { if (keep < 0) keep = p; else stopPad(p); }
        }
    }
    notifyclients();
    refreshCells();
    pushEditor();
}

function changed(p) {
    notifyclients();
    refreshCell(p);
    if (p === selected) pushEditor();
}

function loaded() {
    ready = 1;
    ui("setview", view);
    ui("setquant", quant);
    ui("transport", playing);
    pushEditor();
    refreshCells();
}

function pushEditor() {
    var p = selected;
    ui("editor", "selpad", p);
    ui("editor", "padgroup", group[p]);
    ui("editor", "padmode", mode[p]);
    ui("editor", "padfix", fixVel[p]);
    ui("editor", "padvel", padVel[p]);
}

// One "st" per visible pad change; the canvases draw it. Pads outside the
// view are not sent: nothing is drawing them.
function refreshCell(p) {
    var cell = p - view;
    if (cell < 0 || cell >= CELLS) return;
    ui("st", p, on[p] ? 1 : 0, pending[p] ? 1 : 0, group[p], mode[p], fixVel[p],
       (p >= lo && p <= hi) ? 1 : 0);
}

function refreshCells() {
    for (var c = 0; c < CELLS; c++) if (view + c <= 127) refreshCell(view + c);
}

// --------------------------------------------------- persistence (Live set)
// The v8 box is a hidden "blob" parameter: Live stores whatever getvalueof
// returns and hands it back to setvalueof when the set or a preset loads.
var STATE_VERSION = 1;

function getvalueof() {
    var out = [STATE_VERSION];
    for (var p = 0; p < 128; p++) out.push(group[p], mode[p], fixVel[p], padVel[p]);
    return out;
}

function setvalueof() {
    var a = Array.prototype.slice.call(arguments);
    if (a.length === 1 && a[0] && typeof a[0] === "object" && a[0].length !== undefined) a = Array.prototype.slice.call(a[0]);
    if (a.length < 1 + 128 * 4 || (a[0] | 0) !== STATE_VERSION) return;
    for (var p = 0; p < 128; p++) {
        var i = 1 + p * 4;
        group[p] = clamp(a[i] | 0, 0, 4);
        mode[p] = clamp(a[i + 1] | 0, 0, 3);
        fixVel[p] = a[i + 2] ? 1 : 0;
        padVel[p] = clamp(a[i + 3] | 0, 1, 127);
    }
    refreshCells();
    pushEditor();
}

// ------------------------------------------------------------------- helpers
function send(bytes) { outlet(0, bytes); }

function ui() {
    outlet(1, Array.prototype.slice.call(arguments));
}

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

function noteName(p) {
    // Live's convention: middle C (60) is C3.
    return NOTE_NAMES[p % 12] + (Math.floor(p / 12) - 2);
}

// Debug helper: "dump" posts the sounding and pending pads to the Max console.
function dump() {
    var s = [], w = [];
    for (var p = 0; p < 128; p++) {
        if (on[p]) s.push(noteName(p));
        if (pending[p]) w.push(noteName(p) + ":" + pending[p].action);
    }
    post("on [" + s.join(" ") + "] pending [" + w.join(" ") + "] quant " + QUANT_NAMES[quant] + " playing " + playing + "\n");
}
