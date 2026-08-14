import json
import os
import sys

files = sys.argv[1:]
keys_to_add = {
    "usageTitle": "Distillation usage",
    "usageEmpty": "No distillation usage recorded yet",
    "usageTasks": "{count, plural, one {# task} other {# tasks}}",
    "usageTokens": "Total tokens",
    "usageUsd": "Total cost (USD)",
    "loadUsageFailed": "Could not load distillation usage",
}


def find_dist(d, parent=None, key=None):
    if isinstance(d, dict):
        if "distillation" in d and isinstance(d["distillation"], dict):
            return d, "distillation", d["distillation"]
        for k, v in d.items():
            r = find_dist(v, d, k)
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
    parent, key, dist = find_dist(data["memory"])
    if dist is None or "globalUnavailable" not in dist or "usageTitle" in dist:
        continue
    items = list(dist.items())
    idx = [k for k, _ in items].index("globalUnavailable")
    new_items = items[: idx + 1]
    for k in ["usageTitle", "usageEmpty", "usageTasks", "usageTokens", "usageUsd", "loadUsageFailed"]:
        new_items.append((k, keys_to_add[k]))
    new_items.extend(items[idx + 1 :])
    parent[key] = dict(new_items)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
    print(path)
