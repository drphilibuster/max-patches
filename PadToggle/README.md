# Pad Toggle

A Max for Live MIDI effect that turns any pad, key or e-drum hit into a loop
on/off switch for a Drum Rack. It covers the whole feature set of Ableton
Drummer's *Drumrack Toggle* (Isotonik, v1.0) and adds launch quantise, four
mono groups, Retrig/Gate/Thru pad modes, an e-drum hit guard, a pass-through
range, Panic and Push banks.

Live 12.2 or later (Max 9, for `v8`). Tested in Live 12.4.6 Suite.

## Install

**Just the device:** drag [`dist/Pad Toggle.amxd`](dist/) onto a MIDI track,
or copy it to `User Library/Presets/MIDI Effects/Max MIDI Effect/`. It is
self-contained; all its JavaScript is embedded.

**From source, with the presets:**

```bash
python3 tools/build_device.py --install
python3 tools/make_presets.py --install
```

`make_presets.py` reads its templates (a Simpler, a Drum Rack) and the demo
loops from your Live 12 Suite Core Library, so it needs Live installed at
`/Applications/Ableton Live 12 Suite.app`. That puts three things in the User
Library:

| File | Where | What |
|---|---|---|
| `Pad Toggle.amxd` | MIDI Effects › Max MIDI Effect | the device (self-contained: the JS is embedded) |
| `Pad Toggle Loop.adv` | Instruments › Simpler | Simpler set up for looping, as the original's manual describes |
| `Pad Toggle Demo Kit.adg` | Instruments › Drum Rack | 16 Core Library loops on C1–D#2 in four rows |

## Use

Put **Pad Toggle** on a MIDI track before a Drum Rack. Each hit on a pad
alternately starts and stops its loop. Note Offs from the controller are
ignored: an e-drum's release, which arrives anywhere from a few ms to seconds
after the hit, no longer cuts the loop.

Each pad needs a looping sample. Either load **Pad Toggle Loop** on the pad,
or drop a loop on the pad and set the Simpler to: Classic, LOOP on, SNAP off,
Attack 0 ms, Decay 1 ms, Sustain 0 dB, Release 1 ms.

### Panel

* **Grid**: 16 pads laid out like the Drum Rack (lowest note bottom-left).
  Click to toggle. Each pad shows the Drum Rack pad's name and chain colour,
  and a waveform of its sample. It also shows its note, plus `R`/`G` for
  Retrig/Gate, `v` for a fixed velocity and `thru` for a pass-through pad.
  A tab in the corner shows the pad's group, A–D.
  * **Playing**: the pad lights in its colour. A ring sweeps its border and a
    playhead crosses the waveform once per loop, read from the sample's warp
    markers.
  * **Pending** (waiting for the quantise boundary): the outline pulses and a
    bar along the bottom drains to zero as the boundary arrives.
  * **Hits**: every hit sends out a ripple sized by velocity. A hit swallowed
    by the hit guard flickers red, which makes the guard easy to tune.
* **Hits** (right): the last four bars, one lane per visible pad, with loop
  spans, hit ticks (taller = harder, red = guarded) and bar lines while the
  transport runs.
* **STAGE**: opens a resizable performance window with the big grid and the
  timeline, plus quantise, tempo and bar.beat. Its corner button goes full
  screen. Pads can be clicked there too.
* **View**: which 16 of the 128 pads the grid shows. Pads you can't see still
  work.
* **Selected pad**: edits one pad. With *Follow hits* on, the editor jumps to
  the pad you last played.
  * **Group** `-` `A` `B` `C` `D`: within a group only one pad plays at a time;
    starting one stops the others. `-` = polyphonic. (The original's "M" is
    group A.)
  * **Mode**: *Toggle* (default); *Retrig* (a hit on a playing pad restarts it);
    *Gate* (plays while held, for keyboards); *Thru* (passes the pad untouched).
  * **V** + value: fixed output velocity for this pad.
  * **Set ALL to Mono / Poly**: puts every pad in group A, or none. This
    overwrites per-pad groups.
* **Quantise**: Off, 1/16, 1/8, 1/4, 1/2, 1 / 2 / 4 Bars. A hit waits for the
  next boundary; hitting again before it cancels. A hit within 40 ms *after* a
  boundary counts as on it. Quantise only applies while the transport runs.
* **Hit guard**: repeat hits on one pad within this many ms are ignored
  (e-drum double triggers). 0 turns it off.
* **LiveVelo / SetVelo** + value: pass the played velocity, or force one for
  all pads. A pad's own **V** wins over SetVelo. Velocity only changes volume if
  the Simpler's Vel>Vol is above 0 %.
* **On play**: *Restart* retriggers playing loops when the transport starts, so
  loops started while stopped line up with the downbeat.
* **Range**: notes outside Low–High pass through untouched, Note Offs
  included. This replaces the original's "use a Chain Selector" workaround.
* **Panic**: stops every pad and clears pending hits.
* **In**: the last incoming note and velocity.

Everything other than notes (CCs such as a hi-hat pedal, aftertouch, pitch
bend, sysex, clock) passes straight through.

### Transport stop

When the transport stops, Live itself sends a Note Off for every note a device
left sounding, then All Notes Off. It does this *after* the device, so no
device can keep a loop running through a stop. Pad Toggle follows suit: on stop
every pad is marked off and pending hits are dropped, so the next hit always
starts its loop.

### Control surfaces

Parameters are on two Push banks:

| Bank | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
|---|---|---|---|---|---|---|---|---|
| Main | Quantise | Guard | Vel Mode | Set Vel | On Play | View | Follow | Panic |
| Pad | Pad | Group | Mode | Fix Vel | Pad Vel | Low | High | – |

All of them can be MIDI- or key-mapped. Pad state per pad (group, mode, V,
velocity) is saved with the set and in device presets.

Push's pad LEDs follow the Drum Rack's pad colours, not Pad Toggle's state;
Live gives a MIDI effect no way to light them, or to draw on Push's display.

### CPU

The canvases only redraw while something moves: a ring turning, a countdown,
a ripple, a fade, or a timeline with something on screen. Otherwise they
redraw once per change. Live info reads only the 16 visible pads, every 2 s,
and sends only what changed. Each sample is summarised into a waveform once
and cached.

Measured in Live 12.4.6 with three loops playing:
- With the strip animating, the cost could not be told apart from the device
  being hidden.
- With the stage window open, Live used about 7.5 % more of one core, from
  compositing the large window at 30 fps. Nothing extra once it is closed.

## Develop

| Path | |
|---|---|
| `device/padtoggle.js` | the engine; embedded verbatim in the device's `v8.codebox` |
| `device/ptcanvas.js` | the drawing: one script, three views (grid / timeline / stage), embedded in each `v8ui` |
| `device/ptliveinfo.js` | Live API reader: pad names, colours, loop lengths, waveforms |
| `test/test_engine.js` | behavioural tests, `node test/test_engine.js` |
| `test/test_canvas.js`, `test/test_liveinfo.js` | canvas (idle/animate, clicks, draw budget) and Live-info tests, against fakes of mgraphics and the Live API |
| `tools/render_preview.js` | renders the three views to SVG in `build/preview/` for design review |
| `tools/build_device.py` | generates the patcher and the `.amxd` (`--install`, `--json`) |
| `tools/test_device.py` | structural tests on the generated patch |
| `tools/make_presets.py` | Simpler preset and demo kit, cloned from Live's own XML |
| `tools/build_probe.py`, `tools/probe_read.py` | test-only MIDI logger used to verify output inside Live |
| `TESTING.md` | what was tested in Live and on hardware, and how |

Things learned the hard way, all verified in Live 12.4.6:

* A `live.text` that is not a Live parameter never draws its "on" state, and
  inside an active device it uses its `active*` colours. The pad cells are
  therefore Hidden parameters (`parameter_invisible` 2).
* Drum Rack `ReceivingNote` is stored as 128 − note.
* A device nested in a rack needs `Id="0"`; a standalone `.adv` root has none.
* Simpler's LOOP switch is `Player/LoopModulators/LoopOn`, not `SustainLoop`.
* An embedded `v8ui` stores its code in a `textfile` dict (`text`, `filename`,
  `flags`, `embed`, `autowatch`). A `v8.codebox` uses `code`.
* In the Live API from JS, retarget a cursor by setting `.id`. `goto("id N")`
  silently returns nothing.
* Chains in a generated rack are auto-coloured (track colour) unless
  `AutoColored` is false.
