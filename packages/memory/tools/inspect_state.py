import json, io, os

p = os.path.join(os.path.expanduser("~"), ".dsh", "companion-memory", "state.json")
with io.open(p, encoding="utf-8") as f:
    d = json.load(f)

raw = d.get("raw", [])
def is_noise(t):
    t = t or ""
    return ("automatically generated checkpoint" in t
            or "<compacted-summary>" in t
            or "Current runtime context. This snapshot supersedes" in t)

noise = [r for r in raw if is_noise(r.get("text"))]
assist = [r for r in raw if r.get("role") == "assistant"]
sessions = d.get("sessions", {})
cache_total = 0
cache_noise = 0
for sid, c in sessions.items():
    for row in c.get("recent", []):
        cache_total += 1
        t = row.get("text")
        if row.get("role") != "user" or is_noise(t):
            cache_noise += 1

print("raw=%d noise_in_raw=%d assistant_in_raw=%d" % (len(raw), len(noise), len(assist)))
print("session_caches=%d cached_rows=%d cache_noise_left=%d" % (len(sessions), cache_total, cache_noise))
print("facts=%d episodes=%d moods=%d" % (len(d.get("facts", [])), len(d.get("episodes", [])), len(d.get("moods", []))))
anchored = sum(1 for r in raw if (r.get("anchor") or {}).get("sessionId"))
print("raw_with_session_anchor=%d" % anchored)
