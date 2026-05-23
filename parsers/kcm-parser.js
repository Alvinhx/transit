/**
 * kcm-parser.js — KC Metro GTFS → OBA format parser
 *
 * Agency: King County Metro (agency ID: 1)
 * OBA prefix: '1_'
 * GTFS feed: https://metro.kingcounty.gov/GTFS/google_transit.zip
 */

const { loadGTFS, matchShapesToDirections } = require('./gtfs-parser');

const AGENCY_ID = '1';
const OBA_PREFIX = '1_';
const GTFS_URL = 'https://metro.kingcounty.gov/GTFS/google_transit.zip';

function getShapesForRoute(gtfsData, obaRouteId, obaDirections) {
  const gtfsRouteId = obaRouteId.replace(OBA_PREFIX, '');
  return matchShapesToDirections(gtfsData, gtfsRouteId, OBA_PREFIX, obaDirections);
}

module.exports = { AGENCY_ID, OBA_PREFIX, GTFS_URL, getShapesForRoute, loadGTFS };
