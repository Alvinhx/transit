/**
 * parsers/index.js — Parser registry
 *
 * Maps OBA agency IDs to their GTFS parsers.
 * Each parser knows how to translate GTFS data into OBA format.
 */

const kcm = require('./kcm-parser');
const st = require('./st-parser');

const PARSERS = {
  '1':  kcm,   // KC Metro
  '23': kcm,   // Seattle Streetcar (same GTFS feed as KC Metro)
  '40': st,    // Sound Transit
};

function getParser(agencyId) {
  return PARSERS[agencyId] || null;
}

function getAllParsers() {
  const seen = new Set();
  const unique = [];
  for (const [agencyId, parser] of Object.entries(PARSERS)) {
    if (!seen.has(parser.GTFS_URL)) {
      seen.add(parser.GTFS_URL);
      unique.push({ agencyId, parser });
    }
  }
  return unique;
}

module.exports = { getParser, getAllParsers, PARSERS };
