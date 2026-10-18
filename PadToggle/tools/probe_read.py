#!/usr/bin/env python3
"""Print what PT Probe logged, as readable events (beat = song ticks / 480).

Usage: probe_read.py LOGFILE [--since SEQ]
"""
import argparse, json, pathlib

NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def note(p):
    return f"{NAMES[p % 12]}{p // 12 - 2}({p})"


def events(path, since=0):
    d = json.loads(pathlib.Path(path).read_text())
    ev = d["events"]
    if isinstance(ev, str):
        ev = json.loads(ev)
    return [e for e in ev if e[0] > since]


def fmt(e):
    seq, ticks, ms, st, *data = e
    kind = st & 0xF0
    beat = ticks / 480.0
    if kind == 0x90 and data[1] > 0:
        what = f"ON  {note(data[0])} vel {data[1]}"
    elif kind in (0x80, 0x90):
        what = f"OFF {note(data[0])}"
    else:
        what = "MSG " + " ".join(f"{b:02X}" for b in [st] + data)
    return f"#{seq:<4} beat {beat:8.3f}  ch{(st & 15) + 1:<2} {what}"


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("log")
    ap.add_argument("--since", type=int, default=0)
    a = ap.parse_args()
    for e in events(a.log, a.since):
        print(fmt(e))
