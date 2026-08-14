import json
import sys

files = sys.argv[1:]
keys_to_add = {
    "captureStatusTitle": "L0 capture status",
    "captureSuccess": "Captured",
    "captureFailure": "Failed",
    "captureLastSuccess": "Last success: {when}",
    "captureLastFailure": "Last failure: {when} ({category})",
    "loadStatusFailed": "Could not load L0 capture status",
}


def find_l0(d, parent=None, key=None):
    if isinstance(d, dict):
        if "l0" in d and isinstance(d["l0"], dict):
            return d, "l0", d["l0"]
        for k, v in d.items():
            r = find_l0(v, d, k)
            if r is not None:
                return r
    return None


for path in files:
    with open(path, "r", encoding="utf-8") as fh:
        text = fh.read()
    try:
        data = json.loads(text)
    except Exception:
        print(f"SKIP {path}")
        continue
    if "memory" not in data:
        continue
    parent, key, l0 = find_l0(data["memory"])
    if l0 is None or "permanentDeleteFailed" not in l0 or "captureStatusTitle" in l0:
        continue
    items = list(l0.items())
    idx = [k for k, _ in items].index("permanentDeleteFailed")
    new_items = items[: idx + 1]
    for k in [
        "captureStatusTitle",
        "captureSuccess",
        "captureFailure",
        "captureLastSuccess",
        "captureLastFailure",
        "loadStatusFailed",
    ]:
        new_items.append((k, keys_to_add[k]))
    new_items.extend(items[idx + 1 :])
    parent[key] = dict(new_items)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
    print(path)
