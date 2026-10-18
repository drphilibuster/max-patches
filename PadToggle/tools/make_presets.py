#!/usr/bin/env python3
"""Generate the presets that go with Pad Toggle.

* "Pad Toggle Loop.adv": a Simpler set up the way the original's manual asks
  for (Classic mode, Loop on, Snap off, A 0 / D 1 ms / S 0 dB / R 1 ms), warped
  so it follows the set tempo. Drop any loop onto it.
* "Pad Toggle Demo Kit.adg": a Drum Rack of 16 such Simplers holding Core
  Library loops on C1..D#2, laid out in four rows meant for mono groups A-D.

Both are cloned from XML Live itself writes, not authored from scratch, so
every field Live expects is present and in order. The templates are read from
the local Live install's Core Library at build time (they are Ableton's files,
so they are not redistributed here):

* Defaults/Dropping Samples/On Drum Rack/Sample on Drum Pad Default.adv  (Simpler)
* Devices/Instruments/Simpler/Synth Rhythmic/Git Proc Loop.adv  (one MultiSamplePart)
* Racks/Drum Racks/Acoustic/Ahlimba Kit.adg  (Drum Rack)

Usage: make_presets.py [--install]
"""
from __future__ import annotations
import argparse, copy, gzip, pathlib, re, shutil, subprocess
import xml.etree.ElementTree as ET

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent
LIBRARY = pathlib.Path("/Applications/Ableton Live 12 Suite.app/Contents/App-Resources/"
                       "Core Library")
SIMPLER_SRC = LIBRARY / "Defaults/Dropping Samples/On Drum Rack/Sample on Drum Pad Default.adv"
SAMPLEPART_SRC = LIBRARY / "Devices/Instruments/Simpler/Synth Rhythmic/Git Proc Loop.adv"
DRUMRACK_SRC = LIBRARY / "Racks/Drum Racks/Acoustic/Ahlimba Kit.adg"


def live_xml(path):
    """Parse one of Live's gzipped preset files."""
    return ET.fromstring(gzip.decompress(path.read_bytes()))
BUILD = ROOT / "build"
CORE = pathlib.Path("/Applications/Ableton Live 12 Suite.app/Contents/App-Resources/"
                    "Core Library/Samples/Loops")
USER = pathlib.Path.home() / "Music/Ableton/User Library/Presets/Instruments"

# Live palette indices: orange, cyan, green, purple.
ROW_COLOURS = [1, 7, 5, 11]

# (pad note, loop) -- four rows, each meant to be one mono group.
DEMO = [
    (36, "Drums/Full/Minimal House 127 bpm.aif"),
    (37, "Drums/Full/House Live 123 bpm.aif"),
    (38, "Drums/Full/Deep House 120 bpm.aif"),
    (39, "Drums/Full/Funk 122 bpm.aif"),
    (40, "Drums/Top/Hihat Techno Straight 125 bpm.wav"),
    (41, "Drums/Top/Hihat Off Highroller 128 bpm.wav"),
    (42, "Drums/Top/Hihat with Reverse 127 bpm.aif"),
    (43, "Drums/Top/EDM Jeans 128 bpm.wav"),
    (44, "Drums/Percussion/Conga and Tambourine 106 bpm.aif"),
    (45, "Drums/Percussion/Triangle 118 bpm.aif"),
    (46, "Drums/Percussion/Clapping Flamenco 120 bpm.aif"),
    (47, "Drums/Percussion/Shaker 134 bpm.aif"),
    (48, "Tonal/Synth/Chugged Arp Fmin 130 bpm.wav"),
    (49, "Tonal/Synth/Stutter Fmin 130 bpm.wav"),
    (50, "Tonal/Synth/Reptile F 130 bpm.wav"),
    (51, "Tonal/Synth/Pluck Pad Progression Dm 121 bpm.aif"),
]


# ------------------------------------------------------------------ samples
def audio_info(path: pathlib.Path):
    """(frames, sample_rate) via macOS afinfo -- handles both WAV and AIFF."""
    out = subprocess.run(["afinfo", str(path)], capture_output=True, text=True,
                         check=True).stdout
    rate = int(float(re.search(r"(\d+(?:\.\d+)?) Hz", out).group(1)))
    frames = re.search(r"audio packets:\s*(\d+)", out)
    if frames:
        return int(frames.group(1)), rate
    dur = float(re.search(r"estimated duration:\s*([\d.]+)", out).group(1))
    return int(round(dur * rate)), rate


def bpm_of(path: pathlib.Path) -> float:
    return float(re.search(r"(\d+(?:\.\d+)?)\s*bpm", path.name, re.I).group(1))


def _set(el, path, value):
    e = el.find(path)
    if e is None:
        raise KeyError(path)
    e.set("Value", str(value))


def _clear_preset_ref(el):
    """A generated device must not claim to be the preset it was cloned from."""
    for ref in el.iter("LastPresetRef"):
        for c in list(ref):
            ref.remove(c)
        ET.SubElement(ref, "Value")


# ------------------------------------------------------------------ Simpler
def make_sample_part(sample: pathlib.Path):
    part = copy.deepcopy(live_xml(SAMPLEPART_SRC).find(".//MultiSamplePart"))
    frames, rate = audio_info(sample)
    bpm = bpm_of(sample)
    beats = max(1, round(frames / rate * bpm / 60.0))

    _set(part, "Name", sample.stem)
    _set(part, "RootKey", 60)
    _set(part, "Volume", 1)
    _set(part, "SampleStart", 0)
    _set(part, "SampleEnd", frames)
    # Loop the whole file: SustainLoop mode 1 is Simpler's LOOP switch.
    _set(part, "SustainLoop/Start", 0)
    _set(part, "SustainLoop/End", frames)
    _set(part, "SustainLoop/Mode", 1)
    _set(part, "SustainLoop/Crossfade", 0)
    _set(part, "ReleaseLoop/Start", 0)
    _set(part, "ReleaseLoop/End", frames)

    ref = part.find("SampleRef")
    fr = ref.find("FileRef")
    for tag, val in (("RelativePathType", 0), ("RelativePath", ""), ("Path", str(sample)),
                     ("LivePackName", ""), ("LivePackId", ""),
                     ("OriginalFileSize", sample.stat().st_size), ("OriginalCrc", 0)):
        _set(fr, tag, val)
    sc = ref.find("SourceContext")
    for c in list(sc):
        sc.remove(c)
    _set(ref, "DefaultDuration", frames)
    _set(ref, "DefaultSampleRate", rate)

    # Warp to the loop's own tempo so it follows the set: two markers spanning
    # the whole file. Beats mode for drums, Complex for tonal material.
    wp = part.find("SampleWarpProperties")
    wm = wp.find("WarpMarkers")
    for c in list(wm):
        wm.remove(c)
    ET.SubElement(wm, "WarpMarker", Id="0", SecTime="0", BeatTime="0")
    ET.SubElement(wm, "WarpMarker", Id="1", SecTime=repr(beats * 60.0 / bpm),
                  BeatTime=str(beats))
    _set(wp, "WarpMode", 4 if "Tonal" in sample.parts else 0)
    _set(wp, "IsWarped", "true")
    uo = wp.find("Onsets/UserOnsets")
    for c in list(uo):
        uo.remove(c)
    _set(wp, "Onsets/HasUserOnsets", "false")
    for tag in ("SlicePoints",):
        e = part.find(tag)
        for c in list(e):
            e.remove(c)
    return part


def make_simpler(sample: pathlib.Path | None, name: str):
    root = live_xml(SIMPLER_SRC)
    s = root.find("OriginalSimpler")
    _clear_preset_ref(s)
    _set(s, "UserName", name)
    parts = s.find("Player/MultiSampleMap/SampleParts")
    if sample is not None:
        parts.append(make_sample_part(sample))

    # The manual's loop setup, verbatim.
    _set(s, "Globals/PlaybackMode", 0)                      # Classic
    _set(s, "Player/Snap/Manual", "false")
    _set(s, "Player/LoopModulators/LoopOn/Manual", "true")   # the LOOP switch
    env = s.find("VolumeAndPan/Envelope")
    _set(env, "AttackTime/Manual", "0.1000000015")         # Live's minimum, shown as 0.00 ms
    _set(env, "DecayTime/Manual", 1)
    _set(env, "SustainLevel/Manual", 1)                    # 0 dB
    _set(env, "ReleaseTime/Manual", 1)
    _set(s, "VolumeAndPan/Volume/Manual", -6)
    _set(s, "Globals/NumVoices", 1)                        # a retrigger never stacks two copies
    return root


def write_gz(root: ET.Element, path: pathlib.Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    xml = ET.tostring(root, encoding="UTF-8", xml_declaration=True)
    with gzip.open(path, "wb") as f:
        f.write(xml)
    return path


# ---------------------------------------------------------------- Drum Rack
def make_kit(pads, name):
    src = live_xml(DRUMRACK_SRC)
    parents = {c: p for p in src.iter() for c in p}
    dg = src.find(".//DrumGroupDevice")
    gdp = copy.deepcopy(parents[parents[dg]])
    bps = gdp.find("BranchPresets")
    template = copy.deepcopy(bps[0])
    for c in list(bps):
        bps.remove(c)

    for i, (note, rel) in enumerate(pads):
        sample = CORE / rel
        b = copy.deepcopy(template)
        b.set("Id", str(i))
        _set(b, "Name", sample.stem)
        # Live stores the pad as 128 - note: the template's C1..D#2 pads hold 92..77.
        _set(b, "ZoneSettings/ReceivingNote", 128 - note)
        _set(b, "ZoneSettings/SendingNote", 60)
        _set(b, "ZoneSettings/ChokeGroup", 0)
        # One colour per row, matching Pad Toggle's group colours A-D, so the
        # canvas shows the kit's layout at a glance.
        _set(b, "DocumentColorIndex", ROW_COLOURS[(note - 36) // 4 % 4])
        _set(b, "AutoColored", "false")
        adp = b.find("DevicePresets/AbletonDevicePreset")
        dev = adp.find("Device")
        for c in list(dev):
            dev.remove(c)
        simpler = make_simpler(sample, sample.stem).find("OriginalSimpler")
        # Inside a rack the device is a list member and must carry an Id; a
        # standalone .adv's root device has none.
        simpler.set("Id", "0")
        dev.append(simpler)
        adp.find("PresetRef/AbletonDefaultPresetRef/DeviceId").set("Name", "OriginalSimpler")
        bsc = b.find("SourceContext/BranchSourceContext/BrowserContentPath")
        if bsc is not None:
            bsc.set("Value", "")
        bps.append(b)

    pr = gdp.find("PresetRef")
    if pr is not None:
        for tag in ("RelativePath", "Path"):
            for e in pr.iter(tag):
                e.set("Value", "")
    _set(gdp, "Device/DrumGroupDevice/UserName", name)
    root = ET.Element("Ableton", src.attrib)
    root.append(gdp)
    return root


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--install", action="store_true")
    a = ap.parse_args()
    loop = write_gz(make_simpler(CORE / DEMO[3][1], "Pad Toggle Loop"),
                    BUILD / "Pad Toggle Loop.adv")
    kit = write_gz(make_kit(DEMO, "Pad Toggle Demo Kit"), BUILD / "Pad Toggle Demo Kit.adg")
    print(loop, kit, sep="\n")
    if a.install:
        for f, sub in ((loop, "Simpler"), (kit, "Drum Rack")):
            d = USER / sub
            d.mkdir(parents=True, exist_ok=True)
            shutil.copy2(f, d / f.name)
            print("installed", d / f.name)


if __name__ == "__main__":
    main()
