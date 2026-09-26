import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  DEFAULT_FALSE_BREAKOUT_LOOKBACK,
  observeSameCandleFalseBreakouts,
} from '../src/false-breakout-observer.js';
import { parseDayPayload } from '../src/data.js';

const REPOSITORY_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const DEFAULT_RESEARCH_ROOT = resolve(REPOSITORY_ROOT, 'data', 'research');
export const DEFAULT_REPORT_DIRECTORY = resolve(DEFAULT_RESEARCH_ROOT, 'false_breakout_v0_1');
export const REPORT_FILENAMES = Object.freeze({
  csv: 'observations.csv',
  summary: 'summary.md',
  shortlist: 'shortlist.md',
});

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const EXPORTED_DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:00$/;
const SHORTLIST_LIMIT = 6;

export class InspectionError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'InspectionError';
  }
}

function validateDate(value) {
  if (!DATE_PATTERN.test(value)) throw new InspectionError(`Invalid date ${JSON.stringify(value)}; expected YYYY-MM-DD.`);
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new InspectionError(`Invalid calendar date ${JSON.stringify(value)}.`);
  }
  return value;
}

function validateContract(value) {
  if (typeof value !== 'string' || !/^[A-Z0-9]+$/.test(value)) {
    throw new InspectionError('Contract must contain only uppercase ASCII letters and digits.');
  }
  return value;
}

function validateObjectPath(value, contract, date) {
  const expected = `${contract}/${date}.json`;
  if (
    value !== expected
    || value.startsWith('/')
    || value.includes('\\')
    || value.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new InspectionError(`Manifest contains an invalid object path for ${contract} on ${date}.`);
  }
  return value;
}

async function readJson(path, label) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new InspectionError(`Cannot load ${label}: ${error.message}`, { cause: error });
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new InspectionError(`Cannot parse ${label} as JSON: ${error.message}`, { cause: error });
  }
}

function validateManifest(manifest) {
  if (
    manifest?.schemaVersion !== 1
    || manifest?.sourceTimeframeMinutes !== 1
    || !Array.isArray(manifest.contracts)
    || manifest.contracts.length === 0
  ) {
    throw new InspectionError('Manifest has an incompatible top-level schema.');
  }

  const contracts = new Map();
  for (const item of manifest.contracts) {
    const symbol = validateContract(item?.symbol);
    if (contracts.has(symbol) || !Array.isArray(item.dates)) {
      throw new InspectionError(`Manifest contains an invalid or duplicate contract ${symbol}.`);
    }
    const dates = new Map();
    for (const entry of item.dates) {
      const date = validateDate(entry?.date);
      if (dates.has(date) || !Number.isInteger(entry.candles) || entry.candles <= 0) {
        throw new InspectionError(`Manifest contains an invalid or duplicate date for ${symbol}: ${date}.`);
      }
      validateObjectPath(entry.file, symbol, date);
      dates.set(date, { ...entry });
    }
    contracts.set(symbol, dates);
  }
  return contracts;
}

function validateRawDayTimestamps(payload, expectedDate, label) {
  if (!Array.isArray(payload?.candles)) return;
  for (let index = 0; index < payload.candles.length; index += 1) {
    const row = payload.candles[index];
    const value = Array.isArray(row) ? row[0] : null;
    if (typeof value !== 'string' || !EXPORTED_DATETIME_PATTERN.test(value) || !value.startsWith(`${expectedDate} `)) {
      throw new InspectionError(`${label}: invalid candle timestamp at row ${index + 1}.`);
    }
    try {
      const normalized = new Date(`${value.replace(' ', 'T')}Z`).toISOString().slice(0, 19).replace('T', ' ');
      if (normalized !== value) throw new Error('normalized timestamp differs');
    } catch (error) {
      throw new InspectionError(`${label}: invalid candle timestamp ${JSON.stringify(value)}.`, { cause: error });
    }
  }
}

function uniqueSortedDates(dates) {
  if (!Array.isArray(dates) || dates.length === 0) {
    throw new InspectionError('At least one date must be selected explicitly.');
  }
  const selected = dates.map(validateDate);
  if (new Set(selected).size !== selected.length) {
    throw new InspectionError('Selected dates must not contain duplicates.');
  }
  return selected.sort();
}

export async function loadSelectedCandleDays({ inputDir, contract, dates }) {
  if (typeof inputDir !== 'string' || !inputDir.trim()) {
    throw new InspectionError('An explicit input directory is required.');
  }
  const selectedContract = validateContract(contract);
  const selectedDates = uniqueSortedDates(dates);
  const resolvedInput = resolve(inputDir);
  const manifestPath = resolve(resolvedInput, 'manifest.json');
  const manifest = await readJson(manifestPath, `manifest ${manifestPath}`);
  const contracts = validateManifest(manifest);
  const manifestDates = contracts.get(selectedContract);
  if (!manifestDates) {
    throw new InspectionError(`Requested contract ${selectedContract} is not present in the manifest.`);
  }

  const loadedDays = [];
  for (const date of selectedDates) {
    const entry = manifestDates.get(date);
    if (!entry) throw new InspectionError(`Requested date ${date} is not present for ${selectedContract}.`);
    const dayPath = resolve(resolvedInput, ...entry.file.split('/'));
    const relativePath = relative(resolvedInput, dayPath);
    if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
      throw new InspectionError(`Manifest path escapes the input directory for ${selectedContract} on ${date}.`);
    }
    const payload = await readJson(dayPath, `${selectedContract} candles for ${date}`);
    const label = `${selectedContract}/${date}.json`;
    validateRawDayTimestamps(payload, date, label);
    let candles;
    try {
      candles = parseDayPayload(payload, selectedContract, date);
    } catch (error) {
      throw new InspectionError(`${label}: ${error.message}`, { cause: error });
    }
    if (candles.length !== entry.candles) {
      throw new InspectionError(`${label}: candle count does not match the manifest.`);
    }
    loadedDays.push(Object.freeze({ date, candles: Object.freeze(candles) }));
  }

  return Object.freeze({ contract: selectedContract, days: Object.freeze(loadedDays) });
}

export function formatExchangeLocalDisplayTime(timestamp) {
  if (!Number.isFinite(timestamp)) throw new TypeError('A finite candle timestamp is required.');
  return new Date(timestamp * 1000).toISOString().slice(11, 16);
}

export function buildInspectionReport(dataset, { lookback = DEFAULT_FALSE_BREAKOUT_LOOKBACK } = {}) {
  if (!dataset?.contract || !Array.isArray(dataset.days)) throw new TypeError('A loaded candle dataset is required.');
  const observations = [];
  const days = [];

  for (const day of dataset.days) {
    const candidateByTime = new Map(day.candles.map((candle) => [candle.time, candle]));
    const dayObservations = observeSameCandleFalseBreakouts(day.candles, { lookback });
    let upper = 0;
    let lower = 0;
    for (const item of dayObservations) {
      const candidate = candidateByTime.get(item.candidateTimestamp);
      if (!candidate) throw new InspectionError(`Observer returned an unknown candidate for ${day.date}.`);
      if (item.direction === 'upper') upper += 1;
      if (item.direction === 'lower') lower += 1;
      observations.push(Object.freeze({
        contract: dataset.contract,
        date: day.date,
        candleTimestamp: item.candidateTimestamp,
        exchangeLocalDisplayTime: formatExchangeLocalDisplayTime(item.candidateTimestamp),
        direction: item.direction,
        referenceLevel: item.referenceLevel,
        candidateOpen: candidate.open,
        candidateHigh: candidate.high,
        candidateLow: candidate.low,
        candidateClose: candidate.close,
        lookback: item.lookback,
        observerName: item.observer,
        definitionVersion: item.definitionVersion,
      }));
    }
    days.push(Object.freeze({
      date: day.date,
      candleCount: day.candles.length,
      upper,
      lower,
      total: dayObservations.length,
    }));
  }

  return Object.freeze({
    contract: dataset.contract,
    dates: Object.freeze(dataset.days.map(({ date }) => date)),
    lookback,
    days: Object.freeze(days),
    observations: Object.freeze(observations),
  });
}

function csvCell(value) {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function renderObservationsCsv(report) {
  const columns = [
    'contract', 'date', 'candle_timestamp', 'exchange_local_display_time', 'direction',
    'reference_level', 'candidate_open', 'candidate_high', 'candidate_low', 'candidate_close',
    'lookback', 'observer_name', 'definition_version',
  ];
  const rows = report.observations.map((item) => [
    item.contract,
    item.date,
    item.candleTimestamp,
    item.exchangeLocalDisplayTime,
    item.direction,
    item.referenceLevel,
    item.candidateOpen,
    item.candidateHigh,
    item.candidateLow,
    item.candidateClose,
    item.lookback,
    item.observerName,
    item.definitionVersion,
  ].map(csvCell).join(','));
  return `${[columns.join(','), ...rows].join('\n')}\n`;
}

export function renderSummary(report) {
  const total = report.observations.length;
  const dayRows = report.days.map((day) => (
    `| ${day.date} | ${day.candleCount} | ${day.upper} | ${day.lower} | ${day.total} |`
  ));
  return `# Same-candle false-breakout inspection\n\n`
    + `- Contract: \`${report.contract}\`\n`
    + `- Dates: ${report.dates.join(', ')}\n`
    + `- Lookback: \`N = ${report.lookback}\` preceding completed one-minute candles\n`
    + `- Observer: \`same-candle-false-breakout\`, definition \`0.1\`\n\n`
    + `| Date | Candles | Upper | Lower | Total |\n`
    + `| --- | ---: | ---: | ---: | ---: |\n`
    + `${dayRows.join('\n')}\n\n`
    + `Total observations: **${total}**.\n\n`
    + `## Definition used\n\n`
    + `For each completed candidate candle, the reference window is the preceding ${report.lookback} completed one-minute candle records and excludes the candidate. An upper observation requires a high strictly above the highest reference high and a close strictly below it. A lower observation requires a low strictly below the lowest reference low and a close strictly above it. A close exactly at the reference does not qualify. Both directions are retained when both qualify.\n\n`
    + `## Limitations\n\n`
    + `- Definition v0.1 is provisional and has not been validated against the trader's discretionary interpretation.\n`
    + `- Confirmation uses the completed candidate candle only; OHLC data cannot establish intrabar ordering.\n`
    + `- Lookback resets at each trading day and counts existing candle records. Missing minutes are not synthesized.\n`
    + `- No trading-window filter, ranking, order recommendation, transaction cost, P&L, or profitability calculation is applied.\n`
    + `- Projected timestamps preserve exchange-local wall-clock display and are not assertions that the source times are UTC.\n\n`
    + `## Questions for trader validation\n\n`
    + `- Does a same-candle return through the reference match the intended false-breakout observation?\n`
    + `- Is a ${report.lookback}-candle record window appropriate, including across gaps with no candle?\n`
    + `- Should later definitions require confirmation in a subsequent candle?\n`
    + `- How should candles that qualify in both directions be interpreted without intrabar ordering?\n`;
}

function groupObservationCandidates(observations) {
  const groups = [];
  const byKey = new Map();
  for (const item of observations) {
    const key = `${item.contract}|${item.date}|${item.candleTimestamp}`;
    let group = byKey.get(key);
    if (!group) {
      group = {
        ...item,
        directions: [],
        references: [],
      };
      byKey.set(key, group);
      groups.push(group);
    }
    group.directions.push(item.direction);
    group.references.push(`${item.direction}: ${item.referenceLevel}`);
  }
  return groups;
}

export function selectInspectionShortlist(report, limit = SHORTLIST_LIMIT) {
  if (!Number.isInteger(limit) || limit <= 0) throw new RangeError('Shortlist limit must be a positive integer.');
  const candidates = groupObservationCandidates(report.observations);
  const selected = [];
  const selectedKeys = new Set();
  const add = (candidate, reason) => {
    if (!candidate) return;
    const key = `${candidate.contract}|${candidate.date}|${candidate.candleTimestamp}`;
    if (selectedKeys.has(key) || selected.length >= limit) return;
    selectedKeys.add(key);
    selected.push(Object.freeze({ ...candidate, selectionReason: reason }));
  };

  add(candidates.find(({ directions }) => directions.includes('upper') && directions.includes('lower')), 'earliest dual-direction candle');
  add(candidates.find(({ directions }) => directions.includes('upper')), 'earliest additional upper observation');
  add(candidates.find(({ directions }) => directions.includes('lower')), 'earliest additional lower observation');
  for (const candidate of candidates) add(candidate, 'earliest remaining observation');
  return Object.freeze(selected);
}

export function renderShortlist(report) {
  const shortlist = selectInspectionShortlist(report);
  const introduction = `# Deterministic inspection shortlist\n\n`
    + `Selection method: normalize selected dates to chronological order, then order unique candidate candles by date and candle timestamp; choose the earliest dual-direction candle when available, then the earliest additional upper and lower examples when available, then fill with the earliest remaining candidates up to ${SHORTLIST_LIMIT}. This is not a profitability or quality ranking.\n\n`;
  if (shortlist.length === 0) return `${introduction}No observations are available for inspection.\n`;
  const rows = shortlist.map((item) => (
    `| ${item.date} | ${item.exchangeLocalDisplayTime} | ${item.directions.join(' + ')} | ${item.references.join('; ')} | ${item.candidateOpen} | ${item.candidateHigh} | ${item.candidateLow} | ${item.candidateClose} | ${item.selectionReason} |`
  ));
  return introduction
    + `| Date | Time | Direction(s) | Reference(s) | Open | High | Low | Close | Selection reason |\n`
    + `| --- | --- | --- | --- | ---: | ---: | ---: | ---: | --- |\n`
    + `${rows.join('\n')}\n`;
}

export function resolveResearchOutputDirectory(outputDir, allowedRoot = DEFAULT_RESEARCH_ROOT) {
  const root = resolve(allowedRoot);
  const target = resolve(outputDir);
  const relativePath = relative(root, target);
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new InspectionError(`Output directory must remain inside ${root}.`);
  }
  return target;
}

export async function writeInspectionReport(report, { outputDir, allowedRoot = DEFAULT_RESEARCH_ROOT }) {
  const target = resolveResearchOutputDirectory(outputDir, allowedRoot);
  await mkdir(target, { recursive: true });
  const files = {
    csv: resolve(target, REPORT_FILENAMES.csv),
    summary: resolve(target, REPORT_FILENAMES.summary),
    shortlist: resolve(target, REPORT_FILENAMES.shortlist),
  };
  await Promise.all([
    writeFile(files.csv, renderObservationsCsv(report), 'utf8'),
    writeFile(files.summary, renderSummary(report), 'utf8'),
    writeFile(files.shortlist, renderShortlist(report), 'utf8'),
  ]);
  return Object.freeze(files);
}

export function parseArguments(argv) {
  const options = { dates: [], lookback: DEFAULT_FALSE_BREAKOUT_LOOKBACK, outputDir: DEFAULT_REPORT_DIRECTORY };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help') return { help: true };
    if (argument === '--dates') {
      while (argv[index + 1] && !argv[index + 1].startsWith('--')) options.dates.push(argv[++index]);
      continue;
    }
    const value = argv[++index];
    if (value == null || value.startsWith('--')) throw new InspectionError(`Missing value for ${argument}.`);
    if (argument === '--input-dir') options.inputDir = value;
    else if (argument === '--output-dir') options.outputDir = value;
    else if (argument === '--contract') options.contract = value;
    else if (argument === '--lookback') options.lookback = Number(value);
    else throw new InspectionError(`Unknown argument ${argument}.`);
  }
  if (!options.inputDir) throw new InspectionError('--input-dir is required.');
  if (!options.contract) throw new InspectionError('--contract is required.');
  uniqueSortedDates(options.dates);
  return options;
}

function usage() {
  return `Usage: node explorer/scripts/inspect-false-breakouts.mjs --input-dir <directory> --contract <symbol> --dates <YYYY-MM-DD...> [--lookback 20] [--output-dir <data/research/...>]`;
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArguments(argv);
    if (options.help) {
      process.stdout.write(`${usage()}\n`);
      return 0;
    }
    const dataset = await loadSelectedCandleDays(options);
    const report = buildInspectionReport(dataset, { lookback: options.lookback });
    const files = await writeInspectionReport(report, { outputDir: options.outputDir });
    for (const day of report.days) {
      process.stdout.write(`${day.date}: ${day.candleCount} candles, ${day.upper} upper, ${day.lower} lower\n`);
    }
    process.stdout.write(`Total observations: ${report.observations.length}\n`);
    process.stdout.write(`CSV: ${files.csv}\nSummary: ${files.summary}\nShortlist: ${files.shortlist}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`Inspection failed: ${error.message}\n`);
    return 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) process.exitCode = await main();
