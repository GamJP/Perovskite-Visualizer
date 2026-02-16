/* Estado global */
const state = {
  viewMode: 'matrix',          // 'matrix' | 'pivot'
  papersById: new Map(),
  entities: [],
  filtered: [],
  page: 1,
  pageSize: 10,
  filters: { groups: new Set(), search: "", ranges: {} },
  cellIndex: new Map(),
  rangeMeta: {},
  labelsAvailable: [],
  imagesEntities: [], // Añadido para imagenes independientes
  tablesEntities: [], // Añadido para tablas independientes
};

function $(sel) { return document.querySelector(sel); }
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => {
    if (k === "class") node.className = v;
    else if (k === "html") node.innerHTML = v;
    else node.setAttribute(k, v);
  });
  children.forEach(c => node.appendChild(c));
  return node;
}

async function init() {
  if (location.protocol === "file:") $("#protocolWarning").hidden = false;

  // Botones de vista
  const pv = $("#pivotViewBtn"), mv = $("#matrixViewBtn");
  const setActive = () => {
    pv?.classList.toggle("active", state.viewMode === "pivot");
    mv?.classList.toggle("active", state.viewMode === "matrix");
    const iv = $("#imagesViewBtn");
    iv?.classList.toggle("active", state.viewMode === "images");
    const tv = $("#tablesViewBtn");
    tv?.classList.toggle("active", state.viewMode === "tables");
  };
  pv?.addEventListener("click", () => { state.viewMode = "pivot";  setActive(); applyFilters(); });
  mv?.addEventListener("click", () => { state.viewMode = "matrix"; setActive(); applyFilters(); });
  const iv = $("#imagesViewBtn");
  iv?.addEventListener("click", () => { state.viewMode = "images"; setActive(); applyFilters(); });
  const tv = $("#tablesViewBtn");
  tv?.addEventListener("click", () => { state.viewMode = "tables"; setActive(); applyFilters(); });
  setActive();

  // Filtros y acciones
  $("#searchInput").addEventListener("input", e => { state.filters.search = e.target.value.trim().toLowerCase(); state.page = 1; applyFilters(); });
  // Año: esta app no filtra por año (se ocultan los inputs si existen)
  const yFrom = $("#yearFrom"), yTo = $("#yearTo");
  const yearRow = (yFrom || yTo)?.closest?.(".control-row");
  if (yearRow) yearRow.hidden = true;
  $("#exportCsvBtn").addEventListener("click", exportCSV);
  $("#exportJsonBtn").addEventListener("click", exportJSON);
  $("#closeEvidenceBtn").addEventListener("click", () => { $("#evidencePanel").hidden = true; });

  $("#loadEntitiesBtn").addEventListener("click", () => $("#entitiesFile").click());
  $("#entitiesFile").addEventListener("change", handleEntitiesFile);
  $("#loadPapersBtn").addEventListener("click", () => $("#papersFile").click());
  $("#papersFile").addEventListener("change", handlePapersFile);
  $("#loadImagesBtn").addEventListener("click", scanLocalImagesFolder);
  $("#loadTablesBtn").addEventListener("click", scanLocalTablesFolder);

  // Intentar cargar /data; si no, usar embebidos
  let loaded = false;
  if (location.protocol !== "file:") loaded = await tryLoadFromDataFolder();
  if (!loaded) loadFromEmbedded();
  postLoadSetup();
}


/* =============================
   Normalización de entrada
   - Formato antiguo: { papers:[...] } y { entities:[...] }
   - Formato FAIR (nuevo): Array de artículos (como perovskite_dataset_fair.json)
   ============================= */

function normalizeEntitiesInput(raw) {
  // Formato antiguo
  if (raw && typeof raw === 'object' && Array.isArray(raw.entities)) {
    return { mode: 'legacy' };
  }

  // Formato FAIR: array de artículos
  if (Array.isArray(raw)) {
    const first = raw[0];
    const looksFair = !!(first && typeof first === 'object' && ('doi' in first || 'capas' in first || 'cells' in first || 'samples' in first));
    if (looksFair) return normalizeFairDataset(raw);
  }

  return { mode: 'unknown' };
}
function cleanStr(v) {
  return String(v ?? '').trim();
}
function ensureUrl(doi) {
  const d = cleanStr(doi);
  if (!d) return "";
  if (/^https?:\/\//i.test(d)) return d;
  return "https://doi.org/" + d;
}
function normalizeFairDataset(articles) {
  const papers = [];
  const entities = [];

  const toArr = (v) => Array.isArray(v) ? v : (v == null ? [] : [v]);
  const cleanStr = (v) => String(v ?? '').trim();
  const joinBar = (arr) => arr.map(cleanStr).filter(v => v && v !== '#').join(" | ");
  const firstOrJoined = (arr) => {
    const a = arr.map(cleanStr).filter(v => v && v !== '#');
    if (!a.length) return null;
    return (a.length === 1) ? a[0] : a.join(" | ");
  };

  

  articles.forEach((a, idx) => {
    const paper_id = cleanStr(a.id || a.paper_id || a.doi || `paper_${idx + 1}`);
    const doi = cleanStr(a.doi || "");
    const title = cleanStr(a.title || "");
    const url = cleanStr(a.url || a.link || "") || ensureUrl(doi);

        papers.push({ paper_id, doi, title, url });

    const pushListEntity = (label, values, section = "Methods", confidence = 0.8, extra = {}) => {
      const v = joinBar(toArr(values));
      if (!v) return;
      entities.push({
        entity_id: `${paper_id}__${label}__${extra.cell_id ?? 'p'}`,
        paper_id,
        label,
        value: v,
        section,
        confidence,
        ...extra
      });
    };

    // --- Capas ---
    const capas = a.capas || a.layers || {};
    const getCapasVal = (keys) => {
      for (const k of keys) {
        if (capas && Object.prototype.hasOwnProperty.call(capas, k)) return capas[k];
      }
      return null;
    };

    const capMap = [
      { keys: ["Substrate/TCO", "Substrato/TCO"], label: "Substrato/TCO" },
      { keys: ["ETL"], label: "ETL" },
      { keys: ["Perovskite", "Perovskita"], label: "Perovskita" },
      { keys: ["HTL"], label: "HTL" },
      { keys: ["Electrode", "Electrodo"], label: "Electrode" }
    ];

    capMap.forEach(m => pushListEntity(m.label, getCapasVal(m.keys), "Methods", 0.85));

    // --- Métodos ---
    const met = a.metodos || a.methods || {};
    pushListEntity("Síntesis", met.synthesis_method || met.synthesis || met.Synthesis || [], "Methods", 0.8);
    pushListEntity("Fabricación", met.fabrication_technique || met.fabrication || met.Fabrication || [], "Methods", 0.8);

    // --- Capas (cilindro) opcional para vista detallada ---
    const getOneSlice = (vals) => firstOrJoined(toArr(vals));
    const slices = [
      getOneSlice(getCapasVal(capMap[0].keys)),
      getOneSlice(getCapasVal(capMap[1].keys)),
      getOneSlice(getCapasVal(capMap[2].keys)),
      getOneSlice(getCapasVal(capMap[3].keys)),
      getOneSlice(getCapasVal(capMap[4].keys))
    ].filter(Boolean);

    if (slices.length) {
      entities.push({
        entity_id: `${paper_id}__Capas__p`,
        paper_id,
        label: "Capas",
        value: slices,
        section: "Methods",
        confidence: 0.7
      });
    }

    // --- Celdas ---
    const cells = Array.isArray(a.cells) ? a.cells : [];
    const metrics_global = a.metrics_global || {};

    // También soporta muestras en texto: a.samples[] o metrics_global.samples[]
    const samplesList = [];
    if (Array.isArray(a.samples)) samplesList.push(...a.samples);
    if (Array.isArray(metrics_global.samples)) samplesList.push(...metrics_global.samples);

    // Unifica métricas por (celda, etiqueta): si llega otra fuente (p.ej. metrics_global.samples),
// no la descartamos; mergeamos valores/evidencia.
    const metricByKey = new Map(); // key = `${cell_id}||${label}` -> entity object

    const _splitPipe = (s) => {
      const t = cleanStr(s || "");
      if (!t) return [];
      return t.split("|").map(x => x.trim()).filter(Boolean);
    };

    const _mergePipe = (base, extra) => {
      const out = [];
      const seen = new Set();
      for (const v of [..._splitPipe(base), ..._splitPipe(extra)]) {
        if (!v) continue;
        if (seen.has(v)) continue;
        seen.add(v);
        out.push(v);
      }
      return out.join(" | ");
    };

    const _mergeEvidence = (base, extra) => {
      const b = cleanStr(base || "");
      const e = cleanStr(extra || "");
      if (!e) return b;
      if (!b) return e;
      // Evita duplicar exactamente el mismo texto
      if (b.includes(e)) return b;
      return b + "\n\n" + e;
    };

    const pushMetric = (cell_id, label, rawVal, evidence = "", confidence = 0.8, extra = {}) => {
      const v = firstOrJoined(toArr(rawVal));
      if (!v) return;
      const key = `${cell_id}||${label}`;
      const ev = cleanStr(evidence || "");

      if (metricByKey.has(key)) {
        const ent = metricByKey.get(key);
        ent.value = _mergePipe(ent.value, v);
        if (ev) ent.span_text = _mergeEvidence(ent.span_text, ev);
        ent.confidence = Math.max(ent.confidence ?? 0, confidence ?? 0);
        return;
      }

      const ent = {
        entity_id: `${paper_id}__c${cell_id}__${label}`,
        paper_id,
        cell_id,
        label,
        value: v,
        units: "",
        section: "Results",
        span_text: ev,
        confidence,
        ...extra, // Añadido para marcar fallback
      };
      entities.push(ent);
      metricByKey.set(key, ent);
    };

    const parseSampleLine = (line, idxDefault) => {
      const raw = cleanStr(line);
      if (!raw) return null;

      const mId = raw.match(/sample\s*(\d+)/i);
      const cid = mId ? parseInt(mId[1], 10) : (idxDefault + 1);

      const inside = (raw.match(/\[([\s\S]*)\]/) || [])[1] || raw;
      const parts = inside.split(/\s*,\s*/);

      const map = {
        pce: "PCE",
        jsc: "Jsc",
        voc: "Voc",
        ff: "FF",
        eficiencia: "Eficiencia",
        efficiency: "Eficiencia",
        eta: "Eficiencia"
      };

      const metrics = {};
      for (const part of parts) {
        const mm = part.match(/^\s*([A-Za-z]+)\s*:\s*(.+?)\s*$/);
        if (!mm) continue;
        const k = mm[1].toLowerCase();
        const label = map[k];
        if (!label) continue;
        const val = (mm[2] || "").trim();
        if (!val || val === "#" || /^#+$/.test(val)) continue;
        metrics[label] = val;
      }

      return { cid, metrics, evidence: raw };
    };

    // 1) Fuente estructurada: cells[]
    if (cells.length) {
      cells.forEach((c, iCell) => {
        const cid = iCell + 1;
        const evidence = cleanStr(c.sample || c.evidence || "");
        pushMetric(cid, "PCE", c.PCE, evidence, 0.85);
        pushMetric(cid, "Jsc", c.Jsc, evidence, 0.85);
        pushMetric(cid, "Voc", c.Voc, evidence, 0.85);
        pushMetric(cid, "FF", c.FF, evidence, 0.85);

        // Eficiencia: solo si viene explícita
        const effVal = (c.Eficiencia ?? c.efficiency ?? c.eta);
        if (effVal !== undefined && effVal !== null && String(effVal).trim() !== "") {
          pushMetric(cid, "Eficiencia", effVal, evidence, 0.85);
        }
      });
    }

    // 2) Fuente en texto: samples[] (extrae PCE/Jsc/Voc/FF/Eficiencia)
    // IMPORTANT: estos samples en texto deben crear celdas ADICIONALES.
    // Si ya existen X celdas en a.cells[], y hay Y samples en texto, el resultado será X+Y celdas.
    if (samplesList.length) {
      const base = cells.length; // offset
      samplesList.forEach((line, iS) => {
        const parsed = parseSampleLine(line, iS);
        if (!parsed) return;
        const { metrics, evidence } = parsed;

        // Crea una nueva celda para cada línea de sample en texto
        const cid = base + iS + 1;

        // Confianza menor: viene parseado de texto
        if (metrics.PCE) pushMetric(cid, "PCE", metrics.PCE, evidence, 0.75 );
        if (metrics.Jsc) pushMetric(cid, "Jsc", metrics.Jsc, evidence, 0.75);
        if (metrics.Voc) pushMetric(cid, "Voc", metrics.Voc, evidence, 0.75);
        if (metrics.FF) pushMetric(cid, "FF", metrics.FF, evidence, 0.75);
        if (metrics.Eficiencia) pushMetric(cid, "Eficiencia", metrics.Eficiencia, evidence, 0.75);
      });
    }

    // 3) Siempre agregar metrics_global como celdas adicionales individuales (una por valor)
    const evidenceGlobal = cleanStr((metrics_global.samples && metrics_global.samples[0]) || "");
    const baseGlobal = cells.length + samplesList.length;
    let globalCidCounter = baseGlobal; // Contador para cids únicos por valor

    // PCE
    const pceValues = toArr(metrics_global.PCE).filter(v => cleanStr(v) && cleanStr(v) !== '#');
    pceValues.forEach((val, idx) => {
      globalCidCounter++;
      pushMetric(globalCidCounter, "PCE", val, evidenceGlobal, 0.75, { isGlobalFallback: true });
    });

    // Jsc
    const jscValues = toArr(metrics_global.Jsc).filter(v => cleanStr(v) && cleanStr(v) !== '#');
    jscValues.forEach((val, idx) => {
      globalCidCounter++;
      pushMetric(globalCidCounter, "Jsc", val, evidenceGlobal, 0.75, { isGlobalFallback: true });
    });

    // Voc
    const vocValues = toArr(metrics_global.Voc).filter(v => cleanStr(v) && cleanStr(v) !== '#');
    vocValues.forEach((val, idx) => {
      globalCidCounter++;
      pushMetric(globalCidCounter, "Voc", val, evidenceGlobal, 0.75, { isGlobalFallback: true });
    });

    // FF
    const ffValues = toArr(metrics_global.FF).filter(v => cleanStr(v) && cleanStr(v) !== '#');
    ffValues.forEach((val, idx) => {
      globalCidCounter++;
      pushMetric(globalCidCounter, "FF", val, evidenceGlobal, 0.75, { isGlobalFallback: true });
    });

    // Eficiencia (maneja si es array o valor simple)
    const effValRaw = (metrics_global.Eficiencia ?? metrics_global.efficiency ?? metrics_global.eta);
    const effValues = toArr(effValRaw).filter(v => cleanStr(v) && cleanStr(v) !== '#');
    effValues.forEach((val, idx) => {
      globalCidCounter++;
      pushMetric(globalCidCounter, "Eficiencia", val, evidenceGlobal, 0.75, { isGlobalFallback: true });
    });
    const tables = toArr(a.tables || a.Tables || []);
    tables.forEach((tbl, idx) => {
      if (!tbl || !tbl.rows || !tbl.columns) return;
      entities.push({
        entity_id: `${paper_id}__Tabla__${idx + 1}`,
        paper_id,
        label: "Tabla",
        value: `Tabla ${idx + 1} (página ${tbl.page || '#'})`,
        section: "Tables",
        confidence: 1.0,
        table: tbl // Almacena datos de tabla para mostrar
      });
    });
    const folderDoi = cleanStr(doi).replace(/[\/:]/g, '_');
    const images = toArr(a.images || a.Imagenes || []);
    images.forEach((img, idx) => {
      const filename = cleanStr(img);
      if (!filename) return;
      entities.push({
        entity_id: `${paper_id}__Imagen__${idx + 1}`,
        paper_id,
        label: "Imagen",
        value: filename,
        section: "Images",
        confidence: 1.0,
        path: `imagenes/${folderDoi}/${filename}`
      });
    });
  });

  return { mode: 'fair', papersJson: { papers }, entitiesJson: { entities } };
}


async function tryLoadFromDataFolder() {
  try {
    // Primero intentamos leer entities.json (puede ser el formato antiguo o el FAIR)
    const eRes = await fetch("data/entities.json", { cache: "no-store" });
    if (!eRes.ok) throw new Error("No se pudo leer data/entities.json");
    const rawEntities = await eRes.json();

    const normalized = normalizeEntitiesInput(rawEntities);
    if (normalized.mode === "fair") {
      setPapers(normalized.papersJson);
      setEntities(normalized.entitiesJson);
      return true;
    }

    // Formato antiguo -> requiere papers.json
    const pRes = await fetch("data/papers.json", { cache: "no-store" });
    if (!pRes.ok) throw new Error("No se pudo leer data/papers.json");
    setPapers(await pRes.json());
    setEntities(rawEntities);
    return true;
  } catch {
    return false;
  }
}
function loadFromEmbedded() {
  const e = $("#sample-entities-json");
  if (e) {
    const raw = JSON.parse(e.textContent);
    const normalized = normalizeEntitiesInput(raw);
    if (normalized.mode === "fair") {
      setPapers(normalized.papersJson);
      setEntities(normalized.entitiesJson);
      return;
    }
  }

  // Formato antiguo (papers + entities separados)
  const p = $("#sample-papers-json");   if (p) setPapers(JSON.parse(p.textContent));
  const e2 = $("#sample-entities-json"); if (e2) setEntities(JSON.parse(e2.textContent));
}

function setPapers(papersJson) {
  state.papersById.clear();
  (papersJson.papers || []).forEach(p => state.papersById.set(p.paper_id, p));
}
function setEntities(entitiesJson) {
  state.entities = (entitiesJson.entities || []).slice();
  buildLabelsAvailable();
  buildCellIndex();
  computeRangeMetaAndInit();
  renderRangeFilters();
  state.page = 1; applyFilters();
}
function buildLabelsAvailable() {
  state.groupsAvailable = ['capas', 'metodos', 'celdas']; // Solo estos tres grupos
  state.groupLabels = {
    capas: new Set(['Substrato/TCO', 'ETL', 'Perovskita', 'HTL', 'Electrode', 'Capas']),
    metodos: new Set(['Síntesis', 'Fabricación']),
    celdas: new Set(['PCE', 'Jsc', 'Voc', 'FF', 'Eficiencia'])
  };
  renderGroupFilters(); // Cambia a renderGroupFilters en lugar de renderLabelFilters
}
function renderGroupFilters() {
  const box = $("#labelFilters"); box.innerHTML = "";
  if (state.groupsAvailable.length === 0) {
    box.appendChild(el("div", { class: "badge" , html: "Sin grupos (carga datos)" }));
    return;
  }
  // Cambia state.filters.labels a state.filters.groups (inicializa si vacío)
  if (!state.filters.groups) state.filters.groups = new Set();
  if (state.filters.groups.size === 0) state.groupsAvailable.forEach(g => state.filters.groups.add(g));
  state.groupsAvailable.forEach(group => {
    const id = "grp_" + group;
    const input = el("input", { type: "checkbox", id });
    input.checked = state.filters.groups.has(group);
    input.addEventListener("change", () => {
      if (input.checked) state.filters.groups.add(group);
      else state.filters.groups.delete(group);
      state.page = 1; applyFilters();
    });
    const badge = el("label", { for: id, class: "badge" }, [ input, el("span", {}, [document.createTextNode(group.charAt(0).toUpperCase() + group.slice(1))]) ]);
    box.appendChild(badge);
  });
}


/* =============================
   Filtros por rango (FF, Voc, Jsc, PCE)
   - Slider doble + inputs manuales
   - Se aplica a nivel de CELDA (paper_id + cell_id)
   ============================= */

const RANGE_METRICS = [
  { key: "PCE", label: "PCE (%)", unit: "%", step: 0.1 },
  { key: "Jsc", label: "Jsc (mA/cm²)", unit: "mA/cm²", step: 0.1 },
  { key: "Voc", label: "Voc (V)", unit: "V", step: 0.01 },
  { key: "FF",  label: "FF (%)", unit: "%", step: 0.1 },
];

function _splitBar(v) {
  const s = (v == null) ? "" : String(v);
  return s.split("|").map(x => x.trim()).filter(Boolean);
}

function _firstNumber(s) {
  const m = String(s).match(/[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?/);
  return m ? Number(m[0]) : null;
}

function parseMetricNumbers(metricKey, rawValue, rawUnits) {
  const units = String(rawUnits ?? "").toLowerCase();
  const part = String(rawValue ?? "").trim(); // Ahora es un solo valor
  if (!part || part === "#" || /^#+$/.test(part)) return [];
  const pLower = part.toLowerCase();
  const num = _firstNumber(part);
  if (num == null || isNaN(num)) return [];
  let v = num;
  if (metricKey === "Voc") {
    const ismV = pLower.includes("mv") || units.includes("mv");
    if (ismV) v = v * 0.001;
    else if (v > 5) v = v * 0.001; // heurística: Voc rara vez >5 V en estos papers
    return [v];
  }
  if (metricKey === "Jsc") {
    // Canon: mA/cm²
    if (pLower.includes("µa") || pLower.includes("ua") || units.includes("µa") || units.includes("ua")) v = v * 0.001;
    else if ((pLower.includes(" a") || pLower.endsWith("a") || units === "a") && !pLower.includes("ma") && !units.includes("ma")) v = v * 1000;
    // si está en mA ya está bien
    return [v];
  }
  if (metricKey === "PCE" || metricKey === "FF") {
    const hasPct = pLower.includes("%") || units.includes("%");
    if (!hasPct && v <= 1) v = v * 100; // si viene fracción
    return [v];
  }
  return [v];
}

function buildCellIndex() {
  state.cellIndex = new Map();
  const metricsSet = new Set(RANGE_METRICS.map(m => m.key));

  for (const e of state.entities) {
    const label = String(e.label ?? "").trim();
    if (!metricsSet.has(label)) continue;

    const pid = e.paper_id;
    const cid = getEntityCellId(e);
    if (pid == null || cid == null) continue;

    const key = `${pid}__${cid}`;
    if (!state.cellIndex.has(key)) {
      state.cellIndex.set(key, { paper_id: pid, cell_id: cid, metrics: {} });
    }
    const info = state.cellIndex.get(key);

    const nums = parseMetricNumbers(label, e.value, e.units);
    if (!nums.length) continue;

    if (!info.metrics[label]) info.metrics[label] = [];
    // agrega sin duplicar
    for (const n of nums) {
      if (!info.metrics[label].includes(n)) info.metrics[label].push(n);
    }
  }
}

function computeRangeMetaAndInit() {
  const meta = {};
  const metrics = RANGE_METRICS.map(m => m.key);

  for (const k of metrics) meta[k] = { min: null, max: null };

  for (const [, cinfo] of state.cellIndex) {
    for (const k of metrics) {
      const arr = cinfo.metrics?.[k] || [];
      for (const v of arr) {
        if (v == null || isNaN(v)) continue;
        meta[k].min = (meta[k].min == null) ? v : Math.min(meta[k].min, v);
        meta[k].max = (meta[k].max == null) ? v : Math.max(meta[k].max, v);
      }
    }
  }

  state.rangeMeta = meta;

  // Inicializa rangos si no existen
  if (!state.filters.ranges) state.filters.ranges = {};
  for (const k of metrics) {
    const gmin = meta[k].min, gmax = meta[k].max;
    if (gmin == null || gmax == null) {
      state.filters.ranges[k] = { min: null, max: null, disabled: true };
    } else if (!state.filters.ranges[k]) {
      state.filters.ranges[k] = { min: gmin, max: gmax, disabled: false };
    } else {
      // si ya existía, clamp al nuevo global
      const r = state.filters.ranges[k];
      r.min = (r.min == null || isNaN(r.min)) ? gmin : Math.max(gmin, Number(r.min));
      r.max = (r.max == null || isNaN(r.max)) ? gmax : Math.min(gmax, Number(r.max));
      r.disabled = false;
    }
  }
}

function _clamp(x, a, b) { return Math.min(Math.max(x, a), b); }

function renderRangeFilters() {
  const root = $("#rangeFilters");
  if (!root) return;
  root.innerHTML = "";

  const meta = state.rangeMeta || {};
  if (!state.entities.length) {
    root.appendChild(el("div", { class: "muted", html: "Carga un JSON para habilitar filtros por rango." }));
    return;
  }

  const wrap = el("div", { class: "range-filters-wrap" }, []);
  const title = el("div", { class: "range-filters-title", html: "Filtrar por rango" });
  wrap.appendChild(title);

  const resetAllBtn = el("button", { class: "range-reset-all", type: "button", html: "Reset rangos" });
  resetAllBtn.addEventListener("click", () => {
    for (const m of RANGE_METRICS) {
      const g = meta[m.key];
      if (g?.min == null || g?.max == null) continue;
      state.filters.ranges[m.key] = { min: g.min, max: g.max, disabled: false };
    }
    renderRangeFilters();
    state.page = 1; applyFilters();
  });
  wrap.appendChild(resetAllBtn);

  const list = el("div", { class: "range-list" }, []);

  for (const m of RANGE_METRICS) {
    const g = meta[m.key] || {};
    const gmin = g.min, gmax = g.max;
    const r = state.filters.ranges?.[m.key] || { min: gmin, max: gmax, disabled: false };

    const disabled = (gmin == null || gmax == null || r.disabled);
    const item = el("div", { class: "range-item" }, []);

    const head = el("div", { class: "range-head" }, [
      el("div", { class: "range-name", html: escapeHtml(m.label) }),
    ]);

    const inputs = el("div", { class: "range-inputs" }, []);
    const inMin = el("input", { class: "range-num", type: "number", step: String(m.step), value: (r.min ?? "").toString(), placeholder: (gmin==null?"—":String(gmin))});
    const inMax = el("input", { class: "range-num", type: "number", step: String(m.step), value: (r.max ?? "").toString(), placeholder: (gmax==null?"—":String(gmax))});
    if (disabled) { inMin.disabled = true; inMax.disabled = true; }
    const dash = el("span", { class: "range-dash", html: "—" });
    const resetBtn = el("button", { class: "range-reset", type: "button", html: "↺", title: "Reset" });
    resetBtn.disabled = !!disabled;

    inputs.appendChild(inMin); inputs.appendChild(dash); inputs.appendChild(inMax); inputs.appendChild(resetBtn);
    head.appendChild(inputs);

    item.appendChild(head);

    const slider = el("div", { class: "dual-range" }, []);
    const sMin = el("input", { class: "range-slider min", type: "range" });
    const sMax = el("input", { class: "range-slider max", type: "range" });

    if (!disabled) {
      sMin.min = String(gmin); sMin.max = String(gmax); sMin.step = String(m.step);
      sMax.min = String(gmin); sMax.max = String(gmax); sMax.step = String(m.step);
      sMin.value = String(r.min ?? gmin);
      sMax.value = String(r.max ?? gmax);
    } else {
      sMin.disabled = true; sMax.disabled = true;
    }

    slider.appendChild(sMin);
    slider.appendChild(sMax);
    item.appendChild(slider);

    const bounds = el("div", { class: "range-bounds", html: disabled ? "Sin datos" : `min: ${gmin} · max: ${gmax}` });
    item.appendChild(bounds);

    const sync = () => {
      if (disabled) return;
      let vmin = Number(inMin.value);
      let vmax = Number(inMax.value);
      if (isNaN(vmin)) vmin = Number(sMin.value);
      if (isNaN(vmax)) vmax = Number(sMax.value);

      vmin = _clamp(vmin, gmin, gmax);
      vmax = _clamp(vmax, gmin, gmax);

      if (vmin > vmax) {
        // Mantener orden
        const t = vmin; vmin = vmax; vmax = t;
      }

      inMin.value = String(vmin);
      inMax.value = String(vmax);
      sMin.value = String(vmin);
      sMax.value = String(vmax);

      state.filters.ranges[m.key] = { min: vmin, max: vmax, disabled: false };
      _updateDualRangeFill(slider, vmin, vmax, gmin, gmax);
    };

    const commit = () => { sync(); state.page = 1; applyFilters(); };

    sMin.addEventListener("input", () => { 
      if (Number(sMin.value) > Number(sMax.value)) sMin.value = sMax.value;
      inMin.value = sMin.value; 
      commit();
    });
    sMax.addEventListener("input", () => { 
      if (Number(sMax.value) < Number(sMin.value)) sMax.value = sMin.value;
      inMax.value = sMax.value; 
      commit();
    });

    inMin.addEventListener("input", commit);
    inMax.addEventListener("input", commit);
    inMin.addEventListener("change", commit);
    inMax.addEventListener("change", commit);

    resetBtn.addEventListener("click", () => {
      inMin.value = String(gmin);
      inMax.value = String(gmax);
      commit();
    });

    // set fill initially
    if (!disabled) _updateDualRangeFill(slider, Number(sMin.value), Number(sMax.value), gmin, gmax);

    list.appendChild(item);
  }

  wrap.appendChild(list);
  root.appendChild(wrap);
}

function _updateDualRangeFill(container, vmin, vmax, gmin, gmax) {
  const span = (gmax - gmin) || 1;
  const from = ((vmin - gmin) / span) * 100;
  const to = ((vmax - gmin) / span) * 100;
  container.style.setProperty("--from", `${from}%`);
  container.style.setProperty("--to", `${to}%`);
}
function applyFilters() {
  const { groups, search, ranges } = state.filters;

  // 1) Filtro por búsqueda a nivel de paper
  const allowedPapersBySearch = new Set();
  if (!search) {
    for (const [pid] of state.papersById) allowedPapersBySearch.add(pid);
  } else {
    const q = search.trim().toLowerCase();
    for (const [pid, p] of state.papersById) {
      const hay = ((p?.title || "") + " " + (p?.doi || "")).toLowerCase();
      if (hay.includes(q)) allowedPapersBySearch.add(pid);
    }
  }

  // 2) Filtros por rango (tipo Booking) a nivel de CELDA
  const active = {};
  const meta = state.rangeMeta || {};
  const eps = 1e-9;
  for (const k of Object.keys(meta)) {
    const r = ranges?.[k];
    if (!r) continue;
    const gmin = meta[k]?.min, gmax = meta[k]?.max;
    if (gmin == null || gmax == null) continue;
    const rmin = (r.min == null || isNaN(r.min)) ? gmin : Number(r.min);
    const rmax = (r.max == null || isNaN(r.max)) ? gmax : Number(r.max);
    // Activo solo si recorta el rango global
    if (rmin > gmin + eps || rmax < gmax - eps) active[k] = { min: rmin, max: rmax };
  }

  const allowedCells = new Set();
  const allowedPapers = new Set();

  // Si no hay filtros activos de rango, entonces todas las celdas de papers permitidos pasan
  const hasActiveRanges = Object.keys(active).length > 0;

  for (const [ckey, cinfo] of state.cellIndex) {
    const pid = cinfo.paper_id;
    if (!allowedPapersBySearch.has(pid)) continue;

    if (!hasActiveRanges) {
      allowedCells.add(ckey);
      allowedPapers.add(pid);
      continue;
    }

    let ok = true;
    for (const [metric, lim] of Object.entries(active)) {
      const arr = cinfo.metrics?.[metric] || [];
      if (!arr.length) { ok = false; break; }

      // pasa si ALGUNO de los valores está dentro del rango
      const pass = arr.some(v => (v >= lim.min && v <= lim.max));
      if (!pass) { ok = false; break; }
    }

    if (ok) {
      allowedCells.add(ckey);
      allowedPapers.add(pid);
    }
  }

  // 3) Construir state.filtered: incluye entidades paper-level si el paper tiene al menos una celda permitida
  let rows = state.entities.filter(e => {
    const pid = e.paper_id;
    if (!allowedPapersBySearch.has(pid)) return false;
    if (!allowedPapers.has(pid) && hasActiveRanges) return false;

    let groupOk = (groups.size === 0);
    if (!groupOk) {
      for (const g of groups) {
        if (state.groupLabels[g].has(e.label)) {
          groupOk = true;
          break;
        }
      }
    }
    if (!groupOk) return false;

    // Si es entidad por celda, debe estar en allowedCells cuando hay filtro por rango
    const cid = e.cell_id != null ? getEntityCellId(e) : null;
    if (hasActiveRanges && cid != null) {
      const key = `${pid}__${cid}`;
      if (!allowedCells.has(key)) return false;
    }
    return true;
  });

  state.filtered = rows;
  renderKPIs(); renderTable(); renderPagination();
}

/* KPIs */
function renderKPIs() {
  const kpis = $("#kpis");
  const totalPapers = new Set(state.filtered.map(e => e.paper_id)).size;
  const countsByLabel = state.filtered.reduce((acc, e) => (acc[e.label]=(acc[e.label]||0)+1, acc), {});
  const totalEntities = state.filtered.length;
  kpis.innerHTML = "";
  const c1 = el("div", { class: "kpi" }, [ el("div", { class: "label", html: "Artículos (filtrados)" }), el("div", { class: "value", html: String(totalPapers) }) ]);
  const c2 = el("div", { class: "kpi" }, [ el("div", { class: "label", html: "Entidades (filtradas)" }), el("div", { class: "value", html: String(totalEntities) }) ]);
  kpis.appendChild(c1); kpis.appendChild(c2);
  Object.entries(countsByLabel).forEach(([label, count]) => {
    const card = el("div", { class: "kpi" }, [ el("div", { class: "label", html: label }), el("div", { class: "value", html: String(count) }) ]);
    kpis.appendChild(card);
  });
}

/* Renderizador central */
function renderTable() {
  const thead = $("#tableHead"); thead.innerHTML = "";
  const tbody = $("#entitiesTbody"); tbody.innerHTML = "";
  // Marca la tabla con la vista actual para ajustar estilos (ancho de columnas, etc.)
  const table = document.querySelector(".table-scroller table") || document.querySelector("table");
  if (table) table.dataset.view = state.viewMode;
  if (state.viewMode === 'pivot')  return renderPivotTable();
  if (state.viewMode === 'matrix')  return renderMatrixTable();
  if (state.viewMode === 'images')   return renderImagesTable();
  if (state.viewMode === 'tables') return renderTablesTable();
}

// --- Vista detallada eliminada (solo se usan vista matriz y por celda) ---

/* Vista por celda (pivot clásica) */
function renderPivotTable() {
  const thead = $("#tableHead"); const tbody = $("#entitiesTbody");
  tbody.innerHTML = "";

  const showCeldas = state.filters.groups.has('celdas');
  const labels = showCeldas ? getPivotLabels() : []; // Si no celdas, no métricas
  const headCells = ['DOI', 'Celda'].concat(labels);
  thead.innerHTML = "<tr>" + headCells.map(h => `<th>${h}</th>`).join("") + "</tr>";

  const groups = new Map();
  const pivotRows = getPivotRows();
  for (const e of pivotRows) {
    const p = state.papersById.get(e.paper_id) || {};
    const cell = getEntityCellId(e);
    const key = `${e.paper_id}||${cell}`;
    if (!groups.has(key)) groups.set(key, { paper: p, cell_id: cell, byLabel: {} });
    const slot = groups.get(key);
    const cur = slot.byLabel[e.label];
    if (!cur || (e.confidence ?? 0) > (cur.confidence ?? 0)) slot.byLabel[e.label] = e;
  }

  const rows = Array.from(groups.values());
  const start = (state.page - 1) * state.pageSize;
  const end = start + state.pageSize;
  const pageRows = rows.slice(start, end);

  pageRows.forEach(row => {
    const doi = row.paper?.doi || row.paper?.paper_id || "";
    const doiUrl = row.paper?.url || "#";
    const tr = document.createElement("tr");
    const cells = [];
    cells.push(`<td><a href="${doiUrl}" target="_blank" rel="noopener">${escapeHtml(doi)}</a></td>`);
    cells.push(`<td>${row.cell_id}</td>`);
    for (const lab of labels) {
      const ent = row.byLabel[lab];
      if (!ent) { cells.push("<td>—</td>"); continue; }

      const text = `${ent.value ?? ""}${ent.units ? " " + ent.units : ""}`;
      cells.push(`<td class="pivot-value"><button data-entity="${ent.entity_id}">${escapeHtml(String(text))}</button></td>`);
    }
    tr.innerHTML = cells.join("");
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll(".pivot-value button").forEach(btn => {
    btn.addEventListener("click", (ev) => {
      const id = ev.currentTarget.getAttribute("data-entity");
      const ent = state.filtered.find(x => x.entity_id === id) || state.entities.find(x => x.entity_id === id);
      if (ent) showEvidence(ent);
    });
  });
}

/* Vista matriz (como en tu imagen) */
function renderMatrixTable(){
  const thead = $("#tableHead"), tbody = $("#entitiesTbody");
  tbody.innerHTML = "";
  const hasEff = state.filtered.some(e => e.label === "Eficiencia");

  thead.innerHTML = `
    <tr class="head-top">
      <th rowspan="2">DOI</th>
      <th colspan="5">Capas</th>
      <th colspan="2">Métodos</th>
      <th colspan="${hasEff ? 5 : 4}">Celda</th>
    </tr>
    <tr class="head-sub">
      <th>Substrato/TCO</th><th>ETL</th><th>Perovskita</th><th>HTL</th><th>Electrode</th>
      <th>Síntesis</th><th>Fabricación</th>
      <th>PCE</th><th>Jsc</th><th>Voc</th><th>FF</th>${hasEff ? "<th>Eficiencia</th>" : ""}
    </tr>`;

  const groups = buildMatrixGroups(state.filtered);
  const papers = Array.from(groups.values());
  const start = (state.page - 1) * state.pageSize;
  const end   = start + state.pageSize;
  const pageGroups = papers.slice(start, end);

  pageGroups.forEach(g => {
    const tr = document.createElement("tr");

    // DOI
    const doiTd = document.createElement("td");
    const p = g.paper || {};
    const doi = p.doi || g.paper_id || "";
    const url = p.url || "#";
    doiTd.innerHTML = `<a href="${url}" target="_blank" rel="noopener">${escapeHtml(doi)}</a>`;
    tr.appendChild(doiTd);

    // Capas y Métodos (sin cambios)
    appendChipsCell(tr, g.capasItems?.["Substrato/TCO"] || [], 1);
    appendChipsCell(tr, g.capasItems?.["ETL"] || [], 1);
    appendChipsCell(tr, g.capasItems?.["Perovskita"] || [], 1);
    appendChipsCell(tr, g.capasItems?.["HTL"] || [], 1);
    appendChipsCell(tr, g.capasItems?.["Electrode"] || [], 1);
    appendChipsCell(tr, g.metodosItems?.["Síntesis"] || [], 1);
    appendChipsCell(tr, g.metodosItems?.["Fabricación"] || [], 1);

    // === Métricas: ahora mostramos TODOS los valores (cells + samples + metrics_global) ===
    const metrics = ["PCE", "Jsc", "Voc", "FF"];
    if (hasEff) metrics.push("Eficiencia");

    metrics.forEach(lab => {
      const td = document.createElement("td");
      td.className = "pivot-value chips-cell";

      const ents = g.metricsByLabel.get(lab) || [];
      if (ents.length === 0) {
        td.innerHTML = "—";
      } else {
        td.innerHTML = ents.map(ent => 
          `<button class="chip" data-entity="${ent.entity_id}">${escapeHtml(ent.value + (ent.units ? " " + ent.units : ""))}</button>`
        ).join("");
      }
      tr.appendChild(td);
    });

    tbody.appendChild(tr);
  });

  // Event listeners (mantener el resaltado y apertura de evidencia)
  tbody.querySelectorAll(".pivot-value button").forEach(btn => {
    btn.addEventListener("click", ev => {
      document.querySelectorAll('.chip.active').forEach(b => b.classList.remove('active'));
      ev.currentTarget.classList.add('active');
      const id = ev.currentTarget.getAttribute("data-entity");
      const ent = state.entities.find(x => x.entity_id === id);
      if (ent) showEvidence(ent);
    });
  });
}
function renderImagesTable() {
  const thead = $("#tableHead"); thead.innerHTML = "";
  const tbody = $("#entitiesTbody"); tbody.innerHTML = "";
  const table = thead.closest("table");
  table.setAttribute("data-view", "images");
  const headRow = el("tr", {}, [
    el("th", { html: "DOI" }),
    el("th", { html: "Imagen" })
  ]);
  thead.appendChild(headRow);
  const groups = new Map();
  state.imagesEntities.forEach(e => {
    if (e.label !== 'Imagen') return;
    const pid = e.paper_id;
    if (!groups.has(pid)) groups.set(pid, { paper: state.papersById.get(pid) || {}, images: [] });
    groups.get(pid).images.push(e);
  });
 const sortedGroups = Array.from(groups.values()).sort((a, b) => (a.paper.doi || a.paper.paper_id || '').localeCompare(b.paper.doi || b.paper.paper_id || ''));  const start = (state.page - 1) * state.pageSize;
  const end = start + state.pageSize;
  const paginated = sortedGroups.slice(start, end);
  paginated.forEach(g => {
    g.images.forEach((img, i) => {
      const pid = img.paper_id; // Añadido para fallback en DOI
      const tr = el("tr", {}, [
        el("td", { html: i === 0 ? `<a href="${ensureUrl((g.paper.doi || g.paper.paper_id || pid).replace(/_/g, '/'))}" target="_blank" rel="noopener">${escapeHtml((g.paper.doi || g.paper.paper_id || pid).replace(/_/g, '/'))}</a>` : "" }),
        el("td", { class: "pivot-value chips-cell", html: `<button class="chip" data-entity="${img.entity_id}">${escapeHtml(img.value)}</button>` })
      ]);
      tbody.appendChild(tr);
    });
  });
  tbody.querySelectorAll(".pivot-value button").forEach(btn => {
    btn.addEventListener("click", ev => {
      ev.preventDefault();
      const id = ev.currentTarget.getAttribute("data-entity");
      const ent = state.imagesEntities.find(x => x.entity_id === id);
      if (ent) showImage(ent);
    });
  });
}
function renderTablesTable() {
  console.log('Rendering tables table with state.tablesEntities:', state.tablesEntities); // Depurar entities cargadas
  const thead = $("#tableHead"); thead.innerHTML = "";
  const tbody = $("#entitiesTbody"); tbody.innerHTML = "";
  const table = thead.closest("table");
  table.setAttribute("data-view", "tables");
  const headRow = el("tr", {}, [
    el("th", { html: "DOI" }),
    el("th", { html: "Tabla" })
  ]);
  thead.appendChild(headRow);
  const groups = new Map();
  state.tablesEntities.forEach(e => {
    if (e.label !== 'Tabla') return;
    const pid = e.paper_id;
    if (!groups.has(pid)) groups.set(pid, { paper: state.papersById.get(pid) || {}, tables: [] });
    groups.get(pid).tables.push(e);
  });
  console.log('Groups built:', groups); // Depurar grupos
  const sortedGroups = Array.from(groups.values()).sort((a, b) => (a.paper.doi || a.paper.paper_id || '').localeCompare(b.paper.doi || b.paper.paper_id || ''));
  const start = (state.page - 1) * state.pageSize;
  const end = start + state.pageSize;
  const paginated = sortedGroups.slice(start, end);
  console.log('Paginated groups:', paginated); // Depurar paginados
  paginated.forEach(g => {
    g.tables.forEach((tbl, i) => {
      const pid = tbl.paper_id; // Fallback
      const tr = el("tr", {}, [
        el("td", { html: i === 0 ? `<a href="${ensureUrl((g.paper.doi || g.paper.paper_id || pid).replace(/_/g, '/'))}" target="_blank" rel="noopener">${escapeHtml((g.paper.doi || g.paper.paper_id || pid).replace(/_/g, '/'))}</a>` : "" }),
        el("td", { class: "pivot-value chips-cell", html: `<button class="chip" data-entity="${tbl.entity_id}">${escapeHtml(tbl.value)}</button>` })
      ]);
      tbody.appendChild(tr);
    });
  });
  tbody.querySelectorAll(".pivot-value button").forEach(btn => {
    btn.addEventListener("click", ev => {
      ev.preventDefault();
      const id = ev.currentTarget.getAttribute("data-entity");
      const ent = state.tablesEntities.find(x => x.entity_id === id);
      if (ent) showTable(ent);
    });
  });
}
function buildMatrixGroups(rows){
  const groups = new Map(); // paper_id -> group

  for (const e of rows){
    const pid = e.paper_id;
    if (!groups.has(pid)){
      const paper = state.papersById.get(pid) || {};
      groups.set(pid, {
        paper_id: pid,
        paper,
        capas: { "Substrato/TCO": new Set(), "ETL": new Set(), "Perovskita": new Set(), "HTL": new Set(), "Electrode": new Set() },
        metodos: { "Síntesis": new Set(), "Fabricación": new Set() },
        capasItems: { "Substrato/TCO": [], "ETL": [], "Perovskita": [], "HTL": [], "Electrode": [] },
        metodosItems: { "Síntesis": [], "Fabricación": [] },
        cells: new Map(),                    // cid -> { PCE: [...], Jsc: [...], ... }
        metricsByLabel: new Map()            // label -> array de entidades (nuevo)
      });
    }
    const g = groups.get(pid);
    const lab = String(e.label || "").trim();

    // === Capas y Métodos (sin cambios) ===
    if (["Substrato/TCO","ETL","Perovskita","HTL","Electrode"].includes(lab)){
      const vals = parseList(e.value);
      if (!vals.length && !_is_empty(e.value)) vals.push(String(e.value).trim());
      vals.forEach(v => {
        g.capas[lab].add(v);
        pushChip(g.capasItems[lab], v, e.entity_id);
      });
      continue;
    }
    if (["Síntesis","Fabricación"].includes(lab)){
      const vals = parseList(e.value);
      if (!vals.length && !_is_empty(e.value)) vals.push(String(e.value).trim());
      vals.forEach(v => {
        g.metodos[lab].add(v);
        pushChip(g.metodosItems[lab], v, e.entity_id);
      });
      continue;
    }

    // === Métricas (PCE, Jsc, Voc, FF, Eficiencia) ===
    if (RANGE_METRICS.some(m => m.key === lab)){
      const cid = getEntityCellId(e);

      // Guardamos todas las entidades (cells, samples, metrics_global) en un array por label
      if (!g.metricsByLabel.has(lab)) g.metricsByLabel.set(lab, []);
      g.metricsByLabel.get(lab).push(e);

      // También mantenemos el Map cells (para compatibilidad con otros sitios si hace falta)
      if (!g.cells.has(cid)) g.cells.set(cid, {});
      const slot = g.cells.get(cid);
      if (!slot[lab]) slot[lab] = [];
      slot[lab].push(e);
    }
  }
  return groups;
}

/* Paginación */
function renderPagination() {
  const pag = $("#pagination");
  let total;
  if (state.viewMode === 'pivot') total = countPivotGroups();
  else total = countMatrixGroups();
  if (state.viewMode === 'images') total = countImagesGroups();
  if (state.viewMode === 'tables') total = countTablesGroups();
  const pages = Math.max(1, Math.ceil(total / state.pageSize));
  
  state.page = Math.min(state.page, pages);

  function btn(txt, onClick, disabled=false) { const b = el("button", { html: txt }); b.disabled = disabled; b.addEventListener("click", onClick); return b; }
  pag.innerHTML = "";
  pag.appendChild(btn("« Primero", () => { state.page = 1; renderTable(); renderPagination(); }, state.page === 1));
  pag.appendChild(btn("‹ Anterior", () => { state.page = Math.max(1, state.page - 1); renderTable(); renderPagination(); }, state.page === 1));
  pag.appendChild(el("span", { html: `Página ${state.page} de ${pages}` }));
  pag.appendChild(btn("Siguiente ›", () => { state.page = Math.min(pages, state.page + 1); renderTable(); renderPagination(); }, state.page === pages));
  pag.appendChild(btn("Última »", () => { state.page = pages; renderTable(); renderPagination(); }, state.page === pages));
}
function countPivotGroups() {
  const seen = new Set();
  for (const e of getPivotRows()) { seen.add(`${e.paper_id}||${getEntityCellId(e)}`); }
  return seen.size || 0;
}
function countMatrixGroups() {
  return new Set(state.filtered.map(e => e.paper_id)).size || 0;
}
function countImagesGroups() {
  const seen = new Set();
  for (const e of state.imagesEntities) {
    if (e.label === 'Imagen') seen.add(e.paper_id);
  }
  return seen.size || 0;
}
function countTablesGroups() {
  const seen = new Set();
  for (const e of state.tablesEntities) {
    if (e.label === 'Tabla') seen.add(e.paper_id);
  }
  return seen.size || 0;
}
/* Evidencia */
function showEvidence(entity) {
  const p = state.papersById.get(entity.paper_id) || {};
  const box = $("#evidenceContent");
  const header = `${entity.label} = ${entity.value}${entity.units ? " " + entity.units : ""}`;
  const titleLine = `${p.title || entity.paper_id}`;
  const url = p.url ? `<a href="${p.url}" target="_blank" rel="noopener">${p.doi || p.url}</a>` : "";
  const safeText = (entity.span_text || "").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  box.innerHTML = `<div><strong>${header}</strong></div>
  <div style="color:#556270; margin-bottom:6px;">${titleLine} ${url ? " · " + url : ""}</div>
  <div>${safeText}</div>`;
  $("#evidencePanel").hidden = false;
}

/* Exportaciones */
function exportCSV() {
  if (state.viewMode === 'pivot') return exportPivotCSV();
  const rows = state.filtered.map(e => {
    const p = state.papersById.get(e.paper_id) || {};
    return {
      doi: p.doi || p.paper_id || "",
      cell_id: getEntityCellId(e),
      label: e.label || "",
      value: formatValueForExport(e),
      units: e.units || "",
      title: p.title || "",
      section: e.section || "",
      span_text: e.span_text || ""
    };
  });
  const headers = Object.keys(rows[0] || {doi:"",cell_id:"",label:"",value:"",units:"",title:"",section:"",span_text:""});
  const csv = [headers.join(",")].concat(rows.map(r => headers.map(h => csvEscape(r[h])).join(","))).join("\n");
  downloadFile("entities_detalle.csv", new Blob([csv], { type: "text/csv;charset=utf-8" }));
}


function exportJSON() {
  // Exporta lo que esté filtrado (independiente de la vista)
  const rows = state.filtered.map(e => {
    const p = state.papersById.get(e.paper_id) || {};
    return {
      entity_id: e.entity_id,
      paper_id: e.paper_id,
      doi: p.doi || p.paper_id || "",
      title: p.title || "",
      cell_id: getEntityCellId(e),
      label: e.label || "",
      value: formatValueForExport(e),
      units: e.units || "",
      section: e.section || "",
      span_text: e.span_text || "",
      confidence: e.confidence ?? null
    };
  });

  const payload = {
    exported_at: new Date().toISOString(),
    viewMode: state.viewMode,
    total: rows.length,
    entities: rows
  };

  downloadFile(
    "entities_filtradas.json",
    new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" })
  );
}

function exportPivotCSV() {
  const labels = getPivotLabels();
  const groups = new Map();
  for (const e of getPivotRows()) {
    const p = state.papersById.get(e.paper_id) || {};
    const cell = getEntityCellId(e);
    const key = `${e.paper_id}||${cell}`;
    if (!groups.has(key)) groups.set(key, { paper: p, byLabel: {}, cell_id: cell });
    const slot = groups.get(key);
    const cur = slot.byLabel[e.label];
    if (!cur || (e.confidence ?? 0) > (cur.confidence ?? 0)) slot.byLabel[e.label] = e;
  }
  const headers = ["doi","celda"].concat(labels);
  const outRows = [];
  for (const g of groups.values()) {
    const row = { doi: g.paper?.doi || g.paper?.paper_id || "", celda: g.cell_id };
    for (const lab of labels) {
      const ent = g.byLabel[lab];
      row[lab] = ent ? (`${ent.value ?? ""}${ent.units ? " " + ent.units : ""}`) : "";
    }
    outRows.push(row);
  }
  const csv = [headers.join(",")].concat(outRows.map(r => headers.map(h => csvEscape(r[h])).join(","))).join("\n");
  downloadFile("entities_pivot.csv", new Blob([csv], { type: "text/csv;charset=utf-8" }));
}

// =============================
// Helpers de vista por celda
// - Excluye Capas y Métodos (por sección y por etiquetas conocidas)
// =============================
const PIVOT_EXCLUDED_LABELS = new Set([
  "Substrato/TCO", "ETL", "Perovskita", "HTL", "Electrode",
  "Síntesis", "Fabricación", "Capas", "Tabla"
]);
// Añade exclusión dinámica basada en grupos no seleccionados
function getDynamicPivotExcluded() {
  const excluded = new Set(PIVOT_EXCLUDED_LABELS);
  if (!state.filters.groups.has('capas')) {
    excluded.add('Capas'); // Ya está, pero por si acaso
  }
  if (!state.filters.groups.has('metodos')) {
    excluded.add('Síntesis');
    excluded.add('Fabricación');
  }
  if (!state.filters.groups.has('celdas')) {
    excluded.add('PCE');
    excluded.add('Jsc');
    excluded.add('Voc');
    excluded.add('FF');
    excluded.add('Eficiencia');
  }
  return excluded;
}

function _isMethodsSection(e) {
  const s = String(e?.section ?? "").trim().toLowerCase();
  return s === "methods" || s === "method";
}

function getPivotRows() {
  // Filtramos entidades para que en la vista por celda solo queden resultados/métricas.
  return state.filtered.filter(e => {
    const label = String(e.label ?? "").trim();
    const dynamicExcluded = getDynamicPivotExcluded();
    if (dynamicExcluded.has(label)) return false;
    if (_isMethodsSection(e)) return false;
    if (e.isGlobalFallback) return false;
    return true;
  });
}

function getPivotLabels() {
  const rows = getPivotRows();
  const set = new Set(rows.map(e => e.label).filter(Boolean));
  const order = ["PCE", "Jsc", "Voc", "FF", "Eficiencia"]; // orden preferido
  return Array.from(set).sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib) || String(a).localeCompare(String(b));
  });
}

/* Utilidades comunes */
function parseLayers(value){
  if (Array.isArray(value)) return value.slice(0,5);
  if (value && typeof value === 'object' && Array.isArray(value.layers)) return value.layers.slice(0,5);
  if (typeof value === 'string') return value.split(/[|,\/>\-]+/).map(s=>s.trim()).filter(Boolean).slice(0,5);
  return [];
}
function layersToString(value){ return parseLayers(value).join(" > "); }
function formatValueForExport(e){ return (e.label==='Capas') ? layersToString(e.value) : String(e.value ?? ""); }
function csvEscape(v) { const s = String(v ?? ""); return /[\",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
function downloadFile(filename, blob) {
  const url = URL.createObjectURL(blob); const a = document.createElement("a");
  a.href = url; a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(url), 2000);
}
function handleEntitiesFile(ev) {
  const f = ev.target.files[0];
  if (!f) return;

  const r = new FileReader();
  r.onload = () => {
    try {
      const raw = JSON.parse(r.result);
      const normalized = normalizeEntitiesInput(raw);

      if (normalized.mode === "fair") {
        setPapers(normalized.papersJson);
        setEntities(normalized.entitiesJson);
      } else {
        setEntities(raw);
      }

      postLoadSetup();
      applyFilters();
    } catch (err) {
      alert("No se pudo leer entities.json: " + err.message);
    }
  };
  r.readAsText(f, "utf-8");
}
function handlePapersFile(ev) { const f = ev.target.files[0]; if (!f) return;
  const r = new FileReader(); r.onload = () => { try { setPapers(JSON.parse(r.result)); postLoadSetup(); applyFilters(); } catch (err) { alert("No se pudo leer papers.json: " + err.message); } };
  r.readAsText(f, "utf-8");
}
function postLoadSetup() {
  buildLabelsAvailable();
  buildCellIndex();
  computeRangeMetaAndInit();
  renderRangeFilters();
  applyFilters();
}
window.addEventListener("DOMContentLoaded", init);

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[ch])); }
function getEntityCellId(e) { if (e.cell_id != null) return e.cell_id; if (e.device != null) return e.device; if (e.sample != null) return e.sample; return 1; }

/* Render Capas (cilindro) para la vista por celda */
function renderLayerStackHTML(value) {
  let layers = [];
  if (Array.isArray(value)) layers = value.slice();
  else if (value && typeof value === 'object' && Array.isArray(value.layers)) layers = value.layers.slice();
  else if (typeof value === 'string') layers = value.split(/[|,\/>\-]+/).map(s => s.trim()).filter(Boolean);
  layers = layers.slice(0, 5);
  if (!layers.length) return "—";
  const slices = layers.map((name, i) =>
    `<div class="layer-slice idx-${(i % 5) + 1}"><span class="slice-label">${escapeHtml(name)}</span></div>`
  ).join("");
  return `<div class="layer-cylinder"><div class="layer-body">${slices}</div></div>`;
}

/* Helpers vista matriz */
function pushChip(arr, text, entity_id){
  if (!arr) return;
  const t = String(text ?? "").trim();
  if (!t) return;
  // evita duplicados exactos (texto + entidad)
  if (arr.some(x => x.text === t && x.entity_id === entity_id)) return;
  arr.push({ text: t, entity_id });
}
function appendChipsCell(tr, items, rowspan){
  const td = document.createElement("td");
  td.className = "pivot-value chips-cell";
  td.rowSpan = rowspan;
  if (!items || !items.length){
    td.textContent = "—";
    tr.appendChild(td);
    return;
  }
  td.innerHTML = items.map(it =>
    `<button class="chip" data-entity="${escapeHtml(String(it.entity_id))}">${escapeHtml(String(it.text))}</button>`
  ).join("");
  tr.appendChild(td);
}
function appendMultiCell(tr, html, rowspan){ const td = document.createElement("td"); td.rowSpan = rowspan; td.innerHTML = html || "—"; tr.appendChild(td); }
function joinList(setOrArr){ const arr = Array.from(setOrArr || []); return arr.length ? `<div class="multiline">${arr.map(escapeHtml).join("\n")}</div>` : "—"; }
function metricCell(ent){ if (!ent) return el("td", { html: "—" }); const txt = `${ent.value ?? ""}${ent.units ? " " + ent.units : ""}`; const td = document.createElement("td"); td.className = "pivot-value"; td.innerHTML = `<button data-entity="${ent.entity_id}">${escapeHtml(String(txt))}</button>`; return td; }
function parseList(v){ if (Array.isArray(v)) return v.map(x=>String(x).trim()).filter(Boolean); if (typeof v === "string") return v.split(/[|,;/\n]+/).map(s=>s.trim()).filter(Boolean); return []; }
function showImage(entity) {
  const box = $("#evidenceContent");
  const p = state.papersById.get(entity.paper_id) || {};
  const doi = entity.paper_id.replace(/_/g, '/') || "";
  const url = entity.path || "";
  const name = entity.value || "Imagen";
  box.innerHTML = `<div><strong>${name}</strong></div>
  <div style="color:#556270; margin-bottom:0px;"><a href="${ensureUrl(doi)}" target="_blank" rel="noopener">${escapeHtml(doi)}</a></div>
  <div><img src="${url}" alt="${name}" style="max-width:100%; height:auto; border:1px solid var(--border); border-radius:3px;"></div>`;
  $("#evidencePanel").hidden = false;
}
function showTable(entity) {
  const box = $("#evidenceContent");
  const p = state.papersById.get(entity.paper_id) || {};
  const doi = entity.paper_id.replace(/_/g, '/') || "";
  const url = entity.path || "";
  const name = entity.value || "Tabla";
  box.innerHTML = `<div><strong>${name}</strong></div>
  <div style="color:#556270; margin-bottom:0px;"><a href="${ensureUrl(doi)}" target="_blank" rel="noopener">${escapeHtml(doi)}</a></div>
  <div><img src="${url}" alt="${name}" style="max-width:100%; height:auto; border:1px solid var(--border); border-radius:3px;"></div>`;
  $("#evidencePanel").hidden = false;
}
async function scanLocalImagesFolder() {
  try {
    const dirHandle = await window.showDirectoryPicker({ mode: 'read' });
    if (dirHandle.name !== 'imagenes') {
      alert('Por favor, selecciona la carpeta "imagenes".');
      return;
    }
    let added = 0;
    for await (const [subName, subHandle] of dirHandle.entries()) {
      if (subHandle.kind !== 'directory') continue;
      console.log('Procesando subcarpeta (independiente):', subName);
      const paper_id = subName;
      for await (const [fileName, fileHandle] of subHandle.entries()) {
        if (fileHandle.kind !== 'file') continue;
        if (!/\.(jpg|png|gif|jpeg|webp|svg)$/i.test(fileName)) continue;
        const existing = state.imagesEntities.find(e => e.label === "Imagen" && e.value === fileName && e.paper_id === paper_id);
        if (existing) {
          console.log('Imagen duplicada ignorada:', fileName);
          continue;
        }
        const file = await fileHandle.getFile();
        const blobUrl = URL.createObjectURL(file);
        state.imagesEntities.push({
          entity_id: `${paper_id}__Imagen__${state.imagesEntities.length + 1}`,
          paper_id,
          label: "Imagen",
          value: fileName,
          section: "Images",
          confidence: 1.0,
          path: blobUrl
        });
        added++;
        console.log('Imagen añadida a imagesEntities:', fileName, 'para subcarpeta:', subName);
      }
    }
    if (state.viewMode === 'images') {
      renderTable();
      renderPagination();
    }
    alert(`Imágenes cargadas en vista independiente: ${added}.`);
    applyFilters();
    console.log('ImagesEntities después de carga:', state.imagesEntities); // Añadido para depurar
    if (state.viewMode === 'images') {
      renderTable();
      renderPagination();
    }
  } catch (err) {
    console.error('Error escanea-ndo carpeta local:', err);
    alert('Error al seleccionar carpeta: ' + err.message);
  }
}
async function scanLocalTablesFolder() {
  try {
    const dirHandle = await window.showDirectoryPicker({ mode: 'read' });
    if (dirHandle.name !== 'tablas') {
      alert('Por favor, selecciona la carpeta "tablas".');
      return;
    }
    let added = 0;
    for await (const [subName, subHandle] of dirHandle.entries()) {
      if (subHandle.kind !== 'directory') continue;
      console.log('Procesando subcarpeta (independiente):', subName);
      const paper_id = subName;
      for await (const [fileName, fileHandle] of subHandle.entries()) {
        if (fileHandle.kind !== 'file') continue;
        if (!/\.(jpg|png|gif|jpeg|webp|svg)$/i.test(fileName)) continue;
        const existing = state.tablesEntities.find(e => e.label === "Tabla" && e.value === fileName && e.paper_id === paper_id);
        if (existing) {
          console.log('Tabla duplicada ignorada:', fileName);
          continue;
        }
        const file = await fileHandle.getFile();
        const blobUrl = URL.createObjectURL(file);
        state.tablesEntities.push({
          entity_id: `${paper_id}__Tabla__${state.tablesEntities.length + 1}`,
          paper_id,
          label: "Tabla",
          value: fileName,
          section: "Tables",
          confidence: 1.0,
          path: blobUrl
        });
        added++;
        console.log('Tabla añadida a tablesEntities:', fileName, 'para subcarpeta:', subName);
      }
    }
    if (state.viewMode === 'tables') {
      renderTable();
      renderPagination();
    }
    alert(`Tablas cargadas en vista independiente: ${added}.`);
    applyFilters();
    console.log('TablesEntities después de carga:', state.tablesEntities); // Añadido para depurar
    if (state.viewMode === 'tables') {
      renderTable();
      renderPagination();
    }
  } catch (err) {
    console.error('Error escaneando carpeta local:', err);
    alert('Error al seleccionar carpeta: ' + err.message);
  }
}