#!/usr/bin/env python3
"""Build "PT Probe", a test-only MIDI effect that logs what Pad Toggle sends.

Placed between Pad Toggle and the Drum Rack it passes everything through
unchanged and appends each message, with the song position in ticks
(480 PPQ) and wall-clock ms, to a JSON file the test harness reads. The
Ableton MCP has no track-routing or MIDI-capture call, so this is how the
device's real output inside Live is observed.

Usage: build_probe.py LOGFILE [--install]
"""
from __future__ import annotations
import argparse, pathlib, shutil, sys

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import amxd
from maxpat import Patcher
import build_device

CODE = r"""
inlets = 1;
outlets = 1;
var LOG = "%LOG%";
var events = [];
var ticks = 0, seq = 0, cur = [], need = 0;

function rawticks(t) { ticks = t; }

function midi(b) {
    outlet(0, b);                                   // pass through first
    if (b >= 0xF8) return;
    if (b >= 0x80) { cur = [b]; var h = b & 0xF0; need = (h === 0xC0 || h === 0xD0) ? 2 : 3; return; }
    if (!cur.length) return;
    cur.push(b);
    if (cur.length < need) return;
    seq++;
    events.push([seq, ticks, Date.now()].concat(cur));
    cur = [cur[0]];                                 // running status
    write();
}

function clear() { events = []; write(); }

function write() {
    var d = new Dict();
    d.set("events", JSON.stringify(events));
    d.export_json(LOG);
}
"""


def build(log, out):
    p = Patcher(width=900, height=500, description="Pad Toggle test probe",
                digest="PT Probe", tags="test")
    code = CODE.replace("%LOG%", str(log))
    v8 = p._add({"maxclass": "v8.codebox", "code": code, "filename": "none",
                 "fontface": 0, "fontname": "Menlo", "fontsize": 10.0,
                 "numinlets": 1, "numoutlets": 1, "outlettype": [""],
                 "patching_rect": [20.0, 160.0, 420.0, 240.0],
                 "saved_object_attributes": {"parameter_enable": 0}})
    midiin = p.obj("midiin", 20, 20)
    trig = p.obj("t i b", 20, 50, w=50, outlets=2, outlettype=["int", "bang"])
    tport = p.obj("transport", 120, 80, w=70, inlets=2, outlets=9,
                  outlettype=["int", "int", "float", "float", "float", "", "int", "float", ""])
    pre_t = p.obj("prepend rawticks", 120, 110, w=110)
    pre_m = p.obj("prepend midi", 20, 120, w=80)
    midiout = p.obj("midiout", 20, 420)
    lb = p.obj("live.thisdevice", 300, 20, w=90, outlets=3, outlettype=["bang", "int", "int"])
    clr = p.message("clear", 300, 50, w=40)
    p.chain(midiin, trig)
    p.connect(trig, 1, tport, 0)
    p.connect(tport, 7, pre_t, 0)
    p.connect(pre_t, 0, v8, 0)
    p.connect(trig, 0, pre_m, 0)
    p.connect(pre_m, 0, v8, 0)
    p.connect(v8, 0, midiout, 0)
    p.connect(lb, 0, clr, 0)
    p.connect(clr, 0, v8, 0)
    p.panel(0, 0, 10, 10, bgcolor=[0.3, 0.1, 0.1, 1.0], presentation_rect=[0, 0, 90, 169])
    p.comment("PT PROBE\n(test only)", 0, 300, w=80, fontsize=10.0,
              presentation_rect=[6, 6, 80, 40])
    d = p.to_dict()
    d["patcher"]["appversion"] = {"major": 9, "minor": 1, "revision": 0,
                                  "architecture": "x64", "modernui": 1}
    amxd.write(d, out, build_device.TEMPLATE, device_type="midi_effect")
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("log")
    ap.add_argument("--install", action="store_true")
    a = ap.parse_args()
    out = build(pathlib.Path(a.log).resolve(), build_device.ROOT / "build" / "PT Probe.amxd")
    print(out, amxd.verify(out))
    if a.install:
        shutil.copy2(out, build_device.LIVE_MIDI_FX / out.name)
        print("installed", build_device.LIVE_MIDI_FX / out.name)
