#!/usr/bin/env python3
"""Structural tests for the generated Pad Toggle device.

These catch the failure mode that is otherwise invisible: a device that loads
and silently does nothing because a message selector has no JS function behind
it, a line points at an outlet that does not exist, or a control sits outside
the 169 px device strip.
"""
import pathlib, re, sys, tempfile

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import amxd, build_device

fails = []
def check(label, ok, detail=""):
    print(("  ok   " if ok else "  FAIL ") + label + ("" if ok else f"\n         {detail}"))
    if not ok:
        fails.append(label)


out = pathlib.Path(tempfile.mkdtemp()) / "Pad Toggle.amxd"
path, d = build_device.build(out=out)
pt = d["patcher"]
boxes = {b["box"]["id"]: b["box"] for b in pt["boxes"]}
lines = [l["patchline"] for l in pt["lines"]]
src = build_device.ENGINE.read_text()
js_funcs = set(re.findall(r"^function\s+([A-Za-z_$][\w$]*)\s*\(", src, re.M))

# ---------------------------------------------------------------- container
r = amxd.read(out)
v = amxd.verify(out)
check("container sizes coherent", v["ptch_size_ok"] and v["mx_size_ok"], v)
check("Live classifies it as a MIDI effect", r["device_type"] == "midi_effect", r["device_type"])
check("embedded engine is byte-identical to device/padtoggle.js",
      any(b.get("code") == src for b in boxes.values()))

# --------------------------------------------------------------------- lines
bad = []
for l in lines:
    s, so = l["source"]; t, ti = l["destination"]
    if s not in boxes or t not in boxes:
        bad.append(("missing box", l)); continue
    if so >= boxes[s]["numoutlets"]:
        bad.append(("outlet out of range", boxes[s].get("text") or boxes[s]["maxclass"], so))
    if ti >= boxes[t]["numinlets"]:
        bad.append(("inlet out of range", boxes[t].get("text") or boxes[t]["maxclass"], ti))
check("every patchline joins existing inlets/outlets", not bad, bad[:5])

engine_id = next(i for i, b in boxes.items() if b["maxclass"] == "v8.codebox")
outlets = int(re.search(r"^outlets\s*=\s*(\d+);", src, re.M).group(1))
check("engine box outlet count matches the JS", boxes[engine_id]["numoutlets"] == outlets,
      (boxes[engine_id]["numoutlets"], outlets))

# ------------------------------------------------- selectors reach functions
into_engine = [l["source"][0] for l in lines if l["destination"][0] == engine_id]
selectors = set()
for sid in into_engine:
    b = boxes[sid]
    text = b.get("text", "")
    if b["maxclass"] == "newobj" and text.startswith("prepend "):
        selectors.add(text.split()[1])
    elif b["maxclass"] == "message":
        selectors.add(text.split()[0])
missing = sorted(s for s in selectors if s not in js_funcs)
check(f"all {len(selectors)} selectors sent to the engine have JS functions", not missing, missing)

engine_out = [l for l in lines if l["source"][0] == engine_id]
check("engine outlet 0 feeds midiout via zl.iter",
      any(l["source"][1] == 0 and boxes[l["destination"][0]].get("text", "").startswith("zl.iter")
          for l in engine_out))

# ui() keys: editor/monitor go to the panel, every other key is a canvas
# message and must be a function in ptcanvas.js.
canvas_src = build_device.CANVAS.read_text()
canvas_funcs = set(re.findall(r"^function\s+([A-Za-z_$][\w$]*)\s*\(", canvas_src, re.M))
info_src = build_device.LIVEINFO.read_text()
info_funcs = set(re.findall(r"^function\s+([A-Za-z_$][\w$]*)\s*\(", info_src, re.M))
route = next(b for b in boxes.values() if b.get("text", "").startswith("route editor"))
routed = set(route["text"].split()[1:])
emitted = set(re.findall(r'ui\("(\w+)"', src))
check("editor and monitor keys are routed to the panel", {"editor", "monitor"} <= routed)
to_canvas = emitted - routed
missing_c = sorted(k for k in to_canvas if k not in canvas_funcs)
check(f"all {len(to_canvas)} canvas keys the engine emits are canvas functions", not missing_c, missing_c)
info_out = set(re.findall(r'outlet\(0,\s*\["(\w+)"', info_src))
missing_i = sorted(k for k in info_out if k not in canvas_funcs)
check(f"Live-info messages {sorted(info_out)} are canvas functions", info_out and not missing_i, missing_i)

# Every embedded script matches its source, in each view.
v8uis = [b for b in boxes.values() if b["maxclass"] == "v8ui"]
stage_box = next(b for b in boxes.values() if b.get("text") == "p stage")
stage_boxes = {bb["box"]["id"]: bb["box"] for bb in stage_box["patcher"]["boxes"]}
v8uis += [b for b in stage_boxes.values() if b["maxclass"] == "v8ui"]
modes = sorted(b["jsarguments"][0] for b in v8uis)
check("three canvases: grid, stage, timeline", modes == ["grid", "stage", "timeline"], modes)
check("each canvas embeds ptcanvas.js verbatim",
      all(b["embed"] == 1 and b["textfile"]["embed"] == 1 and b["textfile"]["text"] == canvas_src
          for b in v8uis))
info_box = next(b for b in boxes.values() if b.get("varname") == "liveinfo")
check("Live-info embeds ptliveinfo.js verbatim", info_box["code"] == info_src)

def selectors_into(target_id, bxs, lns):
    out = set()
    for l in lns:
        if l["destination"][0] != target_id:
            continue
        b = bxs[l["source"][0]]
        text = b.get("text", "")
        if b["maxclass"] == "newobj" and text.startswith("prepend "):
            out.add(text.split()[1])
        elif b["maxclass"] == "message":
            out.add(text.split()[0])
    return out

for cv in v8uis:
    in_stage = cv["id"] in stage_boxes and cv["jsarguments"][0] == "stage"
    bxs = stage_boxes if in_stage else boxes
    lns = [l["patchline"] for l in stage_box["patcher"]["lines"]] if in_stage else lines
    sel = selectors_into(cv["id"], bxs, lns)
    miss = sorted(x for x in sel if x not in canvas_funcs)
    check(f"{cv['jsarguments'][0]} canvas: selectors {sorted(sel)} exist", sel and not miss, miss)
    clocks = [l for l in lns if l["source"] == [cv["id"], 1]
              and bxs[l["destination"][0]].get("text", "").startswith("qmetro")]
    check(f"{cv['jsarguments'][0]} canvas drives its own frame clock", len(clocks) == 1)

sel = selectors_into(info_box["id"], boxes, lines)
miss = sorted(x for x in sel if x not in info_funcs)
check(f"Live-info selectors {sorted(sel)} exist", not miss, miss)
check("canvas clicks reach the engine",
      any(l["source"][0] == next(b["id"] for b in boxes.values() if b.get("varname") == "canvas_grid")
          and l["destination"][0] == engine_id for l in lines) and "click" in js_funcs)
check("waveform buffer name is per-instance ('---')",
      any(b.get("text") == "buffer~ ---ptwave" for b in boxes.values())
      and any(b.get("text") == "setbufname ---ptwave" for b in boxes.values()))
ed_route = next(b for b in boxes.values() if b.get("text", "").startswith("route selpad"))
ed_emitted = set(re.findall(r'ui\("editor",\s*"(\w+)"', src))
check("every editor key is routed", ed_emitted == set(ed_route["text"].split()[1:]),
      (ed_emitted, ed_route["text"]))

# ------------------------------------------------------------- parameters
params = pt["parameters"]
names = {}
hidden = set()
for oid, (ln, sn, _) in ((k, v) for k, v in params.items() if k.startswith("obj-")):
    names[ln] = oid
    b = boxes[oid]
    va = b["saved_attribute_attributes"]["valueof"]
    if va.get("parameter_invisible") == 2:
        hidden.add(ln)
    else:
        check(f"param '{ln}' has matching longname and varname",
              va["parameter_longname"] == ln and b.get("varname") == ln)
    if len(sn) > 8 and ln != "Pad State":
        check(f"param '{ln}' short name fits Push ({sn!r})", False, sn)
    if va.get("parameter_type") == 2:
        check(f"param '{ln}' enum range", va["parameter_mmax"] == len(va["parameter_enum"]) - 1)
check("no duplicate parameter long names", len(names) == sum(1 for k in params if k.startswith("obj-")))

banks = params["parameterbanks"]
for i, bank in banks.items():
    unknown = [n for n in bank["parameters"] if n not in names and n != "-"]
    check(f"bank {bank['name']!r}: 8 known parameters", len(bank["parameters"]) == 8 and not unknown,
          unknown)
banked = {n for b in banks.values() for n in b["parameters"]}
unbanked = sorted(n for n in names if n not in banked and n != "Pad State" and n not in hidden)
check("every automatable parameter is on a Push bank", not unbanked, unbanked)

state = boxes[names["Pad State"]]
check("pad state is a stored-only blob",
      state["saved_attribute_attributes"]["valueof"]["parameter_type"] == 3
      and state["saved_attribute_attributes"]["valueof"]["parameter_invisible"] == 1
      and state["saved_object_attributes"]["parameter_enable"] == 1)

for js in ("getvalueof", "setvalueof", "loaded", "transport", "bars", "click", "panic"):
    check(f"JS defines {js}()", js in js_funcs)

# Initial values must match the engine's own defaults, or the device starts in a
# state its UI does not show.
def initial(ln):
    return boxes[names[ln]]["saved_attribute_attributes"]["valueof"]["parameter_initial"][0]
def js_default(var):
    return float(re.search(rf"^var {var} = ([\d.]+);", src, re.M).group(1))
for ln, var in (("Quantise", "quant"), ("Hit Guard", "guardMs"), ("Vel Mode", "velMode"),
                ("Global Vel", "globalVel"), ("On Play", "onPlay"),
                ("Follow", "follow")):
    check(f"'{ln}' initial matches engine default", float(initial(ln)) == js_default(var),
          (initial(ln), js_default(var)))
check("'View' initial matches engine default (36)", initial("View") * 4 == js_default("view"))
check("'Pad' initial matches engine default", float(initial("Pad")) == js_default("selected"))

# ------------------------------------------------------------- presentation
outside = []
for b in boxes.values():
    if b.get("presentation"):
        x, y, w, h = b["presentation_rect"]
        if y < 0 or y + h > build_device.DEVICE_H or x < 0 or x + w > build_device.DEVICE_W:
            outside.append((b.get("text") or b.get("varname") or b["maxclass"], b["presentation_rect"]))
check("all presented objects fit the device strip", not outside, outside)

controls = [b for b in boxes.values() if b.get("presentation")
            and (b["maxclass"].startswith("live.") or b["maxclass"] == "v8ui")]
ov = []
for i, a in enumerate(controls):
    ra = a["presentation_rect"]
    for b in controls[i + 1:]:
        rb = b["presentation_rect"]
        if ra[0] < rb[0] + rb[2] and rb[0] < ra[0] + ra[2] and ra[1] < rb[1] + rb[3] and rb[1] < ra[1] + ra[3]:
            ov.append((a.get("varname"), b.get("varname")))
check("no two controls overlap", not ov, ov)

print(f"\n{'FAILED: ' + str(len(fails)) if fails else 'all passed'}")
sys.exit(1 if fails else 0)
