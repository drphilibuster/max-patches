// Pad Toggle -- canvas (v8ui).
//
// One script, three views, picked by the box's first jsargument:
//   "grid"      the 16 pads in the device strip
//   "timeline"  the last four bars of hits and loop spans, one lane per pad
//   "stage"     the big resizable performance window (grid + timeline)
//
// It draws only; all behaviour lives in padtoggle.js, which sends state here.
// Embedded verbatim in each v8ui by tools/build_device.py, and loaded by the
// Node tests (test/test_canvas.js) against a recording mgraphics stand-in.
//
// CPU: nothing redraws on a timer unless something is actually moving. The
// view asks the patch to start its frame clock (outlet 1) only while a ring is
// turning, a countdown is running, a ripple or fade is in flight, or the
// timeline has something on screen; otherwise it redraws once per change.

inlets = 1;
outlets = 3;            // 0: to engine (click)   1: frame clock on/off   2: window (stage)

// jsarguments[0] is the script's name; the view is whichever argument names one.
var MODE = "grid";
if (typeof jsarguments !== "undefined") {
    for (var ai = 0; ai < jsarguments.length; ai++) {
        var av = String(jsarguments[ai]);
        if (av === "grid" || av === "timeline" || av === "stage") MODE = av;
    }
}

mgraphics.init();
mgraphics.relative_coords = 0;
mgraphics.autofill = 0;

// ------------------------------------------------------------------ palette
var BG = [0.075, 0.075, 0.09, 1];
var CELL_OFF = [0.17, 0.17, 0.20];
var TEXT = [0.90, 0.90, 0.92];
var DIM = [0.52, 0.53, 0.58];
var GUARD_RED = [1.0, 0.25, 0.22];
var GROUP_COL = [
    null,
    [1.00, 0.45, 0.15],     // A orange
    [0.20, 0.75, 0.95],     // B cyan
    [0.40, 0.85, 0.35],     // C green
    [0.90, 0.40, 0.85]      // D magenta
];
var NOGROUP_COL = [0.95, 0.78, 0.20];
var BODY = [0, 0, 0];                       // scratch colour, reused every cell
var GROUPS = ["", "A", "B", "C", "D"];
var MODE_TAG = ["", "R", "G", "T"];
var NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
var QUANT_NAMES = ["Off", "1/16", "1/8", "1/4", "1/2", "1 Bar", "2 Bars", "4 Bars"];

var FADE_MS = 140;          // on/off glow ease
var RIPPLE_MS = 420;
var GUARD_MS = 260;
var TIMELINE_BEATS = 16;    // four bars of 4/4
var WAVE_N = 40;

// -------------------------------------------------------------------- state
var pads = [];
for (var i = 0; i < 128; i++) pads.push(newPad());

function newPad() {
    return {
        on: 0, pending: 0, group: 0, mode: 0, fix: 0, inrange: 1,
        name: "", col: null, wave: null, loopBeats: 0, loopMs: 0,
        startBeat: 0, startMs: 0, level: 0, levelFrom: 0, levelAt: -1e9,
        ripples: []
    };
}

var view = 36;
var tempo = 120;
var playing = 0;
var quant = 0;
var qk = 0, qn = 0, qAt = -1e9;             // sixteenths into the quantum, at time qAt
var songBeat = 0, songAt = -1e9, barBeats = 4;
var clockBase = 0, clockBaseMs = 0;         // free-running beat clock (follows tempo)
var hits = [];                              // {p, beat, vel, flag}
var spans = [];                             // {p, from, to (or -1)}
var animating = 0;
var fullscreen = 0;
var width = 0, height = 0;

function nowMs() { return Date.now(); }

function clock(t) { return clockBase + (t - clockBaseMs) * tempo / 60000; }

// --------------------------------------------------------- engine messages
function st(p, on, pending, group, mode, fix, inrange) {
    var d = pads[p | 0];
    if (!d) return;
    var t = nowMs();
    var wasOn = d.on;
    d.pending = pending | 0; d.group = group | 0; d.mode = mode | 0;
    d.fix = fix | 0; d.inrange = inrange | 0;
    if ((on | 0) !== wasOn) {
        d.levelFrom = currentLevel(d, t);
        d.levelAt = t;
        d.on = on | 0;
        if (d.on) {
            d.startBeat = clock(t);
            d.startMs = t;
            spans.push({ p: p | 0, from: clock(t), to: -1 });
        } else {
            for (var s = spans.length - 1; s >= 0; s--) {
                if (spans[s].p === (p | 0) && spans[s].to < 0) { spans[s].to = clock(t); break; }
            }
        }
    }
    changed();
}

function hit(p, vel, flag) {
    var d = pads[p | 0];
    if (!d) return;
    var t = nowMs();
    d.ripples.push({ t: t, vel: vel | 0, flag: flag | 0 });
    if (d.ripples.length > 4) d.ripples.shift();
    hits.push({ p: p | 0, beat: clock(t), vel: vel | 0, flag: flag | 0 });
    if (hits.length > 256) hits.shift();
    changed();
}

function setview(v) { view = v | 0; changed(); }

function settempo(bpm) {
    var t = nowMs();
    clockBase = clock(t); clockBaseMs = t;      // rebase so the clock never jumps
    tempo = bpm > 0 ? +bpm : 120;
}

function transport(s) { playing = s ? 1 : 0; changed(); }

function setquant(i) { quant = i | 0; changed(); }

// One message per 1/16 from the engine: where the song is and how far the
// current quantum has run.
function tick(beat, bb, k, n) {
    var t = nowMs();
    songBeat = +beat; songAt = t; barBeats = bb > 0 ? +bb : 4;
    qk = k | 0; qn = n | 0; qAt = t;
}

// ------------------------------------------------------- Live info messages
function pinfo(p, r, g, b, loopBeats, loopMs) {
    var d = pads[p | 0];
    if (!d) return;
    d.col = (r < 0) ? null : [r / 255, g / 255, b / 255];
    d.loopBeats = +loopBeats; d.loopMs = +loopMs;
    var a = Array.prototype.slice.call(arguments, 6);
    // "Funk 122 bpm" -> "Funk 122": the tempo is noise on a 50 px pad
    d.name = a.join(" ").replace(/\s*\d+(\.\d+)?\s*bpm$/i, "");
    changed();
}

function wave(p) {
    var d = pads[p | 0];
    if (!d) return;
    var a = Array.prototype.slice.call(arguments, 1);
    d.wave = a.length ? a.map(function (v) { return v / 99; }) : null;
    changed();
}

// Stage window: keep the canvas the size of its window.
function fitwin() {
    if (MODE !== "stage") return;
    var w = this.patcher.wind;
    if (!w) return;
    var sz = w.size;
    if (Math.abs(sz[0] - width) > 1 || Math.abs(sz[1] - height) > 1) box.message("size", sz[0], sz[1]);
}

// ----------------------------------------------------------- animation clock
function frame() {
    mgraphics.redraw();
    updateAnimating();
}

function changed() {
    mgraphics.redraw();
    updateAnimating();
}

function needsFrames(t) {
    for (var c = 0; c < 16; c++) {
        var d = pads[view + c];
        if (!d) continue;
        if (d.pending) return true;
        if (t - d.levelAt < FADE_MS) return true;
        if (d.on && (d.loopBeats > 0 || d.loopMs > 0)) return true;
        if (d.ripples.length && t - d.ripples[d.ripples.length - 1].t < RIPPLE_MS) return true;
    }
    if (MODE !== "grid") {
        if (playing) return true;
        var oldest = clock(t) - TIMELINE_BEATS;
        for (var s = 0; s < spans.length; s++) if (spans[s].to < 0 || spans[s].to > oldest) return true;
        for (var h = 0; h < hits.length; h++) if (hits[h].beat > oldest) return true;
    }
    return false;
}

function updateAnimating() {
    var want = needsFrames(nowMs()) ? 1 : 0;
    if (want !== animating) {
        animating = want;
        outlet(1, want);
    }
}

// -------------------------------------------------------------------- mouse
function onclick(x, y) {
    var r = gridRect();
    if (MODE === "stage" && x > width - 28 && y < 22) {      // fullscreen toggle
        fullscreen = 1 - fullscreen;
        outlet(2, "fullscreen", fullscreen);
        return;
    }
    if (MODE === "timeline") return;
    var cw = r[2] / 4, ch = r[3] / 4;
    if (x < r[0] || y < r[1] || x >= r[0] + r[2] || y >= r[1] + r[3]) return;
    var col = Math.floor((x - r[0]) / cw), row = Math.floor((y - r[1]) / ch);
    var cell = (3 - row) * 4 + col;                           // lowest note bottom-left
    outlet(0, "click", cell, 1);
}
onclick.local = 1;

function onresize(w, h) { mgraphics.redraw(); }
onresize.local = 1;

// ------------------------------------------------------------------- layout
function gridRect() {
    if (MODE === "stage") {
        var top = Math.round(26 * headerScale()), tl = Math.max(60, Math.round(height * 0.24));
        return [10, top, width - 20, height - top - tl - 16];
    }
    return [0, 0, width, height];
}

function timelineRect() {
    if (MODE === "stage") {
        var tl = Math.max(60, Math.round(height * 0.24));
        return [10, height - tl - 8, width - 20, tl];
    }
    return [0, 0, width, height];
}

// -------------------------------------------------------------------- paint
function paint() {
    var sz = mgraphics.size;
    width = sz[0]; height = sz[1];
    var t = nowMs();

    mgraphics.set_source_rgba(BG[0], BG[1], BG[2], BG[3]);
    mgraphics.rectangle(0, 0, width, height);
    mgraphics.fill();

    if (MODE === "grid") paintGrid(gridRect(), t, 1);
    else if (MODE === "timeline") paintTimeline(timelineRect(), t, 1);
    else {
        paintHeader(t);
        paintGrid(gridRect(), t, Math.max(1, Math.min(2.4, height / 300)));
        paintTimeline(timelineRect(), t, headerScale());
    }
}

function headerScale() { return Math.max(1, Math.min(2, height / 600)); }

function paintHeader(t) {
    var hs = headerScale();
    mgraphics.select_font_face("Ableton Sans Bold");
    mgraphics.set_font_size(13 * hs);
    rgba(NOGROUP_COL, 1);
    mgraphics.move_to(12, 17 * hs);
    mgraphics.show_text("PAD TOGGLE");
    mgraphics.select_font_face("Ableton Sans Medium");
    mgraphics.set_font_size(11 * hs);
    rgba(DIM, 1);
    var pos = playing ? barBeatText(t) : "stopped";
    mgraphics.move_to(110 * hs, 17 * hs);
    mgraphics.show_text("Quantise " + QUANT_NAMES[quant] + "    " + tempo.toFixed(1) + " BPM    " + pos);
    // fullscreen toggle, top right
    rgba(fullscreen ? NOGROUP_COL : DIM, 1);
    mgraphics.set_line_width(1.5);
    var x = width - 22, y = 6;
    mgraphics.rectangle(x, y, 14, 11);
    mgraphics.stroke();
}

function barBeatText(t) {
    var b = songBeat + (t - songAt) * tempo / 60000;
    var bar = Math.floor(b / barBeats) + 1;
    var beat = Math.floor(b - (bar - 1) * barBeats) + 1;
    return bar + "." + beat;
}

function paintGrid(r, t, scale) {
    var gap = 2 * scale;
    var cw = (r[2] - gap * 3) / 4, ch = (r[3] - gap * 3) / 4;
    for (var c = 0; c < 16; c++) {
        var p = view + c;
        var row = 3 - Math.floor(c / 4), col = c % 4;
        var x = r[0] + col * (cw + gap), y = r[1] + row * (ch + gap);
        if (p > 127) { cellEmpty(x, y, cw, ch, scale); continue; }
        paintCell(pads[p], p, x, y, cw, ch, t, scale);
    }
}

function cellEmpty(x, y, w, h, s) {
    mgraphics.set_source_rgba(0.11, 0.11, 0.13, 1);
    mgraphics.rectangle_rounded(x, y, w, h, 4 * s, 4 * s);
    mgraphics.fill();
}

function padColour(d) {
    if (d.col) return d.col;
    return d.group ? GROUP_COL[d.group] : NOGROUP_COL;
}

function currentLevel(d, t) {
    var k = Math.min(1, (t - d.levelAt) / FADE_MS);
    var e = k * (2 - k);                              // ease-out
    return d.levelFrom + ((d.on ? 1 : 0) - d.levelFrom) * e;
}

function loopPhase(d, t) {
    if (!d.on) return -1;
    if (d.loopBeats > 0) {
        var ph = (clock(t) - d.startBeat) / d.loopBeats;
        return ph - Math.floor(ph);
    }
    if (d.loopMs > 0) {
        var q = (t - d.startMs) / d.loopMs;
        return q - Math.floor(q);
    }
    return -1;
}

function quantProgress(t) {
    if (!qn) return 0;
    var sixteenthMs = 15000 / tempo;
    var k = qk + Math.min(1, (t - qAt) / sixteenthMs);
    return Math.max(0, Math.min(1, k / qn));
}

function paintCell(d, p, x, y, w, h, t, s) {
    var base = padColour(d);
    var lvl = currentLevel(d, t);
    var thru = !d.inrange || d.mode === 3;
    var rad = 4 * s;

    // body: a dark tint of the pad's colour when off, the colour itself when
    // on, eased between the two
    var k = thru ? 0 : lvl;
    for (var ci = 0; ci < 3; ci++) {
        var off = CELL_OFF[ci] + (base[ci] - CELL_OFF[ci]) * 0.22;
        BODY[ci] = off + (base[ci] * 0.92 - off) * k;
    }
    rgba(BODY, thru ? 0.55 : 1);
    mgraphics.rectangle_rounded(x, y, w, h, rad, rad);
    mgraphics.fill();

    // waveform silhouette
    if (d.wave) {
        var dark = k > 0.5;
        rgba(dark ? [0, 0, 0] : [1, 1, 1], dark ? 0.22 : 0.16);
        var wx = x + 3 * s, ww = w - 6 * s, mid = y + h * 0.58, amp = h * 0.26;
        var n = d.wave.length, bw = ww / n;
        for (var i = 0; i < n; i++) {
            var a = Math.max(0.04, d.wave[i]) * amp;
            mgraphics.rectangle(wx + i * bw, mid - a, Math.max(1, bw - 0.6), a * 2);
        }
        mgraphics.fill();
    }

    var ph = loopPhase(d, t);
    if (ph >= 0) {
        // playhead and the ring sweeping the pad's border once per loop
        rgba([1, 1, 1], 0.55);
        var px = x + 3 * s + (w - 6 * s) * ph;
        mgraphics.rectangle(px, y + 3 * s, 1 * s, h - 6 * s);
        mgraphics.fill();
        perimeter(x + 1 * s, y + 1 * s, w - 2 * s, h - 2 * s, ph);
        rgba([1, 1, 1], 0.95);
        mgraphics.set_line_width(2 * s);
        mgraphics.stroke();
    }

    if (d.pending) {
        // countdown to the boundary: a bar draining along the bottom, and a
        // border that pulses faster as the moment arrives
        var prog = quantProgress(t);
        var pulse = 0.45 + 0.45 * Math.abs(Math.sin(t / (90 + 160 * (1 - prog))));
        rgba(base, pulse);
        mgraphics.set_line_width(1.5 * s);
        mgraphics.rectangle_rounded(x + 0.75 * s, y + 0.75 * s, w - 1.5 * s, h - 1.5 * s, rad, rad);
        mgraphics.stroke();
        rgba(base, 0.95);
        mgraphics.rectangle(x + 3 * s, y + h - 4 * s, (w - 6 * s) * (1 - prog), 2 * s);
        mgraphics.fill();
    }

    // group tab
    if (d.group) {
        var gc = GROUP_COL[d.group];
        rgba(gc, 1);
        var tw = 10 * s, th = 10 * s;
        mgraphics.rectangle_rounded(x + w - tw - 2 * s, y + 2 * s, tw, th, 2 * s, 2 * s);
        mgraphics.fill();
        if (k > 0.3) {                               // keep the tab visible on a lit pad of its own colour
            rgba([0.06, 0.06, 0.07], 0.8);
            mgraphics.set_line_width(1 * s);
            mgraphics.rectangle_rounded(x + w - tw - 2 * s, y + 2 * s, tw, th, 2 * s, 2 * s);
            mgraphics.stroke();
        }
        rgba([0.06, 0.06, 0.07], 1);
        mgraphics.select_font_face("Ableton Sans Bold");
        mgraphics.set_font_size(7.5 * s);
        mgraphics.move_to(x + w - tw + 0.5 * s, y + 9.6 * s);
        mgraphics.show_text(GROUPS[d.group]);
    }

    // labels
    var light = k > 0.55 && !thru;
    var ink = light ? [0.06, 0.06, 0.07] : TEXT;
    mgraphics.select_font_face("Ableton Sans Medium");
    fontsz(8.5 * s);
    rgba(ink, thru ? 0.6 : 1);
    var label = d.name || noteName(p);
    var maxw = w - (d.group ? 15 : 6) * s;
    var lines = wrap2(label, maxw, w - 6 * s);
    mgraphics.move_to(x + 3 * s, y + 10 * s);
    mgraphics.show_text(lines[0]);
    if (lines[1] && h > 28 * s) {
        mgraphics.move_to(x + 3 * s, y + 19 * s);
        mgraphics.show_text(lines[1]);
    }

    var tags = noteName(p);
    if (thru) tags += " thru";
    else {
        if (MODE_TAG[d.mode]) tags += " " + MODE_TAG[d.mode];
        if (d.fix) tags += " v";
    }
    mgraphics.set_font_size(7 * s);
    rgba(light ? [0.06, 0.06, 0.07] : DIM, 1);
    mgraphics.move_to(x + 3 * s, y + h - 4 * s);
    if (d.name) mgraphics.show_text(tags);
    else if (tags !== noteName(p)) mgraphics.show_text(tags.slice(noteName(p).length + 1));

    // ripples: one per hit, size by velocity; a swallowed (guarded) hit
    // flickers red so the hit guard can be tuned by eye
    for (var j = 0; j < d.ripples.length; j++) {
        var rp = d.ripples[j];
        var life = rp.flag === 1 ? GUARD_MS : RIPPLE_MS;
        var age = (t - rp.t) / life;
        if (age >= 1) continue;
        var rr = (4 + rp.vel / 127 * Math.min(w, h) * 0.55) * (0.3 + 0.7 * age);
        rgba(rp.flag === 1 ? GUARD_RED : [1, 1, 1], (1 - age) * (rp.flag === 1 ? 0.9 : 0.6));
        mgraphics.set_line_width((rp.flag === 1 ? 2 : 1.5) * s);
        mgraphics.arc(x + w / 2, y + h / 2, rr, 0, Math.PI * 2);
        mgraphics.stroke();
    }
    // prune old ripples (no allocation while drawing otherwise)
    while (d.ripples.length && t - d.ripples[0].t > RIPPLE_MS) d.ripples.shift();
}

// Path tracing the rectangle's border clockwise from the top-left corner,
// `f` (0..1) of the way round.
function perimeter(x, y, w, h, f) {
    var total = 2 * (w + h), left = f * total;
    mgraphics.move_to(x, y);
    var seg = [[w, 0], [0, h], [-w, 0], [0, -h]];
    var cx = x, cy = y;
    for (var i = 0; i < 4 && left > 0; i++) {
        var len = Math.abs(seg[i][0] + seg[i][1]);
        var u = Math.min(1, left / len);
        cx += seg[i][0] * u; cy += seg[i][1] * u;
        mgraphics.line_to(cx, cy);
        left -= len;
    }
}

function paintTimeline(r, t, s) {
    var now = clock(t);
    var lanes = 16, laneH = r[3] / lanes;
    var labelW = MODE === "stage" ? Math.round(30 * s) : 0;
    var x0 = r[0] + labelW, w = r[2] - labelW;
    var pxPerBeat = w / TIMELINE_BEATS;
    function xAt(beat) { return x0 + w - (now - beat) * pxPerBeat; }

    mgraphics.set_source_rgba(0.10, 0.10, 0.12, 1);
    mgraphics.rectangle(r[0], r[1], r[2], r[3]);
    mgraphics.fill();

    // beat and bar lines, from the song position while the transport runs
    if (playing && songAt > 0) {
        var songNow = songBeat + (t - songAt) * tempo / 60000;
        var first = Math.ceil(songNow - TIMELINE_BEATS);
        for (var b = first; b <= songNow; b++) {
            var bx = x0 + w - (songNow - b) * pxPerBeat;
            var isBar = Math.abs((b / barBeats) - Math.round(b / barBeats)) < 1e-6;
            mgraphics.set_source_rgba(1, 1, 1, isBar ? 0.16 : 0.05);
            mgraphics.rectangle(bx, r[1], isBar ? 1 : 0.6, r[3]);
            mgraphics.fill();
        }
    }

    // spans: a loop playing on this lane
    var oldest = now - TIMELINE_BEATS;
    for (var i = 0; i < spans.length; i++) {
        var sp = spans[i];
        var lane = sp.p - view;
        if (lane < 0 || lane >= lanes) continue;
        var to = sp.to < 0 ? now : sp.to;
        if (to < oldest) continue;
        var ly = r[1] + (lanes - 1 - lane) * laneH;
        var xa = Math.max(x0, xAt(sp.from)), xb = xAt(to);
        rgba(padColour(pads[sp.p]), 0.55);
        mgraphics.rectangle(xa, ly + laneH * 0.22, Math.max(1, xb - xa), laneH * 0.56);
        mgraphics.fill();
    }
    // prune spans and hits that have scrolled off
    while (spans.length && spans[0].to >= 0 && spans[0].to < oldest) spans.shift();
    while (hits.length && hits[0].beat < oldest) hits.shift();

    // hits: ticks, height by velocity; swallowed hits in red
    for (var h = 0; h < hits.length; h++) {
        var e = hits[h];
        var ln = e.p - view;
        if (ln < 0 || ln >= lanes) continue;
        var hy = r[1] + (lanes - 1 - ln) * laneH;
        var hh = laneH * (0.3 + 0.7 * e.vel / 127);
        rgba(e.flag === 1 ? GUARD_RED : (e.flag === 2 ? DIM : TEXT), e.flag === 1 ? 1 : 0.9);
        mgraphics.rectangle(xAt(e.beat) - 0.75, hy + (laneH - hh) / 2, 1.5, hh);
        mgraphics.fill();
    }

    if (labelW) {
        mgraphics.select_font_face("Ableton Sans Medium");
        mgraphics.set_font_size(Math.min(9 * s, laneH * 0.8));
        for (var l = 0; l < lanes; l++) {
            var pp = view + l;
            if (pp > 127) continue;
            rgba(DIM, 1);
            mgraphics.move_to(r[0] + 2, r[1] + (lanes - 1 - l) * laneH + laneH * 0.78);
            mgraphics.show_text(noteName(pp));
        }
    }
    // "now" edge
    rgba(NOGROUP_COL, 0.6);
    mgraphics.rectangle(x0 + w - 1, r[1], 1, r[3]);
    mgraphics.fill();
}

// ------------------------------------------------------------------ helpers
function rgba(c, a) { mgraphics.set_source_rgba(c[0], c[1], c[2], a); }

function noteName(p) { return NOTE_NAMES[p % 12] + (Math.floor(p / 12) - 2); }

// Measuring text is the most expensive call in a frame, so fitted labels are
// cached by text, width and font size.
var fitCache = {};
function fit(s, maxw) {
    var key = s + "|" + Math.round(maxw) + "|" + fontSize;
    var hitc = fitCache[key];
    if (hitc !== undefined) return hitc;
    var out = s;
    if (mgraphics.text_measure(s)[0] > maxw) {
        while (out.length > 1 && mgraphics.text_measure(out + "…")[0] > maxw) out = out.slice(0, -1);
        out += "…";
    }
    fitCache[key] = out;
    return out;
}

// Up to two lines: as many words as fit on the first (which is shortened by
// the group tab), the rest on the second, cut with an ellipsis if need be.
var wrapCache = {};
function wrap2(s, w1, w2) {
    var key = s + "|" + Math.round(w1) + "|" + Math.round(w2) + "|" + fontSize;
    var hitc = wrapCache[key];
    if (hitc !== undefined) return hitc;
    var out;
    if (mgraphics.text_measure(s)[0] <= w1) out = [s, ""];
    else {
        var words = s.split(" "), first = words[0], i = 1;
        while (i < words.length && mgraphics.text_measure(first + " " + words[i])[0] <= w1) first += " " + words[i++];
        if (mgraphics.text_measure(first)[0] > w1) out = [fit(first, w1), fit(words.slice(1).join(" "), w2)];
        else out = [first, fit(words.slice(i).join(" "), w2)];
    }
    wrapCache[key] = out;
    return out;
}

var fontSize = 0;
function fontsz(sz) { fontSize = sz; mgraphics.set_font_size(sz); }
