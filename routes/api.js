const express = require('express');
const fetch = require('node-fetch');
const csv = require('csvtojson');
const jStat = require('jstat');
const _ = require('lodash');
const moment = require('moment');
const turf = require('@turf/turf');
const fs = require('fs');
const path = require('path');
const NodeCache = require('node-cache');
const { ReReadable } = require('rereadable-stream');
const zlib = require('node:zlib');

const myCache = new NodeCache({ stdTTL: 3600, useClones: false });

var router = express.Router();

const getUsCountiesUrl = (resolution) =>
  `https://eric.clst.org/assets/wiki/uploads/Stuff/gz_2010_us_050_00_${resolution}.json`;

/*
const usCountiesLowResUrl =
  'https://eric.clst.org/assets/wiki/uploads/Stuff/gz_2010_us_050_00_20m.json';

const usCountiesMedResUrl =
  'https://eric.clst.org/assets/wiki/uploads/Stuff/gz_2010_us_050_00_5m.json';

const usCountiesHighResUrl =
  'https://eric.clst.org/assets/wiki/uploads/Stuff/gz_2010_us_050_00_500k.json';
  */

const whoCovidByCountryUrl =
  'https://covid19.who.int/WHO-COVID-19-global-data.csv';

const covidByCountyUrl =
  'https://raw.githubusercontent.com/nytimes/covid-19-data/master/us-counties.csv';

const covidByStateUrl =
  'https://raw.githubusercontent.com/nytimes/covid-19-data/master/us-states.csv';

const usCovidTotalsUrl =
  'https://raw.githubusercontent.com/nytimes/covid-19-data/master/us.csv';

const fetchUsCovidByCounty = async () => {
  const cached = myCache.get('nyTimesCovidByCounty');
  if (cached) return cached;

  const response = await fetch(covidByCountyUrl);
  const rewindable = response.body.pipe(new ReReadable());
  myCache.set('nyTimesCovidByCounty', rewindable);
  return rewindable;
};

const fetchUsCovidByState = async () => {
  const cached = myCache.get('nyTimesCovidByState');
  if (cached) return cached;

  const response = await fetch(covidByStateUrl);
  const text = response.body;
  myCache.set('nyTimesCovidByState', text);
  return text;
};

const fetchWhoCovidByCountryCsv = async () => {
  const cached = myCache.get('whoCovidByCountryCsv');
  if (cached) return cached;

  const response = await fetch(whoCovidByCountryUrl);
  const rewindable = response.body.pipe(new ReReadable());
  myCache.set('whoCovidByCountryCsv', rewindable);
  return rewindable;
};

const fetchUsCovidTotals = async () => {
  const cached = myCache.get('nyTimesUsCovidTotals');
  if (cached) return cached;

  const response = await fetch(usCovidTotalsUrl);
  const text = response.body;
  myCache.set('nyTimesUsCovidTotals', text);
  return text;
};

const fetchUsCovidTotalsJson = async () => {
  const cached = myCache.get('usCovidTotalsJson');
  if (cached) return cached;

  const totals = await fetchUsCovidTotals();

  const json = { data: await csv().fromStream(totals) };
  myCache.set('usCovidTotalsJson', json);

  return json;
};

const nycboroughs = [36005, 36047, 36061, 36081, 36085];

const mergeNycBoroughs = (json) => {
  const id = 36999;
  const nyc = {
    type: 'Feature',
    properties: {
      GEO_ID: `0500000US${id}`,
      FEATURE_ID: id,
      STATE: '36',
      COUNTY: '999',
      NAME: 'New York City',
      LSAD: 'City',
      CENSUSAREA: 'N/A',
    },
    geometry: { type: 'MultiPolygon', coordinates: [] },
  };
  const nycFeatures = json.features.filter((feature) =>
    nycboroughs.includes(parseInt(feature.properties.GEO_ID.split('US')[1]))
  );

  nycFeatures.forEach((feature) => {
    if (feature.geometry.type === 'MultiPolygon') {
      nyc.geometry.coordinates.push(...feature.geometry.coordinates);
    } else if (feature.geometry.type === 'Polygon') {
      nyc.geometry.coordinates.push(feature.geometry.coordinates);
    }
  });
  return nyc;
};

const getWorldPopulationData = () => {
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(
      path.join(__dirname, '../public/resources/2019_WorldPopulation.csv'),
      { encoding: 'utf8' }
    );
    resolve(csv().fromStream(stream));
  });
};

const normalizeWorldPopulationData = async () => {
  const popJson = await getWorldPopulationData();
  const response = await fetch(
    'https://pkgstore.datahub.io/core/country-codes/country-codes_json/data/471a2e653140ecdd7243cdcacfd66608/country-codes_json.json'
  );
  const countryCodes = await response.json();
  const normalized = {};
  popJson.forEach((item) => {
    const record = countryCodes.find(
      (record) => record['ISO3166-1-Alpha-3'] === item.code
    );
    if (record) {
      normalized[record['ISO3166-1-Alpha-2']] = {
        ...item,
        population: item.POPESTIMATE2019,
      };
    } else {
      console.debug({ record, item });
    }
  });
  return normalized;
};

const getPopulationData = () => {
  return new Promise((resolve, reject) => {
    fs.readFile(
      path.join(
        __dirname,
        '../public/resources/us-estimated-population-2019.json'
      ),
      (err, data) => {
        if (err) reject(err);
        resolve(JSON.parse(data));
      }
    );
  });
};

const getMoCities = () => {
  return new Promise((resolve, reject) => {
    fs.readFile(
      path.join(
        __dirname,
        '../public/resources/tl_2019_29_place_subset.geojson'
      ),
      (err, data) => {
        if (err) reject(err);
        const cities = JSON.parse(data).features;
        resolve(cities);
      }
    );
  });
};

const fetchUsCountiesGeoJson = async (resolution = '500k') => {
  const cached = myCache.get(`usCountiesGeoJson_${resolution}`);
  if (cached) return cached;

  const response = await fetch(getUsCountiesUrl(resolution));
  const json = await response.json();

  myCache.set(`usCountiesGeoJson_${resolution}`, json, 0);
  return json;
};

const fetchUsCountiesCitiesHybrid = async (resolution = '500k') => {
  const cached = myCache.get(`usCountiesCitiesHybrid_{resolution}`);
  if (cached) return cached;

  const moCities = getMoCities();
  const json = await fetchUsCountiesGeoJson(resolution);

  json.features.forEach((feature) => {
    _.set(
      feature,
      'properties.FEATURE_ID',
      parseInt(feature.properties.GEO_ID.split('US')[1])
    );
  });

  json.features.push(mergeNycBoroughs(json));
  json.features.push(...(await moCities));
  myCache.set(`usCountiesCitiesHybrid_{resolution}`, json, 0);
  return json;
};

const fetchUsCountyCentroids = async () => {
  const cached = myCache.get('usCountycached');
  if (cached) return cached;

  const lowRes = await fetchUsCountiesCitiesHybrid('20m');
  const centroids = { type: 'FeatureCollection', features: [] };
  lowRes.features.forEach((feature) => {
    if (feature.geometry.type === 'Polygon') {
      try {
        centroids.features.push({
          ...feature,
          geometry: turf.centerOfMass(
            turf.polygon(feature.geometry.coordinates)
          ).geometry,
          id: feature.properties.FEATURE_ID,
        });
      } catch (err) {
        console.log(err);
        console.log(feature);
      }
    } else if (feature.geometry.type === 'MultiPolygon') {
      try {
        centroids.features.push({
          ...feature,
          geometry: turf.centerOfMass(
            turf.multiPolygon(feature.geometry.coordinates)
          ).geometry,
          id: feature.properties.FEATURE_ID,
        });
      } catch (err) {
        console.log(err);
        console.log(feature);
      }
    }
  });
  myCache.set('usCountyCentroids', centroids, 0);
  return centroids;
};

const fixJoplinMo = (record) => {
  if (
    record.county === 'Joplin' &&
    record.state === 'Missouri' &&
    record.fips === ''
  ) {
    record.fips = 2937592;
  }
  return record;
};

const fixKansasCity = (record) => {
  if (
    record.county === 'Kansas City' &&
    record.state === 'Missouri' &&
    record.fips === ''
  ) {
    record.fips = 2938000;
  }
  return record;
};

const fixNewYorkCity = (record) => {
  if (
    record.county === 'New York City' &&
    record.state === 'New York' &&
    record.fips === ''
  ) {
    record.fips = 36999;
  }
  return record;
};

const fixRhodeIsland = (record) => {
  if (record.state === 'Rhode Island' && record.fips === '') {
    record.fips = 44000;
  }
  return record;
};

const fixCountyRecord = (record) => {
  record = fixNewYorkCity(record);
  record = fixRhodeIsland(record);
  record = fixJoplinMo(record);
  record = fixKansasCity(record);
  return record;
};

const applyFixes = (cases) => {
  cases.data.forEach((record) => {
    record = fixCountyRecord(record);
  });
  return cases;
};

/*
const getUsCovidAnalysis = async (cases, lowResPromise) => {
  const cached = myCache.get('usCovidAnalysis');
  if (cached) return cached;

  cases = applyFixes(cases);

  const casesByCounty = {};
  const lowRes = await lowResPromise;
  lowRes.features.forEach((county) => {
    casesByCounty[parseInt(county.properties.GEO_ID.split('US')[1])] = [
      {
        date: '2020-01-01',
        cases: 0,
        deaths: 0,
        county: county.properties.NAME,
        state: county.properties.STATE,
      },
    ];
  });

  const badRecords = [];
  cases.data
    .filter((status) =>
      moment(status.date, 'YYYY-MM-DD').isAfter(moment().subtract(7, 'days'))
    )
    .forEach((status) => {
      const countyId = parseInt(status.fips);

      if (isNaN(countyId)) {
        badRecords.push(status);
      } else if (countyId in casesByCounty) {
        casesByCounty[countyId].push({
          date: status.date,
          cases: status.cases,
          deaths: status.deaths,
          county: status.county,
          state: status.state,
        });
      } else {
        casesByCounty[countyId] = [
          {
            date: status.date,
            cases: status.cases,
            deaths: status.deaths,
            county: status.county,
            state: status.state,
          },
        ];
      }
    });

  const nonReportingCounties = Object.entries(casesByCounty).filter(
    ([id, list]) => list.length === 1
  );
  console.log(`found ${badRecords.length} bad records`);
  console.log(`found ${nonReportingCounties.length} non-reporting counties`);
  const analysis = { casesByCounty };
  myCache.set('usCovidAnalysis', analysis);
  return analysis;
};
*/

let fetchWhoCovidPromise = Promise.resolve();
const fetchWhoCovidByCountryJson = async () => {
  fetchWhoCovidPromise = fetchWhoCovidPromise.then(async () => {
    try {
      const cached = myCache.get('whoCovidByCountryJson');
      if (cached) return cached;

      const who = await fetchWhoCovidByCountryCsv();

      const json = { data: await csv().fromStream(who.rewind()) };
      myCache.set('whoCovidByCountryJson', json);
      return json;
    } catch (err) {
      console.error(err);
      return null;
    }
  });
  return fetchWhoCovidPromise;
};

const fetchWhoCovid = async () => {
  return await fetchWhoCovidByCountryJson();
};

let fetchCovidByCountyPromise = Promise.resolve();
const fetchUsCovidByCountyJson = async () => {
  fetchCovidByCountyPromise = fetchCovidByCountyPromise.then(async () => {
    try {
      const cached = myCache.get('usCasesByCounty');
      if (cached) return cached;

      const cases = await fetchUsCovidByCounty();

      const json = { data: await csv().fromStream(cases) };
      myCache.set('usCasesByCounty', json);
      return json;
    } catch (err) {
      console.error(err);
      return null;
    }
  });
  return fetchCovidByCountyPromise;
};

const fetchCasesByCounty = async () => {
  const usCovidByCounty = await fetchUsCovidByCountyJson();

  return applyFixes(usCovidByCounty);
};

const getGlobalCovidTotals = async () => {
  const cached = myCache.get('GlobalCovidTotals');
  if (cached) return cached;

  const { data } = await fetchWhoCovid();

  const totals = {};

  data.forEach((record) => {
    if (record.Date_reported in totals) {
      totals[record.Date_reported].cases += parseInt(record.Cumulative_cases);
      totals[record.Date_reported].deaths += parseInt(record.Cumulative_deaths);
    } else {
      _.set(totals, [record.Date_reported], {
        cases: parseInt(record.Cumulative_cases),
        deaths: parseInt(record.Cumulative_deaths),
        date: record.Date_reported,
      });
    }
  });
  const totalsArray = Object.values(totals).sort((a, b) =>
    a.date.localeCompare(b.date)
  );
  myCache.set('GlobalCovidTotals', totalsArray);
  return totalsArray;
};

router.get('/', function (req, res, next) {
  res.send('version 0.0.1');
});

let fetchCovidByStatePromise = Promise.resolve();
const fetchUsCovidByStateJson = async () => {
  fetchCovidByStatePromise = fetchCovidByStatePromise.then(async () => {
    try {
      const cached = myCache.get('usCasesByState');
      if (cached) return cached;

      const cases = await fetchUsCovidByState();

      const json = { data: await csv().fromStream(cases) };
      myCache.set('usCasesByState', json);
      return json;
    } catch (err) {
      console.error(err);
      return null;
    }
  });
  return fetchCovidByStatePromise;
};

const fetchCasesByState = async () => {
  return await fetchUsCovidByStateJson();
};

router.get('/us-county-stats', async (req, res, next) => {
  const { data: casesByCounty } = await fetchCasesByCounty();

  const casesArray = [];
  const deathsArray = [];
  let totalCases = 0;
  let totalDeaths = 0;
  Object.values(casesByCounty).forEach((county) => {
    casesArray.push(parseInt(_.get(_.last(county), 'cases', 0)));
    deathsArray.push(parseInt(_.get(_.last(county), 'deaths', 0)));
    totalCases += _.last(casesArray);
    totalDeaths += _.last(deathsArray);
  });

  const popData = await getPopulationData();
  const casesMax = jStat.max(casesArray);
  const casesMean = jStat.mean(casesArray);
  const casesMode = jStat.mode(casesArray);
  const casesPercentiles = [
    jStat.percentile(casesArray, 0.1),
    jStat.percentile(casesArray, 0.2),
    jStat.percentile(casesArray, 0.3),
    jStat.percentile(casesArray, 0.4),
    jStat.percentile(casesArray, 0.5),
    jStat.percentile(casesArray, 0.6),
    jStat.percentile(casesArray, 0.7),
    jStat.percentile(casesArray, 0.8),
    jStat.percentile(casesArray, 0.9),
  ];
  const deathsMax = jStat.max(deathsArray);
  const deathsMean = jStat.mean(deathsArray);
  const deathsMode = jStat.mode(deathsArray);

  res.send({
    population: popData,
    cases: {
      max: casesMax,
      mean: casesMean,
      mode: casesMode,
      percetiles: casesPercentiles,
      total: totalCases,
    },
    deaths: {
      max: deathsMax,
      mean: deathsMean,
      mode: deathsMode,
      total: totalDeaths,
    },
  });
});

router.get('/us-counties', async (req, res, next) => {
  const resolution = req.query.resolution || '500k';
  res.send(await fetchUsCountiesCitiesHybrid(resolution));
});

router.get('/us-covid-by-state', async (req, res, next) => {
  const { data: cases } = await fetchCasesByState();

  const pageSize = parseInt(req.query.pageSize) || cases.length;
  let startIndex = parseInt(req.query.startIndex) || 0;
  let lastIndex = startIndex + pageSize;

  if (req.query.reverse === 'true') {
    lastIndex = cases.length - startIndex;
    startIndex = lastIndex - pageSize;
    if (startIndex < 0) startIndex = 0;
  }

  res.send({
    data: cases.slice(startIndex, lastIndex),
    meta: { startIndex, lastIndex, totalCount: cases.length },
  });
});

router.get('/us-cases-by-county', async (req, res, next) => {
  const stream = await fetchUsCovidByCounty();
  const gzip = zlib.createGzip({level: zlib.constants.Z_BEST_SPEED});
  stream
    .rewind()
    .pipe(csv())
    .subscribe((json) => fixCountyRecord(json))
    .pipe(gzip)
    .pipe(res);
});

router.get('/global-covid-totals', async (req, res, next) => {
  res.send(await getGlobalCovidTotals());
});

router.get('/global-covid-by-country', async (req, res, next) => {
  const stream = await fetchWhoCovidByCountryCsv();
  const gzip = zlib.createGzip({level: zlib.constants.Z_BEST_SPEED});
  stream
    .rewind()
    .pipe(csv())
    .pipe(gzip)
    .pipe(res);
});

router.get('/world-population', async (req, res) => {
  res.send(await normalizeWorldPopulationData());
});

router.get('/us-totals', async (req, res, next) => {
  res.send(await fetchUsCovidTotalsJson());
});

router.get('/us-county-centroids', async (req, res, next) => {
  res.send(await fetchUsCountyCentroids());
});

router.get('/alive', async (req, res, next) => {
  res.send(`${moment().toISOString()}`);
});

module.exports = router;
