#!/usr/bin/env python3
"""Generate the Pad Toggle Max for Live MIDI effect.

The device is generated rather than hand-patched so its wiring and layout are
reviewable and reproducible. The toggle engine (device/padtoggle.js) is
embedded in a [v8.codebox], so the .amxd is self-contained: there is no
external .js to install or lose.

The container is cloned from Live's own blank "Max MIDI Effect.amxd".

Usage: build_device.py [--install]
"""
from __future__ import annotations
import argparse, json, pathlib, shutil, sys

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import amxd
from maxpat import Patcher

ROOT = HERE.parent
ENGINE = ROOT / "device" / "padtoggle.js"
CANVAS = ROOT / "device" / "ptcanvas.js"
LIVEINFO = ROOT / "device" / "ptliveinfo.js"
OUT = ROOT / "build" / "Pad Toggle.amxd"
TEMPLATE = pathlib.Path(
    "/Applications/Ableton Live 12 Suite.app/Contents/App-Resources/Misc/"
    "Max Devices/Max MIDI Effect.amxd")
LIVE_MIDI_FX = pathlib.Path.home() / (
    "Music/Ableton/User Library/Presets/MIDI Effects/Max MIDI Effect")

DEVICE_H = 169          # Live's device strip height
DEVICE_W = 692
GRID_RECT = [6, 22, 206, 142]
TIMELINE_RECT = [516, 22, 170, 142]
STAGE_SIZE = [960, 620]
FONT = "Ableton Sans Medium"
TEXT = [0.85, 0.85, 0.87, 1.0]
DIM = [0.55, 0.56, 0.60, 1.0]
LCD = [0.95, 0.78, 0.20, 1.0]
CELL_OFF = [0.20, 0.20, 0.23, 1.0]
CELL_ON = [0.95, 0.78, 0.20, 1.0]

NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
def note_name(p): return f"{NOTE_NAMES[p % 12]}{p // 12 - 2}"

# Menus. Order matters: the engine indexes these lists.
QUANT = ["Off", "1/16", "1/8", "1/4", "1/2", "1 Bar", "2 Bars", "4 Bars"]
GROUPS = ["-", "A", "B", "C", "D"]
MODES = ["Toggle", "Retrig", "Gate", "Thru"]
VIEWS = [f"{note_name(r * 4)}-{note_name(r * 4 + 15)}" if r * 4 + 15 <= 127
         else f"{note_name(r * 4)}-G8" for r in range(29)]
DEFAULT_VIEW = 9        # C1-D#2: Drum Rack's default 16 pads

# Push / bank layout: 8 parameters per bank, by long name.
BANKS = [
    ("Main", ["Quantise", "Hit Guard", "Vel Mode", "Global Vel",
              "On Play", "View", "Follow", "Panic"]),
    ("Pad", ["Pad", "Pad Group", "Pad Mode", "Pad Fix Vel",
             "Pad Vel", "Low", "High", "-"]),
]



class Device:
    def __init__(self):
        self.p = Patcher(width=1400, height=900,
                         description="Toggle loops in a Drum Rack from any pad: "
                                     "Note Offs ignored, mono groups, launch quantise.",
                         digest="Pad Toggle", tags="drum rack toggle loop e-drum")
        self.params = {}            # obj id -> (longname, shortname)
        self.patch_y = 400          # patching-view cursor for UI objects

    # ------------------------------------------------------------ UI helpers
    def _pres(self, spec, rect):
        spec["presentation"] = 1
        spec["presentation_rect"] = [float(v) for v in rect]

    def _param(self, o, longname, shortname, valueof):
        v = {"parameter_longname": longname, "parameter_shortname": shortname,
             "parameter_linknames": 1}
        v.update(valueof)
        o.spec["parameter_enable"] = 1
        o.spec["varname"] = longname
        o.spec["saved_attribute_attributes"] = {"valueof": v}
        self.params[o.id] = (longname, shortname)

    def _ui(self, maxclass, outlets, outlettype, rect, w, h, **extra):
        o = self.p.obj(maxclass, 1000, self.patch_y, w=w, outlets=outlets,
                       outlettype=outlettype)
        self.patch_y += h + 10
        o.spec.pop("text", None)
        o.spec["maxclass"] = maxclass
        o.spec["patching_rect"] = [1000.0, float(self.patch_y), float(w), float(h)]
        self._pres(o.spec, rect)
        o.spec.update(extra)
        return o

    def menu(self, longname, shortname, items, rect, initial=0, invisible=0):
        o = self._ui("live.menu", 3, ["", "", "float"], rect, rect[2], rect[3])
        self._param(o, longname, shortname, {
            "parameter_type": 2, "parameter_enum": list(items),
            "parameter_mmax": len(items) - 1,
            "parameter_initial": [initial], "parameter_initial_enable": 1,
            "parameter_invisible": invisible, "parameter_unitstyle": 9})
        return o

    def tab(self, longname, shortname, items, rect, initial=0):
        o = self._ui("live.tab", 3, ["", "", "float"], rect, rect[2], rect[3],
                     num_lines_presentation=1, num_lines_patching=1)
        self._param(o, longname, shortname, {
            "parameter_type": 2, "parameter_enum": list(items),
            "parameter_mmax": len(items) - 1,
            "parameter_initial": [initial], "parameter_initial_enable": 1,
            "parameter_unitstyle": 9})
        return o

    def numbox(self, longname, shortname, rect, lo, hi, initial, unitstyle=0,
               ptype=1, units=""):
        o = self._ui("live.numbox", 2, ["", "float"], rect, rect[2], rect[3])
        v = {"parameter_type": ptype, "parameter_mmin": float(lo),
             "parameter_mmax": float(hi), "parameter_initial": [initial],
             "parameter_initial_enable": 1, "parameter_unitstyle": unitstyle}
        if units:
            v["parameter_units"] = units
        self._param(o, longname, shortname, v)
        return o

    def toggle(self, longname, shortname, rect, text, texton=None, initial=0,
               enum=("Off", "On")):
        o = self._ui("live.text", 2, ["", ""], rect, rect[2], rect[3],
                     mode=1, text=text, texton=texton or text)
        self._param(o, longname, shortname, {
            "parameter_type": 2, "parameter_enum": list(enum),
            "parameter_mmax": 1, "parameter_initial": [initial],
            "parameter_initial_enable": 1})
        return o

    def button(self, text, rect, longname=None, shortname=None):
        o = self._ui("live.text", 2, ["", ""], rect, rect[2], rect[3],
                     mode=0, text=text, texton=text)
        if longname:
            self._param(o, longname, shortname or longname, {
                "parameter_type": 2, "parameter_enum": ["off", "on"],
                "parameter_mmax": 1})
        else:
            o.spec["parameter_enable"] = 0
        return o

    def label(self, text, rect, color=DIM, size=9.0, justify=0):
        o = self.p.comment(text, 1200, self.patch_y, w=rect[2], fontsize=size,
                           color=color, presentation_rect=rect,
                           textjustification=justify)
        o.spec["fontname"] = FONT
        self.patch_y += 24
        return o

    def v8ui(self, patcher, mode, x, y, w, h, pres_rect=None):
        """A v8ui running ptcanvas.js embedded, in the given view mode."""
        spec = {
            "maxclass": "v8ui", "numinlets": 1, "numoutlets": 3,
            "outlettype": ["", "", ""], "border": 0, "embed": 1,
            "filename": "none", "jsarguments": [mode], "parameter_enable": 0,
            "patching_rect": [float(x), float(y), float(w), float(h)],
            "textfile": {"text": CANVAS.read_text(), "filename": "none",
                         "flags": 0, "embed": 1, "autowatch": 1},
            "varname": f"canvas_{mode}",
        }
        o = patcher._add(spec)
        if pres_rect:
            self._pres(o.spec, pres_rect)
        # Its own frame clock, switched on and off by the canvas (outlet 1)
        # so an idle view costs nothing.
        clk = patcher.obj("qmetro 33", x, y + h + 30, w=70, inlets=2, outlets=1,
                          outlettype=["bang"])
        frm = patcher.message("frame", x, y + h + 60, w=44)
        patcher.connect(o, 1, clk, 0)
        patcher.connect(clk, 0, frm, 0)
        patcher.connect(frm, 0, o, 0)
        return o

    def stage(self, x, y):
        """[p stage]: a window holding a big canvas that follows its size."""
        sp = Patcher(width=STAGE_SIZE[0], height=STAGE_SIZE[1], presentation=False)
        inl = sp._add({"maxclass": "inlet", "numinlets": 0, "numoutlets": 1,
                       "outlettype": [""], "index": 1, "comment": "",
                       "patching_rect": [20.0, 700.0, 30.0, 30.0]})
        outl = sp._add({"maxclass": "outlet", "numinlets": 1, "numoutlets": 0,
                        "index": 1, "comment": "",
                        "patching_rect": [20.0, 820.0, 30.0, 30.0]})
        cv = self.v8ui(sp, "stage", 0, 0, STAGE_SIZE[0], STAGE_SIZE[1])
        tp = sp.obj("thispatcher", 200, 760, w=80, outlets=2, outlettype=["", ""])
        lb = sp.obj("loadbang", 300, 700, w=60, inlets=1, outlets=1, outlettype=["bang"])
        one = sp.message("1", 300, 730, w=24)
        fitclk = sp.obj("qmetro 500", 300, 760, w=70, inlets=2, outlets=1, outlettype=["bang"])
        fit = sp.message("fitwin", 300, 790, w=44)
        sp.connect(inl, 0, cv, 0)
        sp.connect(cv, 0, outl, 0)
        sp.connect(cv, 2, tp, 0)
        sp.chain(lb, one, fitclk, fit)
        sp.connect(fit, 0, cv, 0)
        # Everything but the canvas is plumbing: hide it so nothing draws over
        # the canvas when the window is locked, and keep the canvas last so it
        # stacks on top in an unlocked window too.
        for o in sp.objects:
            if o is not cv:
                o.spec["hidden"] = 1
        sp.objects.remove(cv)
        sp.objects.append(cv)
        sub = sp.to_dict()["patcher"]
        sub.update({"rect": [120.0, 120.0, float(STAGE_SIZE[0]), float(STAGE_SIZE[1])],
                    "toolbarvisible": 0, "statusbarvisible": 0, "bglocked": 0,
                    "openinpresentation": 0, "title": "Pad Toggle — Stage",
                    "bgcolor": [0.075, 0.075, 0.09, 1.0],
                    "editing_bgcolor": [0.075, 0.075, 0.09, 1.0],
                    "enablehscroll": 0, "enablevscroll": 0})
        sub["appversion"] = {"major": 9, "minor": 1, "revision": 0,
                             "architecture": "x64", "modernui": 1}
        box = self.p._add({"maxclass": "newobj", "text": "p stage",
                           "numinlets": 1, "numoutlets": 1, "outlettype": [""],
                           "patching_rect": [float(x), float(y), 60.0, 22.0],
                           "patcher": sub, "varname": "stage"})
        return box

    # ------------------------------------------------------------- the device
    def build(self, selftest=False, selftest_file="/tmp/padtoggle_liveinfo.json"):
        p = self.p

        # ------------------------------------------------- engine and MIDI I/O
        code = ENGINE.read_text()
        engine = p._add({
            "maxclass": "v8.codebox", "code": code, "filename": "none",
            "fontface": 0, "fontname": "Menlo", "fontsize": 10.0,
            "numinlets": 1, "numoutlets": 2, "outlettype": ["", ""],
            "patching_rect": [20.0, 120.0, 520.0, 240.0],
            "saved_object_attributes": {"parameter_enable": 1},
            "saved_attribute_attributes": {"valueof": {
                "parameter_longname": "Pad State", "parameter_shortname": "Pad State",
                "parameter_type": 3, "parameter_invisible": 1,
                "parameter_linknames": 1}},
            "varname": "Pad State",
        })
        self.params[engine.id] = ("Pad State", "Pad State")
        self.engine = engine

        midiin = p.obj("midiin", 20, 20)
        pre_midi = p.obj("prepend midi", 20, 60, w=80)
        p.chain(midiin, pre_midi)
        p.connect(pre_midi, 0, engine, 0)

        # Lists from the engine are split into bytes for midiout. zl's default
        # 256-element limit would truncate a long sysex passing through.
        iter_ = p.obj("zl.iter 1 @zlmaxsize 32767", 20, 380, w=170,
                      inlets=2, outlets=2, outlettype=["", ""])
        midiout = p.obj("midiout", 20, 420)
        p.connect(engine, 0, iter_, 0)
        p.connect(iter_, 0, midiout, 0)

        def to_engine(src, selector, x, y, outlet=0):
            pre = p.obj(f"prepend {selector}", x, y, w=8 * (9 + len(selector)))
            p.connect(src, outlet, pre, 0)
            p.connect(pre, 0, engine, 0)
            return pre

        # -------------------------------------- load / transport state / clock
        thisdev = p.obj("live.thisdevice", 600, 20, w=90, outlets=3,
                        outlettype=["bang", "int", "int"])
        trig = p.obj("t b b b", 600, 50, w=60, outlets=3, outlettype=["bang"] * 3)
        loaded = p.message("loaded", 600, 230, w=50)
        prop = p.message("property is_playing", 720, 80, w=120)
        path = p.obj("live.path live_set", 660, 110, w=110, outlets=3,
                     outlettype=["", "", ""])
        obs = p.obj("live.observer", 660, 150, w=90, inlets=2, outlets=2,
                    outlettype=["", ""])
        obs.spec["saved_object_attributes"] = {"_persistence": 1}
        p.connect(thisdev, 0, trig, 0)
        p.connect(trig, 2, prop, 0)
        p.connect(prop, 0, obs, 0)
        p.connect(trig, 1, path, 0)
        p.connect(path, 0, obs, 1)
        p.connect(trig, 0, loaded, 0)
        p.connect(loaded, 0, engine, 0)
        to_engine(obs, "transport", 660, 190)

        # A transport-locked 1/16 metro; [transport] reports where it landed.
        # transport fires right to left, so tsig/units/beats are all stored by
        # the time `bars` (outlet 0) triggers the boundary check.
        metro = p.obj("metro 16n @quantize 16n @active 1", 900, 20, w=200)
        tport = p.obj("transport", 900, 60, w=70, inlets=2, outlets=9,
                      outlettype=["int", "int", "float", "float", "float", "",
                                  "int", "float", ""])
        p.connect(metro, 0, tport, 0)
        to_engine(tport, "tsig", 1120, 100, outlet=5)
        to_engine(tport, "units", 1040, 130, outlet=2)
        to_engine(tport, "beats", 970, 160, outlet=1)
        to_engine(tport, "bars", 900, 190, outlet=0)

        # Tempo, from Live: the canvases' ring speed and the Live-info loop
        # maths follow it even while the transport is stopped.
        tprop = p.message("property tempo", 840, 80, w=100)
        tobs = p.obj("live.observer", 780, 150, w=90, inlets=2, outlets=2,
                     outlettype=["", ""])
        tobs.spec["saved_object_attributes"] = {"_persistence": 1}
        p.connect(trig, 2, tprop, 0)
        p.connect(tprop, 0, tobs, 0)
        p.connect(path, 0, tobs, 1)
        to_engine(tobs, "tempo", 780, 190)

        # Live info: pad names, colours, loop lengths and waveforms.
        liveinfo = p._add({
            "maxclass": "v8.codebox", "code": LIVEINFO.read_text(), "filename": "none",
            "fontface": 0, "fontname": "Menlo", "fontsize": 10.0,
            "numinlets": 1, "numoutlets": 2, "outlettype": ["", ""],
            "patching_rect": [600.0, 600.0, 420.0, 200.0],
            "saved_object_attributes": {"parameter_enable": 0},
            "varname": "liveinfo",
        })
        self.liveinfo = liveinfo

        def to_info(src, selector, x, y, outlet=0):
            pre = p.obj(f"prepend {selector}", x, y, w=8 * (9 + len(selector)))
            p.connect(src, outlet, pre, 0)
            p.connect(pre, 0, liveinfo, 0)
            return pre

        # "---" is made unique per device instance by Max for Live, in object
        # and message boxes alike; the message box is how the JS learns the
        # buffer's real name.
        itrig = p.obj("t b b", 1040, 520, w=40, outlets=2, outlettype=["bang", "bang"])
        bufmsg = p.message("setbufname ---ptwave", 1100, 550, w=140)
        initmsg = p.message("init", 1040, 580, w=34)
        p.connect(thisdev, 0, itrig, 0)
        p.connect(itrig, 1, bufmsg, 0)
        p.connect(itrig, 0, initmsg, 0)
        p.connect(bufmsg, 0, liveinfo, 0)
        p.connect(initmsg, 0, liveinfo, 0)
        pollclk = p.obj("qmetro 2000 @active 1", 1260, 520, w=140, inlets=2, outlets=1,
                        outlettype=["bang"])
        pollmsg = p.message("poll", 1260, 550, w=34)
        p.chain(pollclk, pollmsg)
        p.connect(pollmsg, 0, liveinfo, 0)
        to_info(tobs, "settempo", 900, 190)
        buf = p.obj("buffer~ ---ptwave", 600, 820, w=120, inlets=1, outlets=2,
                    outlettype=["float", "bang"])
        loadedmsg = p.message("bufloaded", 740, 850, w=60)
        p.connect(liveinfo, 1, buf, 0)
        p.connect(buf, 1, loadedmsg, 0)
        p.connect(loadedmsg, 0, liveinfo, 0)

        if selftest:
            dl = p.obj("delay 2500", 1100, 470, w=70, inlets=2, outlets=1, outlettype=["bang"])
            vb = p.message("dumpfile " + str(selftest_file), 1100, 500, w=200)
            p.connect(thisdev, 0, dl, 0)
            p.connect(dl, 0, vb, 0)
            p.connect(vb, 0, liveinfo, 0)
            st = p.message("dump", 760, 230, w=40)
            p.connect(thisdev, 0, st, 0)
            p.connect(st, 0, engine, 0)

        # ---------------------------------------------------------------- UI
        # editor/monitor go to the panel; everything else is canvas state.
        ui_route_keys = ["editor", "monitor"]
        uiroute = p.obj("route " + " ".join(ui_route_keys), 20, 460, w=140,
                        outlets=len(ui_route_keys) + 1,
                        outlettype=[""] * (len(ui_route_keys) + 1))
        p.connect(engine, 1, uiroute, 0)

        # Background and title.
        p.panel(0, 0, 10, 10, bgcolor=[0.13, 0.13, 0.15, 1.0],
                presentation_rect=[0, 0, DEVICE_W, DEVICE_H])
        self.label("PAD TOGGLE", [6, 2, 90, 18], color=LCD, size=10.0)

        # View selector above the grid.
        view = self.menu("View", "View", VIEWS, [118, 3, 94, 15], initial=DEFAULT_VIEW)
        to_engine(view, "setview", 1250, 20)
        to_info(view, "setview", 1250, 50)

        # The canvases: grid, timeline, and the stage window.
        grid = self.v8ui(p, "grid", 20, 1000, *GRID_RECT[2:], pres_rect=GRID_RECT)
        timeline = self.v8ui(p, "timeline", 260, 1000, *TIMELINE_RECT[2:],
                             pres_rect=TIMELINE_RECT)
        stage = self.stage(460, 1000)
        tx = TIMELINE_RECT[0]
        self.label("HITS", [tx, 3, 40, 16], color=DIM)
        stage_btn = self.button("STAGE", [tx + TIMELINE_RECT[2] - 56, 3, 56, 15])
        stage_open = p.message("open", 520, 960, w=40)
        pctl = p.obj("pcontrol", 520, 980, w=60, inlets=1, outlets=1, outlettype=[""])
        stage_t = p.obj("t b", 470, 960, w=30, outlettype=["bang"])
        p.connect(stage_btn, 0, stage_t, 0)
        p.connect(stage_t, 0, stage_open, 0)
        p.connect(stage_open, 0, pctl, 0)
        p.connect(pctl, 0, stage, 0)
        for cv in (grid, timeline, stage):
            p.connect(uiroute, len(ui_route_keys), cv, 0)
            p.connect(liveinfo, 0, cv, 0)
        p.connect(grid, 0, engine, 0)
        p.connect(stage, 0, engine, 0)
        self.canvases = (grid, timeline, stage)

        # ---------------------------------------------------------- pad editor
        ex = 222
        p.panel(0, 0, 10, 10, bgcolor=[0.17, 0.17, 0.20, 1.0],
                presentation_rect=[ex - 4, 20, 128, 146], rounded=4)
        self.label("SELECTED PAD", [ex, 22, 120, 16])
        self.label("Pad", [ex, 40, 40, 16], color=TEXT)
        pad = self.numbox("Pad", "Pad", [ex + 62, 40, 56, 15], 0, 127, 36,
                          unitstyle=8)
        self.label("Group", [ex, 60, 40, 16], color=TEXT)
        grp = self.tab("Pad Group", "Group", GROUPS, [ex + 38, 60, 80, 15])
        self.label("Mode", [ex, 80, 40, 16], color=TEXT)
        pmode = self.menu("Pad Mode", "Mode", MODES, [ex + 50, 80, 68, 15])
        fix = self.toggle("Pad Fix Vel", "Fix Vel", [ex, 100, 50, 15], "V",
                          texton="V")
        pvel = self.numbox("Pad Vel", "Pad Vel", [ex + 62, 100, 56, 15], 1, 127, 100)
        follow = self.toggle("Follow", "Follow", [ex, 122, 118, 15],
                             "Follow hits", texton="Follow hits", initial=1)
        self.label("Set ALL to", [ex, 142, 60, 16])
        all_mono = self.button("Mono", [ex + 56, 142, 30, 15])
        all_poly = self.button("Poly", [ex + 88, 142, 30, 15])

        to_engine(pad, "selpad", 1250, 60)
        to_engine(grp, "padgroup", 1250, 90)
        to_engine(pmode, "padmode", 1250, 120)
        to_engine(fix, "padfix", 1250, 150)
        to_engine(pvel, "padvel", 1250, 180)
        to_engine(follow, "setfollow", 1250, 210)
        for btn, g, y in ((all_mono, 1, 240), (all_poly, 0, 270)):
            t = p.obj("t b", 1250, y, w=30, outlettype=["bang"])
            m = p.message(f"setall {g}", 1290, y, w=60)
            p.connect(btn, 0, t, 0)
            p.connect(t, 0, m, 0)
            p.connect(m, 0, engine, 0)

        # Engine -> editor: values are `set` so they do not echo back.
        ed_keys = ["selpad", "padgroup", "padmode", "padfix", "padvel"]
        edroute = p.obj("route " + " ".join(ed_keys), 400, 500, w=260,
                        outlets=len(ed_keys) + 1, outlettype=[""] * (len(ed_keys) + 1))
        p.connect(uiroute, 0, edroute, 0)
        for i, target in enumerate((pad, grp, pmode, fix, pvel)):
            s = p.obj("prepend set", 400 + i * 80, 530, w=74)
            p.connect(edroute, i, s, 0)
            p.connect(s, 0, target, 0)

        # ------------------------------------------------------------ globals
        gx = 356
        self.label("Quantise", [gx, 22, 60, 16], color=TEXT)
        quant = self.menu("Quantise", "Quantise", QUANT, [gx + 60, 22, 92, 15])
        self.label("Hit guard", [gx, 40, 60, 16], color=TEXT)
        guard = self.numbox("Hit Guard", "Guard", [gx + 60, 40, 92, 15], 0, 250, 20,
                            unitstyle=2, ptype=0)
        velmode = self.toggle("Vel Mode", "Vel Mode", [gx, 60, 56, 15],
                              "LiveVelo", texton="SetVelo",
                              enum=("LiveVelo", "SetVelo"))
        gvel = self.numbox("Global Vel", "Set Vel", [gx + 60, 60, 92, 15], 1, 127, 100)
        self.label("On play", [gx, 80, 60, 16], color=TEXT)
        onplay = self.menu("On Play", "On Play", ["Keep", "Restart"],
                           [gx + 60, 80, 92, 15])
        self.label("Range", [gx, 100, 60, 16], color=TEXT)
        low = self.numbox("Low", "Low", [gx + 60, 100, 44, 15], 0, 127, 0, unitstyle=8)
        high = self.numbox("High", "High", [gx + 108, 100, 44, 15], 0, 127, 127,
                           unitstyle=8)
        self.label("Outside the range, notes pass through.", [gx, 116, 156, 16],
                   color=DIM, size=8.0)
        panic = self.button("PANIC", [gx, 136, 56, 26], longname="Panic")
        self.label("In", [gx + 62, 136, 18, 16], color=DIM)
        monitor = self.label("--", [gx + 78, 136, 74, 16], color=LCD)
        self.label("Note Offs ignored", [gx + 62, 150, 92, 16], color=DIM, size=8.0)

        to_engine(quant, "setquant", 1400, 20)
        to_engine(guard, "setguard", 1400, 50)
        to_engine(velmode, "setvelmode", 1400, 80)
        to_engine(gvel, "setglobalvel", 1400, 110)
        to_engine(onplay, "setonplay", 1400, 170)
        to_engine(low, "setlo", 1400, 200)
        to_engine(high, "sethi", 1400, 230)
        to_engine(panic, "panic", 1400, 260)

        mon = p.obj("prepend set", 750, 500, w=74)
        p.connect(uiroute, 1, mon, 0)
        p.connect(mon, 0, monitor, 0)

        self.widgets = dict(view=view, pad=pad, grp=grp, pmode=pmode, fix=fix,
                            pvel=pvel, follow=follow, quant=quant, guard=guard,
                            velmode=velmode, gvel=gvel,
                            onplay=onplay, low=low, high=high, panic=panic,
                            monitor=monitor, all_mono=all_mono, all_poly=all_poly)
        return self.patcher_dict()

    def patcher_dict(self):
        d = self.p.to_dict()
        pt = d["patcher"]
        pt["appversion"] = {"major": 9, "minor": 1, "revision": 0,
                            "architecture": "x64", "modernui": 1}
        pt["openrect"] = [0.0, 0.0, float(DEVICE_W), float(DEVICE_H)]
        params = {oid: [ln, sn, 0] for oid, (ln, sn) in self.params.items()}
        params["parameterbanks"] = {
            str(i): {"index": i, "name": name, "parameters": list(names)}
            for i, (name, names) in enumerate(BANKS)}
        params["inherited_shortname"] = 1
        pt["parameters"] = params
        return d


def build(selftest=False, out=OUT, selftest_file=None):
    d = (Device().build(selftest=selftest, selftest_file=selftest_file) if selftest_file
         else Device().build(selftest=selftest))
    amxd.write(d, out, TEMPLATE, device_type="midi_effect")
    return out, d


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--install", action="store_true",
                    help="copy the device into the Live User Library")
    ap.add_argument("--dist", action="store_true",
                    help="copy the device to dist/, the ready-to-load copy kept in git")
    ap.add_argument("--selftest", action="store_true",
                    help="post engine state to the Max console on load")
    ap.add_argument("--selftest-file", default=None,
                    help="where a --selftest build writes its Live-info diagnostics")
    ap.add_argument("--json", action="store_true",
                    help="also write build/Pad Toggle.maxpat for inspection in Max")
    a = ap.parse_args()
    out, d = build(selftest=a.selftest, selftest_file=a.selftest_file)
    print(out, amxd.verify(out))
    if a.json:
        j = out.with_suffix(".maxpat")
        j.write_text(json.dumps(d, indent=1))
        print(j)
    if a.dist:
        if a.selftest:
            sys.exit("refusing to put a --selftest build in dist/")
        (ROOT / "dist").mkdir(exist_ok=True)
        shutil.copy2(out, ROOT / "dist" / out.name)
        print("dist", ROOT / "dist" / out.name)
    if a.install:
        LIVE_MIDI_FX.mkdir(parents=True, exist_ok=True)
        dest = LIVE_MIDI_FX / out.name
        shutil.copy2(out, dest)
        print("installed", dest)


if __name__ == "__main__":
    main()
