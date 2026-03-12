// ===========================================
// FuelFinder — UI Interactions
// ===========================================

const UI = {
  activeTab: 'stations',
  sheetState: 'peek',

  // --- Bottom Sheet Drag ---
  initBottomSheet() {
    const sheet = document.getElementById('bottom-sheet');
    const handle = sheet.querySelector('.handle');
    let startY = 0, startTranslate = 0, isDragging = false;

    if (Utils.isMobile()) {
      handle.addEventListener('touchstart', e => {
        isDragging = true;
        startY = e.touches[0].clientY;
        sheet.style.transition = 'none';
      }, { passive: true });

      document.addEventListener('touchmove', e => {
        if (!isDragging) return;
        const dy = e.touches[0].clientY - startY;
        const currentY = this._getSheetTranslate();
        const newY = Math.max(0, currentY + dy);
        sheet.style.transform = `translateY(${newY}px)`;
        startY = e.touches[0].clientY;
      }, { passive: true });

      document.addEventListener('touchend', () => {
        if (!isDragging) return;
        isDragging = false;
        sheet.style.transition = '';
        const sheetHeight = sheet.offsetHeight;
        const currentY = this._getSheetTranslate();
        const ratio = currentY / sheetHeight;

        if (ratio > 0.65) this.setSheetState('peek');
        else if (ratio > 0.3) this.setSheetState('half');
        else this.setSheetState('full');
      });
    }

    // Tab switching
    sheet.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this.switchTab(btn.dataset.tab);
      });
    });
  },

  _getSheetTranslate() {
    const sheet = document.getElementById('bottom-sheet');
    const style = window.getComputedStyle(sheet);
    const matrix = new DOMMatrix(style.transform);
    return matrix.m42;
  },

  setSheetState(state) {
    this.sheetState = state;
    document.getElementById('bottom-sheet').dataset.state = state;
  },

  switchTab(tab) {
    this.activeTab = tab;
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tab);
    });
    document.getElementById('tab-stations').style.display = tab === 'stations' ? '' : 'none';
    document.getElementById('station-detail').classList.remove('show');
    document.getElementById('tab-tips').style.display = tab === 'tips' ? '' : 'none';
  },

  // --- Station List ---
  showStationList(stations) {
    const container = document.getElementById('station-list');
    const countEl = document.getElementById('station-count');

    if (stations.length === 0) {
      countEl.innerHTML = '';
      container.innerHTML = `
        <div class="empty-state">
          <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="var(--text-muted)" stroke-width="1.5">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <h4>No stations found</h4>
          <p>Try increasing the search radius in filters</p>
        </div>`;
      return;
    }

    const openCount = stations.filter(s => s.isOpen !== false).length;
    countEl.innerHTML = `<strong>${stations.length}</strong> stations found &middot; <strong>${openCount}</strong> open`;

    container.innerHTML = stations.map(s => {
      const closed = s.isOpen === false;
      const congClass = closed ? 'station-closed' : s.congestion ? `congestion-${s.congestion}` : '';
      const hasReport = !!s.lastReport;

      // Fuel tags — show estimated tag if guessed
      const fuelTags = Object.entries(s.fuelTypes)
        .filter(([, v]) => v)
        .map(([k]) => `<span class="fuel-tag${s.fuelEstimated && !hasReport ? ' estimated' : ''}">${k.charAt(0).toUpperCase() + k.slice(1)}</span>`)
        .join('');

      // Congestion badge
      const estLabel = s.trafficLive ? ' (live)' : s.autoEstimated ? ' (est.)' : '';
      const estClass = s.autoEstimated && !s.trafficLive ? ' estimated-cong' : '';
      const congBadge = closed
        ? '<span class="congestion-badge closed-badge"><span class="dot"></span>Closed</span>'
        : s.congestion
          ? `<span class="congestion-badge ${s.congestion}${estClass}"><span class="dot"></span>${Utils.congestionLabel(s.congestion)}${estLabel}</span>`
          : '';

      // Wait time display
      const waitDisplay = s.waitTime
        ? `<div class="card-wait"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>${Utils.waitTimeLabel(s.waitTime)}</div>`
        : '';

      // Status line: either last report or a helpful CTA
      const statusLine = hasReport
        ? `<div class="last-report">Updated ${Utils.timeAgo(s.lastReport)} &middot; ${s.reportCount} report${s.reportCount > 1 ? 's' : ''}</div>`
        : `<div class="card-cta"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>Tap to report live status</div>`;

      // Opening hours hint
      const hoursHint = !hasReport && s.openingHours && s.openingHours !== '24/7'
        ? `<div class="card-hours"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>${Utils.escapeHtml(s.openingHours)}</div>`
        : '';

      return `
        <div class="station-card ${congClass}" data-id="${s.id}">
          <div class="card-header">
            <div>
              <div class="station-name">${Utils.escapeHtml(s.name)}</div>
              ${s.brand && s.brand !== s.name ? `<div class="station-brand">${Utils.escapeHtml(s.brand)}</div>` : ''}
            </div>
            <span class="station-distance">${Utils.formatDistance(s.distance)}</span>
          </div>
          <div class="card-meta">
            ${fuelTags}${congBadge}
          </div>
          ${waitDisplay}
          ${hoursHint}
          ${statusLine}
        </div>`;
    }).join('');

    // Click handlers
    container.querySelectorAll('.station-card').forEach(card => {
      card.addEventListener('click', () => {
        App.selectStation(parseInt(card.dataset.id));
      });
    });
  },

  // --- Station Detail ---
  showStationDetail(station) {
    this.switchTab('stations');
    document.getElementById('tab-stations').style.display = 'none';
    const detail = document.getElementById('station-detail');
    detail.classList.add('show');

    document.getElementById('detail-name').textContent = station.name;
    document.getElementById('detail-brand').textContent = station.brand || '';
    document.getElementById('detail-address').querySelector('span').textContent = station.address;

    // Fuel grid
    const fuelGrid = document.getElementById('detail-fuel-grid');
    const fuelNames = { petrol: 'Petrol', diesel: 'Diesel', lpg: 'LPG', cng: 'CNG' };
    const fuelIcons = { petrol: 'P', diesel: 'D', lpg: 'L', cng: 'C' };
    const hasReport = station.lastReport != null;
    fuelGrid.innerHTML = Object.entries(fuelNames).map(([key, label]) => {
      const available = station.fuelTypes[key];
      let statusClass, statusText;
      if (hasReport) {
        statusClass = available ? 'available' : 'unavailable';
        statusText = available ? 'Available' : 'Unavailable';
      } else if (station.fuelEstimated) {
        statusClass = available ? 'estimated' : 'unknown';
        statusText = available ? 'Likely available' : 'Unknown';
      } else {
        statusClass = available ? 'available' : 'unknown';
        statusText = available ? 'Listed' : 'Not listed';
      }
      return `
        <div class="fuel-item ${statusClass}">
          <div class="fuel-icon">${fuelIcons[key]}</div>
          <div>
            <div class="fuel-label">${label}</div>
            <div class="fuel-status">${statusText}</div>
          </div>
        </div>`;
    }).join('');

    // Congestion
    const congInfo = document.getElementById('detail-congestion-info');
    const congBar = document.getElementById('detail-congestion-bar');
    if (station.congestion) {
      const pct = { low: 25, medium: 55, high: 90 }[station.congestion] || 0;
      const estNote = station.trafficLive
        ? `<div class="auto-est-note">Live traffic: ${Math.round(station.trafficSpeed)} km/h (free flow: ${Math.round(station.trafficFreeFlow)} km/h)</div>`
        : station.autoEstimated
          ? '<div class="auto-est-note">Based on nearby road traffic & time of day</div>'
          : '';
      congInfo.innerHTML = `<span class="congestion-badge ${station.congestion}${station.autoEstimated ? ' estimated-cong' : ''}"><span class="dot"></span>${Utils.congestionLabel(station.congestion)}${station.autoEstimated ? ' (est.)' : ''}</span>${estNote}`;
      congBar.style.width = pct + '%';
      congBar.style.background = Utils.congestionColor(station.congestion);
    } else {
      congInfo.innerHTML = '<span class="detail-needs-report">Help others! Tap <strong>Report</strong> below to share the queue status.</span>';
      congBar.style.width = '0%';
    }

    // Wait time
    document.getElementById('detail-wait').innerHTML = station.waitTime
      ? Utils.waitTimeLabel(station.waitTime)
      : '<span class="detail-needs-report">Visit this station? Report the wait time to help your community.</span>';

    // Last report
    const lastEl = document.getElementById('detail-last-report');
    if (station.lastReport) {
      lastEl.textContent = `Last reported ${Utils.timeAgo(station.lastReport)} \u00b7 ${station.reportCount} report${station.reportCount > 1 ? 's' : ''}`;
    } else {
      lastEl.innerHTML = '<span class="detail-cta-highlight">Be the first to report! Your update helps nearby drivers save time.</span>';
    }

    // Directions button
    document.getElementById('btn-directions').onclick = () => {
      const url = `https://www.google.com/maps/dir/?api=1&destination=${station.lat},${station.lng}`;
      window.open(url, '_blank');
    };

    // Report button
    document.getElementById('btn-detail-report').onclick = () => {
      this.showReportModal(station.id, station.name);
    };

    // Share button
    document.getElementById('btn-share').onclick = () => {
      Utils.shareStation(station);
    };

    // Expand sheet on mobile
    if (Utils.isMobile()) {
      this.setSheetState('half');
    }

    // Store current station for reference
    this._currentStation = station;
  },

  hideStationDetail() {
    document.getElementById('station-detail').classList.remove('show');
    document.getElementById('tab-stations').style.display = '';
    this._currentStation = null;
  },

  // --- Report Modal ---
  showReportModal(stationId, stationName) {
    const modal = document.getElementById('report-modal');
    modal.classList.add('show');

    // Reset form first, then set station ID
    const form = document.getElementById('report-form');
    form.reset();

    document.getElementById('report-station-id').value = stationId || '';
    document.getElementById('report-station-name').textContent = stationName
      ? `Reporting on: ${stationName}`
      : 'Help others by sharing what you see';
  },

  hideReportModal() {
    document.getElementById('report-modal').classList.remove('show');
  },

  initReportModal() {
    document.getElementById('report-backdrop').addEventListener('click', () => this.hideReportModal());
    document.getElementById('report-close').addEventListener('click', () => this.hideReportModal());

    document.getElementById('report-form').addEventListener('submit', e => {
      e.preventDefault();
      const stationId = document.getElementById('report-station-id').value;
      if (!stationId) {
        this.showToast('Please select a station first', 'error');
        return;
      }

      const fuelChecks = document.querySelectorAll('#report-form input[name="fuel"]');
      const fuelAvailable = {};
      fuelChecks.forEach(cb => { fuelAvailable[cb.value] = cb.checked; });

      const congestion = document.querySelector('#report-form input[name="congestion"]:checked');
      const status = document.querySelector('#report-form input[name="status"]:checked');
      const waitTime = document.getElementById('report-wait').value;

      Reports.submitReport(parseInt(stationId), {
        fuelAvailable,
        congestion: congestion ? congestion.value : null,
        waitTime: waitTime || null,
        isOpen: status ? status.value === 'open' : true
      });

      this.hideReportModal();
      this.showToast('Report submitted! Thank you', 'success');

      // Refresh station data locally (don't re-fetch from API)
      App.refreshStations(true);
    });
  },

  // --- Filter Panel ---
  showFilterPanel() {
    document.getElementById('filter-panel').classList.add('show');
    document.getElementById('filter-backdrop').classList.add('show');
  },

  hideFilterPanel() {
    document.getElementById('filter-panel').classList.remove('show');
    document.getElementById('filter-backdrop').classList.remove('show');
  },

  initFilterPanel() {
    document.getElementById('filter-backdrop').addEventListener('click', () => this.hideFilterPanel());

    document.getElementById('filter-radius').addEventListener('input', e => {
      document.getElementById('radius-display').textContent = e.target.value + ' km';
    });

    document.getElementById('filter-apply').addEventListener('click', () => {
      const fuelChecks = document.querySelectorAll('#filter-panel input[name="filter-fuel"]:checked');
      const congChecks = document.querySelectorAll('#filter-panel input[name="filter-congestion"]:checked');
      const radius = parseInt(document.getElementById('filter-radius').value);

      App.applyFilters({
        fuelTypes: Array.from(fuelChecks).map(cb => cb.value),
        congestionLevels: Array.from(congChecks).map(cb => cb.value),
        radius: radius * 1000
      });

      this.hideFilterPanel();
    });

    document.getElementById('filter-reset').addEventListener('click', () => {
      document.querySelectorAll('#filter-panel input[type="checkbox"]').forEach(cb => cb.checked = true);
      document.getElementById('filter-radius').value = 5;
      document.getElementById('radius-display').textContent = '5 km';
    });
  },

  // --- Toast Notification ---
  showToast(message, type = 'info') {
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);

    requestAnimationFrame(() => toast.classList.add('show'));
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  },

  // --- Loading ---
  hideLoading() {
    const overlay = document.getElementById('loading-overlay');
    overlay.classList.add('hide');
    setTimeout(() => overlay.style.display = 'none', 400);
  }
};
