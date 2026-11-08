import json, io, os, collections

p = os.path.join(os.path.expanduser("~"), ".dsh", "companion-memory", "state.json")
d = json.load(io.open(p, encoding="utf-8"))
raw = d.get("raw", [])
pats = [
    "You are repeating the exact same tool call",
    "Current runtime context",
    "<compacted-summary>",
    "<goal_round>",
    "automatically generated checkpoint",
    "Approval prompts are disabled",
    "Time sampled while preparing turn",
    "[model changed",
    "<system-reminder>",
    "available skill catalog changed",
    "Elapsed since",
    "Agent ",
]
c = collections.Counter()
for r in raw:
    t = r.get("text") or ""
    for pat in pats:
        if pat in t:
            c[pat] += 1
print("raw", len(raw))
for k, v in c.most_common():
    print(v, "|", k)
print("roles", collections.Counter(r.get("role") for r in raw))
print("facts", len(d.get("facts", [])), "episodes", len(d.get("episodes", [])), "profile", len(d.get("profile", [])))
