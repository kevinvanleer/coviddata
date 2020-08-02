var express = require('express');
var fetch = require('node-fetch');
var Papa = require('papaparse');
var jStat = require('jstat');
var _ = require('lodash');
var turf = require('@turf/turf');
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
  const text = await response.text();
  myCache.set('nyTimesCovidByCounty', text);
  return text;
};

const fetchUsCountiesGeoJson = async () => {
  const cached = myCache.get('usCountiesGeoJsonHighRes');
  if (cached) {
    return cached;
  }

  const response = await fetch(usCountiesHighResUrl);
  const json = await response.json();

  json.features.forEach((feature) => {
    feature.id = parseInt(feature.properties.GEO_ID.split('US')[1]);
  });
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

const fixNewYorkCity = (cases) => {
  cases.data.forEach((record) => {
    if (
      record.county === 'New York City' &&
      record.state === 'New York' &&
      record.fips === ''
    ) {
      record.fips = 36061;
    }
  });
  return cases;
};

const getUsCovidAnalysis = async (cases, lowResPromise) => {
  const cached = myCache.get('usCovidAnalysis');
  if (cached) return cached;

  cases = fixNewYorkCity(cases);

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
  cases.data.forEach((status) => {
    const countyId = parseInt(status.fips);
    if (countyId in casesByCounty) {
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
  /* const casesByDate = {};
  cases.data.forEach((status) => {
    if (status.date in casesByDate) {
      casesByDate[status.date].push(status);
    } else {
      casesByDate[status.date] = [status];
    }
  }); */

  /*
  counties.features.forEach((county) => {
    county.properties.cases = parseInt(
      _.get(
        _.last(casesByCounty[county.properties.GEO_ID.split('US')[1]]),
        'cases',
        0
      )
    );
    county.properties.deaths = parseInt(
      _.get(
        _.last(casesByCounty[county.properties.GEO_ID.split('US')[1]]),
        'deaths',
        0
      )
    );
  });
  */

  // return { geoCasesByCounty: counties, casesByCounty, casesByDate };
  const analysis = { casesByCounty };
  myCache.set('usCovidAnalysis', analysis);
  return analysis;
};

const fetchCasesByCounty = async () => {
  const lowResPromise = fetchUsCountiesLowRes();
  const cases = await fetchUsCovidByCounty();

  let usCovidByCounty = myCache.get('usCasesByCounty');
  if (!usCovidByCounty) {
    usCovidByCounty = Papa.parse(cases, { header: true });
    console.log('parsed csv data');
    myCache.set('usCasesByCounty', usCovidByCounty);
  }

  const usCovidAnalysis = getUsCovidAnalysis(usCovidByCounty, lowResPromise);
  return usCovidAnalysis;
};

/* GET users listing. */
router.get('/', function (req, res, next) {
  res.send('version 0.0.1');
});

router.get('/us-county-stats', async (req, res, next) => {
  const data = await fetchCasesByCounty();

  const casesArray = [];
  const deathsArray = [];
  let totalCases = 0;
  let totalDeaths = 0;
  data.casesByCounty.forEach((county) => {
    casesArray.push = parseInt(
      _.get(
        _.last(data.casesByCounty[county.properties.GEO_ID.split('US')[1]]),
        'cases',
        0
      )
    );
    deathsArray.push = parseInt(
      _.get(
        _.last(data.casesByCounty[county.properties.GEO_ID.split('US')[1]]),
        'deaths',
        0
      )
    );
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
