# Pad Toggle — test report

Live 12.4.6 Suite, Max 9.2.0 (Live set to use the standalone Max), macOS.

## 1. Offline suites

| Suite | Command | Result |
|---|---|---|
| Engine behaviour | `node test/test_engine.js` | 51/51 pass |
| Generated patch structure | `python3 tools/test_device.py` | all pass |

The structural suite checks:
- every patchline joins real inlets/outlets
- every selector sent to the engine has a JS function
- every UI key the engine emits is routed
- parameter names, ranges and initial values match the engine's defaults
- each Push bank holds 8 known parameters
- every control fits the 169 px strip and none overlap
- the cells are Hidden parameters
- the embedded JS is byte-identical to `device/padtoggle.js`

## 2. In Live

The device's real output was captured by **PT Probe**, a test-only MIDI effect
placed between Pad Toggle and the Drum Rack. It logs each message with its song
position to JSON (`tools/probe_read.py` prints it). Input came from session
clips, from parameter changes over the Ableton MCP, and from real mouse clicks
on the device.

| # | Feature | Input | Observed at the Drum Rack | |
|---|---|---|---|---|
| T1 | Toggle, Note Offs ignored | C1 hits on beats 0 and 1, D1 held for 3 beats then re-hit | On, Off; D1's held Off at beat 7 dropped, Off only at re-hit (beat 8) | pass |
| T1 | Hit guard 20 ms | C#1 twice, 5 ms apart | one toggle | pass |
| T2 | Group A + 1/4 quantise | C1 at 0.3; C#1 at 1.5; D1 at 2.2 then C1 at 2.6 | On C1 @1.0; Off C1 + On C#1 @2.0; Off C#1 + On C1 @3.0 (D1 cancelled: last armed wins) | pass |
| T2 | Ungrouped pad unaffected; cancel | E1 at 3.3; E1 at 5.1 and 5.5 | On E1 @4.0 with C1 still on; nothing at 6.0 | pass |
| T3 | Per-pad V | F1 V=40, hit at velocity 120 | On velocity 40 | pass |
| T3 | Retrig | F#1 hits at 2 and 3 | On; Off + On at 3 | pass |
| T3 | Gate | G1 held one beat | On @5, Off @6 | pass |
| T3 | Thru | G#1 held half a beat | On, then its own Off @7.5 | pass |
| T4 | SetVelo 127 | A1 at velocity 10 | On velocity 127 | pass |
| T4 | V beats SetVelo | F1 at velocity 10 | On velocity 40 | pass |
| T4 | Range 36–51 | C3 (60) | On and its Off passed through | pass |
| T5 | Panic | C1 and F1 playing | Off C1, Off F1, nothing else | pass |
| T6 | Mouse toggle | click C1, click D1 | On C1, On D1; cells lit | pass |
| T6 | Set ALL to Mono | with C1 and D1 playing | Off C1 (D1 kept); every cell tagged "A"; D1 drawn orange | pass |
| T6 | 1 Bar quantise from the grid | click C1 at beat 957.5 | C1 flashes; Off D1 + On C1 at **960.000** exactly | pass |
| T7 | Persistence | duplicate the track (Live serialises and restores the device) | groups and Quantise restored; no pads lit | pass |
| T8 | On Play = Restart | C1 started while stopped, then play | Off + On C1 at beat 0 | pass |
| T9 | View | View → E1–G2 | grid relabelled | pass |
| T9 | Input monitor, Follow | clip note F#1 velocity 87 | "In F#1 87"; editor jumped to F#1 | pass |
| T10 | Downbeat hits under 1 Bar quantise | F#1 on every downbeat | toggles on every bar line (0, 4, 8, 12, 16) | pass, after fix 4 |
| — | Max console | fresh instances loaded, played, duplicated | no errors or warnings from the device | pass |
| — | Presets | demo kit and Simpler preset loaded | 16 named pads; Classic, LOOP on, SNAP off | pass, after fixes 1–2 |

### Defects found in Live and fixed

1. The demo kit was rejected as corrupt ("Not all list members have Ids"). The
   Simpler nested in each pad needed `Id="0"`.
2. Simpler's LOOP stayed off. The switch is `LoopModulators/LoopOn`.
3. Pad cells never drew their lit state. A non-parameter `live.text` doesn't
   draw "on" (isolated with the Max console's JS REPL). The cells are now
   Hidden parameters.
4. Downbeat hits under bar quantise waited a whole bar. Added a 40 ms late-hit
   grace window.
5. The planned "On Stop: Keep" option was dropped. Live sends Note Offs for
   every sounding note after the device when the transport stops, so no device
   can keep a loop alive through a stop. The device now resyncs instead.

## 2b. Canvas UI (2026-10-18, second pass)

The 16 `live.text` cells were replaced by three `v8ui` views of one drawing
script (grid, hits timeline, stage window). A Live-info helper reads the Drum
Rack through the Live API.

| Suite | Result |
|---|---|
| `node test/test_engine.js` (new canvas protocol) | 56/56 |
| `node test/test_canvas.js` (idle/animate contract, clicks, every view paints within a draw-call budget, label cache) | 16/16 |
| `node test/test_liveinfo.js` (fake LOM: rack discovery, warp-marker loop length, change-only reporting, one-at-a-time cached waveforms) | 11/11 |
| `python3 tools/test_device.py` (embedded scripts verbatim, selectors exist, per-canvas frame clocks) | all pass |

In Live 12.4.6:

| Check | Result |
|---|---|
| Names, chain colours, waveforms of the demo kit | shown; the bpm suffix is stripped |
| Loop lengths read from warp markers | 4, 8, 12 and 16 beats, matching the files |
| Ring and playhead | sweep once per loop; a 16-beat loop moves at half the speed of an 8-beat one |
| Set ALL Mono, then 1-bar quantised handoff | pending outline and countdown bar, then the switch on the bar line; the timeline shows it |
| Stage window | opens; full screen resizes the canvas; clicking pads in it works |
| CPU (three loops playing, 15 s averages) | strip animating ≈ device hidden (79.9 %); stage open +7.5 % in Live's process; Max 3.8–4.3 % |

Defects found in Live and fixed:
1. Live info found no rack because `LiveAPI.goto("id N")` silently returns
   nothing. The cursor is now retargeted with `.id`, and the fake LOM in the
   tests behaves the same way.
2. Every chain showed the track colour (`AutoColored`). The demo kit now sets
   one palette colour per row.
3. The stage subpatcher's helper boxes drew over the full-screen canvas. They
   are now hidden and stacked under it.

## 3. Control surfaces

No hardware was connected on 2026-10-18, so none of this has been tested yet.
The plan for the hardware session: arm the test track and play each surface by
hand while PT Probe (left in the User Library for this) captures what reaches
the Drum Rack.

| Surface | What to check | Result |
|---|---|---|
| MPC Live 3 | pads as track input toggle; velocity vs V/SetVelo | pending (next session) |
| Midi Fighter | arcade buttons toggle; short Note Offs don't cancel | pending (next session) |
| Midi Fighter Twister | encoders MIDI-mapped to the parameters; LED rings follow | pending (next session) |
| MIDI keyboard | Gate mode; pass-through range | pending (next session) |
| E-drum kit | delayed Note Offs ignored; double triggers guarded; hi-hat CC passes | not yet scheduled |
| Push 2 / Push 3 | bank pages and names; encoders; Drum Rack pads; Panic | can't test: no Push owned. Banks are declared and structurally tested only |
