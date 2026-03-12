// ===========================================
// FuelFinder — Utility Functions
// ===========================================

const Utils = {
  // Haversine formula: distance between two lat/lng points in km
  haversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  },

  formatDistance(km) {
    if (km < 1) return Math.round(km * 1000) + ' m';
    return km.toFixed(1) + ' km';
  },

  timeAgo(timestamp) {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + ' min ago';
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + ' hr ago';
    const days = Math.floor(hours / 24);
    return days + ' day' + (days > 1 ? 's' : '') + ' ago';
  },

  generateId() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return Date.now().toString(36) + Math.random().toString(36).slice(2);
  },

  debounce(fn, ms) {
    let timer;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), ms);
    };
  },

  escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  },

  congestionScore(level) {
    return { low: 1, medium: 2, high: 3 }[level] || 0;
  },

  congestionColor(level) {
    return {
      low: '#22c55e',
      medium: '#eab308',
      high: '#ef4444'
    }[level] || '#94a3b8';
  },

  congestionLabel(level) {
    return {
      low: 'Low Congestion',
      medium: 'Moderate',
      high: 'Heavy Congestion'
    }[level] || 'Unknown';
  },

  waitTimeLabel(code) {
    return {
      '<5': '< 5 min',
      '<15': '< 15 min',
      '15-30': '15–30 min',
      '30-60': '30–60 min',
      '>60': '> 1 hour'
    }[code] || code || 'Unknown';
  },

  isMobile() {
    return window.innerWidth < 768;
  },

  shareStation(station) {
    const text = `⛽ ${station.name}\n` +
      `📍 ${station.address}\n` +
      `🚦 Congestion: ${Utils.congestionLabel(station.congestion)}\n` +
      `⏱ Wait: ${Utils.waitTimeLabel(station.waitTime)}\n` +
      `🗺 Directions: https://www.google.com/maps/dir/?api=1&destination=${station.lat},${station.lng}`;

    if (navigator.share) {
      navigator.share({ title: 'FuelFinder — ' + station.name, text }).catch(() => {});
    } else {
      navigator.clipboard.writeText(text).then(() => {
        UI.showToast('Copied to clipboard!', 'success');
      }).catch(() => {
        UI.showToast('Could not copy', 'error');
      });
    }
  }
};
