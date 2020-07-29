var express = require('express');
var fetch = require('node-fetch');
var Papa = require('papaparse');
var jStat = require('jstat');
var _ = require('lodash');
var turf = require('@turf/turf');
var memoize = require('memoizee');
const NodeCache = require('node-cache');
const myCache = new NodeCache({ stdTTL: 86400, useClones: false });

var router = express.Router();

const usCountiesLowResUrl =
  'https://eric.clst.org/assets/wiki/uploads/Stuff/gz_2010_us_050_00_20m.json';

const usCountiesHighResUrl =
  'https://eric.clst.org/assets/wiki/uploads/Stuff/gz_2010_us_050_00_500k.json';

const covidByCountyUrl =
  'https://raw.githubusercontent.com/nytimes/covid-19-data/master/us-counties.csv';

const fetchUsCovidByCounty = memoize(
  async () => {
    const response = await fetch(covidByCountyUrl);
    return await response.text();
  },
  { async: true }
);

const fetchUsCountiesGeoJson = memoize(
  async () => {
    const cached = myCache.get('usCountiesGeoJsonHighRes');
    if (cached) {
      return cached;
    }

    const response = await fetch(usCountiesHighResUrl);
    const json = await response.json();

    json.features.forEach((feature) => {
      feature.id = feature.properties.GEO_ID.split('US')[1];
    });
    myCache.set('usCountiesGeoJsonHighRes', json, 0);
    return json;
  },
  { async: true }
);

const fetchUsCountiesLowRes = memoize(
  async () => {
    const cached = myCache.get('usCountiesGeoJsonLowRes');
    if (cached) return cached;

    const response = await fetch(usCountiesLowResUrl);
    const json = await response.json();
    myCache.set('usCountiesGeoJsonLowRes', json, 0);
    return json;
  },
  { async: true }
);

const fetchUsCountyCentroids = memoize(
  async () => {
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
  },
  { async: true }
);

const getUsCovidAnalysis = memoize((counties, cases) => {
  const casesByCounty = {};
  counties.features.forEach(
    (county) => (casesByCounty[county.properties.GEO_ID.split('US')[1]] = [])
  );
  cases.data.forEach((status) => {
    status.fips in casesByCounty &&
      casesByCounty[status.fips].push({
        date: status.date,
        cases: status.cases,
        deaths: status.deaths,
      });
  });
  /* const casesByDate = {};
  cases.data.forEach((status) => {
    if (status.date in casesByDate) {
      casesByDate[status.date].push(status);
    } else {
      casesByDate[status.date] = [status];
    }
  }); */

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

  // return { geoCasesByCounty: counties, casesByCounty, casesByDate };
  return { geoCasesByCounty: counties, casesByCounty };
});

const fetchCasesByCounty = memoize(
  async () => {
    console.log('fetching data');
    const responses = await Promise.all([
      fetchUsCountiesGeoJson(),
      fetchUsCovidByCounty(),
      fetchUsCountyCentroids(),
    ]);

    const usCountiesGeoJsonHighRes = responses[0];
    const usCovidByCounty = Papa.parse(responses[1], { header: true });

    console.log('parsed responses');
    myCache.set('usCasesByCounty', usCovidByCounty);
    console.log('parsed csv data');
    let usCovidAnalysis = myCache.get('usCovidAnalysis');
    if (!usCovidAnalysis) {
      usCovidAnalysis = getUsCovidAnalysis(
        usCountiesGeoJsonHighRes,
        usCovidByCounty
      );
      myCache.set('usCovidAnalysis', usCovidAnalysis);
    }
    return { ...usCovidAnalysis, centroids: responses[2] };
  },
  { async: true }
);

/* GET users listing. */
router.get('/', function (req, res, next) {
  res.send('version 0.0.1');
});

router.get('/us-county-stats', async (req, res, next) => {
  const data = await fetchCasesByCounty();
  const counties = data.geoCasesByCounty;
  const casesArray = counties.features.map((county) => county.properties.cases);
  const deathsArray = counties.features.map(
    (county) => county.properties.deaths
  );

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
    },
    deaths: { max: deathsMax, mean: deathsMean, mode: deathsMode },
  });
});

router.get('/us-geo-cases-by-county', async (req, res, next) => {
  const data = await fetchCasesByCounty();
  res.send(data.geoCasesByCounty);
});

router.get('/us-cases-by-county', async (req, res, next) => {
  const data = await fetchCasesByCounty();
  res.send(data.casesByCounty);
});
router.get('/us-county-centroids', async (req, res, next) => {
  const data = await fetchCasesByCounty();
  res.send(data.centroids);
});

module.exports = router;
