"""Resolve a BBL bundled preset's `inherits` chain into a flat JSON profile."""
import json
import os
import sys

# The BBL profile tree is copied out of the sidecar image at run time
# (`docker cp spike-orca:/app/squashfs-root/resources/profiles/BBL .`), so it
# lives in the caller's working directory, not next to this script.
ROOT = os.environ.get("BBL_ROOT", os.path.join(os.getcwd(), "BBL"))


def index(category):
    d = os.path.join(ROOT, category)
    idx = {}
    for fn in os.listdir(d):
        if not fn.endswith(".json"):
            continue
        try:
            j = json.load(open(os.path.join(d, fn)))
        except Exception:
            continue
        name = j.get("name") or fn[:-5]
        idx[name] = j
    return idx


def resolve(category, name):
    idx = index(category)
    chain = []
    cur = name
    seen = set()
    while cur and cur in idx and cur not in seen:
        seen.add(cur)
        j = idx[cur]
        chain.append(j)
        cur = j.get("inherits")
    if cur and cur not in idx:
        raise SystemExit(f"missing base {cur!r} for {name!r} in {category}")
    merged = {}
    for j in reversed(chain):  # base first
        merged.update(j)
    merged["name"] = name
    merged.pop("inherits", None)
    merged.pop("instantiation", None)
    return merged


if __name__ == "__main__":
    print(json.dumps(resolve(sys.argv[1], sys.argv[2]), indent=1))
