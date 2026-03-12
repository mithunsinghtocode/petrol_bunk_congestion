// ===========================================
// FuelFinder — Station Data (Overpass API)
// ===========================================

const Stations = {
  markerLayer: null,
  CACHE_KEY: 'fuelFinderCachedStations',
  ROADS_CACHE_KEY: 'fuelFinderCachedRoads',
  lastQueryCenter: null,
  _cachedRoads: null,
  _fetching: false,

  // Overpass API mirrors for failover
  OVERPASS_MIRRORS: [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
  ],

  async fetchNearby(lat, lng, radiusMeters) {
    // Prevent concurrent requests
    if (this._fetching) return this.loadCached(lat, lng);
    this._fetching = true;

    // Single combined Overpass query: fuel stations + major roads (limited to 2km for roads to avoid timeouts)
    const roadRadius = Math.min(radiusMeters, 2000);
    const query = `[out:json][timeout:30];(node["amenity"="fuel"](around:${radiusMeters},${lat},${lng});way["amenity"="fuel"](around:${radiusMeters},${lat},${lng});way["highway"~"^(trunk|trunk_link|primary|primary_link|secondary|tertiary|motorway)$"](around:${roadRadius},${lat},${lng}););out center body;`;

    // Try each mirror
    let lastErr = null;
    for (const mirror of this.OVERPASS_MIRRORS) {
      const url = mirror + '?data=' + encodeURIComponent(query);
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error('Overpass API error: ' + res.status);
        const data = await res.json();

        // Separate fuel stations from roads
        const fuelElements = [];
        const roadElements = [];
        (data.elements || []).forEach(el => {
          const tags = el.tags || {};
          if (tags.amenity === 'fuel') {
            fuelElements.push(el);
          } else if (tags.highway) {
            roadElements.push(el);
          }
        });

        // Cache stations for offline use
        try {
          localStorage.setItem(this.CACHE_KEY, JSON.stringify({
            timestamp: Date.now(), lat, lng, radius: radiusMeters, data: fuelElements
          }));
        } catch { /* storage full */ }

        // Cache roads
        this._cachedRoads = roadElements.map(el => ({
          lat: el.center ? el.center.lat : el.lat,
          lng: el.center ? el.center.lon : el.lon,
          highway: el.tags ? el.tags.highway : 'unknown',
          lanes: parseInt(el.tags?.lanes) || 0
        })).filter(r => r.lat && r.lng);

        try {
          localStorage.setItem(this.ROADS_CACHE_KEY, JSON.stringify(this._cachedRoads));
        } catch {}

        this.lastQueryCenter = { lat, lng };
        this._fetching = false;
        return this.processResults(fuelElements, lat, lng);
      } catch (err) {
        lastErr = err;
        console.warn(`Overpass mirror ${mirror} failed:`, err.message);
      }
    }

    // All mirrors failed
    this._fetching = false;
    console.warn('All Overpass mirrors failed, trying cache:', lastErr);
    try {
      this._cachedRoads = JSON.parse(localStorage.getItem(this.ROADS_CACHE_KEY)) || [];
    } catch { this._cachedRoads = []; }
    return this.loadCached(lat, lng);
  },

  async loadCached(userLat, userLng) {
    // Try localStorage first
    try {
      const cached = JSON.parse(localStorage.getItem(this.CACHE_KEY));
      if (cached && cached.data) {
        return this.processResults(cached.data, userLat, userLng);
      }
    } catch {}

    // Fallback: load from bundled stations_cache.json (for first-time users when Overpass is down)
    try {
      const res = await fetch('data/stations_cache.json');
      if (res.ok) {
        const cache = await res.json();
        if (cache.stations && cache.stations.length > 0) {
          // Convert to Overpass-like elements for processResults
          const elements = cache.stations.map(s => ({
            id: s.id,
            lat: s.lat,
            lon: s.lng,
            tags: { amenity: 'fuel', name: s.name, brand: s.brand || '' }
          }));
          return this.processResults(elements, userLat, userLng);
        }
      }
    } catch {}

    return [];
  },

  processResults(elements, userLat, userLng) {
    if (!elements || elements.length === 0) return [];

    const stations = elements.map(el => {
      const tags = el.tags || {};
      const lat = el.lat || (el.center && el.center.lat);
      const lng = el.lon || (el.center && el.center.lon);
      if (!lat || !lng) return null;

      const distance = Utils.haversineDistance(userLat, userLng, lat, lng);

      // Check if OSM has explicit fuel type tags
      const hasExplicitFuel = ['fuel:octane_91','fuel:octane_95','fuel:octane_98',
        'fuel:diesel','fuel:lpg','fuel:cng'].some(k => tags[k] === 'yes' || tags[k] === 'no');

      // If no explicit tags, assume standard Indian station (petrol + diesel)
      const fuelTypes = hasExplicitFuel ? {
        petrol: tags['fuel:octane_95'] === 'yes' || tags['fuel:octane_98'] === 'yes' || tags['fuel:octane_91'] === 'yes',
        diesel: tags['fuel:diesel'] === 'yes',
        lpg: tags['fuel:lpg'] === 'yes',
        cng: tags['fuel:cng'] === 'yes'
      } : {
        petrol: true,
        diesel: true,
        lpg: false,
        cng: false
      };

      return {
        id: el.id,
        name: tags.name || tags.brand || 'Fuel Station',
        brand: tags.brand || tags.operator || '',
        lat, lng,
        address: [tags['addr:street'], tags['addr:city'], tags['addr:postcode']]
          .filter(Boolean).join(', ') || 'Address unavailable',
        distance,
        fuelTypes,
        fuelEstimated: !hasExplicitFuel, // true if we guessed the fuel types
        openingHours: tags.opening_hours || '24/7',
        // These will be populated by Reports.mergeReports
        congestion: null,
        waitTime: null,
        isOpen: true,
        lastReport: null,
        reportCount: 0
      };
    }).filter(Boolean);

    // Sort by distance
    stations.sort((a, b) => a.distance - b.distance);

    // Merge crowdsourced reports
    const merged = Reports.mergeReports(stations);

    // Auto-estimate congestion for stations without reports
    return merged.map(s => {
      if (s.congestion || s.lastReport) return s; // has real data
      const estimated = this._estimateCongestion(s, this._cachedRoads);
      // Estimate wait time from congestion level
      const waitMap = { low: '<5', medium: '<15', high: '15-30' };
      return { ...s, congestion: estimated, waitTime: waitMap[estimated] || '<5', autoEstimated: true };
    });
  },

  renderMarkers(stations, map) {
    if (this.markerLayer) {
      map.removeLayer(this.markerLayer);
    }
    this.markerLayer = L.layerGroup();

    stations.forEach(station => {
      const closed = station.isOpen === false;
      const color = closed ? '#6b7280' : Utils.congestionColor(station.congestion);
      const darkColor = closed ? '#4b5563' : this._darken(color);
      const waitLabel = station.waitTime ? Utils.waitTimeLabel(station.waitTime) : '';

      // Build custom HTML marker
      const icon = L.divIcon({
        className: 'custom-marker-wrapper',
        iconSize: [36, 44],
        iconAnchor: [18, 44],
        popupAnchor: [0, -44],
        html: `
          <div class="fuel-marker ${closed ? 'closed' : ''} ${station.congestion || 'unknown'}" style="--marker-color:${color};--marker-dark:${darkColor}">
            <div class="marker-pin">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="white" stroke="white" stroke-width="0.5">
                <path d="M3 22V6a2 2 0 012-2h6a2 2 0 012 2v7h1a2 2 0 012 2v4a1 1 0 002 0v-7l-2.35-2.35a1 1 0 010-1.41l1.41-1.41a1 1 0 011.41 0L21 10v9a3 3 0 01-6 0v-4h-1a2 2 0 01-2-2V6H5v16"/>
              </svg>
            </div>
            <div class="marker-point"></div>
            ${waitLabel ? `<div class="marker-wait">${waitLabel}</div>` : ''}
          </div>`
      });

      const marker = L.marker([station.lat, station.lng], { icon });

      // Tooltip
      const status = closed ? 'CLOSED' : Utils.congestionLabel(station.congestion);
      const estTag = station.autoEstimated ? ' (est.)' : '';
      marker.bindTooltip(
        `<strong>${Utils.escapeHtml(station.name)}</strong><br>${Utils.formatDistance(station.distance)} &middot; ${status}${estTag}`,
        { direction: 'top', offset: [0, -48], className: 'station-tooltip' }
      );

      // Click: show quick-report popup; tap station name for detail
      marker.on('click', () => {
        const hasReport = !!station.lastReport;
        const sid = Number(station.id);
        const safeName = Utils.escapeHtml(station.name);
        const popupHtml = `
          <div class="quick-report-popup">
            <div class="qr-title" data-sid="${sid}">${safeName} →</div>
            <div class="qr-label">${hasReport ? 'Update congestion:' : 'How busy is it?'}</div>
            <div class="qr-buttons">
              <button class="qr-btn qr-low" data-sid="${sid}" data-cong="low">Low</button>
              <button class="qr-btn qr-medium" data-sid="${sid}" data-cong="medium">Medium</button>
              <button class="qr-btn qr-high" data-sid="${sid}" data-cong="high">High</button>
            </div>
          </div>`;
        marker.unbindPopup();
        marker.bindPopup(popupHtml, {
          className: 'quick-report-wrapper',
          closeButton: false,
          offset: [0, -44],
          maxWidth: 200
        }).openPopup();
      });
      marker.stationId = station.id;
      this.markerLayer.addLayer(marker);
    });

    this.markerLayer.addTo(map);
  },

  getRecommendations(stations, fuelTypeFilter) {
    return stations
      .map(s => {
        // Closed stations get a massive penalty so they sink to bottom
        let score = s.isOpen === false ? 1000 : 0;
        // Distance factor (0-3 range for typical 0-10km)
        score += s.distance * 0.3;
        // Congestion: low=1, medium=4, high=8, unknown=2
        score += s.congestion ? { low: 1, medium: 4, high: 8 }[s.congestion] : 2;
        // Data reliability bonus: live traffic & user reports are most trustworthy
        if (s.trafficLive) score -= 1;       // live TomTom data
        if (s.lastReport) score -= 1.5;      // crowdsourced report (best)
        if (s.autoEstimated) score += 0.5;   // road+time guess (least reliable)
        // Wait time: lower is better
        score += s.waitTime ? { '<15': 0, '15-30': 2, '30-60': 5, '>60': 10 }[s.waitTime] || 3 : 1;
        // Penalize stations without the needed fuel type
        if (fuelTypeFilter && !s.fuelTypes[fuelTypeFilter]) score += 5;
        return { ...s, score };
      })
      .sort((a, b) => a.score - b.score);
  },

  // Estimate congestion using nearby road analysis + time of day
  _estimateCongestion(station, nearbyRoads) {
    const hour = new Date().getHours();
    const day = new Date().getDay(); // 0=Sun
    const isWeekend = day === 0 || day === 6;

    // Base score from time of day (0-10)
    // Indian context: morning office rush, evening return, lunch break dip
    let timeScore;
    if ((hour >= 7 && hour < 10) || (hour >= 17 && hour < 20)) {
      timeScore = isWeekend ? 6 : 8; // peak hours
    } else if (hour >= 10 && hour < 13) {
      timeScore = isWeekend ? 4 : 5; // late morning
    } else if (hour >= 13 && hour < 17) {
      timeScore = isWeekend ? 3 : 5; // afternoon
    } else {
      timeScore = 2; // night/early morning
    }

    // Road density score from nearby roads (0-10)
    let roadScore = 0;
    if (nearbyRoads && nearbyRoads.length > 0) {
      const roadsNearStation = nearbyRoads.filter(r => {
        const d = Utils.haversineDistance(station.lat, station.lng, r.lat, r.lng);
        return d < 0.3; // within 300m
      });

      // Score based on road types nearby (Indian context: NH/SH = trunk/primary)
      roadsNearStation.forEach(r => {
        const hw = r.highway;
        let base = 0;
        if (hw === 'motorway' || hw === 'motorway_link') base = 4;
        else if (hw === 'trunk' || hw === 'trunk_link' || hw === 'primary' || hw === 'primary_link') base = 3;
        else if (hw === 'secondary' || hw === 'secondary_link' || hw === 'tertiary') base = 2;
        else if (hw === 'residential' || hw === 'unclassified') base = 1;
        // Multi-lane roads = more traffic
        if (r.lanes >= 4) base += 1;
        roadScore += base;
      });
      roadScore = Math.min(10, roadScore);
    } else {
      // No road data: use moderate default
      roadScore = 4;
    }

    // Combine: 55% time, 45% road density
    const combined = (timeScore * 0.55) + (roadScore * 0.45);

    if (combined >= 6.5) return 'high';
    if (combined >= 3.5) return 'medium';
    return 'low';
  },

  _darken(hex) {
    const num = parseInt(hex.replace('#', ''), 16);
    const r = Math.max(0, (num >> 16) - 40);
    const g = Math.max(0, ((num >> 8) & 0xFF) - 40);
    const b = Math.max(0, (num & 0xFF) - 40);
    return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
  }
};
