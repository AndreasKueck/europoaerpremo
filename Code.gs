/******************************************************
 * Premosistemoj en Europo / Norda Atlantiko per Open-Meteo
 * ----------------------------------------------------
 * - Chiun duan horon ekigilo shargas freshajn datumojn
 * - La reteja programo montras la laste preparitajn datumojn
 * - Krado: 2,5 gradoj
 * - API en blokoj
 * - Tiu chi dosiero kaj index.html estis kreita per AI
 ******************************************************/

const PRESSURE_CFG = {
  latMin: 35.0,
  latMax: 72.5,
  lonMin: -25.0,
  lonMax: 32.5,
  step: 2.5,

  apiUrl: 'https://api.open-meteo.com/v1/forecast',
  apiChunkSize: 90,

  neighborhoodRadiusCells: 2,
  minProminenceHpa: 0.6,
  minSystemDistanceKm: 850,
  maxSystemsPerType: 4
};

const PRESSURE_STORE_CFG = {
  keyPrefix: 'PRESSURE_MAP_DATA_CHUNK_',
  chunkCountKey: 'PRESSURE_MAP_DATA_CHUNK_COUNT',
  updatedAtKey: 'PRESSURE_MAP_DATA_UPDATED_AT',
  chunkSize: 8000
};


/**
 * Enirejo de la reteja programo.
 */
function doGet() {
  return HtmlService
    .createHtmlOutputFromFile('index')
    .setTitle('Europo: aerpremo')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}


/**
 * Por index.html / google.script.run.
 * La reteja programo normale liveras la laste preparitajn datumojn.
 * Se ankorau ne ekzistas datumoj, ili estas kreitaj unufoje tuj.
 */
function getPressureMapData() {
  const stored = loadStoredPressureMapData_();

  if (stored) {
    stored.servedFromPreparedStore = true;
    return stored;
  }

  return updatePressureMapData();
}


/**
 * Funkcio por la tempo-trigger.
 * Shargas freshajn datumojn, analizas ilin kaj konservas la rezulton.
 */
function updatePressureMapData() {
  const lock = LockService.getScriptLock();

  try {
    lock.waitLock(30000);

    const data = getPressureAnalysis();
    data.preparedAt = new Date().toISOString();
    data.servedFromPreparedStore = false;

    saveStoredPressureMapData_(data);

    return data;
  } finally {
    lock.releaseLock();
  }
}


/**
 * Unufoje mane lanchebla funkcio.
 * Ghi forigas eventualajn malnovajn samfunkciajn triggerojn,
 * kreas novan triggeron por chiu 2 horoj kaj tuj preparas datumojn.
 */
function installTwoHourlyPressureTrigger() {
  deletePressureUpdateTriggers_();

  ScriptApp.newTrigger('updatePressureMapData')
    .timeBased()
    .everyHours(2)
    .create();

  updatePressureMapData();
}


/**
 * Opcie mane lanchebla funkcio por forigi la aktualigan triggeron.
 */
function deleteTwoHourlyPressureTrigger() {
  deletePressureUpdateTriggers_();
}


/**
 * Forigas triggerojn por updatePressureMapData.
 */
function deletePressureUpdateTriggers_() {
  const triggers = ScriptApp.getProjectTriggers();

  triggers.forEach(function(trigger) {
    if (trigger.getHandlerFunction() === 'updatePressureMapData') {
      ScriptApp.deleteTrigger(trigger);
    }
  });
}


/**
 * Konservas la pretan JSON-rezulton en pluraj Script Properties.
 */
function saveStoredPressureMapData_(data) {
  const props = PropertiesService.getScriptProperties();
  const json = JSON.stringify(data);
  const chunks = [];

  for (let i = 0; i < json.length; i += PRESSURE_STORE_CFG.chunkSize) {
    chunks.push(json.slice(i, i + PRESSURE_STORE_CFG.chunkSize));
  }

  deleteStoredPressureMapData_();

  const values = {};
  values[PRESSURE_STORE_CFG.chunkCountKey] = String(chunks.length);
  values[PRESSURE_STORE_CFG.updatedAtKey] = new Date().toISOString();

  chunks.forEach(function(chunk, index) {
    values[PRESSURE_STORE_CFG.keyPrefix + index] = chunk;
  });

  props.setProperties(values);
}


/**
 * Shargas la konservitan JSON-rezulton.
 */
function loadStoredPressureMapData_() {
  const props = PropertiesService.getScriptProperties();
  const chunkCountRaw = props.getProperty(PRESSURE_STORE_CFG.chunkCountKey);

  if (!chunkCountRaw) return null;

  const chunkCount = Number(chunkCountRaw);

  if (!isFinite(chunkCount) || chunkCount <= 0) return null;

  let json = '';

  for (let i = 0; i < chunkCount; i++) {
    const chunk = props.getProperty(PRESSURE_STORE_CFG.keyPrefix + i);

    if (chunk === null || chunk === undefined) {
      return null;
    }

    json += chunk;
  }

  try {
    return JSON.parse(json);
  } catch (e) {
    return null;
  }
}


/**
 * Forigas nur la konservitajn datumojn de chi tiu programero.
 */
function deleteStoredPressureMapData_() {
  const props = PropertiesService.getScriptProperties();
  const all = props.getProperties();

  Object.keys(all).forEach(function(key) {
    if (
      key.indexOf(PRESSURE_STORE_CFG.keyPrefix) === 0 ||
      key === PRESSURE_STORE_CFG.chunkCountKey ||
      key === PRESSURE_STORE_CFG.updatedAtKey
    ) {
      props.deleteProperty(key);
    }
  });
}


/**
 * Chefa analizo.
 */
function getPressureAnalysis() {
  const grid = buildGrid_();
  const points = fetchPressureGrid_(grid.points);
  const systems = findPressureSystems_(points, grid.nRows, grid.nCols);
  const stats = calcStats_(points);

  return {
    generatedAt: new Date().toISOString(),
    fromCache: false,
    apiRequestCount: Math.ceil(grid.points.length / PRESSURE_CFG.apiChunkSize),
    domain: {
      latMin: PRESSURE_CFG.latMin,
      latMax: PRESSURE_CFG.latMax,
      lonMin: PRESSURE_CFG.lonMin,
      lonMax: PRESSURE_CFG.lonMax,
      step: PRESSURE_CFG.step,
      nRows: grid.nRows,
      nCols: grid.nCols
    },
    stats: stats,
    systems: systems,
    points: points
  };
}


/**
 * Krei kradon.
 */
function buildGrid_() {
  const points = [];
  const nRows = Math.round((PRESSURE_CFG.latMax - PRESSURE_CFG.latMin) / PRESSURE_CFG.step) + 1;
  const nCols = Math.round((PRESSURE_CFG.lonMax - PRESSURE_CFG.lonMin) / PRESSURE_CFG.step) + 1;

  let id = 0;

  for (let r = 0; r < nRows; r++) {
    const lat = roundCoord_(PRESSURE_CFG.latMax - r * PRESSURE_CFG.step);

    for (let c = 0; c < nCols; c++) {
      const lon = roundCoord_(PRESSURE_CFG.lonMin + c * PRESSURE_CFG.step);

      points.push({
        id: id++,
        row: r,
        col: c,
        lat: lat,
        lon: lon
      });
    }
  }

  return {
    points: points,
    nRows: nRows,
    nCols: nCols
  };
}


/**
 * Shargi premdatumojn de Open-Meteo.
 */
function fetchPressureGrid_(gridPoints) {
  const chunks = [];

  for (let i = 0; i < gridPoints.length; i += PRESSURE_CFG.apiChunkSize) {
    chunks.push(gridPoints.slice(i, i + PRESSURE_CFG.apiChunkSize));
  }

  const requests = chunks.map(function(chunk) {
    const params = {
      latitude: chunk.map(p => p.lat).join(','),
      longitude: chunk.map(p => p.lon).join(','),
      current: 'pressure_msl',
      timezone: 'UTC',
      cell_selection: 'nearest'
    };

    return {
      url: PRESSURE_CFG.apiUrl,
      method: 'post',
      payload: toFormBody_(params),
      contentType: 'application/x-www-form-urlencoded',
      muteHttpExceptions: true,
      headers: {
        'User-Agent': 'GAS-Europe-PressureSystems-Prepared/1.0'
      }
    };
  });

  const responses = UrlFetchApp.fetchAll(requests);
  const out = [];

  for (let ci = 0; ci < responses.length; ci++) {
    const response = responses[ci];
    const code = response.getResponseCode();

    if (code !== 200) {
      throw new Error(
        'Open-Meteo-eraro HTTP ' + code + ': ' + response.getContentText().slice(0, 300)
      );
    }

    const json = JSON.parse(response.getContentText());
    const arr = Array.isArray(json) ? json : [json];
    const chunk = chunks[ci];

    for (let i = 0; i < chunk.length; i++) {
      const loc = arr[i];
      const original = chunk[i];

      if (!loc || !loc.current || loc.current.pressure_msl === undefined || loc.current.pressure_msl === null) {
        continue;
      }

      out.push({
        id: original.id,
        row: original.row,
        col: original.col,
        lat: original.lat,
        lon: original.lon,
        pressure: Number(loc.current.pressure_msl),
        time: loc.current.time || null
      });
    }
  }

  if (!out.length) {
    throw new Error('Neniuj premdatumoj ricevitaj de Open-Meteo.');
  }

  return out;
}


/**
 * Trovi altpremojn kaj malaltpremojn.
 */
function findPressureSystems_(points, nRows, nCols) {
  const matrix = [];

  for (let r = 0; r < nRows; r++) {
    matrix.push(new Array(nCols).fill(null));
  }

  points.forEach(function(p) {
    matrix[p.row][p.col] = p;
  });

  const radius = PRESSURE_CFG.neighborhoodRadiusCells;
  const highs = [];
  const lows = [];

  points.forEach(function(p) {
    const neighbors = [];

    for (let dr = -radius; dr <= radius; dr++) {
      for (let dc = -radius; dc <= radius; dc++) {
        if (dr === 0 && dc === 0) continue;

        const rr = p.row + dr;
        const cc = p.col + dc;

        if (rr < 0 || rr >= nRows || cc < 0 || cc >= nCols) continue;

        const q = matrix[rr][cc];
        if (q) neighbors.push(q);
      }
    }

    if (neighbors.length < 8) return;

    const pressures = neighbors.map(q => q.pressure);
    const maxN = Math.max.apply(null, pressures);
    const minN = Math.min.apply(null, pressures);
    const avgN = pressures.reduce((a, b) => a + b, 0) / pressures.length;

    const edge = (
      p.row < radius ||
      p.row >= nRows - radius ||
      p.col < radius ||
      p.col >= nCols - radius
    );

    const highProm = p.pressure - avgN;
    const lowProm = avgN - p.pressure;

    if (p.pressure >= maxN && highProm >= PRESSURE_CFG.minProminenceHpa) {
      highs.push(makeCandidate_(p, 'A', highProm, edge, 'loka maksimumo'));
    }

    if (p.pressure <= minN && lowProm >= PRESSURE_CFG.minProminenceHpa) {
      lows.push(makeCandidate_(p, 'M', lowProm, edge, 'loka minimumo'));
    }
  });

  let selectedHighs = selectSeparatedSystems_(highs, 'A');
  let selectedLows = selectSeparatedSystems_(lows, 'M');

  if (!selectedHighs.length) {
    const maxPoint = points.reduce((best, p) => p.pressure > best.pressure ? p : best, points[0]);
    selectedHighs = [
      makeCandidate_(
        maxPoint,
        'A',
        null,
        isEdge_(maxPoint, nRows, nCols),
        'plej forta regiona altpremo / centro eble ekstere'
      )
    ];
  }

  if (!selectedLows.length) {
    const minPoint = points.reduce((best, p) => p.pressure < best.pressure ? p : best, points[0]);
    selectedLows = [
      makeCandidate_(
        minPoint,
        'M',
        null,
        isEdge_(minPoint, nRows, nCols),
        'plej forta regiona malaltpremo / centro eble ekstere'
      )
    ];
  }

  return {
    highs: selectedHighs,
    lows: selectedLows
  };
}


function makeCandidate_(p, type, prominence, edge, method) {
  return {
    type: type,
    lat: roundCoord_(p.lat),
    lon: roundCoord_(p.lon),
    pressure: round1_(p.pressure),
    prominence: prominence === null ? null : round1_(prominence),
    edge: !!edge,
    method: method
  };
}


function selectSeparatedSystems_(candidates, type) {
  const sorted = candidates.slice().sort(function(a, b) {
    if (type === 'A') {
      if (b.pressure !== a.pressure) return b.pressure - a.pressure;
      return (b.prominence || 0) - (a.prominence || 0);
    } else {
      if (a.pressure !== b.pressure) return a.pressure - b.pressure;
      return (b.prominence || 0) - (a.prominence || 0);
    }
  });

  const selected = [];

  sorted.forEach(function(c) {
    const tooClose = selected.some(function(s) {
      return haversineKm_(c.lat, c.lon, s.lat, s.lon) < PRESSURE_CFG.minSystemDistanceKm;
    });

    if (!tooClose && selected.length < PRESSURE_CFG.maxSystemsPerType) {
      selected.push(c);
    }
  });

  return selected;
}


function calcStats_(points) {
  const vals = points.map(p => p.pressure);
  const min = Math.min.apply(null, vals);
  const max = Math.max.apply(null, vals);
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;

  return {
    count: points.length,
    minPressure: round1_(min),
    maxPressure: round1_(max),
    meanPressure: round1_(mean)
  };
}


/**
 * Helpaj funkcioj.
 */
function toFormBody_(params) {
  return Object.keys(params)
    .map(k => encodeURIComponent(k) + '=' + encodeURIComponent(params[k]))
    .join('&');
}


function roundCoord_(x) {
  return Math.round(x * 1000) / 1000;
}


function round1_(x) {
  return Math.round(Number(x) * 10) / 10;
}


function isEdge_(p, nRows, nCols) {
  const r = PRESSURE_CFG.neighborhoodRadiusCells;
  return p.row < r || p.row >= nRows - r || p.col < r || p.col >= nCols - r;
}


function haversineKm_(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = d => d * Math.PI / 180;

  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);

  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
