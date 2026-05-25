// Hawaii Election Dashboard — client-side state + rendering.
// Data is index-encoded in window.__DATA (see preprocess.py).

const PLOTLY_THEME = {
  paper_bgcolor: 'rgba(0,0,0,0)',
  plot_bgcolor: 'rgba(0,0,0,0)',
  font: { color: '#d1d5db', family: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', size: 12 },
  margin: { t: 30, r: 20, b: 60, l: 50 },
  xaxis: { gridcolor: '#262626', zerolinecolor: '#333', tickfont: { color: '#9ca3af' } },
  yaxis: { gridcolor: '#262626', zerolinecolor: '#333', tickfont: { color: '#9ca3af' } },
  legend: { font: { color: '#d1d5db' }, bgcolor: 'rgba(0,0,0,0)' },
  hoverlabel: { bgcolor: '#1a1a1a', bordercolor: '#333', font: { color: '#f9fafb' } },
};

const PLOTLY_CONFIG = { responsive: true, displaylogo: false, modeBarButtonsToRemove: ['lasso2d', 'select2d'] };

// District-type metadata: prefix used in labels + the row field
const DISTRICT_TYPES = [
  { prefix: 'HD', key: 'hd' },
  { prefix: 'SD', key: 'sd' },
  { prefix: 'CONGRESS', key: 'cd' },
  { prefix: 'COUNTY', key: 'cc' },
];

function parseDistrictLabel(label) {
  // "HD-3" -> { prefix: "HD", value: "3" }
  const idx = label.indexOf('-');
  if (idx === -1) return null;
  return { prefix: label.slice(0, idx), value: label.slice(idx + 1) };
}

function districtFieldFor(prefix) {
  const m = DISTRICT_TYPES.find(d => d.prefix === prefix);
  return m ? m.key : null;
}

// Build a full district label list from data
function buildDistrictLabels(data) {
  const out = [];
  for (const { prefix, key } of DISTRICT_TYPES) {
    const vals = data.districts[key] || [];
    for (const v of vals) out.push(`${prefix}-${v}`);
  }
  return out;
}

// ---------- Alpine root ----------
function dashboard() {
  return {
    tab: 'dashboard',
    filters: { years: [], types: [], districts: [], races: [] },
    combineVotes: true,
    viewMode: 'cbp',  // 'cbp' = candidates by precinct, 'pbc' = precincts by candidate
    chart1Pct: true,
    turnoutPct: false,
    raceSearch: '',
    districtSearch: '',
    ranking: { year: null, type: null, view: 'precinct', display: 'both' },
    rankingRows: [],
    stats: { totalVotes: 0, precinctCount: 0, candidateCount: 0 },
    statusMessage: '',
    resultsTableHtml: '',
    mapStatus: '',
    mapHideUnselected: false,
    demoMode: 'precinct',  // 'precinct' = 2020 Decennial per-precinct; 'district' = 2023 ACS per HD/SD
    _geojson: null,
    _geojsonPromise: null,
    _precinctCentroids: null,
    _mapZoom: 6.2,
    _labelReposition: null,
    _labelHandlersBound: false,

    init() {
      const data = window.__DATA;
      if (!data) {
        document.body.innerHTML = '<div style="padding: 40px; color: #ef4444;">Failed to load data.js</div>';
        return;
      }
      this._data = data;
      this._allDistricts = buildDistrictLabels(data);

      // defaults
      if (data.years.includes(2024)) this.filters.years = [2024];
      else if (data.years.length) this.filters.years = [data.years[data.years.length - 1]];
      if (data.types.includes('Primary')) this.filters.types = ['Primary'];
      else if (data.types.length) this.filters.types = [data.types[0]];
      if (this._allDistricts.length) this.filters.districts = [this._allDistricts[0]];

      this.ranking.year = data.years[data.years.length - 1];
      this.ranking.type = data.types.includes('Primary') ? 'Primary' : data.types[0];

      // Kick off GeoJSON fetch in parallel with first render
      this._loadGeojson();

      // Wait for Alpine to mount, then render
      this.$nextTick(() => this.refresh());
    },

    _loadGeojson() {
      if (this._geojson) return Promise.resolve(this._geojson);
      if (this._geojsonPromise) return this._geojsonPromise;
      this.mapStatus = 'Loading map…';
      this._geojsonPromise = fetch('https://map.mohoaina.com/Precincts.geojson')
        .then(r => {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        })
        .then(gj => {
          this._geojson = gj;
          this.mapStatus = '';
          return gj;
        })
        .catch(err => {
          this.mapStatus = 'Map failed to load: ' + err.message;
          this._geojsonPromise = null;
          return null;
        });
      return this._geojsonPromise;
    },

    toggle(key, value) {
      const arr = this.filters[key];
      const i = arr.indexOf(value);
      if (i === -1) arr.push(value);
      else arr.splice(i, 1);
    },

    filteredDistricts() {
      const q = this.districtSearch.toLowerCase();
      const list = this._allDistricts.map(label => ({ label }));
      return q ? list.filter(d => d.label.toLowerCase().includes(q)) : list;
    },

    availableRaces() {
      // Races that have at least one row matching year/type/district
      const data = this._data;
      const yi = new Set(this.filters.years.map(y => data.years.indexOf(y)));
      const ti = new Set(this.filters.types.map(t => data.types.indexOf(t)));
      const districtFilter = this._buildDistrictFilter();
      const e = data.election;
      const seen = new Set();
      for (let i = 0; i < e.yi.length; i++) {
        if (yi.size && !yi.has(e.yi[i])) continue;
        if (ti.size && !ti.has(e.ti[i])) continue;
        if (districtFilter && !districtFilter(e.pi[i])) continue;
        seen.add(e.ri[i]);
      }
      const result = [];
      for (const ri of seen) result.push(data.races[ri]);
      result.sort();
      return result;
    },

    filteredRaces() {
      const q = this.raceSearch.toLowerCase();
      const avail = this.availableRaces();
      return q ? avail.filter(r => r.toLowerCase().includes(q)) : avail;
    },

    _buildDistrictFilter() {
      if (!this.filters.districts.length) return null;
      const data = this._data;
      // pi -> bool
      const allowedPi = new Set();
      for (const label of this.filters.districts) {
        const parsed = parseDistrictLabel(label);
        if (!parsed) continue;
        const fieldKey = districtFieldFor(parsed.prefix);
        if (!fieldKey) continue;
        // Walk mapping_by_pi
        for (const [piStr, m] of Object.entries(data.mapping)) {
          if (m[fieldKey] === parsed.value) {
            allowedPi.add(parseInt(piStr, 10));
          }
        }
      }
      return (pi) => allowedPi.has(pi);
    },

    _filterElection() {
      const data = this._data;
      const yi = new Set(this.filters.years.map(y => data.years.indexOf(y)));
      const ti = new Set(this.filters.types.map(t => data.types.indexOf(t)));
      const ri = new Set(this.filters.races.map(r => data.races.indexOf(r)));
      const districtFilter = this._buildDistrictFilter();
      const e = data.election;
      // Aggregate (or not) into rows {p, c, r, v, vt}
      // If combineVotes: sum across vt. Else: keep vt-separated rows.
      const agg = new Map();  // key -> { pi, ci, ri, vt, v }
      for (let i = 0; i < e.yi.length; i++) {
        if (yi.size && !yi.has(e.yi[i])) continue;
        if (ti.size && !ti.has(e.ti[i])) continue;
        if (ri.size && !ri.has(e.ri[i])) continue;
        if (districtFilter && !districtFilter(e.pi[i])) continue;
        const vt = this.combineVotes ? '' : e.vt[i];
        const key = `${e.pi[i]}|${e.ri[i]}|${e.ci[i]}|${vt}`;
        const existing = agg.get(key);
        if (existing) existing.v += e.v[i];
        else agg.set(key, { pi: e.pi[i], ri: e.ri[i], ci: e.ci[i], vt, v: e.v[i] });
      }
      // Compute percentages per (precinct, race)
      const totals = new Map();  // `${pi}|${ri}|${vt}` -> total v
      for (const r of agg.values()) {
        const k = `${r.pi}|${r.ri}|${r.vt}`;
        totals.set(k, (totals.get(k) || 0) + r.v);
      }
      const rows = [];
      for (const r of agg.values()) {
        const tot = totals.get(`${r.pi}|${r.ri}|${r.vt}`);
        rows.push({
          precinct: this._data.precincts[r.pi],
          precinctLabel: r.vt ? `${r.vt === 'M' ? 'MAIL ' : 'IN-PERSON '}${this._data.precincts[r.pi]}` : this._data.precincts[r.pi],
          race: this._data.races[r.ri],
          candidate: this._data.candidates[r.ci],
          votes: r.v,
          pct: tot > 0 ? (r.v / tot) * 100 : 0,
          vt: r.vt,
        });
      }
      return rows;
    },

    _filterTurnout() {
      const data = this._data;
      const yi = new Set(this.filters.years.map(y => data.years.indexOf(y)));
      const ti = new Set(this.filters.types.map(t => data.types.indexOf(t)));
      const districtFilter = this._buildDistrictFilter();
      const t = data.turnout;
      const rows = [];
      for (let i = 0; i < t.yi.length; i++) {
        if (yi.size && !yi.has(t.yi[i])) continue;
        if (ti.size && !ti.has(t.ti[i])) continue;
        if (districtFilter && !districtFilter(t.pi[i])) continue;
        rows.push({
          precinct: data.precincts[t.pi[i]],
          pi: t.pi[i],
          reg: t.reg[i],
          tn: t.tn[i],
          tp: t.tp[i],
          dem: t.parties.democraticParty ? t.parties.democraticParty[i] : 0,
          rep: t.parties.republicanParty ? t.parties.republicanParty[i] : 0,
        });
      }
      return rows;
    },

    refresh() {
      if (this.tab !== 'dashboard') return;
      // Prune races that are no longer available
      const avail = new Set(this.availableRaces());
      this.filters.races = this.filters.races.filter(r => avail.has(r));
      this.renderAll();
    },

    renderAll() {
      if (this.tab !== 'dashboard') return;
      if (this.filters.races.length === 0) {
        ['chart1', 'chart2', 'chart3'].forEach(id => {
          const el = document.getElementById(id);
          if (el) Plotly.purge(el);
        });
        this.resultsTableHtml = '';
        const demoEl = document.getElementById('demographics');
        if (demoEl) demoEl.innerHTML = '';
        return;
      }
      this._filteredCache = this._filterElection();
      this._turnoutCache = this._filterTurnout();
      this.stats = {
        totalVotes: this._filteredCache.reduce((s, r) => s + r.votes, 0),
        precinctCount: new Set(this._filteredCache.map(r => r.precinctLabel)).size,
        candidateCount: new Set(this._filteredCache.map(r => r.candidate)).size,
      };
      this.statusMessage = this.combineVotes
        ? 'Vote Aggregation: Mail + in-person combined per precinct.'
        : 'Vote Breakdown: Mail and in-person shown separately.';
      // Defer Plotly renders until Alpine has flushed the x-show DOM updates.
      this.$nextTick(() => {
        this.renderChart1();
        this.renderChart2();
        this.renderChart3();
        this.buildResultsTable();
        this.renderMap();
        this.renderDemographics();
      });
    },

    _computeCentroids(geo) {
      if (this._precinctCentroids) return this._precinctCentroids;
      const polyCentroid = (ring) => {
        let sx = 0, sy = 0, n = 0;
        for (const [x, y] of ring) { sx += x; sy += y; n++; }
        return [sx / n, sy / n];
      };
      const out = new Map();
      for (const feat of geo.features) {
        const g = feat.geometry;
        let c = null;
        if (g.type === 'Polygon') c = polyCentroid(g.coordinates[0]);
        else if (g.type === 'MultiPolygon') {
          let best = null, bestLen = -1;
          for (const poly of g.coordinates) {
            if (poly[0].length > bestLen) { bestLen = poly[0].length; best = poly; }
          }
          if (best) c = polyCentroid(best[0]);
        }
        if (c) out.set(feat.properties.dp, c);
      }
      this._precinctCentroids = out;
      return out;
    },

    async renderMap() {
      const el = document.getElementById('mapChart');
      if (!el) return;
      const geo = await this._loadGeojson();
      if (!geo) return;

      const rows = this._filteredCache || [];
      const selected = new Set(rows.map(r => r.precinct));
      const hideUnsel = this.mapHideUnselected && selected.size > 0;
      const centroids = this._computeCentroids(geo);

      // Split centroids: selected (always shown) vs others (shown unless hidden)
      const allLng = [], allLat = [], allTxt = [];
      const selLng = [], selLat = [], selTxt = [];
      for (const [dp, [lng, lat]] of centroids) {
        if (selected.has(dp)) { selLng.push(lng); selLat.push(lat); selTxt.push(dp); }
        else if (!hideUnsel)  { allLng.push(lng); allLat.push(lat); allTxt.push(dp); }
      }

      // Empty scatter trace — labels are rendered as HTML overlays below
      // (scattermap text rendering is broken in this dashboard context)
      const traces = [{
        type: 'scattermap', mode: 'markers',
        lon: [], lat: [],
        marker: { size: 0 },
        hoverinfo: 'skip',
      }];

      const layers = [
        {
          sourcetype: 'raster',
          source: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
          type: 'raster',
          below: 'traces',
        },
      ];
      const selFeatures = {
        type: 'FeatureCollection',
        features: geo.features.filter(f => selected.has(f.properties.dp)),
      };
      if (hideUnsel) {
        // Only outline selected precincts
        layers.push({
          sourcetype: 'geojson', source: selFeatures,
          type: 'line', color: '#fbbf24', line: { width: 2.5 },
        });
      } else {
        // Outline everything; selected gets a brighter, thicker line on top
        layers.push({
          sourcetype: 'geojson',
          source: 'https://map.mohoaina.com/Precincts.geojson',
          type: 'line', color: '#3b82f6', line: { width: 1 },
        });
        if (selected.size) {
          layers.push({
            sourcetype: 'geojson', source: selFeatures,
            type: 'line', color: '#fbbf24', line: { width: 2.5 },
          });
        }
      }

      Plotly.react(el, traces, {
        ...PLOTLY_THEME,
        map: {
          style: 'white-bg',
          layers,
          center: { lat: 20.7, lon: -157.5 },
          zoom: this._mapZoom,
        },
        height: 600,
        margin: { t: 10, r: 10, b: 10, l: 10 },
        showlegend: false,
      }, { ...PLOTLY_CONFIG, scrollZoom: true });

      // HTML overlay labels — Plotly's scattermap text fails in this context,
      // so we draw labels ourselves on top of the maplibre canvas.
      this._renderMapLabels(centroids, selected, hideUnsel);
    },

    _renderMapLabels(centroids, selected, hideUnsel) {
      const el = document.getElementById('mapChart');
      if (!el) return;
      const subplot = el._fullLayout?.map?._subplot;
      const mlMap = subplot?.map;
      if (!mlMap) {
        // Plotly hasn't finished mounting the maplibre map yet — try again
        setTimeout(() => this._renderMapLabels(centroids, selected, hideUnsel), 200);
        return;
      }

      // Ensure overlay container exists, positioned over the map
      let overlay = el.querySelector('.precinct-label-overlay');
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.className = 'precinct-label-overlay';
        Object.assign(overlay.style, {
          position: 'absolute', inset: '0', pointerEvents: 'none',
          overflow: 'hidden', zIndex: '5',
        });
        // mapChart is .chart-body inside .chart-card; make sure it can hold absolutely-positioned children
        const cs = window.getComputedStyle(el);
        if (cs.position === 'static') el.style.position = 'relative';
        el.appendChild(overlay);
      }

      const visible = [];
      for (const [dp, [lng, lat]] of centroids) {
        const isSel = selected.has(dp);
        if (hideUnsel && !isSel) continue;
        visible.push({ dp, lng, lat, isSel });
      }

      // Diff against existing children
      const byDp = new Map();
      overlay.querySelectorAll('span[data-dp]').forEach(n => byDp.set(n.dataset.dp, n));
      const keep = new Set();
      for (const v of visible) {
        keep.add(v.dp);
        let span = byDp.get(v.dp);
        if (!span) {
          span = document.createElement('span');
          span.dataset.dp = v.dp;
          span.textContent = v.dp;
          Object.assign(span.style, {
            position: 'absolute',
            transform: 'translate(-50%, -50%)',
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
            fontWeight: '700',
            whiteSpace: 'nowrap',
            pointerEvents: 'none',
            textShadow: '0 0 4px rgba(0,0,0,0.95), 0 0 8px rgba(0,0,0,0.7)',
          });
          overlay.appendChild(span);
        }
        span.style.color = v.isSel ? '#fbbf24' : '#ffffff';
      }
      // Remove no-longer-visible labels
      for (const [dp, node] of byDp) if (!keep.has(dp)) node.remove();

      // Latest reposition fn is stored on `this`; the bound map handler reads it.
      // Smooth size curve: z=6 (state) ~11px, z=10 (county) ~22px, z=13 (city) ~36px, z=16 (street) ~52px.
      this._labelReposition = () => {
        const z = mlMap.getZoom();
        const size = Math.max(11, Math.round(11 + Math.pow(Math.max(0, z - 6), 1.3) * 2.2));
        for (const v of visible) {
          const node = overlay.querySelector(`span[data-dp="${CSS.escape(v.dp)}"]`);
          if (!node) continue;
          const p = mlMap.project([v.lng, v.lat]);
          node.style.left = p.x + 'px';
          node.style.top = p.y + 'px';
          node.style.fontSize = (v.isSel ? Math.round(size * 1.25) : size) + 'px';
        }
      };
      this._labelReposition();

      if (!this._labelHandlersBound) {
        const fire = () => this._labelReposition && this._labelReposition();
        mlMap.on('move', fire);
        mlMap.on('zoom', fire);
        mlMap.on('resize', fire);
        this._labelHandlersBound = true;
      }
    },

    get chart1Title() {
      const base = this.viewMode === 'cbp' ? 'Vote' : 'Vote';
      const what = this.chart1Pct ? 'Share' : 'Distribution';
      return this.viewMode === 'cbp'
        ? (this.chart1Pct ? 'Vote Share by Precinct' : 'Votes by Precinct')
        : (this.chart1Pct ? 'Vote Share by Candidate' : 'Votes by Candidate');
    },

    renderChart1() {
      const rows = this._filteredCache;
      if (!rows || !rows.length) return Plotly.purge(document.getElementById('chart1'));
      const multiRace = this.filters.races.length > 1;
      const yKey = this.chart1Pct ? 'pct' : 'votes';
      const yTitle = this.chart1Pct ? 'Vote Share (%)' : 'Votes';

      let traces;
      if (this.viewMode === 'cbp') {
        // x = precinctLabel, color = candidate (or race+candidate)
        const colorKey = multiRace ? r => `${r.race} — ${r.candidate}` : r => r.candidate;
        const groups = new Map();
        for (const r of rows) {
          const k = colorKey(r);
          if (!groups.has(k)) groups.set(k, []);
          groups.get(k).push(r);
        }
        const allPrecincts = [...new Set(rows.map(r => r.precinctLabel))].sort();
        traces = [];
        for (const [name, grp] of groups) {
          const byPrec = new Map(grp.map(r => [r.precinctLabel, r[yKey]]));
          traces.push({
            type: 'bar', name,
            x: allPrecincts,
            y: allPrecincts.map(p => byPrec.get(p) || 0),
            hovertemplate: this.chart1Pct ? '%{x}<br>%{y:.1f}%<extra>' + name + '</extra>' : '%{x}<br>%{y:,}<extra>' + name + '</extra>',
          });
        }
      } else {
        // x = candidate (or race+cand), color = precinct
        const xKey = multiRace ? r => `${r.race} — ${r.candidate}` : r => r.candidate;
        const groups = new Map();
        for (const r of rows) {
          if (!groups.has(r.precinctLabel)) groups.set(r.precinctLabel, []);
          groups.get(r.precinctLabel).push(r);
        }
        const allX = [...new Set(rows.map(xKey))].sort();
        traces = [];
        for (const [precinctLabel, grp] of groups) {
          const byX = new Map(grp.map(r => [xKey(r), r[yKey]]));
          traces.push({
            type: 'bar', name: precinctLabel,
            x: allX,
            y: allX.map(x => byX.get(x) || 0),
            hovertemplate: this.chart1Pct ? '%{x}<br>%{y:.1f}%<extra>' + precinctLabel + '</extra>' : '%{x}<br>%{y:,}<extra>' + precinctLabel + '</extra>',
          });
        }
      }

      const layout = {
        ...PLOTLY_THEME,
        barmode: 'group',
        xaxis: { ...PLOTLY_THEME.xaxis, type: 'category', tickangle: -45, automargin: true },
        yaxis: { ...PLOTLY_THEME.yaxis, title: yTitle, automargin: true },
        showlegend: true,
        height: 420,
        margin: { t: 10, r: 20, b: 120, l: 60 },
      };
      Plotly.react('chart1', traces, layout, PLOTLY_CONFIG);
    },

    renderChart2() {
      const rows = this._filteredCache;
      if (!rows || !rows.length) return Plotly.purge(document.getElementById('chart2'));
      const multiRace = this.filters.races.length > 1;
      const groupKey = multiRace ? r => `${r.race} — ${r.candidate}` : r => r.candidate;
      const totals = new Map();
      for (const r of rows) {
        const k = groupKey(r);
        totals.set(k, (totals.get(k) || 0) + r.votes);
      }
      const labels = [...totals.keys()];
      const values = labels.map(l => totals.get(l));
      Plotly.react('chart2', [{
        type: 'pie', labels, values,
        textinfo: 'percent+label',
        textposition: 'inside',
        hovertemplate: '%{label}<br>%{value:,} votes (%{percent})<extra></extra>',
      }], {
        ...PLOTLY_THEME,
        height: 420,
        showlegend: false,
        margin: { t: 10, r: 10, b: 10, l: 10 },
      }, PLOTLY_CONFIG);
    },

    renderChart3() {
      const turnout = this._turnoutCache;
      const electionPrecincts = new Set(this._filteredCache.map(r => r.precinct));
      const rows = turnout.filter(t => electionPrecincts.has(t.precinct));
      rows.sort((a, b) => a.precinct.localeCompare(b.precinct));
      if (!rows.length) {
        Plotly.purge(document.getElementById('chart3'));
        document.getElementById('chart3').innerHTML = '<div class="empty">No turnout data for selected filters</div>';
        return;
      }

      const x = rows.map(r => r.precinct);
      const isGeneral = this.filters.types.includes('General');
      const usePct = this.turnoutPct;
      const traces = [];

      if (!isGeneral) {
        traces.push({
          type: 'bar', name: 'Democratic',
          x, y: rows.map(r => usePct ? (r.dem / Math.max(1, r.reg) * 100) : r.dem),
          marker: { color: '#3b82f6' },
          hovertemplate: usePct ? '%{y:.1f}%<extra>Democratic</extra>' : '%{y:,}<extra>Democratic</extra>',
        });
        traces.push({
          type: 'bar', name: 'Republican',
          x, y: rows.map(r => usePct ? (r.rep / Math.max(1, r.reg) * 100) : r.rep),
          marker: { color: '#ef4444' },
          hovertemplate: usePct ? '%{y:.1f}%<extra>Republican</extra>' : '%{y:,}<extra>Republican</extra>',
        });
      }
      traces.push({
        type: 'bar', name: 'Registration',
        x, y: rows.map(r => usePct ? 100 : r.reg),
        marker: { color: '#6b7280' },
        hovertemplate: usePct ? '100%<extra>Registration</extra>' : '%{y:,}<extra>Registration</extra>',
      });
      traces.push({
        type: 'bar', name: 'Turnout',
        x, y: rows.map(r => usePct ? r.tp : r.tn),
        marker: { color: '#10b981' },
        hovertemplate: usePct ? '%{y:.1f}%<extra>Turnout</extra>' : '%{y:,}<extra>Turnout</extra>',
      });

      const maxY = usePct ? 110 : Math.max(...rows.map(r => r.reg)) * 1.15;

      const annotations = rows.map(r => ({
        x: r.precinct, y: usePct ? 105 : Math.max(...rows.map(rr => rr.reg)) * 1.05,
        text: `${r.tp.toFixed(1)}%`,
        showarrow: false,
        font: { size: 10, color: '#0f0f0f', family: 'Arial Black' },
        bgcolor: '#fbbf24', opacity: 0.92, borderpad: 2,
      }));

      Plotly.react('chart3', traces, {
        ...PLOTLY_THEME,
        barmode: 'group',
        xaxis: { ...PLOTLY_THEME.xaxis, type: 'category', tickangle: -45, automargin: true },
        yaxis: { ...PLOTLY_THEME.yaxis, title: usePct ? 'Percentage of Registration (%)' : 'Count', range: [0, maxY] },
        height: 420,
        showlegend: true,
        legend: { orientation: 'h', yanchor: 'bottom', y: 1.02, xanchor: 'right', x: 1, font: { color: '#d1d5db' }, bgcolor: 'rgba(0,0,0,0)' },
        annotations,
        margin: { t: 30, r: 20, b: 120, l: 60 },
      }, PLOTLY_CONFIG);
    },

    buildResultsTable() {
      const rows = this._filteredCache;
      const turnout = this._turnoutCache;
      const precincts = [...new Set(rows.map(r => r.precinctLabel))].sort();
      // Base precinct (strip MAIL/IN-PERSON) used to look up turnout
      const basePrecincts = precincts.map(p => p.replace(/^(MAIL|IN-PERSON)\s+/, ''));

      const turnoutByPrecinct = new Map(turnout.map(t => [t.precinct, t]));

      // Candidate ordering by total votes desc
      const candidateTotals = new Map();
      for (const r of rows) candidateTotals.set(r.candidate, (candidateTotals.get(r.candidate) || 0) + r.votes);
      const candidates = [...candidateTotals.entries()].sort((a, b) => b[1] - a[1]).map(x => x[0]);

      let html = '<table class="results"><thead><tr>';
      html += '<th style="text-align:left;">Row</th>';
      html += '<th class="total-col">Total</th>';
      for (const p of precincts) html += `<th>${p}</th>`;
      html += '</tr></thead><tbody>';

      // Registration row
      let regRow = '<tr><td class="row-label">Total Registration</td>';
      let regTotal = 0;
      const regVals = precincts.map((_, i) => {
        const t = turnoutByPrecinct.get(basePrecincts[i]);
        return t ? t.reg : null;
      });
      regTotal = regVals.filter(v => v != null).reduce((s, v) => s + v, 0);
      regRow += `<td class="total-col">${regTotal ? regTotal.toLocaleString() : '-'}</td>`;
      for (const v of regVals) regRow += `<td>${v != null ? v.toLocaleString() : '-'}</td>`;
      regRow += '</tr>';
      html += regRow;

      // Turnout row
      let tnRow = '<tr><td class="row-label">Total Turnout</td>';
      const tnVals = precincts.map((_, i) => {
        const t = turnoutByPrecinct.get(basePrecincts[i]);
        return t ? t.tn : null;
      });
      const tnTotal = tnVals.filter(v => v != null).reduce((s, v) => s + v, 0);
      tnRow += `<td class="total-col">${tnTotal ? tnTotal.toLocaleString() : '-'}</td>`;
      for (const v of tnVals) tnRow += `<td>${v != null ? v.toLocaleString() : '-'}</td>`;
      tnRow += '</tr>';
      html += tnRow;

      // Candidate rows
      for (const cand of candidates) {
        const byPrec = new Map();
        for (const r of rows) {
          if (r.candidate !== cand) continue;
          byPrec.set(r.precinctLabel, (byPrec.get(r.precinctLabel) || 0) + r.votes);
        }
        let row = `<tr><td class="row-label">${cand}</td>`;
        let total = 0;
        const cells = precincts.map(p => {
          const v = byPrec.get(p) || 0;
          total += v;
          return v;
        });
        row += `<td class="total-col">${total.toLocaleString()}</td>`;
        for (const v of cells) row += `<td>${v.toLocaleString()}</td>`;
        row += '</tr>';
        html += row;
      }

      html += '</tbody></table>';
      this.resultsTableHtml = html;
    },

    // -------- Demographics --------
    renderDemographics() {
      const container = document.getElementById('demographics');
      if (!container) return;

      const isDistrict = this.demoMode === 'district';
      const sourceNote = isDistrict
        ? '2023 American Community Survey, scoped to State House or State Senate district'
        : '2020 Decennial Census, scoped to precincts of the selected races';

      const header = `
        <div class="demo-controls">
          <h2 class="demo-header-title">Demographics</h2>
          <div class="demo-toggle">
            <div class="chip ${isDistrict ? '' : 'active'}" data-demo-mode="precinct">Precinct-level</div>
            <div class="chip ${isDistrict ? 'active' : ''}" data-demo-mode="district">District-wide</div>
          </div>
        </div>
        <div class="demo-source-note">Source: ${sourceNote}.</div>
      `;
      container.innerHTML = header + '<div id="demographics-body"></div>';

      // Hook up the toggle pills
      container.querySelectorAll('[data-demo-mode]').forEach(el => {
        el.addEventListener('click', () => {
          this.demoMode = el.dataset.demoMode;
          this.renderDemographics();
        });
      });

      const body = container.querySelector('#demographics-body');
      if (isDistrict) this._renderDistrictDemographics(body);
      else this._renderPrecinctDemographics(body);
    },

    _renderDistrictDemographics(body) {
      const data = this._data;
      const acs = data.acs_district || {};

      const selected = this.filters.districts || [];
      const hdSd = selected.filter(d => d.startsWith('HD-') || d.startsWith('SD-'));

      if (selected.length === 0) {
        body.innerHTML = '<div class="status-bar" style="border-left-color: var(--amber); color: var(--text-muted);">Select a State House (HD) or State Senate (SD) district in the sidebar to view district-wide demographics.</div>';
        return;
      }
      if (hdSd.length === 0) {
        body.innerHTML = '<div class="status-bar" style="border-left-color: var(--text-dim);">District-wide data coming soon for Congressional and County Council districts.</div>';
        return;
      }

      const present = hdSd.filter(d => acs[d]);
      const missing = hdSd.filter(d => !acs[d]);

      const renderSection = (key, title, fmtPct, helpNote) => {
        const sid = 'demo-district-' + key;
        return `
          <div class="demo-section">
            <div class="demo-head">
              <h3 class="demo-title">${title}</h3>
              ${helpNote ? `<span style="font-size: 11px; color: var(--text-dim);">${helpNote}</span>` : ''}
            </div>
            <div id="${sid}" style="min-height: 380px;"></div>
          </div>
        `;
      };

      let html = '';
      if (missing.length) {
        html += `<div class="status-bar" style="border-left-color: var(--text-dim); margin-bottom: 12px;">No ACS data for: ${missing.join(', ')}.</div>`;
      }
      if (!present.length) { body.innerHTML = html; return; }

      html += renderSection('age', 'Age', false);
      html += renderSection('ethnicity', 'Ethnicity', false, 'Indented labels are sub-races within Asian / Pacific Islander');
      html += renderSection('income', 'Income', true, 'Percent of households');
      body.innerHTML = html;

      this._renderDistrictBars('demo-district-age', present, acs, 'age', { asPct: false });
      this._renderDistrictBars('demo-district-ethnicity', present, acs, 'ethnicity', { asPct: false, indented: true });
      this._renderDistrictBars('demo-district-income', present, acs, 'income', { asPct: true });
    },

    _renderDistrictBars(elId, districts, acs, key, opts) {
      // Build union of labels preserving the order from the first district that has data
      const order = [];
      const seen = new Set();
      const indentByLabel = new Map();
      for (const d of districts) {
        const rows = acs[d]?.[key] || [];
        for (const [label, , indent] of rows) {
          if (!seen.has(label)) {
            seen.add(label);
            order.push(label);
            indentByLabel.set(label, indent);
          }
        }
      }

      // Display labels: prefix sub-race rows with a non-breaking-space indent
      const displayLabels = order.map(l => (opts.indented && indentByLabel.get(l) ? '    ' + l : l));

      const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#6366f1', '#14b8a6', '#ef4444'];
      const traces = districts.map((d, i) => {
        const map = new Map((acs[d][key] || []).map(([lbl, val]) => [lbl, val]));
        const yVals = order.map(l => {
          const v = map.get(l) || 0;
          return opts.asPct ? v * 100 : v;
        });
        return {
          type: 'bar', name: d,
          x: displayLabels, y: yVals,
          marker: { color: COLORS[i % COLORS.length] },
          hovertemplate: opts.asPct
            ? '%{x}<br>%{y:.1f}%<extra>' + d + '</extra>'
            : '%{x}<br>%{y:,}<extra>' + d + '</extra>',
        };
      });

      Plotly.react(elId, traces, {
        ...PLOTLY_THEME,
        barmode: 'group',
        xaxis: { ...PLOTLY_THEME.xaxis, tickangle: -35, automargin: true, type: 'category' },
        yaxis: { ...PLOTLY_THEME.yaxis, title: opts.asPct ? '% of households' : 'Count', automargin: true, tickformat: opts.asPct ? '.0f' : ',' },
        height: 380,
        margin: { t: 10, r: 20, b: 140, l: 70 },
        showlegend: districts.length > 1,
        legend: { orientation: 'v', x: 1.02, y: 1, font: { color: '#d1d5db' }, bgcolor: 'rgba(0,0,0,0)' },
      }, PLOTLY_CONFIG);
    },

    _renderPrecinctDemographics(body) {
      const data = this._data;
      if (!data.demographics) { body.innerHTML = ''; return; }
      const precincts = [...new Set(this._filteredCache.map(r => r.precinct))].sort();
      const demoByPrec = precincts
        .map(p => {
          // demographics keyed by precinct index
          const pi = data.precincts.indexOf(p);
          return { precinct: p, pi, rec: data.demographics[pi] };
        })
        .filter(x => x.rec);

      if (!demoByPrec.length) {
        body.innerHTML = '<div class="status-bar" style="border-left-color: var(--text-dim);">No demographic data available for selected precincts.</div>';
        return;
      }

      // Build a section per category present in the first record
      const sample = demoByPrec[0].rec;
      let html = '';
      const sectionIds = [];

      // Standard categories
      const standardCats = ['Housing Occupancy', 'Housing Tenure', 'Householder Race', 'Household Size', 'Household Type'];
      for (const cat of standardCats) {
        if (!sample.categories || !sample.categories[cat]) continue;
        const sid = 'demo-' + cat.replace(/[^a-z0-9]/gi, '');
        sectionIds.push({ id: sid, kind: 'bars', cat });
        html += `
          <div class="demo-section">
            <div class="demo-head">
              <h3 class="demo-title">${cat}</h3>
              <label class="toggle-row" style="font-size: 11px;">
                <input type="checkbox" data-demo-pct="${sid}" checked> Show as %
              </label>
            </div>
            <div id="${sid}" style="min-height: 380px;"></div>
          </div>
        `;
      }

      if (sample.age_pyramid) {
        const sid = 'demo-age';
        sectionIds.push({ id: sid, kind: 'pyramid', source: 'age_pyramid', title: 'Age of Householder' });
        html += `
          <div class="demo-section">
            <div class="demo-head">
              <h3 class="demo-title">Age of Householder — Owner (left) vs Renter (right)</h3>
              <label class="toggle-row" style="font-size: 11px;">
                <input type="checkbox" data-demo-pct="${sid}" checked> Show as %
              </label>
            </div>
            <div id="${sid}" style="min-height: 460px;"></div>
          </div>
        `;
      }

      if (sample.children_pyramid) {
        const sid = 'demo-children';
        sectionIds.push({ id: sid, kind: 'pyramid', source: 'children_pyramid', title: 'Presence of Children' });
        html += `
          <div class="demo-section">
            <div class="demo-head">
              <h3 class="demo-title">Presence of Children Under 18 — Owner (left) vs Renter (right)</h3>
              <label class="toggle-row" style="font-size: 11px;">
                <input type="checkbox" data-demo-pct="${sid}" checked> Show as %
              </label>
            </div>
            <div id="${sid}" style="min-height: 380px;"></div>
          </div>
        `;
      }

      body.innerHTML = html;

      // Hook up per-section toggles + initial render
      for (const sec of sectionIds) {
        const cb = body.querySelector(`input[data-demo-pct="${sec.id}"]`);
        const render = () => {
          if (sec.kind === 'bars') this._renderDemoBars(sec.id, sec.cat, demoByPrec, cb.checked);
          else this._renderDemoPyramid(sec.id, sec.source, sec.title, demoByPrec, cb.checked);
        };
        cb.addEventListener('change', render);
        render();
      }
    },

    _renderDemoBars(elId, category, demoByPrec, asPct) {
      // For each precinct, get { label: value } in this category
      const labels = new Set();
      for (const { rec } of demoByPrec) {
        if (rec.categories && rec.categories[category]) {
          for (const k of Object.keys(rec.categories[category])) labels.add(k);
        }
      }
      const labelList = [...labels];
      const traces = [];
      for (const { precinct, rec } of demoByPrec) {
        const vals = rec.categories?.[category] || {};
        const total = rec.totals?.[category] || 0;
        const y = labelList.map(l => {
          const v = vals[l] || 0;
          return asPct && total > 0 ? (v / total * 100) : v;
        });
        traces.push({
          type: 'bar', name: precinct, x: labelList, y,
          hovertemplate: asPct ? '%{x}<br>%{y:.1f}%<extra>' + precinct + '</extra>' : '%{x}<br>%{y:,}<extra>' + precinct + '</extra>',
        });
      }
      Plotly.react(elId, traces, {
        ...PLOTLY_THEME,
        barmode: 'group',
        xaxis: { ...PLOTLY_THEME.xaxis, tickangle: -35, automargin: true, type: 'category' },
        yaxis: { ...PLOTLY_THEME.yaxis, title: asPct ? '% of category' : 'Count', automargin: true },
        height: 380,
        margin: { t: 10, r: 20, b: 140, l: 60 },
        showlegend: true,
        legend: { orientation: 'v', x: 1.02, y: 1, font: { color: '#d1d5db' }, bgcolor: 'rgba(0,0,0,0)' },
      }, PLOTLY_CONFIG);
    },

    _renderDemoPyramid(elId, sourceKey, title, demoByPrec, asPct) {
      // Pyramid: y = category labels (e.g. age buckets), x = owner (negative) | renter (positive)
      // One trace per precinct per side.
      const cats = new Set();
      for (const { rec } of demoByPrec) {
        const src = rec[sourceKey];
        if (src) {
          for (const k of Object.keys(src.owner || {})) cats.add(k);
          for (const k of Object.keys(src.renter || {})) cats.add(k);
        }
      }
      let catList;
      if (sourceKey === 'age_pyramid') {
        const order = ['15 to 24', '25 to 34', '35 to 44', '45 to 54', '55 to 64', '65 to 74', '75 to 84', '85+'];
        catList = order.filter(c => cats.has(c));
      } else {
        catList = [...cats].sort();
      }

      const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#6366f1', '#14b8a6', '#ef4444'];
      const traces = [];
      demoByPrec.forEach(({ precinct, rec }, i) => {
        const src = rec[sourceKey];
        if (!src) return;
        // Use age total column for normalization when in pct mode
        const totalForPct = asPct ? (rec.totals?.['Age of Householder'] || rec.totals?.['Presence of Children (Owner)'] || 0) : 0;
        const owner = catList.map(c => (src.owner?.[c] || 0));
        const renter = catList.map(c => (src.renter?.[c] || 0));
        const ownerVals = asPct && totalForPct > 0 ? owner.map(v => -(v / totalForPct * 100)) : owner.map(v => -v);
        const renterVals = asPct && totalForPct > 0 ? renter.map(v => (v / totalForPct * 100)) : renter;
        const color = COLORS[i % COLORS.length];
        traces.push({
          type: 'bar', name: `${precinct} (Owner)`, y: catList, x: ownerVals,
          orientation: 'h', marker: { color },
          legendgroup: precinct, showlegend: true,
          hovertemplate: (asPct ? '%{customdata:.1f}%' : '%{customdata:,}') + '<extra>' + precinct + ' Owner</extra>',
          customdata: owner.map((v, idx) => asPct && totalForPct > 0 ? (v / totalForPct * 100) : v),
        });
        traces.push({
          type: 'bar', name: `${precinct} (Renter)`, y: catList, x: renterVals,
          orientation: 'h', marker: { color, opacity: 0.6 },
          legendgroup: precinct, showlegend: false,
          hovertemplate: (asPct ? '%{x:.1f}%' : '%{x:,}') + '<extra>' + precinct + ' Renter</extra>',
        });
      });

      Plotly.react(elId, traces, {
        ...PLOTLY_THEME,
        barmode: 'overlay',
        xaxis: {
          ...PLOTLY_THEME.xaxis,
          title: asPct ? '%' : 'Count',
          tickvals: undefined,
          ticktext: undefined,
          tickformat: asPct ? '.0f' : ',',
          // Reflect absolute values on the axis: use custom labels via transform-free approach
        },
        yaxis: { ...PLOTLY_THEME.yaxis, type: 'category', categoryorder: 'array', categoryarray: catList, automargin: true },
        height: Math.max(380, 60 + catList.length * 40),
        shapes: [{ type: 'line', x0: 0, x1: 0, y0: 0, y1: 1, yref: 'paper', line: { color: '#666', width: 1.5 } }],
        annotations: [
          { x: 0.25, y: 1.05, xref: 'paper', yref: 'paper', text: '<b>OWNER</b>', showarrow: false, font: { size: 12, color: '#d1d5db' } },
          { x: 0.75, y: 1.05, xref: 'paper', yref: 'paper', text: '<b>RENTER</b>', showarrow: false, font: { size: 12, color: '#d1d5db' } },
        ],
        margin: { t: 50, r: 20, b: 60, l: 100 },
      }, PLOTLY_CONFIG);
    },

    // ============== Rankings ==============
    get rankingViewLabel() {
      return {
        precinct: 'Precincts',
        hd: 'House Districts',
        sd: 'Senate Districts',
        cd: 'Congressional Districts',
        cc: 'County Council Districts',
      }[this.ranking.view] || '';
    },

    renderRankings() {
      if (this.tab !== 'rankings') {
        // still compute so it's ready
      }
      const data = this._data;
      const yIdx = data.years.indexOf(this.ranking.year);
      const tIdx = data.types.indexOf(this.ranking.type);
      if (yIdx === -1 || tIdx === -1) { this.rankingRows = []; return; }
      const t = data.turnout;
      const matched = [];
      for (let i = 0; i < t.yi.length; i++) {
        if (t.yi[i] === yIdx && t.ti[i] === tIdx) {
          matched.push({ pi: t.pi[i], reg: t.reg[i], tn: t.tn[i], tp: t.tp[i] });
        }
      }

      if (this.ranking.view === 'precinct') {
        this.rankingRows = matched.map(r => ({
          name: data.precincts[r.pi],
          reg: r.reg, tn: r.tn, tp: r.tp,
        })).sort((a, b) => b.tp - a.tp);
        return;
      }

      // Aggregate by district
      const districtField = this.ranking.view;
      const districtPrefix = { hd: 'HD', sd: 'SD', cd: 'CONGRESS', cc: 'COUNTY' }[districtField];
      const agg = new Map();
      for (const r of matched) {
        const m = data.mapping[r.pi];
        if (!m) continue;
        const d = m[districtField];
        if (d == null) continue;
        const key = d;
        const existing = agg.get(key);
        if (existing) {
          existing.reg += r.reg;
          existing.tn += r.tn;
        } else {
          agg.set(key, { reg: r.reg, tn: r.tn });
        }
      }
      const out = [];
      for (const [k, v] of agg) {
        out.push({
          name: `${districtPrefix}-${k}`,
          reg: v.reg, tn: v.tn,
          tp: v.reg > 0 ? (v.tn / v.reg * 100) : 0,
        });
      }
      out.sort((a, b) => b.tp - a.tp);
      this.rankingRows = out;
    },
  };
}
