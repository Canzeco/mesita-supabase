#!/usr/bin/env python3
"""Atlas channel-link discovery benchmark (Firecrawl vs Perplexity).

Runs resolveChannels-equivalent queries against live APIs and scores precision
against labeled fixtures. Requires FIRECRAWL_API_KEY; PERPLEXITY_KEY optional
for fallback comparison.

Usage:
  cd mesita-supabase
  python3 scripts/atlas_link_benchmark.py
  python3 scripts/atlas_link_benchmark.py --fixtures scripts/atlas_link_benchmark_fixtures.json
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

FIRECRAWL_SEARCH = "https://api.firecrawl.dev/v1/search"
PERPLEXITY_URL = "https://api.perplexity.ai/chat/completions"


def fold(s: str) -> str:
    return s.lower()


def canonical_host_path(url: str) -> str:
    m = re.match(r"https?://([^/]+)(/.*)?", url.strip(), re.I)
    if not m:
        return url.lower()
    host = m.group(1).lower().removeprefix("www.")
    path = (m.group(2) or "").rstrip("/").lower()
    return f"{host}{path}"


def hit(truth: str | None, found: str | None) -> bool | None:
    if truth is None:
        return None
    if not found:
        return False
    return canonical_host_path(truth) == canonical_host_path(found)


def firecrawl_search(api_key: str, query: str, limit: int = 6) -> list[str]:
    body = json.dumps({"query": query, "limit": limit}).encode()
    req = urllib.request.Request(
        FIRECRAWL_SEARCH,
        data=body,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=25) as resp:
            data = json.load(resp)
    except (urllib.error.URLError, TimeoutError):
        return []
    arr: list[Any] = []
    raw = data.get("data")
    if isinstance(raw, list):
        arr = raw
    elif isinstance(raw, dict):
        for key in ("web", "news", "images"):
            if isinstance(raw.get(key), list):
                arr.extend(raw[key])
    elif isinstance(data.get("results"), list):
        arr = data["results"]
    urls: list[str] = []
    for item in arr:
        if isinstance(item, dict) and isinstance(item.get("url"), str):
            urls.append(item["url"])
    return urls


def pick_first(urls: list[str], host_needles: tuple[str, ...], path_re: str | None = None) -> str | None:
    rx = re.compile(path_re, re.I) if path_re else None
    for u in urls:
        low = u.lower()
        if not any(n in low for n in host_needles):
            continue
        if rx and not rx.search(u):
            continue
        return u
    return None


def discover_firecrawl(api_key: str, venue: dict[str, Any]) -> dict[str, str | None]:
    scope = f"{venue['name']} {venue.get('city', '')}".strip()
    ig = firecrawl_search(api_key, f"{scope} instagram")
    fb = firecrawl_search(api_key, f"{scope} facebook")
    ot = firecrawl_search(api_key, f"{scope} opentable")
    ue = firecrawl_search(api_key, f"{scope} uber eats")
    return {
        "instagram_url": pick_first(ig, ("instagram.com",), r"instagram\.com/[^/?#]+/?$"),
        "facebook_url": pick_first(fb, ("facebook.com", "fb.com"), r"facebook\.com/[^/?#]+"),
        "opentable_url": pick_first(ot, ("opentable.",), r"/r/"),
        "uber_eats_url": pick_first(ue, ("ubereats.com",), r"/store/"),
    }


def discover_perplexity(api_key: str, venue: dict[str, Any]) -> dict[str, str | None]:
    prompt = (
        f"Find official Instagram, Facebook, OpenTable, and Uber Eats URLs for "
        f"\"{venue['name']}\" in {venue.get('locationLine', venue.get('city', ''))}. "
        f"Return JSON keys: instagram_url, facebook_url, opentable_url, uber_eats_url. "
        f"Use null when unsure."
    )
    body = json.dumps(
        {
            "model": "sonar-pro",
            "messages": [
                {"role": "system", "content": "Output only JSON. Never invent URLs."},
                {"role": "user", "content": prompt},
            ],
            "response_format": {"type": "json_object"},
        }
    ).encode()
    req = urllib.request.Request(
        PERPLEXITY_URL,
        data=body,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=45) as resp:
            data = json.load(resp)
    except (urllib.error.URLError, TimeoutError):
        return {}
    content = (
        data.get("choices", [{}])[0]
        .get("message", {})
        .get("content", "{}")
    )
    try:
        parsed = json.loads(content)
    except json.JSONDecodeError:
        return {}
    if not isinstance(parsed, dict):
        return {}
    return {
        k: (parsed.get(k) if isinstance(parsed.get(k), str) else None)
        for k in ("instagram_url", "facebook_url", "opentable_url", "uber_eats_url")
    }


def score_provider(rows: list[dict[str, Any]], provider: str, field: str) -> dict[str, Any]:
    labeled = [r for r in rows if r["truth"].get(field) is not None]
    if not labeled:
        return {"field": field, "provider": provider, "labeled": 0, "hits": 0, "precision": None}
    hits = sum(1 for r in labeled if r["results"][provider].get(field) and hit(r["truth"][field], r["results"][provider][field]))
    return {
        "field": field,
        "provider": provider,
        "labeled": len(labeled),
        "hits": hits,
        "precision": round(hits / len(labeled), 3),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--fixtures",
        default=str(Path(__file__).with_name("atlas_link_benchmark_fixtures.json")),
    )
    args = parser.parse_args()

    fc_key = os.environ.get("FIRECRAWL_API_KEY", "").strip()
    pp_key = os.environ.get("PERPLEXITY_KEY", "").strip()
    if not fc_key:
        print("FIRECRAWL_API_KEY required", file=sys.stderr)
        return 1

    fixtures = json.loads(Path(args.fixtures).read_text())
    rows: list[dict[str, Any]] = []
    for venue in fixtures:
        row = {
            "name": venue["name"],
            "truth": venue.get("truth", {}),
            "results": {
                "firecrawl": discover_firecrawl(fc_key, venue),
            },
        }
        if pp_key:
            row["results"]["perplexity"] = discover_perplexity(pp_key, venue)
        rows.append(row)
        print(f"\n=== {venue['name']} ===")
        for provider, found in row["results"].items():
            print(f"  [{provider}]")
            for field in ("instagram_url", "facebook_url", "opentable_url", "uber_eats_url"):
                truth = row["truth"].get(field)
                val = found.get(field)
                if truth is None and not val:
                    continue
                mark = ""
                scored = hit(truth, val)
                if scored is True:
                    mark = " ✓"
                elif scored is False:
                    mark = " ✗"
                print(f"    {field}: {val or '—'}{mark}")

    print("\n=== SUMMARY ===")
    for field in ("instagram_url", "facebook_url", "opentable_url", "uber_eats_url"):
        for provider in rows[0]["results"].keys():
            s = score_provider(rows, provider, field)
            if s["labeled"]:
                print(
                    f"{field:16} {provider:12} "
                    f"{s['hits']}/{s['labeled']} ({s['precision']:.1%})"
                )

    out = Path(__file__).with_name("atlas_link_benchmark_results.json")
    out.write_text(json.dumps(rows, indent=2))
    print(f"\nWrote {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
