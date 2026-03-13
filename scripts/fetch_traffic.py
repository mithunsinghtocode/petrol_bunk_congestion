#!/usr/bin/env python3
"""
FuelFinder — Smart Per-Station Traffic Fetcher

Queries TomTom Traffic Flow at each petrol bunk's EXACT coordinates.
When cars queue at a station, TomTom detects slower speeds right there.

Budget: 2,500 free requests/day — fully utilized via smart scheduling.

Strategy:
  - Time-aware batching: larger batches during peak traffic hours (AM/PM rush),
    smaller batches at night.  Script runs every 5 min via GitHub Actions;
    it decides internally whether to skip the cycle (off-peak spacing).
  - Priority-weighted rotation: high-priority stations (major brands on busy
    roads) appear 1.5x in rotation, low-priority 0.5x.

Schedule (IST = UTC+5:30):
  Peak AM   07-10  every 5 min   batch 16   →  576 req
  Mid-day   10-13  every 5 min   batch 12   →  432 req
  Afternoon 13-17  every 5 min   batch 10   →  480 req
  Peak PM   17-21  every 5 min   batch 16   →  768 req
  Evening   21-23  every 10 min  batch  8   →   96 req
  Night     23-07  every 15 min  batch  5   →  160 req
  ────────────────────────────────────────────────────
  Total                                      ≈ 2,512 req/day (≤ 2,500 target)

Flow:
  1. Load station list from data/stations_cache.json (or fetch from Overpass)
  2. Determine schedule params (batch size, skip?) from current IST hour
  3. Build priority-weighted rotation list
  4. Pick the next batch from rotation
  5. Fetch TomTom traffic for each
  6. Merge into data/traffic.json (keep previous readings, update queried ones)
  7. Commit via GitHub Actions
"""

import json, os, sys, time, math, urllib.request, urllib.error
from datetime import datetime, timezone, timedelta

TOMTOM_API_KEY = os.environ.get("TOMTOM_API_KEY", "lpsENDetGEPdtooH3AjpJeajDEyjb5i8")
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, "data")

# Chennai metro bounding box
CHENNAI_BBOX = "12.85,80.05,13.25,80.35"

# IST offset
IST = timezone(timedelta(hours=5, minutes=30))

# Schedule: (start_hour_ist, end_hour_ist, batch_size, run_every_n_minutes)
# External cron (cron-job.org) triggers workflow_dispatch every 5 min.
# GitHub Actions */10 cron kept as fallback.
SCHEDULE = [
    (7,  10, 16, 5),   # Peak AM — aggressive refresh
    (10, 13, 12, 5),   # Mid-day
    (13, 17, 10, 5),   # Afternoon
    (17, 21, 16, 5),   # Peak PM — aggressive refresh
    (21, 23,  8, 10),  # Evening — every 10 min
    (23, 24,  5, 15),  # Night (23-00)
    (0,   7,  5, 15),  # Night (00-07)
]

# Priority weights for rotation list
PRIORITY_WEIGHT = {"high": 3, "medium": 2, "low": 1}

# Brands considered high-priority
HIGH_BRANDS = [
    "indian oil", "bharat petroleum", "hindustan petroleum", "hp",
    "shell", "bp", "nayara", "indianoil", "indainoil", "ioc",
]


def get_schedule_params():
    """Return (batch_size, should_run) based on current IST hour and minute."""
    now_ist = datetime.now(IST)
    hour = now_ist.hour
    minute = now_ist.minute

    for start_h, end_h, batch, every_min in SCHEDULE:
        if start_h <= hour < end_h:
            # Should we run this cycle?  GitHub Actions fires every 5 min.
            # If every_min > 5, skip some cycles.
            if every_min <= 5:
                return batch, True
            # Run only if minute aligns (e.g., every 10 min → run at 0,10,20,30,40,50)
            if minute % every_min < 5:  # within the 5-min cron window
                return batch, True
            return 0, False

    # Fallback
    return 5, True


def fetch_stations_from_overpass():
    """Fetch fuel station coordinates from Overpass API (full Chennai metro)."""
    south, west, north, east = [float(x) for x in CHENNAI_BBOX.split(",")]
    query = (
        f'[out:json][timeout:45];'
        f'(node["amenity"="fuel"]({south},{west},{north},{east});'
        f'way["amenity"="fuel"]({south},{west},{north},{east}););'
        f'out center body;'
    )
    url = "https://overpass-api.de/api/interpreter?data=" + urllib.request.quote(query)
    req = urllib.request.Request(url, headers={"User-Agent": "FuelFinder/1.0"})
    with urllib.request.urlopen(req, timeout=45) as resp:
        data = json.loads(resp.read().decode())

    stations = []
    for el in data.get("elements", []):
        tags = el.get("tags", {})
        if tags.get("amenity") != "fuel":
            continue
        lat = el.get("lat") or (el.get("center", {}).get("lat"))
        lng = el.get("lon") or (el.get("center", {}).get("lon"))
        if not lat or not lng:
            continue
        name = tags.get("name") or tags.get("brand") or "Fuel Station"
        brand = tags.get("brand") or tags.get("operator") or ""
        priority = classify_priority(name, brand)
        stations.append({
            "id": el["id"],
            "name": name,
            "brand": brand,
            "lat": lat,
            "lng": lng,
            "priority": priority,
        })
    return stations


def classify_priority(name, brand):
    """Classify station priority based on brand recognition."""
    combined = (name + " " + brand).lower()
    if any(b in combined for b in HIGH_BRANDS):
        return "high"
    if name != "Fuel Station" and name != "fuel station":
        return "medium"
    return "low"


def load_station_cache():
    """Load cached station list, or fetch from Overpass and cache it."""
    cache_path = os.path.join(DATA_DIR, "stations_cache.json")
    if os.path.exists(cache_path):
        with open(cache_path) as f:
            cached = json.load(f)
        age_hours = (time.time() - cached.get("fetched_ts", 0)) / 3600
        if age_hours < 168 and cached.get("stations"):
            return cached["stations"]

    print("Fetching station list from Overpass...")
    stations = fetch_stations_from_overpass()
    if not stations:
        if os.path.exists(cache_path):
            with open(cache_path) as f:
                return json.load(f).get("stations", [])
        return []

    os.makedirs(DATA_DIR, exist_ok=True)
    with open(cache_path, "w") as f:
        json.dump({
            "fetched_ts": time.time(),
            "stations": stations,
            "area": "chennai_metro",
            "bbox": CHENNAI_BBOX.split(","),
        }, f, indent=2)
    print(f"Cached {len(stations)} stations")
    return stations


def build_weighted_rotation(stations):
    """Build a priority-weighted rotation list.

    High-priority stations appear 3x, medium 2x, low 1x.
    This means high stations get refreshed ~3x more often than low ones.
    """
    rotation = []
    for s in stations:
        weight = PRIORITY_WEIGHT.get(s.get("priority", "medium"), 2)
        for _ in range(weight):
            rotation.append(s)
    return rotation


def load_rotation_state():
    """Load rotation state: index + daily request counter."""
    state_path = os.path.join(DATA_DIR, "rotation_state.json")
    if os.path.exists(state_path):
        with open(state_path) as f:
            state = json.load(f)
        # Reset daily counter at midnight IST
        now_ist = datetime.now(IST)
        last_date = state.get("date", "")
        today = now_ist.strftime("%Y-%m-%d")
        if last_date != today:
            state["daily_requests"] = 0
            state["date"] = today
        return state
    return {"next_index": 0, "daily_requests": 0, "date": datetime.now(IST).strftime("%Y-%m-%d")}


def save_rotation_state(state):
    state_path = os.path.join(DATA_DIR, "rotation_state.json")
    with open(state_path, "w") as f:
        json.dump(state, f, indent=2)


def load_existing_traffic():
    """Load existing traffic.json to preserve previous readings."""
    traffic_path = os.path.join(DATA_DIR, "traffic.json")
    if os.path.exists(traffic_path):
        with open(traffic_path) as f:
            return json.load(f)
    return {"timestamp": None, "stations": {}}


def fetch_flow(lat, lng):
    """Fetch TomTom Traffic Flow for a single point."""
    url = (
        f"https://api.tomtom.com/traffic/services/4/flowSegmentData/"
        f"relative0/10/json?point={lat},{lng}&unit=KMPH"
        f"&key={TOMTOM_API_KEY}"
    )
    req = urllib.request.Request(url, headers={"User-Agent": "FuelFinder/1.0"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        data = json.loads(resp.read().decode())

    flow = data.get("flowSegmentData", {})
    current = flow.get("currentSpeed", 0)
    freeflow = flow.get("freeFlowSpeed", 0)
    confidence = flow.get("confidence", 0)

    if freeflow > 0:
        ratio = 1 - (current / freeflow)
        congestion = "high" if ratio >= 0.5 else "medium" if ratio >= 0.2 else "low"
    else:
        congestion = "unknown"

    return {
        "currentSpeed": round(current, 1),
        "freeFlowSpeed": round(freeflow, 1),
        "congestion": congestion,
        "confidence": round(confidence, 2),
    }


def main():
    ts = datetime.now(timezone.utc).isoformat()
    now_ist = datetime.now(IST)

    # 1. Check schedule
    batch_size, should_run = get_schedule_params()
    if not should_run:
        print(f"[{now_ist.strftime('%H:%M IST')}] Skipping cycle (off-peak spacing)")
        sys.exit(0)

    # 2. Load stations
    stations = load_station_cache()
    if not stations:
        print("No stations found. Exiting.")
        sys.exit(1)

    # 3. Check daily budget
    state = load_rotation_state()
    daily_used = state.get("daily_requests", 0)
    remaining = 2500 - daily_used
    if remaining <= 0:
        print(f"[{now_ist.strftime('%H:%M IST')}] Daily budget exhausted ({daily_used} used). Skipping.")
        sys.exit(0)
    # Cap batch to remaining budget
    batch_size = min(batch_size, remaining)

    print(f"[{now_ist.strftime('%H:%M IST')}] {len(stations)} stations | "
          f"batch={batch_size} | budget: {daily_used}/{2500} used")

    # 4. Build weighted rotation and pick batch
    rotation = build_weighted_rotation(stations)
    start_idx = state.get("next_index", 0) % len(rotation)
    batch = []
    seen_ids = set()
    idx = start_idx
    while len(batch) < batch_size and len(seen_ids) < len(stations):
        s = rotation[idx % len(rotation)]
        sid = s["id"]
        if sid not in seen_ids:
            batch.append(s)
            seen_ids.add(sid)
        idx += 1
        # Safety: don't loop forever
        if idx - start_idx > len(rotation):
            break
    next_idx = idx % len(rotation)

    priority_counts = {}
    for s in batch:
        p = s.get("priority", "medium")
        priority_counts[p] = priority_counts.get(p, 0) + 1
    print(f"Batch: {len(batch)} stations (high={priority_counts.get('high',0)}, "
          f"med={priority_counts.get('medium',0)}, low={priority_counts.get('low',0)})")

    # 5. Load existing traffic data
    traffic = load_existing_traffic()
    station_data = traffic.get("stations", {})

    # 6. Fetch TomTom for this batch
    updated = 0
    errors = 0
    for st in batch:
        sid = str(st["id"])
        try:
            flow = fetch_flow(st["lat"], st["lng"])
            station_data[sid] = {
                "name": st["name"],
                "lat": st["lat"],
                "lng": st["lng"],
                "priority": st.get("priority", "medium"),
                "updatedAt": ts,
                **flow,
            }
            updated += 1
            print(f"  OK  {st['name']:30s} [{st.get('priority','?'):6s}] "
                  f"{flow['congestion']:6s}  "
                  f"{flow['currentSpeed']}/{flow['freeFlowSpeed']} km/h")
        except Exception as e:
            errors += 1
            print(f"  ERR {st['name']:30s}  {e}")
        time.sleep(0.3)

    # 7. Prune stale entries (older than 6 hours — covers night gap)
    now = datetime.now(timezone.utc)
    pruned = 0
    for sid in list(station_data.keys()):
        entry = station_data[sid]
        try:
            updated_at = datetime.fromisoformat(entry["updatedAt"])
            age_min = (now - updated_at).total_seconds() / 60
            if age_min > 360:  # 6 hours
                del station_data[sid]
                pruned += 1
        except (KeyError, ValueError):
            del station_data[sid]
            pruned += 1

    # 8. Update state
    state["next_index"] = next_idx
    state["daily_requests"] = daily_used + updated
    state["last_run"] = now_ist.strftime("%H:%M IST")
    save_rotation_state(state)

    # 9. Write output
    output = {
        "timestamp": ts,
        "stationCount": len(station_data),
        "totalStations": len(stations),
        "batchUpdated": updated,
        "errors": errors,
        "dailyRequestsUsed": state["daily_requests"],
        "schedule": f"batch={batch_size} at {now_ist.strftime('%H:%M IST')}",
        "stations": station_data,
    }

    out_path = os.path.join(DATA_DIR, "traffic.json")
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(out_path, "w") as f:
        json.dump(output, f, indent=2)

    print(f"Done: {updated} updated, {errors} errors, {pruned} pruned, "
          f"{len(station_data)} total in traffic.json | "
          f"Daily: {state['daily_requests']}/2500")

    if updated == 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
