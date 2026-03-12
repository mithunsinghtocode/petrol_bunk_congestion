// ===========================================
// FuelFinder — Crowdsourced Reports (localStorage)
// ===========================================

const Reports = {
  STORAGE_KEY: 'fuelFinderReports',
  MAX_PER_STATION: 20,
  STALE_HOURS: 2,

  _load() {
    try {
      return JSON.parse(localStorage.getItem(this.STORAGE_KEY)) || {};
    } catch { return {}; }
  },

  _save(data) {
    try {
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(data));
    } catch { /* storage full */ }
  },

  save(report) {
    const data = this._load();
    const key = String(report.stationId);
    if (!data[key]) data[key] = [];
    data[key].unshift(report);
    if (data[key].length > this.MAX_PER_STATION) {
      data[key] = data[key].slice(0, this.MAX_PER_STATION);
    }
    this._save(data);
  },

  getLatest(stationId) {
    const data = this._load();
    const reports = data[String(stationId)];
    return reports && reports.length > 0 ? reports[0] : null;
  },

  getAll(stationId) {
    const data = this._load();
    return data[String(stationId)] || [];
  },

  getAggregated(stationId) {
    const reports = this.getAll(stationId).slice(0, 5);
    if (reports.length === 0) return null;

    // Majority vote for congestion
    const votes = { low: 0, medium: 0, high: 0 };
    reports.forEach(r => { if (r.congestion && votes[r.congestion] !== undefined) votes[r.congestion]++; });
    const congestion = Object.entries(votes).sort((a, b) => b[1] - a[1])[0];

    // Most recent fuel availability
    const latest = reports[0];

    return {
      congestion: congestion[1] > 0 ? congestion[0] : null,
      fuelAvailable: latest.fuelAvailable || {},
      waitTime: latest.waitTime || null,
      isOpen: latest.isOpen !== undefined ? latest.isOpen : true,
      timestamp: latest.timestamp,
      reportCount: reports.length
    };
  },

  mergeReports(stations) {
    return stations.map(station => {
      const agg = this.getAggregated(station.id);
      if (!agg) return station;

      const staleMs = this.STALE_HOURS * 60 * 60 * 1000;
      const isStale = (Date.now() - agg.timestamp) > staleMs;

      const hasReportFuel = Object.keys(agg.fuelAvailable).length > 0;
      return {
        ...station,
        congestion: isStale ? null : agg.congestion,
        waitTime: isStale ? null : agg.waitTime,
        isOpen: agg.isOpen,
        lastReport: agg.timestamp,
        reportCount: agg.reportCount,
        // Override fuel types if we have report data; clear estimated flag
        fuelTypes: hasReportFuel
          ? {
              petrol: !!agg.fuelAvailable.petrol,
              diesel: !!agg.fuelAvailable.diesel,
              lpg: !!agg.fuelAvailable.lpg,
              cng: !!agg.fuelAvailable.cng
            }
          : station.fuelTypes,
        fuelEstimated: hasReportFuel ? false : station.fuelEstimated
      };
    });
  },

  submitReport(stationId, formData) {
    const report = {
      id: Utils.generateId(),
      stationId: stationId,
      timestamp: Date.now(),
      fuelAvailable: formData.fuelAvailable || {},
      congestion: formData.congestion || null,
      waitTime: formData.waitTime || null,
      isOpen: formData.isOpen !== false
    };
    this.save(report);
    return report;
  }
};
