import json, io, os

p = os.path.join(os.path.expanduser("~"), ".dsh", "companion-memory", "state.json")
d = json.load(io.open(p, encoding="utf-8"))
raw = d.get("raw", [])
n = 0
for r in raw:
    t = r.get("text") or ""
    if "Agent " in t or "repeating the exact same tool call" in t:
        n += 1
        print("---", r.get("role"), r.get("source"), (r.get("anchor") or {}).get("eventType"))
        print(t[:220].replace("\n", " "))
print("total", n)
