/******************************************************
 * Premosistemoj en Europo / Norda Atlantiko per Open-Meteo
 * ----------------------------------------------------
 * - La reteja programo montras la laste preparitajn datumojn
 * - Krado: 2,5 gradoj
 * - API en blokoj
 * - Aldone: eblaj partoj de frontoj surbaze de
 *   temperature_2m-gradienteco kaj precipitation
 * - Tiu chi dosiero kaj index.html estis kreita / shanghita per AI
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

const GERMAN_BIGHT_SUMMARY_CFG = {
  title: 'Resumo de la meteorologia situacio decida por la vetero en Germana Golfo',

  // Grobe Mitte der Deutschen Bucht.
  focus: {
    name: 'Germana Golfo',
    lat: 54.2,
    lon: 7.5
  },

  maxLows: 2,
  maxHighs: 2,

  // Normdruck zur groben Gewichtung der Relevanz.
  pressureReferenceHpa: 1013.25,

  // Distanzskala fuer Einflussgewichtung.
  influenceDistanceScaleKm: 850
};


const POSSIBLE_FRONT_CFG = {
  minTemperatureGradientCPer100Km: 2.5,
  maxMarkers: 300
};


const GRID_POINT_MARKER_CFG = {
  precipitationThreshold: 0.1,
  warmTemperatureThresholdC: 25,
  coldTemperatureThresholdC: 0
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
 */
function getPressureMapData() {
  return updatePressureMapData();
}


/**
 * Funkcio por la tempo-ekigilo.
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

  if (!Number.isFinite(chunkCount) || chunkCount <= 0) return null;

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

  const markerDataTime =
    getRepresentativeDataTime_(points) ||
    new Date().toISOString();

  const temperatureMarkerRule =
    makeTemperatureMarkerRule_(markerDataTime);

  annotateGridPointMarkers_(points, temperatureMarkerRule);

  const systems = findPressureSystems_(points, grid.nRows, grid.nCols);
  const germanBightSummary = makeGermanBightWeatherSummary_(systems);
  const possibleFrontParts = findPossibleFrontParts_(points, grid.nRows, grid.nCols);
  const stats = calcStats_(points);
  const markerStats = calcGridPointMarkerStats_(points);

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
    germanBightSummary: germanBightSummary,
    possibleFrontParts: possibleFrontParts,
    gridPointMarkers: {
      dataTime: markerDataTime,
      precipitation: {
        enabled: true,
        operator: '>=',
        threshold: GRID_POINT_MARKER_CFG.precipitationThreshold,
        unit: 'mm'
      },
      temperature: temperatureMarkerRule,
      stats: markerStats
    },
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
 * Shargi premdatumojn, 2-m-temperaturon kaj precipitadon de Open-Meteo.
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
      current: 'pressure_msl,temperature_2m,precipitation',
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

      if (
        !loc ||
        !loc.current ||
        loc.current.pressure_msl === undefined ||
        loc.current.pressure_msl === null
      ) {
        continue;
      }

      const pressure = Number(loc.current.pressure_msl);

      if (!Number.isFinite(pressure)) {
        continue;
      }

      const rawTemperature = loc.current.temperature_2m;
      const rawPrecipitation = loc.current.precipitation;

      const temperature2m =
        rawTemperature === undefined || rawTemperature === null
          ? null
          : Number(rawTemperature);

      const precipitation =
        rawPrecipitation === undefined || rawPrecipitation === null
          ? null
          : Number(rawPrecipitation);

      out.push({
        id: original.id,
        row: original.row,
        col: original.col,
        lat: original.lat,
        lon: original.lon,
        pressure: pressure,
        temperature2m:
          temperature2m !== null && Number.isFinite(temperature2m)
            ? temperature2m
            : null,
        precipitation:
          precipitation !== null && Number.isFinite(precipitation)
            ? precipitation
            : null,
        time: loc.current.time || null
      });
    }
  }

  if (!out.length) {
    throw new Error('Neniuj datumoj ricevitaj de Open-Meteo.');
  }

  return out;
}


/**
 * Aldonas al kradpunktoj flagojn por la novaj markiloj.
 *
 * Precipitado:
 * - precipitation >= GRID_POINT_MARKER_CFG.precipitationThreshold
 *   Do nuntempe: precipitation >= 0.1 mm
 *
 * Temperaturo:
 * - 1-a de aprilo ghis 30-a de septembro: temperature_2m >= 25 °C
 * - 1-a de oktobro ghis 31-a de marto: temperature_2m <= 0 °C
 */
function annotateGridPointMarkers_(points, temperatureMarkerRule) {
  points.forEach(function(p) {
    const precipitation =
      p.precipitation === null || p.precipitation === undefined
        ? NaN
        : Number(p.precipitation);

    const temperature2m =
      p.temperature2m === null || p.temperature2m === undefined
        ? NaN
        : Number(p.temperature2m);

    p.markerPrecipitation = hasSignificantPrecipitation_(precipitation);

    if (temperatureMarkerRule && temperatureMarkerRule.season === 'warm') {
      p.markerTemperature =
        Number.isFinite(temperature2m) &&
        temperature2m >= GRID_POINT_MARKER_CFG.warmTemperatureThresholdC;
    } else {
      p.markerTemperature =
        Number.isFinite(temperature2m) &&
        temperature2m <= GRID_POINT_MARKER_CFG.coldTemperatureThresholdC;
    }
  });
}


/**
 * Statistikoj pri novaj kradpunktaj markiloj.
 */
function calcGridPointMarkerStats_(points) {
  let precipitation = 0;
  let temperature = 0;
  let both = 0;

  points.forEach(function(p) {
    if (p.markerPrecipitation) precipitation++;
    if (p.markerTemperature) temperature++;
    if (p.markerPrecipitation && p.markerTemperature) both++;
  });

  return {
    precipitation: precipitation,
    temperature: temperature,
    both: both
  };
}


/**
 * Reprezenta tempo de la ricevitaj Open-Meteo-current-datumoj.
 */
function getRepresentativeDataTime_(points) {
  if (!Array.isArray(points)) return null;

  for (let i = 0; i < points.length; i++) {
    if (points[i] && points[i].time) {
      return points[i].time;
    }
  }

  return null;
}


/**
 * Regulo por temperaturaj markiloj lau sezono.
 */
function makeTemperatureMarkerRule_(timeValue) {
  const date = parseOpenMeteoTime_(timeValue) || new Date();
  const month = date.getUTCMonth() + 1;

  const warmSeason = month >= 4 && month <= 9;

  if (warmSeason) {
    return {
      enabled: true,
      season: 'warm',
      seasonLabel: '1-a de aprilo ghis 30-a de septembro',
      operator: '>=',
      threshold: GRID_POINT_MARKER_CFG.warmTemperatureThresholdC,
      unit: '°C',
      variable: 'temperature_2m'
    };
  }

  return {
    enabled: true,
    season: 'cold',
    seasonLabel: '1-a de oktobro ghis 31-a de marto',
    operator: '<=',
    threshold: GRID_POINT_MARKER_CFG.coldTemperatureThresholdC,
    unit: '°C',
    variable: 'temperature_2m'
  };
}


/**
 * Open-Meteo donas UTC-tempon ofte sen fina Z.
 */
function parseOpenMeteoTime_(value) {
  if (!value) return null;

  let text = String(value);

  if (!/[zZ]$/.test(text) && !/[+\-]\d\d:?\d\d$/.test(text)) {
    text += 'Z';
  }

  const date = new Date(text);

  if (isNaN(date.getTime())) return null;

  return date;
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


/**
 * Trovi eblajn partojn de fronto.
 *
 * Kriterioj:
 * - Nur rektaj najbaroj: okcidento-oriento kaj nordo-sudo
 * - Temperaturgradienteco >= POSSIBLE_FRONT_CFG.minTemperatureGradientCPer100Km
 *   Do nuntempe: gradienteco >= 2.5 °C / 100 km
 * - Precipitado en almenau unu el la du najbaraj kradpunktoj lau
 *   hasSignificantPrecipitation_()
 *   Do nuntempe: precipitation >= 0.1 mm
 *
 * La markilo estas metata en la mezo inter la du punktoj.
 */
function findPossibleFrontParts_(points, nRows, nCols) {
  const matrix = [];

  for (let r = 0; r < nRows; r++) {
    matrix.push(new Array(nCols).fill(null));
  }

  points.forEach(function(p) {
    matrix[p.row][p.col] = p;
  });

  const out = [];

  const directions = [
    {
      dr: 0,
      dc: 1,
      name: 'okcidento-oriento'
    },
    {
      dr: 1,
      dc: 0,
      name: 'nordo-sudo'
    }
  ];

  points.forEach(function(p) {
    directions.forEach(function(d) {
      const rr = p.row + d.dr;
      const cc = p.col + d.dc;

      if (rr < 0 || rr >= nRows || cc < 0 || cc >= nCols) return;

      const q = matrix[rr][cc];
      if (!q) return;

      const tA =
        p.temperature2m === null || p.temperature2m === undefined
          ? NaN
          : Number(p.temperature2m);

      const tB =
        q.temperature2m === null || q.temperature2m === undefined
          ? NaN
          : Number(q.temperature2m);

      if (!Number.isFinite(tA) || !Number.isFinite(tB)) return;

      const prA =
        p.precipitation === null || p.precipitation === undefined
          ? NaN
          : Number(p.precipitation);

      const prB =
        q.precipitation === null || q.precipitation === undefined
          ? NaN
          : Number(q.precipitation);

      const precipA = Number.isFinite(prA) ? prA : 0;
      const precipB = Number.isFinite(prB) ? prB : 0;

      const hasPrecipitationA = hasSignificantPrecipitation_(precipA);
      const hasPrecipitationB = hasSignificantPrecipitation_(precipB);

      const hasPrecipitation = hasPrecipitationA || hasPrecipitationB;

      if (!hasPrecipitation) return;

      const distanceKm = haversineKm_(p.lat, p.lon, q.lat, q.lon);

      if (!Number.isFinite(distanceKm) || distanceKm <= 0) return;

      const deltaC = Math.abs(tA - tB);
      const gradientCPer100Km = deltaC / distanceKm * 100;

      if (gradientCPer100Km < POSSIBLE_FRONT_CFG.minTemperatureGradientCPer100Km) {
        return;
      }

      out.push({
        type: 'possibleFrontPart',
        label: 'Ebla parto de fronto',
        lat: roundCoord_((p.lat + q.lat) / 2),
        lon: roundCoord_((p.lon + q.lon) / 2),
        gradientCPer100Km: round1_(gradientCPer100Km),
        deltaC: round1_(deltaC),
        distanceKm: round1_(distanceKm),
        temperatureA: round1_(tA),
        temperatureB: round1_(tB),
        precipitationA: round2_(precipA),
        precipitationB: round2_(precipB),
        hasPrecipitationA: hasPrecipitationA,
        hasPrecipitationB: hasPrecipitationB,
        precipitationThreshold: GRID_POINT_MARKER_CFG.precipitationThreshold,
        pointA: {
          lat: roundCoord_(p.lat),
          lon: roundCoord_(p.lon)
        },
        pointB: {
          lat: roundCoord_(q.lat),
          lon: roundCoord_(q.lon)
        },
        direction: d.name
      });
    });
  });

  out.sort(function(a, b) {
    if (b.gradientCPer100Km !== a.gradientCPer100Km) {
      return b.gradientCPer100Km - a.gradientCPer100Km;
    }

    return b.deltaC - a.deltaC;
  });

  return out.slice(0, POSSIBLE_FRONT_CFG.maxMarkers);
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

/**
 * Mallonga Esperanto-stila resumo lau modelo de Shipping Forecast.
 *
 * Maksimume du malaltoj kaj du altoj estas elektataj.
 * La elekto estas heuristika: forto de la centro kaj distanco al Germana Golfo.
 */
function makeGermanBightWeatherSummary_(systems) {
  systems = systems || {};

  const lows = selectGermanBightRelevantSystems_(
    systems.lows || [],
    'M',
    GERMAN_BIGHT_SUMMARY_CFG.maxLows
  );

  const highs = selectGermanBightRelevantSystems_(
    systems.highs || [],
    'A',
    GERMAN_BIGHT_SUMMARY_CFG.maxHighs
  );

  const parts = [];

  lows.forEach(function(system) {
    parts.push(formatGermanBightSummarySystem_(system, 'M'));
  });

  highs.forEach(function(system) {
    parts.push(formatGermanBightSummarySystem_(system, 'A'));
  });

  return {
    title: GERMAN_BIGHT_SUMMARY_CFG.title,
    text: parts.length
      ? parts.join(' ')
      : 'Neniuj klaraj premcentroj determineblas por Germana Golfo',
    focus: {
      name: GERMAN_BIGHT_SUMMARY_CFG.focus.name,
      lat: GERMAN_BIGHT_SUMMARY_CFG.focus.lat,
      lon: GERMAN_BIGHT_SUMMARY_CFG.focus.lon
    },
    lows: lows,
    highs: highs
  };
}


/**
 * Elektas la plej veterdeterminajn sistemojn por Germana Golfo.
 *
 * Poentaro:
 * - ju pli proksime al Germana Golfo, des pli grava;
 * - ju pli forta la premdiferenco rilate al 1013.25 hPa, des pli grava;
 * - loka prominenceco iomete pligravigas la sistemon.
 */
function selectGermanBightRelevantSystems_(candidates, type, maxCount) {
  if (!Array.isArray(candidates)) return [];

  const focus = GERMAN_BIGHT_SUMMARY_CFG.focus;
  const referencePressure = GERMAN_BIGHT_SUMMARY_CFG.pressureReferenceHpa;
  const distanceScale = GERMAN_BIGHT_SUMMARY_CFG.influenceDistanceScaleKm;

  const enriched = candidates
    .map(function(c) {
      if (!c) return null;

      const lat = Number(c.lat);
      const lon = Number(c.lon);
      const pressure = Number(c.pressure);

      if (
        !Number.isFinite(lat) ||
        !Number.isFinite(lon) ||
        !Number.isFinite(pressure)
      ) {
        return null;
      }

      const distanceKm = haversineKm_(focus.lat, focus.lon, lat, lon);

      if (!Number.isFinite(distanceKm)) return null;

      const pressureIntensity =
        type === 'M'
          ? Math.max(0, referencePressure - pressure)
          : Math.max(0, pressure - referencePressure);

      const prominence =
        c.prominence === null || c.prominence === undefined
          ? 0
          : Number(c.prominence);

      const safeProminence = Number.isFinite(prominence) ? prominence : 0;

      const distanceWeight =
        1 / Math.pow(1 + distanceKm / distanceScale, 2);

      const edgeWeight = c.edge ? 0.9 : 1.0;

      const influenceScore =
        (pressureIntensity + safeProminence * 0.8 + 2) *
        distanceWeight *
        edgeWeight;

      const locationText = describeWeatherSystemLocation_(lat, lon);

      const out = Object.assign({}, c);
      out.distanceToGermanBightKm = round1_(distanceKm);
      out.influenceScore = round2_(influenceScore);
      out.locationText = locationText;

      return out;
    })
    .filter(function(c) {
      return !!c;
    });

  enriched.sort(function(a, b) {
    if (b.influenceScore !== a.influenceScore) {
      return b.influenceScore - a.influenceScore;
    }

    // Sekundara ordigo: pli proksima al Germana Golfo.
    return a.distanceToGermanBightKm - b.distanceToGermanBightKm;
  });

  return enriched.slice(0, maxCount);
}


/**
 * Formatado lau simpligita Shipping-Forecast-stilo:
 * "Malalto Ferooj 985 Alto 400 kilometrojn okcidente de Irlando 1026"
 */
function formatGermanBightSummarySystem_(system, type) {
  const word = type === 'M' ? 'Malalto' : 'Alto';
  const pressure = Math.round(Number(system.pressure));

  return word + ' ' + system.locationText + ' ' + pressure;
}


/**
 * Donas mallongan lokpriskribon en Esperanto.
 *
 * Se sistemo estas proksima al konata regiono, uzighas ties nomo.
 * Alie uzighas distanco kaj direkto de la plej proksima referencloko.
 */
function describeWeatherSystemLocation_(lat, lon) {
  const references = getWeatherLocationReferences_();

  let nearest = null;
  let nearestDistance = Infinity;

  references.forEach(function(ref) {
    const d = haversineKm_(ref.lat, ref.lon, lat, lon);

    if (Number.isFinite(d) && d < nearestDistance) {
      nearestDistance = d;
      nearest = ref;
    }
  });

  if (!nearest) {
    return roundCoord_(lat) + 'N ' + roundCoord_(lon) + 'E';
  }

  if (nearestDistance <= nearest.directKm) {
    return nearest.name;
  }

  const roundedDistance = roundToNearest_(nearestDistance, 50);
  const bearing = initialBearingDeg_(nearest.lat, nearest.lon, lat, lon);
  const direction = esperantoDirectionFromBearing_(bearing);

  return roundedDistance + ' kilometrojn ' + direction + ' de ' + nearest.name;
}


/**
 * Referenclokoj por mallongaj marveteraj lokpriskriboj.
 */
function getWeatherLocationReferences_() {
  return [
    {
      name: 'Germana Golfo',
      lat: 54.2,
      lon: 7.5,
      directKm: 180
    },
    {
      name: 'Norda Maro',
      lat: 56.0,
      lon: 3.0,
      directKm: 380
    },
    {
      name: 'Ferooj',
      lat: 62.0,
      lon: -7.0,
      directKm: 250
    },
    {
      name: 'Islando',
      lat: 65.0,
      lon: -19.0,
      directKm: 450
    },
    {
      name: 'Irlando',
      lat: 53.4,
      lon: -8.0,
      directKm: 350
    },
    {
      name: 'Skotlando',
      lat: 56.8,
      lon: -4.0,
      directKm: 350
    },
    {
      name: 'Anglujo',
      lat: 52.8,
      lon: -1.5,
      directKm: 300
    },
    {
      name: 'Manika Markolo',
      lat: 50.3,
      lon: -1.0,
      directKm: 220
    },
    {
      name: 'Biskaja Golfo',
      lat: 45.5,
      lon: -6.0,
      directKm: 350
    },
    {
      name: 'Norvegujo',
      lat: 61.0,
      lon: 8.0,
      directKm: 500
    },
    {
      name: 'Danujo',
      lat: 56.0,
      lon: 10.0,
      directKm: 250
    },
    {
      name: 'Suda Svedujo',
      lat: 57.0,
      lon: 14.0,
      directKm: 260
    },
    {
      name: 'Balta Maro',
      lat: 57.0,
      lon: 18.0,
      directKm: 350
    },
    {
      name: 'Germanujo',
      lat: 51.0,
      lon: 10.0,
      directKm: 350
    },
    {
      name: 'Francujo',
      lat: 47.0,
      lon: 2.0,
      directKm: 450
    },
    {
      name: 'Alpoj',
      lat: 46.5,
      lon: 10.0,
      directKm: 300
    },
    {
      name: 'Pollando',
      lat: 52.0,
      lon: 19.0,
      directKm: 400
    },
    {
      name: 'Hispanujo',
      lat: 40.0,
      lon: -3.0,
      directKm: 500
    }
  ];
}


/**
 * Komenca direkto de punkto A al punkto B en gradoj.
 */
function initialBearingDeg_(lat1, lon1, lat2, lon2) {
  const toRad = function(d) {
    return d * Math.PI / 180;
  };

  const toDeg = function(r) {
    return r * 180 / Math.PI;
  };

  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const deltaLambda = toRad(lon2 - lon1);

  const y = Math.sin(deltaLambda) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLambda);

  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}


/**
 * Esperanto-direkto kiel adverbo:
 * norde de, nordoriente de, okcidente de ktp.
 */
function esperantoDirectionFromBearing_(bearing) {
  const b = ((Number(bearing) % 360) + 360) % 360;

  const dirs = [
    'norde',
    'nordoriente',
    'oriente',
    'sudoriente',
    'sude',
    'sudokcidente',
    'okcidente',
    'nordokcidente'
  ];

  const index = Math.round(b / 45) % 8;

  return dirs[index];
}


function roundToNearest_(value, step) {
  const n = Number(value);
  const s = Number(step);

  if (!Number.isFinite(n) || !Number.isFinite(s) || s <= 0) {
    return n;
  }

  return Math.round(n / s) * s;
}

/**
 * Unueca kriterio por precipitajho.
 *
 * Uzata kaj por bluaj precipitajhaj kradpunktomarkiloj
 * kaj por la precipitajha parto de la frontkruca kriterio.
 *
 * Nuntempe:
 * - precipitation >= 0.1 mm
 */
function hasSignificantPrecipitation_(value) {
  const n = Number(value);

  return Number.isFinite(n) &&
    n >= GRID_POINT_MARKER_CFG.precipitationThreshold;
}


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


function round2_(x) {
  return Math.round(Number(x) * 100) / 100;
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
