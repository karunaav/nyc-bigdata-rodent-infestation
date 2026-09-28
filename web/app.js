'use strict';

// ── Theme helpers ─────────────────────────────────────────────────────────────

function getTheme() { return document.documentElement.dataset.theme || 'light'; }
function isDark()   { return getTheme() === 'dark'; }

function themeColors() {
  return isDark()
    ? { text: '#A0B8D8', textDim: '#5C7A99', grid: 'rgba(255,255,255,0.06)' }
    : { text: '#374B6E', textDim: '#7089A8', grid: 'rgba(0,0,0,0.05)' };
}

function updateThemeToggleBtn() {
  const btn = document.getElementById('theme-toggle');
  if (!btn) return;
  const moonSvg = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;
  const sunSvg  = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>`;
  btn.innerHTML = isDark() ? `${sunSvg} Light` : `${moonSvg} Dark`;
}

function toggleTheme() {
  const next = isDark() ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('nycRatTheme', next);
  updateThemeToggleBtn();
  updateMapTiles();
  updateHeatGradient();
  updateAllChartTheme();
  buildCalendarHeatmap();
  updateSparklines();
  updateBoroughMarkers();
  updateMLZipTable();
}

function updateAllChartTheme() {
  const tc = themeColors();
  [boroughChart, seasonChart, typeChart, resultChart].forEach(chart => {
    if (!chart) return;
    ['x', 'y'].forEach(axis => {
      if (chart.options.scales?.[axis]) {
        chart.options.scales[axis].ticks.color = tc.textDim;
        chart.options.scales[axis].grid.color  = tc.grid;
      }
    });
    if (chart.options.plugins?.legend?.labels) chart.options.plugins.legend.labels.color = tc.text;
    if (chart.options.plugins?.tooltip) {
      chart.options.plugins.tooltip.backgroundColor = isDark() ? '#0F1F38' : '#FFFFFF';
      chart.options.plugins.tooltip.titleColor      = isDark() ? '#EDF3FC' : '#0D1E35';
      chart.options.plugins.tooltip.bodyColor       = isDark() ? '#A0B8D8' : '#374B6E';
      chart.options.plugins.tooltip.borderColor     = isDark() ? '#1E3A5F' : '#D9E3EF';
    }
    chart.update('none');
  });
  updateTrendChart();
}

// ── Constants ─────────────────────────────────────────────────────────────────

const BOROUGH_COLORS = {
  Manhattan:       '#2563EB',
  Brooklyn:        '#D97706',
  Bronx:           '#DC2626',
  Queens:          '#7C3AED',
  'Staten Island': '#059669',
};

const MONTHS      = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const MONTHS_FULL = ['January','February','March','April','May','June','July','August','September','October','November','December'];

const BOROUGH_CENTERS = {
  Manhattan:       [40.7831, -73.9712],
  Brooklyn:        [40.6501, -73.9496],
  Bronx:           [40.8448, -73.8648],
  Queens:          [40.7282, -73.7949],
  'Staten Island': [40.5795, -74.1502],
};

// ── State ─────────────────────────────────────────────────────────────────────

const state = {
  year: 2025,
  allYears: false,
  borough: 'All',
  data: {},
  heatmapCache: {},
};

// ── Playback ──────────────────────────────────────────────────────────────────

const playback = { active: false, timer: null, speed: 750 };

function togglePlay() { playback.active ? stopPlay() : startPlay(); }

function startPlay() {
  playback.active = true;
  document.getElementById('play-icon').style.display  = 'none';
  document.getElementById('pause-icon').style.display = '';
  document.getElementById('btn-play').classList.add('playing');
  if (state.allYears || state.year >= 2025) {
    state.allYears = false;
    state.year = 2009;
    document.getElementById('btn-all-years').classList.remove('active');
    syncYearUI(); render();
  }
  playback.timer = setInterval(() => {
    if (state.year >= 2025) { stopPlay(); return; }
    state.year++;
    syncYearUI(); render();
  }, playback.speed);
}

function stopPlay() {
  playback.active = false;
  clearInterval(playback.timer);
  document.getElementById('play-icon').style.display  = '';
  document.getElementById('pause-icon').style.display = 'none';
  document.getElementById('btn-play').classList.remove('playing');
}

function syncYearUI() {
  document.getElementById('year-slider').value       = state.year;
  document.getElementById('year-display').textContent = state.year;
}

// ── Chart instances ───────────────────────────────────────────────────────────

let boroughChart, seasonChart, typeChart, trendChart, resultChart;
let leafletMap, heatLayer, tileLayer;
const boroughMarkers = {};

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'K';
  return n.toLocaleString();
}
function fmtFull(n) { return Math.round(n).toLocaleString(); }

function animateKPIValue(el, target, isFloat = false) {
  if (!el) return;
  const raw  = parseFloat(el.textContent.replace(/[^0-9.]/g, '')) || 0;
  const from = isFloat ? raw : raw * (el.textContent.includes('K') ? 1000 : el.textContent.includes('M') ? 1_000_000 : 1);
  const diff = target - from;
  const t0   = performance.now();
  el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
  (function tick(now) {
    const t    = Math.min((now - t0) / 350, 1);
    const ease = 1 - (1 - t) * (1 - t);
    el.textContent = isFloat ? (from + diff * ease).toFixed(1) + '%' : fmtFull(from + diff * ease);
    if (t < 1) requestAnimationFrame(tick);
    else el.textContent = isFloat ? target.toFixed(1) + '%' : fmtFull(target);
  })(t0);
}

function showTooltip(e, html) {
  const tt = document.getElementById('tooltip');
  tt.innerHTML = html; tt.classList.add('show'); moveTooltip(e);
}
function moveTooltip(e) {
  const tt = document.getElementById('tooltip');
  tt.style.left = Math.min(e.clientX + 14, window.innerWidth - 230) + 'px';
  tt.style.top  = (e.clientY - 44) + 'px';
}
function hideTooltip() { document.getElementById('tooltip').classList.remove('show'); }

function linearRegression(xs, ys) {
  const n    = xs.length;
  const sumX = xs.reduce((a,b) => a+b, 0), sumY = ys.reduce((a,b) => a+b, 0);
  const sumXY = xs.reduce((s,x,i) => s + x*ys[i], 0);
  const sumXX = xs.reduce((s,x) => s + x*x, 0);
  const slope = (n*sumXY - sumX*sumY) / (n*sumXX - sumX*sumX);
  const intercept = (sumY - slope*sumX) / n;
  return { slope, intercept, predict: x => Math.max(0, slope*x + intercept) };
}

// ── Data ──────────────────────────────────────────────────────────────────────

async function loadData() {
  const files = [
    'data/summary.json','data/by_year_borough.json','data/by_year_month.json',
    'data/by_year_month_borough.json','data/by_inspection_type.json','data/neighborhoods.json',
    'data/ml_predictions.json','data/ml_zip_risk.json','data/ml_summary.json',
  ];
  const r = await Promise.all(files.map(f => fetch(f).then(x => x.json()).catch(() => null)));
  state.data.summary         = r[0];
  state.data.byYearBorough   = r[1];
  state.data.byYearMonth     = r[2];
  state.data.byYearMonthBoro = r[3];
  state.data.byType          = r[4];
  state.data.neighborhoods   = r[5];
  state.data.mlPredictions   = r[6] || [];
  state.data.mlZipRisk       = r[7] || [];
  state.data.mlSummary       = r[8] || null;
}

async function loadHeatmap(year) {
  if (state.heatmapCache[year]) return state.heatmapCache[year];
  const d = await fetch(`data/heatmap_${year}.json`).then(r => r.json());
  state.heatmapCache[year] = d;
  return d;
}

// ── Filtered accessors ────────────────────────────────────────────────────────

function getByYearBorough() {
  let d = state.data.byYearBorough;
  if (!state.allYears) d = d.filter(r => r.year === state.year);
  if (state.borough !== 'All') d = d.filter(r => r.BOROUGH === state.borough);
  return d;
}

function getKPIs() {
  const d = getByYearBorough();
  return {
    total:        d.reduce((s,r) => s + r.total, 0),
    rat_positive: d.reduce((s,r) => s + r.rat_positive, 0),
    rat_activity: d.reduce((s,r) => s + r.rat_activity, 0),
    bait_applied: d.reduce((s,r) => s + r.bait_applied, 0),
  };
}

// ── Borough selection ─────────────────────────────────────────────────────────

function selectBorough(b) {
  stopPlay();
  state.borough = b;
  document.querySelectorAll('.pill[data-borough]').forEach(el =>
    el.classList.toggle('active', el.dataset.borough === b)
  );
  render();
}

// ── KPI cards ─────────────────────────────────────────────────────────────────

function updateKPIs() {
  const kpi  = getKPIs();
  const rate = kpi.total ? (kpi.rat_positive / kpi.total * 100) : 0;

  animateKPIValue(document.getElementById('kpi-inspections'), kpi.total);
  animateKPIValue(document.getElementById('kpi-rate'),        rate, true);
  animateKPIValue(document.getElementById('kpi-activity'),    kpi.rat_activity);
  animateKPIValue(document.getElementById('kpi-bait'),        kpi.bait_applied);

  const rateEl = document.getElementById('kpi-rate-delta');
  if (rateEl && !state.allYears && state.year > 2009) {
    let prev = state.data.byYearBorough.filter(r => r.year === state.year - 1);
    if (state.borough !== 'All') prev = prev.filter(r => r.BOROUGH === state.borough);
    const pT = prev.reduce((s,r) => s + r.total, 0);
    const pR = pT ? prev.reduce((s,r) => s + r.rat_positive, 0) / pT * 100 : 0;
    const delta = rate - pR;
    if (Math.abs(delta) > 0.1) {
      rateEl.textContent = `${delta > 0 ? '↑' : '↓'} ${Math.abs(delta).toFixed(1)}% vs ${state.year - 1}`;
      rateEl.className   = `kpi-delta ${delta > 0 ? 'up' : 'down'}`;
    } else {
      rateEl.textContent = `≈ same as ${state.year - 1}`;
      rateEl.className   = 'kpi-delta';
    }
  } else if (rateEl) {
    rateEl.textContent = '';
  }
}

// ── Sparklines (canvas) ───────────────────────────────────────────────────────

function drawSparklineCanvas(id, values, colorHex) {
  const canvas = document.getElementById(id);
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const W = Math.max(60, Math.round(rect.width || 84)), H = 28, PAD = 2;
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);

  const valid = values.filter(v => v != null && isFinite(v));
  if (valid.length < 2) return;
  const max = Math.max(...valid) || 1, min = Math.min(...valid), range = max - min || 1;
  const n = values.length;
  const xOf = i => PAD + (i / (n - 1)) * (W - PAD * 2);
  const yOf = v => H - PAD - ((v - min) / range) * (H - PAD * 2);

  // Area
  ctx.beginPath();
  let first = true;
  values.forEach((v, i) => { if (v == null) return; first ? ctx.moveTo(xOf(i), yOf(v)) : ctx.lineTo(xOf(i), yOf(v)); first = false; });
  const lastI = values.reduce((a, v, i) => v != null ? i : a, 0);
  const firstI = values.findIndex(v => v != null);
  ctx.lineTo(xOf(lastI), H - PAD); ctx.lineTo(xOf(firstI), H - PAD); ctx.closePath();
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, colorHex + '44'); g.addColorStop(1, colorHex + '00');
  ctx.fillStyle = g; ctx.fill();

  // Line
  ctx.beginPath(); first = true;
  values.forEach((v, i) => { if (v == null) return; first ? ctx.moveTo(xOf(i), yOf(v)) : ctx.lineTo(xOf(i), yOf(v)); first = false; });
  ctx.strokeStyle = colorHex; ctx.lineWidth = 1.5; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.stroke();

  // End dot
  const lastV = values[lastI];
  if (lastV != null) { ctx.beginPath(); ctx.arc(xOf(lastI), yOf(lastV), 2.5, 0, Math.PI * 2); ctx.fillStyle = colorHex; ctx.fill(); }
}

function updateSparklines() {
  const years   = state.data.summary.years;
  const metrics = years.map(yr => {
    let rows = state.data.byYearBorough.filter(r => r.year === yr);
    if (state.borough !== 'All') rows = rows.filter(r => r.BOROUGH === state.borough);
    const total  = rows.reduce((s,r) => s + r.total, 0);
    const ratPos = rows.reduce((s,r) => s + r.rat_positive, 0);
    return { total, rat_rate: total ? ratPos/total*100 : 0,
             rat_activity: rows.reduce((s,r) => s + r.rat_activity, 0),
             bait_applied: rows.reduce((s,r) => s + r.bait_applied, 0) };
  });
  const navy  = isDark() ? '#5898E8' : '#1B3A6B';
  const red   = isDark() ? '#F87171' : '#C53030';
  const amber = isDark() ? '#FCD34D' : '#B45309';
  const green = isDark() ? '#34D399' : '#047857';
  drawSparklineCanvas('spark-inspections', metrics.map(d => d.total),        navy);
  drawSparklineCanvas('spark-rate',        metrics.map(d => d.rat_rate),      red);
  drawSparklineCanvas('spark-activity',    metrics.map(d => d.rat_activity),  amber);
  drawSparklineCanvas('spark-bait',        metrics.map(d => d.bait_applied),  green);
}

// ── Context strip ─────────────────────────────────────────────────────────────

function updateContextStrip() {
  const el = document.getElementById('context-strip');
  if (!el) return;
  const chips = [];

  const boroughs = Object.keys(BOROUGH_COLORS);
  let topBoro = '', topRate = 0;
  boroughs.forEach(b => {
    let rows = state.data.byYearBorough.filter(r => r.BOROUGH === b);
    if (!state.allYears) rows = rows.filter(r => r.year === state.year);
    const total  = rows.reduce((s,r) => s + r.total, 0);
    const ratPos = rows.reduce((s,r) => s + r.rat_positive, 0);
    const rate   = total ? ratPos/total*100 : 0;
    if (rate > topRate) { topRate = rate; topBoro = b; }
  });
  if (topBoro) chips.push(`<span class="chip danger">Highest: ${topBoro} at ${topRate.toFixed(1)}%</span>`);

  const mRates = Array.from({length:12}, (_,mi) => {
    let rows = state.data.byYearMonthBoro;
    if (!state.allYears) rows = rows.filter(r => r.year === state.year);
    if (state.borough !== 'All') rows = rows.filter(r => r.BOROUGH === state.borough);
    rows = rows.filter(r => r.month === mi + 1);
    const total  = rows.reduce((s,r) => s + r.total, 0);
    const ratPos = rows.reduce((s,r) => s + r.rat_positive, 0);
    return total ? ratPos/total*100 : 0;
  });
  const peakIdx = mRates.indexOf(Math.max(...mRates));
  chips.push(`<span class="chip">Peak season: ${MONTHS_FULL[peakIdx]} (${mRates[peakIdx].toFixed(1)}%)</span>`);

  if (!state.allYears && state.year > 2009) {
    const kpi  = getKPIs();
    const rate = kpi.total ? kpi.rat_positive/kpi.total*100 : 0;
    let prev   = state.data.byYearBorough.filter(r => r.year === state.year - 1);
    if (state.borough !== 'All') prev = prev.filter(r => r.BOROUGH === state.borough);
    const pT = prev.reduce((s,r) => s + r.total, 0);
    const pR = pT ? prev.reduce((s,r) => s + r.rat_positive,0)/pT*100 : 0;
    const delta = rate - pR;
    if (Math.abs(delta) > 0.3) chips.push(`<span class="chip ${delta > 0 ? 'danger' : 'good'}">${delta > 0 ? '↑' : '↓'} ${Math.abs(delta).toFixed(1)}% year-over-year</span>`);
  }

  const kpi = getKPIs();
  chips.push(`<span class="chip">${state.allYears ? 'All years' : state.year}: ${fmt(kpi.total)} inspections</span>`);
  el.innerHTML = chips.join('');
}

// ── Map ───────────────────────────────────────────────────────────────────────

const TILES = {
  light: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
  dark:  'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
};

function getHeatGradient() {
  return isDark()
    ? { 0.15: '#FEF08A', 0.45: '#FB923C', 0.75: '#EF4444', 1.0: '#991B1B' }
    : { 0.15: '#BFDBFE', 0.5:  '#3B82F6', 0.85: '#1E40AF', 1.0: '#1b3a6b' };
}

function updateMapTiles() {
  if (tileLayer) leafletMap.removeLayer(tileLayer);
  tileLayer = L.tileLayer(TILES[getTheme()], { maxZoom: 18, subdomains: 'abcd' }).addTo(leafletMap);
}

function updateHeatGradient() {
  if (heatLayer) heatLayer.setOptions({ gradient: getHeatGradient() });
}

function initMap() {
  leafletMap = L.map('map', { zoomControl: true, attributionControl: false }).setView([40.71, -73.97], 11);
  tileLayer  = L.tileLayer(TILES[getTheme()], { maxZoom: 18, subdomains: 'abcd' }).addTo(leafletMap);
  heatLayer  = L.heatLayer([], { radius: 22, blur: 20, maxZoom: 16, minOpacity: 0.18, max: 0.85, gradient: getHeatGradient() }).addTo(leafletMap);
  initBoroughBoundaries();
}

let boroughGeoLayer = null;

function boroughGeoStyle(rawName) {
  const name   = (rawName || '').replace(/^The /, '');
  const bColor = BOROUGH_COLORS[name] || '#888';
  const sel    = state.borough === name;
  return {
    color:       bColor,
    weight:      sel ? 2.5 : 1.5,
    dashArray:   sel ? null : '8 5',
    fillColor:   bColor,
    fillOpacity: sel ? 0.12 : 0.02,
    opacity:     sel ? 1 : 0.6,
  };
}

function extractBoroName(props) {
  const raw = props.boro_name || props.BoroName || props.BORO_NAME ||
              props.borough  || props.Borough  || props.name || props.NAME || '';
  return raw.replace(/^The /, '');
}

async function initBoroughBoundaries() {
  const URLS = [
    'https://raw.githubusercontent.com/dwillis/nyc-maps/master/boroughs.geojson',
    'https://data.cityofnewyork.us/api/geospatial/7t3b-ywvw?method=export&type=GeoJSON',
  ];
  for (const url of URLS) {
    try {
      const ctrl = new AbortController();
      const tid  = setTimeout(() => ctrl.abort(), 6000);
      const res  = await fetch(url, { signal: ctrl.signal });
      clearTimeout(tid);
      if (!res.ok) continue;
      const geo = await res.json();
      boroughGeoLayer = L.geoJSON(geo, {
        style: f => boroughGeoStyle(extractBoroName(f.properties)),
        onEachFeature(feature, layer) {
          const name = extractBoroName(feature.properties);
          if (!name) return;
          layer.on('click', () => selectBorough(state.borough === name ? 'All' : name));
          layer.on('mouseover', e => {
            let rows = state.data.byYearBorough.filter(r => r.BOROUGH === name);
            if (!state.allYears) rows = rows.filter(r => r.year === state.year);
            const total = rows.reduce((s, r) => s + r.total, 0);
            const rate  = total ? (rows.reduce((s, r) => s + r.rat_positive, 0) / total * 100).toFixed(1) : '—';
            showTooltip(e.originalEvent, `<strong>${name}</strong><br>${rate}% rat positive<br><small>Click to ${state.borough === name ? 'clear filter' : 'filter'}</small>`);
          });
          layer.on('mouseout', hideTooltip);
        },
      }).addTo(leafletMap);
      return;
    } catch { /* try next URL */ }
  }
  initBoroughMarkers();
}

function initBoroughMarkers() {
  Object.keys(BOROUGH_CENTERS).forEach(b => {
    const m = L.circle(BOROUGH_CENTERS[b], {
      radius: 4200, color: BOROUGH_COLORS[b], weight: 1.5,
      dashArray: '8 5', fillOpacity: 0,
    });
    m.bindTooltip(`<strong>${b}</strong>`, { direction: 'top', offset: [0, -6] });
    m.on('click', () => selectBorough(state.borough === b ? 'All' : b));
    m.addTo(leafletMap);
    boroughMarkers[b] = m;
  });
}

function updateBoroughMarkers() {
  if (boroughGeoLayer) {
    boroughGeoLayer.eachLayer(layer => {
      const rawName = extractBoroName(layer.feature?.properties || {});
      layer.setStyle(boroughGeoStyle(rawName));
    });
    return;
  }
  // fallback: circle markers
  Object.keys(BOROUGH_CENTERS).forEach(b => {
    const m = boroughMarkers[b];
    if (!m) return;
    let rows = state.data.byYearBorough.filter(r => r.BOROUGH === b);
    if (!state.allYears) rows = rows.filter(r => r.year === state.year);
    const total  = rows.reduce((s, r) => s + r.total, 0);
    const rate   = total ? rows.reduce((s, r) => s + r.rat_positive, 0) / total * 100 : 0;
    const sel    = state.borough === b;
    m.setRadius(sel ? 5000 : 4200);
    m.setStyle({
      color: BOROUGH_COLORS[b], weight: sel ? 2.5 : 1.5,
      dashArray: sel ? null : '8 5', fillOpacity: sel ? 0.10 : 0,
    });
    m.setTooltipContent(`<strong>${b}</strong><br>${rate.toFixed(1)}% rat positive<br><small>Click to ${sel ? 'clear filter' : 'filter'}</small>`);
  });
}

async function updateMap() {
  const yr = state.allYears ? 2024 : state.year;
  document.getElementById('map-subtitle').textContent = `${state.allYears ? 'All Years' : state.year} · ${state.borough === 'All' ? 'All Boroughs' : state.borough}`;
  const points = await loadHeatmap(yr);
  heatLayer.setLatLngs(points);
}

// ── Trend chart ───────────────────────────────────────────────────────────────

const vertNowPlugin = {
  id: 'vertNow',
  afterDraw(chart) {
    if (!chart.options.plugins?.vertNow) return;
    const { ctx, chartArea, scales } = chart;
    const x = scales.x?.getPixelForValue('2025');
    if (!x || x < chartArea.left || x > chartArea.right) return;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x, chartArea.top); ctx.lineTo(x, chartArea.bottom);
    ctx.strokeStyle = isDark() ? 'rgba(160,184,216,0.3)' : 'rgba(55,75,110,0.22)';
    ctx.lineWidth = 1.5; ctx.setLineDash([4, 4]); ctx.stroke();
    ctx.fillStyle = isDark() ? '#5C7A99' : '#7089A8';
    ctx.font = '10px Plus Jakarta Sans, system-ui'; ctx.fillText('Now', x + 4, chartArea.top + 14);
    ctx.restore();
  },
};
Chart.register(vertNowPlugin);

function initTrendChart() {
  const tc  = themeColors();
  const ctx = document.getElementById('trend-chart').getContext('2d');
  trendChart = new Chart(ctx, {
    type: 'line',
    data: { labels: [], datasets: [] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: { duration: 500 },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend:  { labels: { color: tc.text, boxWidth: 10, font: { size: 11 } } },
        tooltip: {
          backgroundColor: isDark() ? '#0F1F38' : '#FFFFFF',
          titleColor: isDark() ? '#EDF3FC' : '#0D1E35',
          bodyColor:  isDark() ? '#A0B8D8' : '#374B6E',
          borderColor: isDark() ? '#1E3A5F' : '#D9E3EF',
          borderWidth: 1,
          callbacks: {
            label: ctx => {
              if (ctx.parsed.y == null) return null;
              const sfx = ctx.dataset.label?.includes('Projected') ? ' (projected)' : '';
              return ` ${ctx.parsed.y.toFixed(1)}%${sfx}`;
            },
          },
        },
        vertNow:    true,
        testPeriod: true,
      },
      scales: {
        x: { grid: { color: tc.grid }, ticks: { color: tc.textDim, font: { size: 10 }, maxRotation: 0 } },
        y: { grid: { color: tc.grid }, ticks: { color: tc.textDim, font: { size: 11 }, callback: v => v + '%' }, min: 0 },
      },
    },
  });
  updateTrendChart();
}

function updateTrendChart() {
  if (!trendChart) return;
  const years = state.data.summary.years;
  const yearRates = years.map(yr => {
    let rows = state.data.byYearBorough.filter(r => r.year === yr);
    if (state.borough !== 'All') rows = rows.filter(r => r.BOROUGH === state.borough);
    const total  = rows.reduce((s,r) => s + r.total, 0);
    const ratPos = rows.reduce((s,r) => s + r.rat_positive, 0);
    return total ? +(ratPos/total*100).toFixed(2) : null;
  });

  const recentPairs = years.map((yr, i) => ({ yr, rate: yearRates[i] }))
                           .filter(d => d.rate !== null).slice(-6);
  const reg = linearRegression(recentPairs.map(d => d.yr), recentPairs.map(d => d.rate));
  const projYears = [2026, 2027, 2028];
  const allLabels = [...years.map(String), ...projYears.map(String)];
  const actualData = [...yearRates, null, null, null];
  const lastActual = yearRates[yearRates.length - 1];
  const projData   = [...years.map((_, i) => i < years.length - 1 ? null : lastActual),
                      ...projYears.map(yr => +reg.predict(yr).toFixed(2))];

  const navyMain = isDark() ? '#5898E8' : '#1B3A6B';
  const navyProj = isDark() ? 'rgba(88,152,232,0.45)' : 'rgba(27,58,107,0.4)';
  const tc = themeColors();

  trendChart.data.labels   = allLabels;
  trendChart.data.datasets = [
    {
      label: 'Historical Rate',
      data: actualData,
      borderColor: navyMain,
      backgroundColor: isDark() ? 'rgba(88,152,232,0.07)' : 'rgba(27,58,107,0.05)',
      fill: true, tension: 0.4, pointRadius: 3, pointHoverRadius: 6,
      borderWidth: 2.5, spanGaps: false,
    },
    {
      label: 'Projected (linear)',
      data: projData,
      borderColor: navyProj,
      backgroundColor: 'transparent',
      fill: false, tension: 0.3, borderDash: [6, 4],
      pointRadius: 3, pointHoverRadius: 5,
      borderWidth: 2, pointBackgroundColor: navyProj, spanGaps: false,
    },
  ];
  trendChart.options.scales.x.grid.color  = tc.grid;
  trendChart.options.scales.x.ticks.color = tc.textDim;
  trendChart.options.scales.y.grid.color  = tc.grid;
  trendChart.options.scales.y.ticks.color = tc.textDim;
  trendChart.options.plugins.legend.labels.color = tc.text;
  trendChart.update('active');
}

// ── Borough chart ─────────────────────────────────────────────────────────────

function initBoroughChart() {
  const tc  = themeColors();
  const ctx = document.getElementById('borough-chart').getContext('2d');
  boroughChart = new Chart(ctx, {
    type: 'bar',
    data: { labels: [], datasets: [] },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false, animation: { duration: 400 },
      onClick: (_e, elements) => {
        if (!elements.length) return;
        const boros   = ['Manhattan','Brooklyn','Bronx','Queens','Staten Island'];
        const clicked = boros[elements[0].index];
        selectBorough(state.borough === clicked ? 'All' : clicked);
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: isDark() ? '#0F1F38' : '#FFFFFF',
          titleColor: isDark() ? '#EDF3FC' : '#0D1E35',
          bodyColor:  isDark() ? '#A0B8D8' : '#374B6E',
          borderColor: isDark() ? '#1E3A5F' : '#D9E3EF', borderWidth: 1,
          callbacks: {
            label: ctx => ` ${ctx.parsed.x.toFixed(1)}% rat positive (${fmtFull(ctx.dataset.totals[ctx.dataIndex])} inspections)`,
          },
        },
      },
      scales: {
        x: { grid: { color: tc.grid }, ticks: { color: tc.textDim, font: { size: 11 }, callback: v => v + '%' }, max: 35 },
        y: { grid: { display: false }, ticks: { color: tc.text, font: { size: 12, family: 'Plus Jakarta Sans', weight: '500' } } },
      },
    },
  });
}

function updateBoroughChart() {
  const boroughs = ['Manhattan','Brooklyn','Bronx','Queens','Staten Island'];
  const rates = [], totals = [], colors = [];
  boroughs.forEach(b => {
    let d = state.data.byYearBorough.filter(r => r.BOROUGH === b);
    if (!state.allYears) d = d.filter(r => r.year === state.year);
    if (state.borough !== 'All' && state.borough !== b) {
      rates.push(0); totals.push(0);
      colors.push(isDark() ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)');
      return;
    }
    const total  = d.reduce((s,r) => s + r.total, 0);
    const ratPos = d.reduce((s,r) => s + r.rat_positive, 0);
    rates.push(total ? +(ratPos/total*100).toFixed(2) : 0);
    totals.push(total);
    colors.push(BOROUGH_COLORS[b] + 'cc');
  });
  boroughChart.data.labels   = boroughs;
  boroughChart.data.datasets = [{ data: rates, totals, backgroundColor: colors, borderRadius: 5, borderSkipped: false }];
  boroughChart.update('active');
}

// ── Season chart ──────────────────────────────────────────────────────────────

function initSeasonChart() {
  const tc  = themeColors();
  const ctx = document.getElementById('season-chart').getContext('2d');
  seasonChart = new Chart(ctx, {
    type: 'line',
    data: { labels: MONTHS, datasets: [] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: { duration: 350 },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: tc.text, boxWidth: 10, font: { size: 11 } } },
        tooltip: {
          backgroundColor: isDark() ? '#0F1F38' : '#FFFFFF',
          titleColor: isDark() ? '#EDF3FC' : '#0D1E35',
          bodyColor:  isDark() ? '#A0B8D8' : '#374B6E',
          borderColor: isDark() ? '#1E3A5F' : '#D9E3EF', borderWidth: 1,
          callbacks: { label: ctx => ` ${ctx.dataset.label}: ${ctx.parsed.y.toFixed(1)}%` },
        },
      },
      scales: {
        x: { grid: { color: tc.grid }, ticks: { color: tc.textDim, font: { size: 11 } } },
        y: { grid: { color: tc.grid }, ticks: { color: tc.textDim, font: { size: 11 }, callback: v => v + '%' } },
      },
    },
  });
}

function updateSeasonChart() {
  const boroughs = state.borough === 'All'
    ? ['Manhattan','Brooklyn','Bronx','Queens','Staten Island'] : [state.borough];
  const datasets = boroughs.map(b => {
    const monthData = Array.from({length:12}, (_,mi) => {
      let rows = state.data.byYearMonthBoro.filter(r => r.BOROUGH === b && r.month === mi+1);
      if (!state.allYears) rows = rows.filter(r => r.year === state.year);
      const total  = rows.reduce((s,r) => s + r.total, 0);
      const ratPos = rows.reduce((s,r) => s + r.rat_positive, 0);
      return total ? +(ratPos/total*100).toFixed(2) : null;
    });
    return {
      label: b, data: monthData,
      borderColor: BOROUGH_COLORS[b], backgroundColor: BOROUGH_COLORS[b] + '18',
      fill: !state.allYears, tension: 0.4,
      pointRadius: state.allYears ? 3 : 4, pointHoverRadius: 6, borderWidth: 2,
    };
  });
  seasonChart.data.datasets = datasets;
  document.getElementById('season-subtitle').textContent =
    state.allYears ? 'All-years average by month' : `${state.year} monthly rat positive %`;
  seasonChart.update('active');
}

// ── Calendar heatmap ──────────────────────────────────────────────────────────

function calRateColor(rate) {
  rate = Math.min(rate, 35);
  const stops = isDark()
    ? [[0,[20,25,50]],[10,[120,60,20]],[20,[200,80,20]],[35,[220,38,38]]]
    : [[0,[233,242,255]],[12,[147,185,235]],[25,[60,110,180]],[35,[27,58,107]]];
  for (let i = 1; i < stops.length; i++) {
    const [lo, cLo] = stops[i-1], [hi, cHi] = stops[i];
    if (rate <= hi) {
      const t = (rate - lo) / (hi - lo);
      return `rgb(${Math.round(cLo[0]+t*(cHi[0]-cLo[0]))},${Math.round(cLo[1]+t*(cHi[1]-cLo[1]))},${Math.round(cLo[2]+t*(cHi[2]-cLo[2]))})`;
    }
  }
  return isDark() ? 'rgb(220,38,38)' : 'rgb(27,58,107)';
}

function buildCalendarHeatmap() {
  const data   = state.data.byYearMonth;
  const lookup = {};
  data.forEach(r => { lookup[`${r.year}_${r.month}`] = r.rat_rate; });

  const years  = state.data.summary.years;
  const CELL_W = 30, CELL_H = 18, ML = 44, MT = 24;
  const W = ML + 12 * CELL_W + 10, H = MT + years.length * CELL_H + 22;
  const textColor  = isDark() ? '#5C7A99' : '#7089A8';
  const emptyColor = isDark() ? '#0d1428' : '#EEF4FF';
  const strokeSel  = isDark() ? 'rgba(255,255,255,0.4)' : 'rgba(27,58,107,0.6)';

  let svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg" style="font-family:'Plus Jakarta Sans',sans-serif;display:block">`;
  MONTHS.forEach((m, i) => {
    svg += `<text x="${ML + i*CELL_W + CELL_W/2}" y="${MT-8}" text-anchor="middle" fill="${textColor}" font-size="10">${m}</text>`;
  });
  years.forEach((yr, yi) => {
    const cy = MT + yi * CELL_H;
    svg += `<text x="${ML-6}" y="${cy+CELL_H/2+4}" text-anchor="end" fill="${textColor}" font-size="10">${yr}</text>`;
    for (let m = 1; m <= 12; m++) {
      const rate = lookup[`${yr}_${m}`] || 0;
      const fill = rate > 0.5 ? calRateColor(rate) : emptyColor;
      const cx   = ML + (m - 1) * CELL_W;
      const sel  = !state.allYears && yr === state.year;
      svg += `<rect x="${cx+1}" y="${cy+1}" width="${CELL_W-2}" height="${CELL_H-2}" fill="${fill}" rx="2"
        ${sel ? `stroke="${strokeSel}" stroke-width="1.5"` : ''}
        data-yr="${yr}" data-mo="${m}" data-rate="${rate.toFixed(2)}"/>`;
    }
  });

  const lx = ML, ly = H - 14;
  for (let i = 0; i <= 10; i++) {
    const rate = i * 3.5;
    svg += `<rect x="${lx + i*16}" y="${ly-6}" width="15" height="6" fill="${rate > 0.5 ? calRateColor(rate) : emptyColor}" rx="1"/>`;
  }
  svg += `<text x="${lx}" y="${ly+8}" fill="${textColor}" font-size="9">0%</text>`;
  svg += `<text x="${lx+160}" y="${ly+8}" fill="${textColor}" font-size="9">35%+</text>`;
  svg += '</svg>';

  const container = document.getElementById('calendar-heatmap');
  container.innerHTML = svg;
  container.querySelectorAll('rect[data-yr]').forEach(rect => {
    rect.addEventListener('mouseenter', e =>
      showTooltip(e, `<strong>${MONTHS[parseInt(rect.dataset.mo)-1]} ${rect.dataset.yr}</strong><br>${parseFloat(rect.dataset.rate).toFixed(1)}% rat positive`)
    );
    rect.addEventListener('mousemove', moveTooltip);
    rect.addEventListener('mouseleave', hideTooltip);
    rect.addEventListener('click', () => {
      const yr = parseInt(rect.dataset.yr);
      if (state.allYears || state.year !== yr) {
        stopPlay(); state.allYears = false; state.year = yr;
        syncYearUI(); document.getElementById('btn-all-years').classList.remove('active');
        render();
      }
    });
  });
}

function highlightCalendarYear() {
  const strokeSel = isDark() ? 'rgba(255,255,255,0.4)' : 'rgba(27,58,107,0.6)';
  document.querySelectorAll('#calendar-heatmap rect[data-yr]').forEach(rect => {
    const active = !state.allYears && parseInt(rect.dataset.yr) === state.year;
    rect.setAttribute('stroke',       active ? strokeSel : 'none');
    rect.setAttribute('stroke-width', active ? '1.5'     : '0');
  });
}

// ── Leaderboard ───────────────────────────────────────────────────────────────

function updateLeaderboard() {
  const el = document.getElementById('leaderboard');
  let rows = [...state.data.neighborhoods];
  if (state.borough !== 'All') rows = rows.filter(r => r.BOROUGH === state.borough);
  if (!rows.length) { el.innerHTML = ''; return; }

  const maxN    = rows[0]?.rat_positive || 1;
  const prevInp = document.getElementById('lb-input');
  const prevNTA = prevInp ? (prevInp.value.split(' · ')[0].trim() || null) : null;

  const datalistOpts = rows.map(r =>
    `<option value="${r.NTA} · ${r.BOROUGH} · ${r.rat_rate}% positive">`
  ).join('');

  const top15 = rows.slice(0, 15);

  el.innerHTML = `
    <div class="lb-explorer">
      <div class="lb-explorer-hd">
        Neighborhood Explorer
        <span>${rows.length} neighborhoods · all-time cumulative</span>
      </div>
      <div class="lb-search-wrap">
        <label class="lb-search-label" for="lb-input">Search</label>
        <input type="text" id="lb-input" list="lb-datalist"
               placeholder="Type a neighborhood name…" autocomplete="off" class="lb-input" />
        <datalist id="lb-datalist">${datalistOpts}</datalist>
      </div>
      <div class="lb-detail" id="lb-detail"></div>
      <div class="lb-list-hd">Top 15 by Rat-Positive Count<span> · click a row to inspect</span></div>
      <div class="lb-list">
        ${top15.map((r, i) => {
          const rankCls = i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : '';
          const pct     = (r.rat_positive / maxN * 100).toFixed(0);
          const bColor  = BOROUGH_COLORS[r.BOROUGH] || '#888';
          return `
            <div class="lb-row" data-nta="${r.NTA}">
              <span class="lb-rank ${rankCls}">${i+1}</span>
              <div class="lb-info">
                <div class="lb-name">${r.NTA}</div>
                <span class="lb-boro" style="color:${bColor};background:${bColor}1a">${r.BOROUGH}</span>
              </div>
              <div>
                <div class="lb-bar-bg"><div class="lb-bar-fill" style="width:${pct}%;background:${bColor}"></div></div>
                <div style="font-size:0.62rem;color:var(--c-text-3);text-align:right;margin-top:2px">${r.rat_rate}% positive</div>
              </div>
              <span class="lb-count">${fmt(r.rat_positive)}</span>
            </div>`;
        }).join('')}
      </div>
    </div>`;

  function renderDetail(r, animate) {
    const detail = document.getElementById('lb-detail');
    if (!detail) return;
    const bColor = BOROUGH_COLORS[r.BOROUGH] || '#888';

    const draw = () => {
      detail.innerHTML = `
        <div class="lb-detail-left">
          <div class="lb-detail-borough" style="background:${bColor}1a;color:${bColor}">${r.BOROUGH}</div>
          <div class="lb-detail-name">${r.NTA}</div>
          <div class="lb-detail-stats">
            <span class="lb-stat"><strong>${fmt(r.rat_positive)}</strong> rat positive</span>
            <span class="lb-stat-sep">·</span>
            <span class="lb-stat"><strong>${fmt(r.total)}</strong> total</span>
            <span class="lb-stat-sep">·</span>
            <span class="lb-stat"><strong>${fmt(r.rat_activity)}</strong> active signs</span>
          </div>
        </div>
        <div class="lb-detail-right">
          <div class="lb-detail-score">${r.rat_rate}%</div>
          <div class="lb-detail-score-label">Rat Positive Rate</div>
          <div class="lb-detail-bar">
            <div class="lb-detail-bar-fill" id="lb-detail-bar-fill" style="width:0%;background:${bColor}"></div>
          </div>
        </div>`;
      detail.classList.remove('lb-fade');
      requestAnimationFrame(() => {
        const fill = document.getElementById('lb-detail-bar-fill');
        if (fill) fill.style.width = `${r.rat_rate}%`;
      });
    };

    if (animate) {
      detail.classList.add('lb-fade');
      setTimeout(draw, 100);
    } else {
      draw();
    }
  }

  function selectNTA(r) {
    const inp = document.getElementById('lb-input');
    if (inp) inp.value = `${r.NTA} · ${r.BOROUGH} · ${r.rat_rate}% positive`;
    renderDetail(r, true);
    el.querySelector('.lb-detail')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  const initRow = (prevNTA && rows.find(r => r.NTA === prevNTA)) || rows[0];
  if (prevNTA && rows.find(r => r.NTA === prevNTA)) {
    document.getElementById('lb-input').value =
      `${initRow.NTA} · ${initRow.BOROUGH} · ${initRow.rat_rate}% positive`;
  }
  renderDetail(initRow, false);

  document.getElementById('lb-input').addEventListener('input', function () {
    const val    = this.value.trim();
    const ntaStr = val.includes(' · ') ? val.split(' · ')[0].trim() : val;
    if (ntaStr.length < 2) return;
    const r = rows.find(row => row.NTA === ntaStr) ||
              rows.find(row => row.NTA.toLowerCase().startsWith(ntaStr.toLowerCase()));
    if (r) renderDetail(r, true);
  });

  el.querySelectorAll('.lb-row[data-nta]').forEach(rowEl =>
    rowEl.addEventListener('click', () => {
      const r = rows.find(row => row.NTA === rowEl.dataset.nta);
      if (r) selectNTA(r);
    })
  );
}

// ── Type chart ────────────────────────────────────────────────────────────────

function initTypeChart() {
  const tc  = themeColors();
  const ctx = document.getElementById('type-chart').getContext('2d');
  typeChart = new Chart(ctx, {
    type: 'doughnut',
    data: { labels: [], datasets: [] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: { duration: 400 },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: isDark() ? '#0F1F38' : '#FFFFFF',
          titleColor: isDark() ? '#EDF3FC' : '#0D1E35',
          bodyColor:  isDark() ? '#A0B8D8' : '#374B6E',
          borderColor: isDark() ? '#1E3A5F' : '#D9E3EF', borderWidth: 1,
          callbacks: {
            label: ctx => ` ${ctx.label}: ${ctx.parsed.toFixed(1)}% rat positive (${fmtFull(ctx.dataset.totals[ctx.dataIndex])} inspections)`,
          },
        },
      },
    },
  });
  updateTypeChart();
}

function updateTypeChart() {
  const d = state.data.byType;
  const border = isDark() ? '#0F1F38' : '#FFFFFF';
  const COLORS = ['#DC2626cc','#D97706cc','#2563EBcc','#7C3AEDcc','#059669cc'];
  typeChart.data.labels   = d.map(r => r.INSPECTION_TYPE);
  typeChart.data.datasets = [{
    data:   d.map(r => r.rat_rate),
    totals: d.map(r => r.total),
    backgroundColor: COLORS,
    borderColor: border, borderWidth: 2, hoverOffset: 8,
  }];
  typeChart.update('active');

  const legendEl = document.getElementById('type-legend');
  if (legendEl) {
    legendEl.innerHTML = d.map((r, i) =>
      `<li class="type-legend-item">
        <span class="type-legend-swatch" style="background:${COLORS[i % COLORS.length]}"></span>
        <span class="type-legend-name">${r.INSPECTION_TYPE}</span>
      </li>`
    ).join('');
  }
}

// ── Result breakdown chart ────────────────────────────────────────────────────

function initResultChart() {
  const tc  = themeColors();
  const ctx = document.getElementById('result-chart').getContext('2d');
  resultChart = new Chart(ctx, {
    type: 'bar',
    data: { labels: [], datasets: [] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: { duration: 400 },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: tc.text, boxWidth: 12, font: { size: 11 } } },
        tooltip: {
          backgroundColor: isDark() ? '#0F1F38' : '#FFFFFF',
          titleColor: isDark() ? '#EDF3FC' : '#0D1E35',
          bodyColor:  isDark() ? '#A0B8D8' : '#374B6E',
          borderColor: isDark() ? '#1E3A5F' : '#D9E3EF', borderWidth: 1,
          callbacks: {
            label: ctx => {
              const total = ctx.chart.data.datasets.reduce((s, ds) => s + (ds.data[ctx.dataIndex] || 0), 0);
              const pct = total ? (ctx.parsed.y / total * 100).toFixed(1) : 0;
              return ` ${ctx.dataset.label}: ${fmt(ctx.parsed.y)} (${pct}%)`;
            },
          },
        },
      },
      scales: {
        x: { stacked: true, grid: { display: false }, ticks: { color: tc.textDim, font: { size: 10 }, maxRotation: 0 } },
        y: { stacked: true, grid: { color: tc.grid }, ticks: { color: tc.textDim, font: { size: 11 }, callback: v => fmt(v) } },
      },
    },
  });
  updateResultChart();
}

function updateResultChart() {
  if (!resultChart) return;
  const years = state.data.summary.years;
  const tc = themeColors();

  const passed = [], ratActivity = [], baitApplied = [], other = [];
  years.forEach(yr => {
    let rows = state.data.byYearBorough.filter(r => r.year === yr);
    if (state.borough !== 'All') rows = rows.filter(r => r.BOROUGH === state.borough);
    const p  = rows.reduce((s, r) => s + r.passed,       0);
    const ra = rows.reduce((s, r) => s + r.rat_activity,  0);
    const ba = rows.reduce((s, r) => s + r.bait_applied,  0);
    const t  = rows.reduce((s, r) => s + r.total,         0);
    passed.push(p);
    ratActivity.push(ra);
    baitApplied.push(ba);
    other.push(Math.max(0, t - p - ra - ba));
  });

  const green = isDark() ? '#34D399bb' : '#047857bb';
  const red   = isDark() ? '#F87171bb' : '#C53030bb';
  const amber = isDark() ? '#FCD34Dbb' : '#B45309bb';
  const gray  = isDark() ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.12)';

  resultChart.data.labels   = years.map(String);
  resultChart.data.datasets = [
    { label: 'Passed',       data: passed,      backgroundColor: green, borderRadius: 0 },
    { label: 'Bait Applied', data: baitApplied,  backgroundColor: amber, borderRadius: 0 },
    { label: 'Rat Activity', data: ratActivity,  backgroundColor: red,   borderRadius: 0 },
    { label: 'Other',        data: other,        backgroundColor: gray,  borderRadius: 0 },
  ];

  const boroLabel = state.borough === 'All' ? 'All Boroughs' : state.borough;
  document.getElementById('result-subtitle').textContent =
    `Annual count of all inspection outcomes · ${boroLabel} · stacked by result type`;

  resultChart.options.scales.x.ticks.color = tc.textDim;
  resultChart.options.scales.y.ticks.color = tc.textDim;
  resultChart.options.scales.y.grid.color  = tc.grid;
  resultChart.options.plugins.legend.labels.color = tc.text;
  resultChart.update('active');
}

// ── ML prediction signals ─────────────────────────────────────────────────────

function updatePredSignals() {
  const el = document.getElementById('pred-signals');
  if (!el) return;

  // Signal 1: 5-Year Trend
  const years = state.data.summary.years;
  const yearRates = years.map(yr => {
    let rows = state.data.byYearBorough.filter(r => r.year === yr);
    if (state.borough !== 'All') rows = rows.filter(r => r.BOROUGH === state.borough);
    const total  = rows.reduce((s,r) => s + r.total, 0);
    const ratPos = rows.reduce((s,r) => s + r.rat_positive, 0);
    return total ? ratPos/total*100 : 0;
  });
  const recent = years.slice(-6), recentRates = recent.map(yr => yearRates[years.indexOf(yr)]);
  const reg = linearRegression(recent, recentRates);
  const trendPerYear = reg.slope;
  const trendStr   = Math.abs(trendPerYear) < 0.2 ? 'Stable'
    : trendPerYear > 0 ? `↑ +${trendPerYear.toFixed(1)}%/yr` : `↓ ${trendPerYear.toFixed(1)}%/yr`;
  const trendColor = Math.abs(trendPerYear) < 0.2 ? 'var(--c-text-3)'
    : trendPerYear > 0 ? 'var(--c-red)' : 'var(--c-green)';

  // Signal 2: Peak Season
  const peakRates = Array.from({length:12}, (_,mi) => {
    const rows   = state.data.byYearMonthBoro.filter(r => r.month === mi+1);
    const total  = rows.reduce((s,r) => s + r.total, 0);
    const ratPos = rows.reduce((s,r) => s + r.rat_positive, 0);
    return total ? ratPos/total*100 : 0;
  });
  const peakIdx = peakRates.indexOf(Math.max(...peakRates));

  // Signal 3: Highest Risk Borough
  let highBoro = '', highRate = 0;
  Object.keys(BOROUGH_COLORS).forEach(b => {
    let rows = state.data.byYearBorough.filter(r => r.BOROUGH === b);
    if (!state.allYears) rows = rows.filter(r => r.year === state.year);
    const total = rows.reduce((s,r) => s + r.total, 0);
    const rate  = total ? rows.reduce((s,r) => s + r.rat_positive, 0)/total*100 : 0;
    if (rate > highRate) { highRate = rate; highBoro = b; }
  });

  // Signal 4: RF Model Performance (from ml_summary.json)
  const mlSum      = state.data.mlSummary;
  const aucStr     = mlSum ? mlSum.auc_roc.toFixed(2) : '—';
  const accuracyStr = mlSum ? (mlSum.accuracy * 100).toFixed(1) + '%' : '—';

  // Signal 5: High-Risk ZIP count (from ml_zip_risk.json, filtered by borough)
  let zipRisk = [...(state.data.mlZipRisk || [])];
  if (state.borough !== 'All') zipRisk = zipRisk.filter(r => r.BOROUGH === state.borough);
  const highRiskCount = zipRisk.filter(r => r.prediction === 1).length;
  const totalZips     = zipRisk.length;

  const signals = [
    {
      label: '5-Year Trend',
      value: trendStr,
      desc:  'Slope from last 6 years of inspection data',
      color: trendColor,
      icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>`,
    },
    {
      label: 'Peak Season',
      value: MONTHS[peakIdx],
      desc:  `Avg ${peakRates[peakIdx].toFixed(1)}% — prime inspection window`,
      color: 'var(--c-amber)',
      icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`,
    },
    {
      label: 'Highest Risk Borough',
      value: highBoro || '—',
      desc:  `${highRate.toFixed(1)}% rat positive · ${state.allYears ? 'all years' : state.year}`,
      color: 'var(--c-red)',
      icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>`,
    },
    {
      label: 'RF Model AUC-ROC',
      value: aucStr,
      desc:  `${accuracyStr} accuracy · Random Forest · 17 features`,
      color: 'var(--c-blue)',
      icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`,
    },
    {
      label: 'High-Risk ZIPs (ML)',
      value: totalZips ? `${highRiskCount} / ${totalZips}` : '—',
      desc:  'ZIPs flagged high-risk · RF classifier · latest snapshot',
      color: 'var(--c-red)',
      icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
    },
  ];

  el.innerHTML = signals.map(s => `
    <div class="signal-card">
      <div class="signal-icon" style="background:color-mix(in srgb,${s.color} 15%,transparent);color:${s.color}">${s.icon}</div>
      <div class="signal-label">${s.label}</div>
      <div class="signal-value" style="color:${s.color}">${s.value}</div>
      <div class="signal-desc">${s.desc}</div>
    </div>`).join('');
}

function updateMLZipTable() {
  const el = document.getElementById('ml-zip-table');
  if (!el) return;

  let rows = [...(state.data.mlZipRisk || [])];
  if (state.borough !== 'All') rows = rows.filter(r => r.BOROUGH === state.borough);
  rows = rows.sort((a, b) => b.risk_score - a.risk_score);
  if (!rows.length) { el.innerHTML = ''; return; }

  // Preserve selected ZIP across re-renders
  const prevInp = document.getElementById('ml-zip-input');
  const prevZip = prevInp ? (prevInp.value.match(/^(\d{5})/) || [])[1] : null;

  const datalistOpts = rows.map(r => {
    const pct  = (r.risk_score * 100).toFixed(1);
    const risk = r.prediction === 1 ? 'High Risk' : 'Low Risk';
    return `<option value="${r.ZIP_CODE} · ${r.BOROUGH} · ${pct}% — ${risk}">`;
  }).join('');

  const navyBar  = isDark() ? '#5898E8' : '#1B3A6B';
  const top10    = rows.slice(0, 10);

  el.innerHTML = `
    <div class="ml-zip-explorer">
      <div class="ml-zip-explorer-hd">
        ZIP Code Risk Explorer
        <span>RF model · latest snapshot · 2023–2025 · ${rows.length} ZIP codes</span>
      </div>
      <div class="ml-zip-select-wrap">
        <label class="ml-zip-select-label" for="ml-zip-input">Search ZIP</label>
        <input type="text" id="ml-zip-input" list="ml-zip-datalist"
               placeholder="Type a ZIP code…" autocomplete="off" class="ml-zip-input" />
        <datalist id="ml-zip-datalist">${datalistOpts}</datalist>
      </div>
      <div class="ml-zip-detail" id="ml-zip-detail"></div>
      <div class="ml-zip-list-hd">Top High-Risk ZIP Codes<span> · click a row to inspect</span></div>
      <div class="ml-zip-list">
        ${top10.map((r, i) => {
          const bColor  = BOROUGH_COLORS[r.BOROUGH] || '#888';
          const pct     = Math.round(r.risk_score * 100);
          const rankCls = i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : '';
          const badge   = r.prediction === 1
            ? `<span class="zip-risk-badge high">High Risk</span>`
            : `<span class="zip-risk-badge low">Low Risk</span>`;
          return `
            <div class="ml-zip-row" data-zip="${r.ZIP_CODE}">
              <span class="lb-rank ${rankCls}">${i + 1}</span>
              <span class="ml-zip-code">${r.ZIP_CODE}</span>
              <span class="lb-boro" style="color:${bColor};background:${bColor}1a">${r.BOROUGH}</span>
              <div class="ml-zip-bar-wrap">
                <div class="lb-bar-bg" style="flex:1">
                  <div class="lb-bar-fill" style="width:${pct}%;background:${navyBar}"></div>
                </div>
                <span class="ml-zip-score">${(r.risk_score * 100).toFixed(1)}%</span>
              </div>
              ${badge}
            </div>`;
        }).join('')}
      </div>
    </div>`;

  function renderDetail(r, animate) {
    const detail = document.getElementById('ml-zip-detail');
    if (!detail) return;
    const pct    = (r.risk_score * 100).toFixed(1);
    const bColor = BOROUGH_COLORS[r.BOROUGH] || '#888';
    const barClr = r.prediction === 1 ? 'var(--c-red)' : 'var(--c-green)';
    const badge  = r.prediction === 1
      ? `<span class="zip-risk-badge high">High Risk</span>`
      : `<span class="zip-risk-badge low">Low Risk</span>`;
    const mon = MONTHS[(r.month || 1) - 1] || '—';

    const draw = () => {
      detail.innerHTML = `
        <div class="ml-zip-detail-left">
          <div class="ml-zip-detail-zip">${r.ZIP_CODE}</div>
          <div class="ml-zip-detail-borough" style="background:${bColor}1a;color:${bColor}">${r.BOROUGH}</div>
        </div>
        <div class="ml-zip-detail-center">
          <div class="ml-zip-detail-bar-wrap">
            <div class="ml-zip-detail-bar">
              <div class="ml-zip-detail-bar-fill" id="ml-detail-bar-fill" style="width:0%;background:${barClr}"></div>
            </div>
            <span class="ml-zip-detail-pct">${pct}%</span>
          </div>
          <div class="ml-zip-detail-meta">${badge}<span class="ml-zip-period">Latest: ${mon} ${r.year}</span></div>
        </div>
        <div class="ml-zip-detail-right">
          <div class="ml-zip-detail-score">${pct}%</div>
          <div class="ml-zip-detail-score-label">Risk Score</div>
        </div>`;
      detail.classList.remove('zip-fade');
      requestAnimationFrame(() => {
        const fill = document.getElementById('ml-detail-bar-fill');
        if (fill) fill.style.width = `${pct}%`;
      });
    };

    if (animate) {
      detail.classList.add('zip-fade');
      setTimeout(draw, 100);
    } else {
      draw();
    }
  }

  function selectZip(r) {
    const inp = document.getElementById('ml-zip-input');
    if (inp) {
      const pct  = (r.risk_score * 100).toFixed(1);
      const risk = r.prediction === 1 ? 'High Risk' : 'Low Risk';
      inp.value  = `${r.ZIP_CODE} · ${r.BOROUGH} · ${pct}% — ${risk}`;
    }
    renderDetail(r, true);
    el.querySelector('.ml-zip-detail')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // Set initial detail
  const initRow = (prevZip && rows.find(r => String(r.ZIP_CODE) === prevZip)) || rows[0];
  if (prevZip && rows.find(r => String(r.ZIP_CODE) === prevZip)) {
    const pct  = (initRow.risk_score * 100).toFixed(1);
    const risk = initRow.prediction === 1 ? 'High Risk' : 'Low Risk';
    document.getElementById('ml-zip-input').value =
      `${initRow.ZIP_CODE} · ${initRow.BOROUGH} · ${pct}% — ${risk}`;
  }
  renderDetail(initRow, false);

  // Input: fires on every keystroke + datalist selection
  document.getElementById('ml-zip-input').addEventListener('input', function () {
    const zipStr = (this.value.trim().match(/^(\d{5})/) || [])[1];
    if (zipStr) {
      const r = rows.find(row => String(row.ZIP_CODE) === zipStr);
      if (r) renderDetail(r, true);
    }
  });

  // List rows: click to inspect
  el.querySelectorAll('.ml-zip-row[data-zip]').forEach(rowEl =>
    rowEl.addEventListener('click', () => {
      const r = rows.find(row => String(row.ZIP_CODE) === rowEl.dataset.zip);
      if (r) selectZip(r);
    })
  );
}

// ── Controls ──────────────────────────────────────────────────────────────────

function initControls() {
  const slider  = document.getElementById('year-slider');
  const display = document.getElementById('year-display');
  const btnAll  = document.getElementById('btn-all-years');

  slider.addEventListener('input', () => {
    stopPlay(); state.year = parseInt(slider.value); state.allYears = false;
    display.textContent = state.year; btnAll.classList.remove('active'); render();
  });

  btnAll.addEventListener('click', () => {
    stopPlay(); state.allYears = true; display.textContent = 'All';
    btnAll.classList.add('active'); render();
  });

  document.getElementById('btn-play').addEventListener('click', togglePlay);
  document.getElementById('theme-toggle').addEventListener('click', toggleTheme);

  document.querySelectorAll('.pill[data-borough]').forEach(btn =>
    btn.addEventListener('click', () => selectBorough(btn.dataset.borough))
  );

  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if (e.code === 'ArrowRight') {
      e.preventDefault(); stopPlay();
      if (!state.allYears && state.year < 2025) { state.year++; syncYearUI(); btnAll.classList.remove('active'); render(); }
    } else if (e.code === 'ArrowLeft') {
      e.preventDefault(); stopPlay();
      if (state.allYears) { state.allYears = false; state.year = 2025; syncYearUI(); }
      else if (state.year > 2009) { state.year--; syncYearUI(); }
      btnAll.classList.remove('active'); render();
    }
  });
}

// ── Render ────────────────────────────────────────────────────────────────────

function render() {
  updateKPIs();
  updateSparklines();
  updateContextStrip();
  updateBoroughChart();
  updateSeasonChart();
  updateLeaderboard();
  updateMap();
  highlightCalendarYear();
  updateTrendChart();
  updateBoroughMarkers();
  updateResultChart();
  updatePredSignals();
  updateMLZipTable();
}

// ── Boot ──────────────────────────────────────────────────────────────────────

async function init() {
  // Inject flash animation (not in CSS to keep app.js self-contained)
  const s = document.createElement('style');
  s.textContent = `@keyframes kpi-flash{0%{opacity:.3;transform:scale(.95)}100%{opacity:1;transform:scale(1)}}.kpi-value.flash{animation:kpi-flash .32s ease-out}`;
  document.head.appendChild(s);

  // Apply saved theme before data loads
  const saved = localStorage.getItem('nycRatTheme') || 'light';
  document.documentElement.dataset.theme = saved;
  updateThemeToggleBtn();

  await loadData();

  const loadEl = document.getElementById('loading');
  loadEl.classList.add('fade');
  setTimeout(() => { loadEl.style.display = 'none'; }, 400);
  document.getElementById('app').classList.remove('hidden');

  initControls();
  initMap();
  initBoroughChart();
  initSeasonChart();
  initTypeChart();
  initResultChart();
  initTrendChart();
  buildCalendarHeatmap();
  render();
}

window.addEventListener('DOMContentLoaded', init);
