#!/usr/bin/env python3
"""Build Max patcher JSON for Max for Live devices.

Max's patcher format is verbose and position-driven. This wraps it so a device
can be described as objects and connections, with layout handled by the caller.
Object ids are assigned automatically and connections refer to objects directly
rather than to id strings, which is the main source of hand-editing mistakes.
"""
from __future__ import annotations

# Matches what Max 9 writes for a Max for Live device. Max is tolerant of the
# minor keys but strict about fileversion/appversion, so these are kept as-is.
APPVERSION = {"major": 8, "minor": 6, "revision": 5,
              "architecture": "x64", "modernui": 1}

DARK = [0.125, 0.125, 0.165, 1.0]
ACCENT = [0.85, 0.30, 0.12, 1.0]        # the DR-880's orange-red
LCD = [0.62, 0.75, 0.36, 1.0]           # its green backlit display
TEXT = [0.88, 0.88, 0.90, 1.0]
DIM = [0.55, 0.56, 0.60, 1.0]


class Obj:
    __slots__ = ("spec", "id")

    def __init__(self, spec):
        self.spec = spec
        self.id = None


class Patcher:
    def __init__(self, width=900, height=560, presentation=True,
                 description="", tags="", digest="", latency=None):
        self.width, self.height = width, height
        self.presentation = presentation
        self.description, self.tags, self.digest = description, tags, digest
        # Audio devices carry a latency declaration; Live's own blank
        # "Max Audio Effect" template has latency 0.
        self.latency = latency
        self.objects: list[Obj] = []
        self.lines: list[tuple] = []
        self._n = 0

    # ---------------------------------------------------------------- objects
    def _add(self, spec) -> Obj:
        self._n += 1
        spec["id"] = f"obj-{self._n}"
        o = Obj(spec)
        o.id = spec["id"]
        self.objects.append(o)
        return o

    def obj(self, text, x, y, w=None, inlets=1, outlets=1, outlettype=None,
            **extra) -> Obj:
        """A normal object box, e.g. obj("metro 100", 10, 10)."""
        spec = {
            "maxclass": "newobj", "text": text,
            "numinlets": inlets, "numoutlets": outlets,
            "outlettype": outlettype if outlettype is not None else [""] * outlets,
            "patching_rect": [float(x), float(y), float(w or max(40, 8 * len(text))), 22.0],
        }
        spec.update(extra)
        return self._add(spec)

    def message(self, text, x, y, w=None, **extra) -> Obj:
        spec = {
            "maxclass": "message", "text": text,
            "numinlets": 2, "numoutlets": 1, "outlettype": [""],
            "patching_rect": [float(x), float(y), float(w or max(40, 8 * len(text))), 22.0],
        }
        spec.update(extra)
        return self._add(spec)

    def comment(self, text, x, y, w=200, fontsize=10.0, color=None,
                presentation_rect=None, **extra) -> Obj:
        spec = {
            "maxclass": "comment", "text": text,
            "numinlets": 1, "numoutlets": 0,
            "patching_rect": [float(x), float(y), float(w), 20.0],
            "fontsize": fontsize,
            "fontname": "Arial",
            "textjustification": 0,
            "textcolor": color or TEXT,
        }
        if presentation_rect:
            spec["presentation"] = 1
            spec["presentation_rect"] = [float(v) for v in presentation_rect]
        spec.update(extra)
        return self._add(spec)

    def button(self, x, y, presentation_rect=None, **extra) -> Obj:
        spec = {"maxclass": "button", "numinlets": 1, "numoutlets": 1,
                "outlettype": ["bang"],
                "patching_rect": [float(x), float(y), 24.0, 24.0]}
        if presentation_rect:
            spec["presentation"] = 1
            spec["presentation_rect"] = [float(v) for v in presentation_rect]
        spec.update(extra)
        return self._add(spec)

    def textbutton(self, text, x, y, presentation_rect=None, w=100, h=22,
                   bgcolor=None, **extra) -> Obj:
        spec = {
            "maxclass": "live.text", "text": text,
            "numinlets": 1, "numoutlets": 2, "outlettype": ["", ""],
            "patching_rect": [float(x), float(y), float(w), float(h)],
            "parameter_enable": 0,
            "saved_attribute_attributes": {"valueof": {"parameter_longname": text}},
        }
        if bgcolor:
            spec["bgcolor"] = bgcolor
        if presentation_rect:
            spec["presentation"] = 1
            spec["presentation_rect"] = [float(v) for v in presentation_rect]
        spec.update(extra)
        return self._add(spec)

    def panel(self, x, y, w, h, bgcolor=None, presentation_rect=None,
              rounded=0, background=True, **extra) -> Obj:
        """A coloured rectangle.

        `background` puts it in the patcher's background layer, which is almost
        always what a panel is for. Without it the panel sits in the FOREGROUND
        and paints over every control drawn before it -- a full-size backdrop
        then renders the device as a flat empty rectangle with nothing visible
        on it at all.
        """
        spec = {
            "maxclass": "panel", "numinlets": 1, "numoutlets": 0,
            "patching_rect": [float(x), float(y), float(w), float(h)],
            "bgcolor": bgcolor or DARK,
            "bordercolor": bgcolor or DARK,
            "border": 0.0,
            "shadow": 0,
            "rounded": rounded,
        }
        if background:
            spec["background"] = 1
        if presentation_rect:
            spec["presentation"] = 1
            spec["presentation_rect"] = [float(v) for v in presentation_rect]
        spec.update(extra)
        return self._add(spec)

    # ------------------------------------------------------------ connections
    def connect(self, src: Obj, src_outlet: int, dst: Obj, dst_inlet: int):
        self.lines.append((src, src_outlet, dst, dst_inlet))

    def chain(self, *objs):
        """connect a->b->c... on outlet 0 / inlet 0."""
        for a, b in zip(objs, objs[1:]):
            self.connect(a, 0, b, 0)

    # ----------------------------------------------------------------- output
    def to_dict(self) -> dict:
        boxes = [{"box": o.spec} for o in self.objects]
        lines = [{"patchline": {"destination": [d.id, di], "source": [s.id, so]}}
                 for s, so, d, di in self.lines]
        return {"patcher": {
            "fileversion": 1,
            "appversion": dict(APPVERSION),
            "classnamespace": "box",
            "rect": [60.0, 80.0, float(self.width), float(self.height)],
            "bglocked": 0,
            "openinpresentation": 1 if self.presentation else 0,
            "default_fontsize": 10.0,
            "default_fontface": 0,
            "default_fontname": "Arial",
            "gridonopen": 1,
            "gridsize": [5.0, 5.0],
            "gridsnaponopen": 1,
            "objectsnaponopen": 1,
            "statusbarvisible": 2,
            "toolbarvisible": 1,
            "lefttoolbarpinned": 0,
            "toptoolbarpinned": 0,
            "righttoolbarpinned": 0,
            "bottomtoolbarpinned": 0,
            "toolbars_unpinned_last_save": 0,
            "tallnewobj": 0,
            "boxanimatetime": 0,
            "enablehscroll": 1,
            "enablevscroll": 1,
            "devicewidth": 0.0,
            "description": self.description,
            "digest": self.digest,
            "tags": self.tags,
            "style": "",
            "subpatcher_template": "",
            "assistshowspatchername": 0,
            "boxes": boxes,
            "lines": lines,
            "dependency_cache": [],
            "autosave": 0,
            **({"latency": self.latency} if self.latency is not None else {}),
        }}
