import fs from 'node:fs';
import path from 'node:path';

const COVERAGE_DIR = path.resolve(process.cwd(), 'coverage');
const LCOV_PATH = path.join(COVERAGE_DIR, 'lcov.info');
const SRC_DIR = path.resolve(process.cwd(), 'src');
const MIN_LINE_COVERAGE = 90;

type CoverageTotals = {
  linesFound: number;
  linesHit: number;
};

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function normalizeLcovSourcePath(rawPath: string): string {
  const trimmed = rawPath.trim();

  if (trimmed === '') {
    return '';
  }

  if (path.isAbsolute(trimmed)) {
    return path.resolve(trimmed);
  }

  return path.resolve(process.cwd(), trimmed);
}

function isProjectSrcFile(filePath: string): boolean {
  const relative = path.relative(SRC_DIR, filePath);

  return relative !== ''
    && !relative.startsWith('..')
    && !path.isAbsolute(relative)
    && fs.existsSync(filePath)
    && fs.statSync(filePath).isFile();
}

function readLcov(): string {
  if (!fs.existsSync(LCOV_PATH)) {
    fail(`Coverage gate failed: missing LCOV file at ${LCOV_PATH}`);
  }

  return fs.readFileSync(LCOV_PATH, 'utf8');
}

function parseLcovTotals(lcov: string): CoverageTotals {
  const records = lcov.split('end_of_record');
  let linesFound = 0;
  let linesHit = 0;
  let matchedSrcRecords = 0;

  for (const record of records) {
    const lines = record
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '');

    if (lines.length === 0) {
      continue;
    }

    const sourceLine = lines.find((line) => line.startsWith('SF:'));
    if (sourceLine == null) {
      continue;
    }

    const sourcePath = normalizeLcovSourcePath(sourceLine.slice(3));
    if (!isProjectSrcFile(sourcePath)) {
      continue;
    }

    const foundLine = lines.find((line) => line.startsWith('LF:'));
    const hitLine = lines.find((line) => line.startsWith('LH:'));

    if (foundLine == null || hitLine == null) {
      fail(`Coverage gate failed: malformed LCOV record for ${sourcePath}`);
    }

    const recordFound = Number.parseInt(foundLine.slice(3), 10);
    const recordHit = Number.parseInt(hitLine.slice(3), 10);

    if (!Number.isFinite(recordFound) || !Number.isFinite(recordHit) || recordFound < 0 || recordHit < 0) {
      fail(`Coverage gate failed: invalid line totals for ${sourcePath}`);
    }

    matchedSrcRecords += 1;
    linesFound += recordFound;
    linesHit += recordHit;
  }

  if (matchedSrcRecords === 0 || linesFound === 0) {
    fail('Coverage gate failed: no src/ LCOV records found');
  }

  return { linesFound, linesHit };
}

function formatPercent(value: number): string {
  return value.toFixed(2);
}

const lcov = readLcov();
const totals = parseLcovTotals(lcov);
const lineCoverage = (totals.linesHit / totals.linesFound) * 100;

if (lineCoverage < MIN_LINE_COVERAGE) {
  fail(
    `Coverage gate failed: src/ line coverage ${formatPercent(lineCoverage)}% is below ${MIN_LINE_COVERAGE.toFixed(2)}% (${totals.linesHit}/${totals.linesFound})`,
  );
}

console.log(
  `Coverage gate passed: src/ line coverage ${formatPercent(lineCoverage)}% (${totals.linesHit}/${totals.linesFound}) >= ${MIN_LINE_COVERAGE.toFixed(2)}%`,
);
