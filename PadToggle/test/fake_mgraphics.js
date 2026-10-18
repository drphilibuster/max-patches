// A recording stand-in for Max's mgraphics, enough of it for ptcanvas.js.
// It counts calls (so tests can watch cost) and renders what was drawn to
// SVG (so the design can be previewed without Live).
"use strict";

function fmt(n) { return Math.round(n * 100) / 100; }

function make(w, h) {
    const g = {
        size: [w, h],
        relative_coords: 0,
        autofill: 0,
        calls: 0,
        redraws: 0,
        texts: [],
        _src: [0, 0, 0, 1],
        _lw: 1,
        _font: "Arial",
        _fs: 10,
        _path: "",
        _pt: [0, 0],
        _svg: [],
    };
    const c = () => { g.calls++; };
    g.init = () => {};
    g.redraw = () => { g.redraws++; };
    g.set_source_rgba = (r, gg, b, a) => {
        c();
        if (Array.isArray(r)) [r, gg, b, a] = r;
        g._src = [r, gg, b, a === undefined ? 1 : a];
    };
    g.set_line_width = (v) => { c(); g._lw = v; };
    g.select_font_face = (f) => { c(); g._font = f; };
    g.set_font_size = (s) => { c(); g._fs = s; };
    g.move_to = (x, y) => { c(); g._path += `M${fmt(x)} ${fmt(y)} `; g._pt = [x, y]; };
    g.line_to = (x, y) => { c(); g._path += `L${fmt(x)} ${fmt(y)} `; g._pt = [x, y]; };
    g.close_path = () => { c(); g._path += "Z "; };
    g.rectangle = (x, y, w2, h2) => {
        c();
        g._path += `M${fmt(x)} ${fmt(y)} h${fmt(w2)} v${fmt(h2)} h${fmt(-w2)} Z `;
    };
    g.rectangle_rounded = (x, y, w2, h2, rx, ry) => {
        c();
        rx = Math.min(rx, w2 / 2); ry = Math.min(ry, h2 / 2);
        g._path += `M${fmt(x + rx)} ${fmt(y)} H${fmt(x + w2 - rx)} A${fmt(rx)} ${fmt(ry)} 0 0 1 ${fmt(x + w2)} ${fmt(y + ry)} ` +
            `V${fmt(y + h2 - ry)} A${fmt(rx)} ${fmt(ry)} 0 0 1 ${fmt(x + w2 - rx)} ${fmt(y + h2)} ` +
            `H${fmt(x + rx)} A${fmt(rx)} ${fmt(ry)} 0 0 1 ${fmt(x)} ${fmt(y + h2 - ry)} ` +
            `V${fmt(y + ry)} A${fmt(rx)} ${fmt(ry)} 0 0 1 ${fmt(x + rx)} ${fmt(y)} Z `;
    };
    g.arc = (cx, cy, r, a0, a1) => {
        c();
        const full = Math.abs(a1 - a0) >= Math.PI * 2 - 1e-6;
        if (full) {
            g._path += `M${fmt(cx + r)} ${fmt(cy)} A${fmt(r)} ${fmt(r)} 0 1 1 ${fmt(cx - r)} ${fmt(cy)} ` +
                `A${fmt(r)} ${fmt(r)} 0 1 1 ${fmt(cx + r)} ${fmt(cy)} `;
        } else {
            const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
            const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
            const large = (a1 - a0) > Math.PI ? 1 : 0;
            g._path += `M${fmt(x0)} ${fmt(y0)} A${fmt(r)} ${fmt(r)} 0 ${large} 1 ${fmt(x1)} ${fmt(y1)} `;
        }
    };
    const col = () => `rgba(${Math.round(g._src[0] * 255)},${Math.round(g._src[1] * 255)},${Math.round(g._src[2] * 255)},${fmt(g._src[3])})`;
    g.fill = () => { c(); if (g._path) g._svg.push(`<path d="${g._path}" fill="${col()}"/>`); g._path = ""; };
    g.fill_preserve = () => { c(); if (g._path) g._svg.push(`<path d="${g._path}" fill="${col()}"/>`); };
    g.stroke = () => {
        c();
        if (g._path) g._svg.push(`<path d="${g._path}" fill="none" stroke="${col()}" stroke-width="${fmt(g._lw)}" stroke-linejoin="round"/>`);
        g._path = "";
    };
    g.show_text = (s) => {
        c();
        g.texts.push(s);
        const esc = String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
        const bold = /Bold/.test(g._font) ? ' font-weight="700"' : "";
        g._svg.push(`<text x="${fmt(g._pt[0])}" y="${fmt(g._pt[1])}" font-family="Helvetica, Arial" font-size="${fmt(g._fs)}"${bold} fill="${col()}">${esc}</text>`);
    };
    g.text_measure = (s) => { c(); return [String(s).length * g._fs * 0.56, g._fs]; };
    g.svg = (scale = 1) => {
        const [W, H] = g.size;
        return `<svg xmlns="http://www.w3.org/2000/svg" width="${W * scale}" height="${H * scale}" viewBox="0 0 ${W} ${H}">` +
            g._svg.join("") + "</svg>";
    };
    g.clear = () => { g._svg = []; g.texts = []; g.calls = 0; };
    return g;
}

module.exports = { make };
