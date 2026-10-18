#!/usr/bin/env python3
"""Read and write Max for Live device files (.amxd).

An .amxd is the patcher JSON wrapped in Max's chunk container:

    "ampf" <4 bytes>
    "mmmm"
    "ptch" <uint32 LE = bytes from here to EOF>
      "mx@c" <uint32 BE = 16> <uint32 BE = 0> <uint32 BE = 16 + payload>
      <patcher JSON, NUL-terminated>
      "dlst" ... "flag" ... "mdat"        <- trailing metadata chunks

Three sizes have to agree or Max refuses the file: the `ptch` size, the `mx@c`
size, and `sz32` inside `dlst`. Rather than author the container from scratch,
this clones a known-good device and swaps the payload, so any chunk Max cares
about that is not modelled here survives untouched.
"""
from __future__ import annotations
import json, pathlib, struct

MAGIC = b"ampf"

# There are two container layouts in the wild and both must round-trip:
#
#   A  "ampf" <4> "mmmm" "ptch" <size LE> "mx@c" <16> <0> <16+payload> JSON
#   B  "ampf" <4> "aaaa" "meta" <4> <0>   "ptch" <size LE>             JSON
#
# Rather than model them, the template's bytes before the JSON are reused
# verbatim and only the sizes inside them are rewritten. That keeps chunks this
# module knows nothing about -- such as "meta", which a Max audio device needs
# in order to be given any audio inputs at all.

# The four bytes at 0x08 are what tells Live which kind of device this is. They
# are NOT inferred from the objects in the patcher: a device full of plugin~ and
# plugout~ still loads as a MIDI effect if this says "mmmm", landing before the
# instrument instead of after it.
DEVICE_TYPES = {
    "midi_effect": b"mmmm",
    "audio_effect": b"aaaa",
    "midi_transformation": b"natt",
    "midi_generator": b"nagg",
}


def _chunks(buf: bytes, start=0, end=None):
    """Walk tag/size chunks. Size is big-endian and includes the 8-byte header."""
    end = len(buf) if end is None else end
    i = start
    while i + 8 <= end:
        tag = buf[i:i + 4]
        size = struct.unpack_from(">I", buf, i + 4)[0]
        if size < 8 or i + size > end:
            break
        yield tag.decode("latin-1"), i, size, buf[i + 8:i + size]
        i += size


def read(path) -> dict:
    """Return {'json', 'prefix', 'trailer', 'raw', 'device_type'}."""
    data = pathlib.Path(path).read_bytes()
    if data[:4] != MAGIC:
        raise ValueError(f"{path}: not an .amxd (missing 'ampf' magic)")
    start = data.find(b'{"patcher"')
    if start == -1:
        start = data.find(b"{")
    if start == -1:
        raise ValueError(f"{path}: no patcher JSON found")
    text = data[start:].decode("utf-8", errors="replace")
    patcher, end = json.JSONDecoder().raw_decode(text)
    trailer_at = start + len(text[:end].encode("utf-8"))
    while trailer_at < len(data) and data[trailer_at] == 0:
        trailer_at += 1                       # JSON is NUL-terminated
    kind = {v: k for k, v in DEVICE_TYPES.items()}.get(data[0x08:0x0C], "unknown")
    return {"json": patcher, "prefix": data[:start],
            "trailer": data[trailer_at:], "raw": data, "device_type": kind}


def _patch_trailer(trailer: bytes, json_len: int, filename: str) -> bytes:
    """Rewrite sz32 (payload length) and fnam (device filename) in place."""
    out = bytearray(trailer)
    for tag, off, size, payload in _chunks(out):
        if tag != "dlst":
            continue
        for t2, off2, size2, _ in _chunks(out, off + 8, off + size):
            if t2 != "dire":
                continue
            for t3, off3, size3, _ in _chunks(out, off2 + 8, off2 + size2):
                if t3 == "sz32":
                    struct.pack_into(">I", out, off3 + 8, json_len)
                elif t3 == "fnam":
                    room = size3 - 8
                    name = filename.encode("utf-8")[:room]
                    out[off3 + 8:off3 + size3] = name.ljust(room, b"\x00")
    return bytes(out)


def write(patcher: dict, out_path, template, device_type="midi_effect") -> pathlib.Path:
    """Write `patcher` as an .amxd, cloning the container from `template`.

    `device_type` sets the magic at 0x08 and so decides how Live classifies the
    device. It has to be stated explicitly because it is independent of the
    patcher's contents.
    """
    if device_type not in DEVICE_TYPES:
        raise ValueError(f"unknown device type {device_type!r}; "
                         f"expected one of {sorted(DEVICE_TYPES)}")
    out_path = pathlib.Path(out_path)
    tpl = read(template)

    body = json.dumps(patcher, separators=(",", ":")).encode("utf-8") + b"\x00"
    trailer = _patch_trailer(tpl["trailer"], len(body), out_path.name)

    prefix = bytearray(tpl["prefix"])
    prefix[0x08:0x0C] = DEVICE_TYPES[device_type]

    ptch_at = prefix.find(b"ptch")
    if ptch_at == -1:
        raise ValueError("template has no 'ptch' chunk")
    mx_at = prefix.find(b"mx@c", ptch_at)

    tail_len = len(body) + len(trailer)
    if mx_at != -1:
        # The mx@c size is its own 16-byte header plus the payload, and it is
        # the THIRD word of that header, not the first.
        struct.pack_into(">I", prefix, mx_at + 12, 16 + len(body))
    # The ptch size counts everything after its own size field to EOF.
    after_ptch_size = ptch_at + 8
    struct.pack_into("<I", prefix, ptch_at + 4,
                     len(prefix) - after_ptch_size + tail_len)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(bytes(prefix) + body + trailer)
    return out_path


def verify(path) -> dict:
    """Re-read a written device and report whether the container is coherent."""
    data = pathlib.Path(path).read_bytes()
    r = read(path)
    prefix = r["prefix"]
    ptch_at = prefix.find(b"ptch")
    mx_at = prefix.find(b"mx@c", ptch_at)
    ptch = struct.unpack_from("<I", data, ptch_at + 4)[0]
    body_len = len(data) - len(prefix) - len(r["trailer"])
    checks = {
        "bytes": len(data),
        "device_type": r["device_type"],
        "ptch_size_ok": ptch == len(data) - (ptch_at + 8),
        "json_parses": isinstance(r["json"], dict) and "patcher" in r["json"],
        "boxes": len(r["json"].get("patcher", {}).get("boxes", [])),
    }
    checks["mx_size_ok"] = (
        struct.unpack_from(">I", data, mx_at + 12)[0] == 16 + body_len
        if mx_at != -1 else True)
    return checks
