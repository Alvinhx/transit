/**
 * st-parser.js — Sound Transit GTFS → OBA format parser
 *
 * Agency: Sound Transit (agency ID: 40)
 * OBA prefix: '40_'
 * GTFS feed: https://gtfs.sound.obaweb.org/prod/40_gtfs.zip
 */

const { loadGTFS, matchShapesToDirections } = require('./gtfs-parser');

const AGENCY_ID = '40';
const OBA_PREFIX = '40_';
const GTFS_URL = 'https://gtfs.sound.obaweb.org/prod/40_gtfs.zip';

function getShapesForRoute(gtfsData, obaRouteId, obaDirections) {
  const gtfsRouteId = obaRouteId.replace(OBA_PREFIX, '');
  return matchShapesToDirections(gtfsData, gtfsRouteId, OBA_PREFIX, obaDirections);
}

module.exports = { AGENCY_ID, OBA_PREFIX, GTFS_URL, getShapesForRoute, loadGTFS };
