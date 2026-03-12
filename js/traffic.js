// ===========================================
// FuelFinder — Per-Station Live Traffic
// ===========================================
// Traffic data is fetched by GitHub Actions (scripts/fetch_traffic.py) at each
// station's EXACT coordinates. When cars queue at a petrol bunk, TomTom detects
// slower speeds right there. Stations rotate every 5 min (~8 per cycle).
// Browsers read from data/traffic.json — no browser hits TomTom directly.

const Traffic = {
  _cache: null,
  _cacheTime: 0,
  CACHE_TTL: 2 * 60 * 1000, // re-read JSON every 2 min
  DATA_URL: 'data/traffic.json',
  TILE_KEY: 'lpsENDetGEPdtooH3AjpJeajDEyjb5i8',
  _tileLayer: null,

  // --- Centralized per-station traffic data ---

  /** Fetch the centralized traffic JSON (cached for 2 min in memory). */
  async fetchData() {
    const now = Date.now();
    if (this._cache && (now - this._cacheTime) < this.CACHE_TTL) {
      return this._cache;
    }

    try {
      const res = await fetch(this.DATA_URL + '?t=' + now);
      if (!res.ok) throw new Error(res.status);
      const data = await res.json();

      // Freshness check
      const age = now - new Date(data.timestamp).getTime();
      data._stale = age > 3 * 60 * 60 * 1000; // 3 hours (off-peak stations may be 2-3h old)
      data._ageMinutes = Math.round(age / 60000);

      this._cache = data;
      this._cacheTime = now;
      return data;
    } catch (err) {
      console.warn('Traffic data unavailable:', err.message || err);
      return null;
    }
  },

  /** Apply per-station traffic data. Matches by station ID (exact).
   *  User reports always take priority. */
  async applyToStations(stations) {
    const data = await this.fetchData();
    if (!data || !data.stations) return stations;

    const trafficMap = data.stations; // keyed by station ID
    let liveCount = 0;
    const now = Date.now();

    const enhanced = stations.map(s => {
      // Never override fresh crowdsourced reports (that still have congestion data)
      if (s.lastReport && s.congestion) return s;

      const entry = trafficMap[String(s.id)];
      if (!entry) return s;

      // Check per-station freshness (each station has its own updatedAt)
      const entryAge = now - new Date(entry.updatedAt).getTime();
      const isStale = entryAge > 3 * 60 * 60 * 1000; // 3 hours (off-peak refresh gaps)

      // Estimate wait time from speed ratio
      // When traffic slows near a bunk, vehicles are likely queuing
      const speedRatio = entry.freeFlowSpeed > 0
        ? entry.currentSpeed / entry.freeFlowSpeed : 1;
      let waitTime;
      if (speedRatio < 0.2) waitTime = '>60';
      else if (speedRatio < 0.5) waitTime = '30-60';
      else if (speedRatio < 0.8) waitTime = '15-30';
      else if (speedRatio < 0.95) waitTime = '<15';
      else waitTime = '<5';

      liveCount++;
      return {
        ...s,
        congestion: entry.congestion,
        waitTime: waitTime,
        trafficLive: true,
        trafficStale: isStale,
        trafficSpeed: entry.currentSpeed,
        trafficFreeFlow: entry.freeFlowSpeed,
        trafficUpdatedAgo: Math.round(entryAge / 60000),
        autoEstimated: false
      };
    });

    if (liveCount > 0) {
      console.log(`Live traffic: ${liveCount}/${stations.length} stations (per-station)`);
    }
    return enhanced;
  },

  // --- Traffic tile layer (visual overlay, uses separate 50K/day tile quota) ---

  addTrafficLayer(map) {
    if (this._tileLayer) return;
    this._tileLayer = L.tileLayer(
      `https://api.tomtom.com/traffic/map/4/tile/flow/relative0/{z}/{x}/{y}.png?key=${this.TILE_KEY}&tileSize=256`,
      { maxZoom: 18, opacity: 0.6, zIndex: 400, errorTileUrl: '' }
    );
    this._tileLayer.on('tileerror', () => {
      if (this._tileLayer) { map.removeLayer(this._tileLayer); this._tileLayer = null; }
    });
    this._tileLayer.addTo(map);
  },

  removeTrafficLayer(map) {
    if (this._tileLayer) { map.removeLayer(this._tileLayer); this._tileLayer = null; }
  },

  isLayerEnabled() {
    return localStorage.getItem('fuelFinderTrafficLayer') === 'on';
  },

  setLayerEnabled(enabled, map) {
    localStorage.setItem('fuelFinderTrafficLayer', enabled ? 'on' : 'off');
    if (enabled) this.addTrafficLayer(map);
    else this.removeTrafficLayer(map);
  }
};
