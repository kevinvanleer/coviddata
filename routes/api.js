const express = require('express');
const fetch = require('node-fetch');
const csv = require('csvtojson');
const jStat = require('jstat');
const _ = require('lodash');
const turf = require('@turf/turf');
const fs = require('fs');
const path = require('path');
const NodeCache = require('node-cache');
const myCache = new NodeCache({ stdTTL: 43200, useClones: false });

var router = express.Router();

const usCountiesLowResUrl =
  'https://eric.clst.org/assets/wiki/uploads/Stuff/gz_2010_us_050_00_20m.json';

const usCountiesHighResUrl =
  'https://eric.clst.org/assets/wiki/uploads/Stuff/gz_2010_us_050_00_500k.json';

const covidByCountyUrl =
  'https://raw.githubusercontent.com/nytimes/covid-19-data/master/us-counties.csv';

const fetchUsCovidByCounty = async () => {
  const cached = myCache.get('nyTimesCovidByCounty');
  if (cached) {
    return cached;
  }
  const response = await fetch(covidByCountyUrl);
  const text = response.body;
  myCache.set('nyTimesCovidByCounty', text);
  return text;
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

const fetchUsCountiesGeoJson = async () => {
  const cached = myCache.get('usCountiesGeoJsonHighRes');
  if (cached) {
    return cached;
  }

  const moCities = getMoCities();
  const response = await fetch(usCountiesHighResUrl);
  const json = await response.json();

  json.features.forEach((feature) => {
    _.set(
      feature,
      'properties.FEATURE_ID',
      parseInt(feature.properties.GEO_ID.split('US')[1])
    );
  });

  json.features.push(mergeNycBoroughs(json));
  json.features.push(...(await moCities));
  myCache.set('usCountiesGeoJsonHighRes', json, 0);
  return json;
};

const fetchUsCountiesLowRes = async () => {
  const cached = myCache.get('usCountiesGeoJsonLowRes');
  if (cached) return cached;

  const response = await fetch(usCountiesLowResUrl);
  const json = await response.json();
  myCache.set('usCountiesGeoJsonLowRes', json, 0);
  return json;
};

const fetchUsCountyCentroids = async () => {
  let centroids = myCache.get('usCountyCentroids');
  if (centroids) return centroids;

  const lowRes = await fetchUsCountiesLowRes();
  centroids = { type: 'FeatureCollection', features: [] };
  lowRes.features.forEach((feature) => {
    if (feature.geometry.type === 'Polygon') {
      try {
        centroids.features.push({
          ...feature,
          geometry: turf.centerOfMass(
            turf.polygon(feature.geometry.coordinates)
          ).geometry,
          id: feature.properties.GEO_ID.split('US')[1],
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

const applyFixes = (cases) => {
  cases.data.forEach((record) => {
    record = fixNewYorkCity(record);
    record = fixRhodeIsland(record);
    record = fixJoplinMo(record);
    record = fixKansasCity(record);
  });
  return cases;
};

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
  cases.data.forEach((status) => {
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

const fetchUsCovidByCountyJson = async () => {
  const cases = await fetchUsCovidByCounty();

  let usCovidByCounty = myCache.get('usCasesByCounty');
  if (usCovidByCounty === undefined) {
    usCovidByCounty = { data: await csv().fromStream(cases) };
    myCache.set('usCasesByCounty', usCovidByCounty);
  }
  return usCovidByCounty;
};

const fetchCasesByCounty = async () => {
  const usCovidByCounty = await fetchUsCovidByCountyJson();
  const lowResPromise = fetchUsCountiesLowRes();

  const usCovidAnalysis = getUsCovidAnalysis(usCovidByCounty, lowResPromise);
  return usCovidAnalysis;
};

/* GET users listing. */
router.get('/', function (req, res, next) {
  res.send('version 0.0.1');
});

router.get('/us-county-stats', async (req, res, next) => {
  const { casesByCounty } = await fetchCasesByCounty();

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
  res.send(await fetchUsCountiesGeoJson());
});

router.get('/us-cases-by-county', async (req, res, next) => {
  const data = await fetchCasesByCounty();
  res.send(data.casesByCounty);
});
router.get('/us-county-centroids', async (req, res, next) => {
  res.send(await fetchUsCountyCentroids());
});

module.exports = router;
