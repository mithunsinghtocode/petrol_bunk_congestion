// ===========================================
// FuelFinder — Main App Orchestrator
// ===========================================

const App = {
  map: null,
  userLatLng: null,
  userMarker: null,
  accuracyCircle: null,
  currentStations: [],
  searchRadius: 5000,
  filters: {
    fuelTypes: ['petrol', 'diesel', 'lpg', 'cng'],
    congestionLevels: ['low', 'medium', 'high', 'unknown'],
    radius: 5000
  },

  init() {
    // Dark mode
    const dark = localStorage.getItem('darkMode') === 'true';
    if (dark) document.documentElement.dataset.theme = 'dark';
    this._updateDarkModeIcons(dark);

    // Init map
    this.map = L.map('map', {
      zoomControl: false,
      attributionControl: false
    }).setView([20.5937, 78.9629], 5); // Default: India center

    L.control.zoom({ position: 'bottomleft' }).addTo(this.map);
    L.control.attribution({ position: 'bottomright', prefix: false })
      .addAttribution('&copy; <a href="https://openstreetmap.org">OpenStreetMap</a>')
      .addTo(this.map);

    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19
    }).addTo(this.map);

    // Locate user
    this.locateUser();

    // Init UI
    UI.initBottomSheet();
    UI.initFilterPanel();
    UI.initReportModal();
    this.initSettings();

    // Bind events
    document.getElementById('fab-center').addEventListener('click', () => this.centerOnUser());
    document.getElementById('fab-report').addEventListener('click', () => {
      if (this.currentStations.length > 0) {
        // Open report for nearest station
        const nearest = this.currentStations[0];
        UI.showReportModal(nearest.id, nearest.name);
      } else {
        UI.showToast('No stations loaded yet', 'error');
      }
    });
    document.getElementById('fab-filter').addEventListener('click', () => UI.showFilterPanel());
    document.getElementById('btn-dark-mode').addEventListener('click', () => this.toggleDarkMode());
    document.getElementById('btn-settings').addEventListener('click', () => this.showSettings());
    document.getElementById('detail-back').addEventListener('click', () => {
      UI.hideStationDetail();
      this._showFilteredList();
    });

    // Quick-report popup event delegation (avoids inline onclick)
    document.addEventListener('click', e => {
      const qrBtn = e.target.closest('.qr-btn[data-sid]');
      if (qrBtn) {
        this.quickReport(Number(qrBtn.dataset.sid), qrBtn.dataset.cong);
        return;
      }
      const qrTitle = e.target.closest('.qr-title[data-sid]');
      if (qrTitle) {
        this.selectStation(Number(qrTitle.dataset.sid));
        return;
      }
    });

    // Auto-refresh every 2 minutes to keep data fresh
    this._refreshInterval = setInterval(() => {
      if (!document.hidden && this.userLatLng) {
        this.refreshStations();
      }
    }, 2 * 60 * 1000);
    // Pause refresh when tab is hidden, resume when visible
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && this.userLatLng) {
        this.refreshStations();
      }
    });

    // Refresh when coming back online
    window.addEventListener('online', () => {
      this.refreshStations();
    });
  },

  locateUser() {
    if (!navigator.geolocation) {
      UI.hideLoading();
      UI.showToast('Geolocation not supported. Using default location.', 'error');
      this._onLocationFound({ lat: 13.0827, lng: 80.2707 }, 500);
      return;
    }

    navigator.geolocation.getCurrentPosition(
      pos => {
        this._onLocationFound(
          { lat: pos.coords.latitude, lng: pos.coords.longitude },
          pos.coords.accuracy
        );
      },
      err => {
        console.warn('Geolocation error:', err);
        UI.hideLoading();
        UI.showToast('Location access denied. Using default location.', 'error');
        this._onLocationFound({ lat: 13.0827, lng: 80.2707 }, 5000);
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );

    // Watch for updates
    navigator.geolocation.watchPosition(
      pos => {
        const newLatLng = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        this._updateUserMarker(newLatLng, pos.coords.accuracy);

        // Re-fetch if moved significantly (>1km)
        if (this.userLatLng) {
          const moved = Utils.haversineDistance(
            this.userLatLng.lat, this.userLatLng.lng,
            newLatLng.lat, newLatLng.lng
          );
          if (moved > 1) {
            this.userLatLng = newLatLng;
            this.refreshStations();
          } else {
            this.userLatLng = newLatLng;
          }
        }
      },
      () => {},
      { enableHighAccuracy: true, maximumAge: 30000 }
    );
  },

  async _onLocationFound(latlng, accuracy) {
    this.userLatLng = latlng;
    this.map.setView([latlng.lat, latlng.lng], 14);
    this._updateUserMarker(latlng, accuracy);

    // Fetch stations, then layer on centralized live traffic
    const stations = await Stations.fetchNearby(latlng.lat, latlng.lng, this.searchRadius);
    this.currentStations = await Traffic.applyToStations(stations);
    this._renderAll();
    UI.hideLoading();
  },

  _updateUserMarker(latlng, accuracy) {
    if (this.userMarker) {
      this.userMarker.setLatLng([latlng.lat, latlng.lng]);
    } else {
      this.userMarker = L.marker([latlng.lat, latlng.lng], {
        icon: L.divIcon({
          className: 'user-marker',
          iconSize: [16, 16],
          iconAnchor: [8, 8]
        }),
        zIndexOffset: 1000
      }).addTo(this.map);
    }

    if (this.accuracyCircle) {
      this.accuracyCircle.setLatLng([latlng.lat, latlng.lng]);
      this.accuracyCircle.setRadius(Math.min(accuracy, 500));
    } else {
      this.accuracyCircle = L.circle([latlng.lat, latlng.lng], {
        radius: Math.min(accuracy, 500),
        className: 'accuracy-circle',
        interactive: false
      }).addTo(this.map);
    }
  },

  _renderAll() {
    const filtered = this._applyFilterLogic(this.currentStations);
    Stations.renderMarkers(filtered, this.map);
    this._showFilteredList(filtered);
  },

  _showFilteredList(filtered) {
    if (!filtered) filtered = this._applyFilterLogic(this.currentStations);
    const recommended = Stations.getRecommendations(filtered);
    UI.showStationList(recommended);
  },

  _applyFilterLogic(stations) {
    return stations.filter(s => {
      // Fuel type filter: show station if it has at least one of the selected fuel types
      // OR if it has no fuel data (no reports yet)
      const hasFuelData = Object.values(s.fuelTypes).some(v => v);
      if (hasFuelData) {
        const matchesFuel = this.filters.fuelTypes.some(ft => s.fuelTypes[ft]);
        if (!matchesFuel) return false;
      }

      // Congestion filter
      const congLevel = s.congestion || 'unknown';
      if (!this.filters.congestionLevels.includes(congLevel)) return false;

      return true;
    });
  },

  selectStation(stationId) {
    const station = this.currentStations.find(s => s.id === stationId);
    if (!station) return;

    this.map.setView([station.lat, station.lng], 16, { animate: true });
    UI.showStationDetail(station);
  },

  async applyFilters(filters) {
    const radiusChanged = filters.radius !== this.searchRadius;
    this.filters = { ...this.filters, ...filters };
    this.searchRadius = filters.radius || this.searchRadius;

    if (radiusChanged && this.userLatLng) {
      const stations = await Stations.fetchNearby(
        this.userLatLng.lat, this.userLatLng.lng, this.searchRadius
      );
      this.currentStations = stations;
    }

    this._renderAll();
    UI.showToast('Filters applied', 'success');
  },

  async refreshStations(localOnly) {
    if (!this.userLatLng) return;

    if (localOnly) {
      // Re-merge reports onto existing stations without re-fetching
      const base = this.currentStations.map(s => ({
        ...s, congestion: null, waitTime: null, isOpen: true,
        lastReport: null, reportCount: 0, autoEstimated: false, trafficLive: false
      }));
      const merged = Reports.mergeReports(base);
      // Re-apply auto-estimation for stations still without reports
      let estimated = merged.map(s => {
        if (s.congestion || s.lastReport) return s;
        return { ...s, congestion: Stations._estimateCongestion(s, Stations._cachedRoads), autoEstimated: true };
      });
      // Layer on centralized live traffic (overrides estimation, not user reports)
      this.currentStations = await Traffic.applyToStations(estimated);
    } else {
      const stations = await Stations.fetchNearby(
        this.userLatLng.lat, this.userLatLng.lng, this.searchRadius
      );
      this.currentStations = await Traffic.applyToStations(stations);
    }

    this._renderAll();

    // Refresh detail view if open
    if (UI._currentStation) {
      const updated = this.currentStations.find(s => s.id === UI._currentStation.id);
      if (updated) UI.showStationDetail(updated);
    }
  },

  // Quick congestion report from map popup (one-tap)
  quickReport(stationId, congestion) {
    Reports.submitReport(stationId, {
      fuelAvailable: {},
      congestion,
      waitTime: null,
      isOpen: true
    });
    this.map.closePopup();
    UI.showToast(`Reported ${Utils.congestionLabel(congestion)}! Thanks`, 'success');
    this.refreshStations(true);
  },

  centerOnUser() {
    if (this.userLatLng) {
      this.map.setView([this.userLatLng.lat, this.userLatLng.lng], 14, { animate: true });
    }
  },

  toggleDarkMode() {
    const isDark = document.documentElement.dataset.theme === 'dark';
    if (isDark) {
      delete document.documentElement.dataset.theme;
      localStorage.setItem('darkMode', 'false');
    } else {
      document.documentElement.dataset.theme = 'dark';
      localStorage.setItem('darkMode', 'true');
    }
    this._updateDarkModeIcons(!isDark);
  },

  // --- Settings Panel ---
  showSettings() {
    const panel = document.getElementById('settings-panel');
    const backdrop = document.getElementById('settings-backdrop');
    panel.classList.add('show');
    backdrop.classList.add('show');

    const layerEnabled = Traffic.isLayerEnabled();
    document.getElementById('traffic-layer-on').checked = layerEnabled;
    document.getElementById('traffic-layer-off').checked = !layerEnabled;

    this._updateTrafficStatus();
  },

  hideSettings() {
    document.getElementById('settings-panel').classList.remove('show');
    document.getElementById('settings-backdrop').classList.remove('show');
  },

  async _updateTrafficStatus() {
    const el = document.getElementById('traffic-status');
    const data = await Traffic.fetchData();
    if (data && data.stations && Object.keys(data.stations).length > 0) {
      const count = data.stationCount || Object.keys(data.stations).length;
      const age = data._ageMinutes || 0;
      const freshness = data._stale ? `stale (${age}m ago)` : `updated ${age}m ago`;
      el.innerHTML = `<span style="color:#16a34a">${count} stations monitored &middot; ${freshness}</span>`;
    } else {
      el.innerHTML = '<span style="color:var(--text-muted)">No live data — using road + time estimation</span>';
    }
  },

  initSettings() {
    document.getElementById('settings-backdrop').addEventListener('click', () => this.hideSettings());
    document.getElementById('settings-save').addEventListener('click', () => {
      const layerOn = document.getElementById('traffic-layer-on').checked;
      Traffic.setLayerEnabled(layerOn, this.map);
      this.hideSettings();
      UI.showToast('Settings saved', 'success');
    });

    // Restore traffic layer state on boot
    if (Traffic.isLayerEnabled()) {
      Traffic.setLayerEnabled(true, this.map);
    }
  },

  _updateDarkModeIcons(isDark) {
    document.getElementById('icon-sun').style.display = isDark ? 'none' : '';
    document.getElementById('icon-moon').style.display = isDark ? '' : 'none';
  }
};

// Boot
document.addEventListener('DOMContentLoaded', () => App.init());
