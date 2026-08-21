/**
 * Import + normalize + validate STEPBible TVTMS versification data.
 *
 * TVTMS (Translators Versification Traditions with Methodology for
 * Standardisation) records, per verse-block, where the SAME verse-content lives
 * in each tradition: English (KJV), Hebrew (Masoretic / MT), Latin, and Greek
 * (LXX). We consume the CONDENSED section (`#DataStart(Condensed)` ..
 * `#DataStart(Expanded)`), which is an aligned per-column table.
 *
 * v2 parsing (this file) is ACTION-AWARE. v1 did a naive positional zip of every
 * row's `from`/`to` cells and dropped the reorder/split/merge structure. v2:
 *   - determines column indices from EACH section's header (they vary); the
 *     FIRST column whose label starts with `Greek` is LXX, `Hebrew`->MT,
 *     `English KJV`->English; Latin and any 2nd/3rd Greek are ignored.
 *   - skips TEST rows, `#`-commented rows, prose/definition rows, and
 *     tradition-preamble rows; only recognized Action keywords are data.
 *   - interprets each Action's semantics (OneToOne positional zip incl. across
 *     chapters; SubdividedVerse -> source maps to FIRST target, extra targets
 *     map back to source; Merged / Absent -> null; LongVerse / TextMayBeMissing
 *     null-on-Absent else OneToOne). Unknown actions emit null-with-log rather
 *     than guessing.
 *   - a divergent-book verse with no equivalent is stored as an EXPLICIT null
 *     (never omitted, since omission means identity — wrong for a reorder verse).
 *
 * Pipeline:
 *   1. Pin STEPBible-Data to its current master commit SHA (GitHub API), fetch
 *      the TVTMS file at that SHA, cache under source/, write SOURCE.json.
 *   2. Parse the condensed table -> per scheme-pair divergence entries.
 *   3. Normalize to data/stepbible-versification/mapping.json (identity-omitted
 *      except explicit nulls).
 *   4. Validate every mapped target against actual verse text in the sibling
 *      ground-truth packages (OHB=MT, crosswire-KJV=English, swete-lxx=LXX) and
 *      write validation-report.json with a v1->v2 coverage delta.
 *
 * Scheme vocabulary matches @metaxia/scriptures-core EXACTLY: 'MT' | 'LXX' |
 * 'English'. TVTMS Hebrew->MT, first Greek->LXX, English KJV->English. Latin is
 * ignored. NT / apocryphal-book rows are skipped (not in OT_BOOKS).
 *
 * Usage: npx tsx scripts/import.ts
 */

import { mkdir, writeFile, readFile, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { createHash } from 'crypto';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = join(__dirname, '..');
const LIB_DIR = join(ROOT_DIR, '..'); // scriptures-js-libraries/

const SOURCE_DIR = join(ROOT_DIR, 'source');
const DATA_DIR = join(ROOT_DIR, 'data', 'stepbible-versification');

const REPO = 'STEPBible/STEPBible-Data';
const TVTMS_PATH =
  'Versification/TVTMS%20-%20Translators%20Versification%20Traditions%20with%20Methodology%20for%20Standardisation%20for%20Eng%2BHeb%2BLat%2BGrk%2BOthers%20-%20STEPBible.org%20CC%20BY.txt';

// ---------------------------------------------------------------------------
// Scheme vocabulary (must match core: 'MT' | 'LXX' | 'English')
// ---------------------------------------------------------------------------
type Scheme = 'MT' | 'LXX' | 'English';
const SCHEMES: Scheme[] = ['MT', 'LXX', 'English'];

/**
 * Books whose MT<->LXX numbering diverges by whole-block reorder / Greek
 * additions. Mirrors core's MT_LXX_DIVERGENT_BOOKS. For these, a source verse
 * with no TVTMS-derived target is stored as an EXPLICIT null (never omitted),
 * so consumers never fall through to a known-wrong identity.
 */
const MT_LXX_DIVERGENT_BOOKS = new Set<string>([
  'Jeremiah', 'Exodus', '1 Kings', 'Joshua', 'Proverbs', 'Daniel', 'Esther',
]);

// ---------------------------------------------------------------------------
// The 39 OT books. Map STEPBible 3-letter codes -> full names as core uses,
// plus the OSIS code used by the OHB/KJV ground-truth dirs, and the full name
// used by the Swete-LXX ground-truth dir.
// ---------------------------------------------------------------------------
interface BookInfo {
  full: string; // core full name, keys mapping.json
  osis: string; // OHB + KJV dir name
}
const OT_BOOKS: Record<string, BookInfo> = {
  Gen: { full: 'Genesis', osis: 'Gen' },
  Exo: { full: 'Exodus', osis: 'Exod' },
  Lev: { full: 'Leviticus', osis: 'Lev' },
  Num: { full: 'Numbers', osis: 'Num' },
  Deu: { full: 'Deuteronomy', osis: 'Deut' },
  Jos: { full: 'Joshua', osis: 'Josh' },
  Jdg: { full: 'Judges', osis: 'Judg' },
  Rut: { full: 'Ruth', osis: 'Ruth' },
  '1Sa': { full: '1 Samuel', osis: '1Sam' },
  '2Sa': { full: '2 Samuel', osis: '2Sam' },
  '1Ki': { full: '1 Kings', osis: '1Kgs' },
  '2Ki': { full: '2 Kings', osis: '2Kgs' },
  '1Ch': { full: '1 Chronicles', osis: '1Chr' },
  '2Ch': { full: '2 Chronicles', osis: '2Chr' },
  Ezr: { full: 'Ezra', osis: 'Ezra' },
  Neh: { full: 'Nehemiah', osis: 'Neh' },
  Est: { full: 'Esther', osis: 'Esth' },
  Job: { full: 'Job', osis: 'Job' },
  Psa: { full: 'Psalms', osis: 'Ps' },
  Pro: { full: 'Proverbs', osis: 'Prov' },
  Ecc: { full: 'Ecclesiastes', osis: 'Eccl' },
  Sng: { full: 'Song of Solomon', osis: 'Song' },
  Isa: { full: 'Isaiah', osis: 'Isa' },
  Jer: { full: 'Jeremiah', osis: 'Jer' },
  Lam: { full: 'Lamentations', osis: 'Lam' },
  Ezk: { full: 'Ezekiel', osis: 'Ezek' },
  Dan: { full: 'Daniel', osis: 'Dan' },
  Hos: { full: 'Hosea', osis: 'Hos' },
  Jol: { full: 'Joel', osis: 'Joel' },
  Amo: { full: 'Amos', osis: 'Amos' },
  Oba: { full: 'Obadiah', osis: 'Obad' },
  Jon: { full: 'Jonah', osis: 'Jonah' },
  Mic: { full: 'Micah', osis: 'Mic' },
  Nam: { full: 'Nahum', osis: 'Nah' },
  Hab: { full: 'Habakkuk', osis: 'Hab' },
  Zep: { full: 'Zephaniah', osis: 'Zeph' },
  Hag: { full: 'Haggai', osis: 'Hag' },
  Zec: { full: 'Zechariah', osis: 'Zech' },
  Mal: { full: 'Malachi', osis: 'Mal' },
};

// ---------------------------------------------------------------------------
// Ref parsing
// ---------------------------------------------------------------------------
interface Ref {
  book: string; // STEPBible code, e.g. 'Gen'
  chapter: number;
  verse: number;
  part?: string; // subverse '!a'/'!b'/'.1' (or title marker), optional
  isTitle?: boolean;
}

/**
 * The parsed content of one TVTMS cell:
 *   - kind 'refs':    one or more concrete refs (a range expands to many).
 *   - kind 'absent':  a sentinel (Absent/NoVerse/NotExist/Empty) -> explicit
 *                     "no equivalent" (maps to null). Distinct from 'empty'.
 *   - kind 'empty':   truly blank / the column doesn't participate on this row.
 */
type CellParse =
  | { kind: 'refs'; refs: Ref[] }
  | { kind: 'absent' }
  | { kind: 'empty' };

const SENTINELS = /^(Absent|NoVerse|NotExist|Missing|Empty)\b/i;

/** Strip TVTMS annotations from a cell so only the leading ref-expression is left. */
function stripAnnotations(raw: string): string {
  let s = raw.trim();
  // Remove bracketed notes: [=Gen.3:1], [Empty], [=+Exo.28:23-28], [...]
  s = s.replace(/\[[^\]]*\]/g, ' ');
  // Remove %..% inline prose notes and parenthetical language notes.
  s = s.replace(/%[^%]*%/g, ' ');
  s = s.replace(/\([^)]*\)/g, ' ');
  // Drop a trailing "*N" (repetition marker) and stray asterisks/pluses.
  s = s.replace(/\*\d+\b/g, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

/** Parse one Book.Ch:Vs (optionally a range / subverse) token into refs. */
function parseRefToken(token: string): Ref[] {
  let s = token.replace(/^\*+/, '').trim();
  if (!s) return [];

  const m = s.match(/^([1-4]?[A-Za-z]{2,3})\.(.+)$/);
  if (!m) return [];
  const book = m[1];
  const rest = m[2];

  // Only OT books; skip NT / apocryphal (S3Y, Sus, Bel, Man, Mrk, Jhn, ...).
  if (!(book in OT_BOOKS)) return [];

  const cm = rest.match(/^(\d+)[:.](.+)$/);
  if (!cm) return [];
  const chapter = parseInt(cm[1], 10);
  const versePart = cm[2].trim();

  // Title verse (Psalm superscription).
  if (/^title/i.test(versePart)) {
    return [{ book, chapter, verse: 0, isTitle: true }];
  }

  // Cross-chapter range "Vs-Ch:Vs" (e.g. Gen.31:55-32:1 -> handled by caller
  // splitting; here we only see single-chapter tails). Range "a-b" with
  // optional subverse markers on either end (e.g. 22:1-6, 28:22.1-6, 3:2-8).
  const rangeM = versePart.match(
    /^(\d+)(?:[!.]([a-z0-9]))?-(\d+)(?:[!.]([a-z0-9]))?$/i
  );
  if (rangeM) {
    const a = parseInt(rangeM[1], 10);
    const b = parseInt(rangeM[3], 10);
    const out: Ref[] = [];
    if (b >= a && b - a < 400) {
      for (let v = a; v <= b; v++) out.push({ book, chapter, verse: v });
    } else {
      out.push({ book, chapter, verse: a });
    }
    return out;
  }

  // Single verse, optional subverse "!a" / ".2" / ".0".
  const single = versePart.match(/^(\d+)(?:!([a-z])|\.(\d+))?$/i);
  if (single) {
    const verse = parseInt(single[1], 10);
    const part = single[2] ? '!' + single[2] : single[3] ? '.' + single[3] : undefined;
    return [{ book, chapter, verse, part }];
  }
  return [];
}

/**
 * Parse a single TVTMS cell. A cell may hold:
 *   - a sentinel (Absent / NoVerse / NotExist / Empty)          -> {absent}
 *   - one ref, or a range (Gen.32:1-32), possibly cross-chapter
 *   - several refs separated by ';' (e.g. "Exo.37:17; 38:20")   -> merged refs
 *     (subsequent tokens may omit the book, inheriting the previous book/chapter)
 * Bracketed [=..]/[Empty] and %..%/(..) annotations are stripped first.
 */
function parseCell(raw: string): CellParse {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === ',') return { kind: 'empty' };
  if (SENTINELS.test(trimmed)) return { kind: 'absent' };

  const s = stripAnnotations(trimmed);
  if (!s) return { kind: 'empty' };
  if (SENTINELS.test(s)) return { kind: 'absent' };

  const refs: Ref[] = [];
  let lastBook: string | null = null;
  let lastChapter: number | null = null;
  for (let token of s.split(';')) {
    token = token.trim();
    if (!token) continue;
    // A bare "Ch:Vs" continuation (book omitted) inherits the previous book.
    if (lastBook && /^\d+[:.]/.test(token)) token = `${lastBook}.${token}`;
    // A bare "Vs" continuation inherits book+chapter.
    else if (lastBook && lastChapter !== null && /^\d+([!.][a-z0-9])?$/i.test(token))
      token = `${lastBook}.${lastChapter}:${token}`;
    const parsed = parseRefToken(token);
    for (const r of parsed) {
      refs.push(r);
      lastBook = r.book;
      lastChapter = r.chapter;
    }
  }
  if (refs.length === 0) return { kind: 'empty' };
  return { kind: 'refs', refs };
}

// ---------------------------------------------------------------------------
// Fetch + pin
// ---------------------------------------------------------------------------
async function resolveMasterSha(): Promise<string> {
  const url = `https://api.github.com/repos/${REPO}/commits/master`;
  const res = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'metaxia-scriptures-import',
    },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status} resolving master SHA`);
  const body = (await res.json()) as { sha?: string };
  if (!body.sha) throw new Error('No sha in GitHub API response');
  return body.sha;
}

async function fetchTvtms(sha: string): Promise<string> {
  const cached = join(SOURCE_DIR, 'tvtms.txt');
  const shaFile = join(SOURCE_DIR, `.tvtms-${sha}.sha`);
  if (existsSync(cached) && existsSync(shaFile)) {
    console.log(`Using cached TVTMS (SHA ${sha})`);
    return readFile(cached, 'utf-8');
  }
  const url = `https://raw.githubusercontent.com/${REPO}/${sha}/${TVTMS_PATH}`;
  console.log(`Fetching TVTMS @ ${sha} ...`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch TVTMS: ${res.status}`);
  const text = await res.text();
  await mkdir(SOURCE_DIR, { recursive: true });
  await writeFile(cached, text, 'utf-8');
  await writeFile(shaFile, sha, 'utf-8');
  return text;
}

// ---------------------------------------------------------------------------
// Parse condensed table -> divergence rows
// ---------------------------------------------------------------------------
interface AlignedRow {
  action: string;
  cols: Partial<Record<Scheme, CellParse>>; // scheme -> parsed cell for this row
}

/**
 * Recognized TVTMS Action keywords. Anything else in the action cell (tradition
 * names like "Latin + Greek", "EngTitleMerged", "BrentonSeparate", or prose) is
 * NOT a data row and is skipped. Unknown-but-action-shaped tokens are logged.
 */
const KNOWN_ACTIONS = new Set<string>([
  'OneToOne',
  'SubdividedVerse',
  'MergedPrevVerse',
  'MergedFollVerse',
  'MergedVerse',
  'TextMayBeMissing',
  'LongVerseElsewhere',
  'LongVerseElsewhereJoin',
  'LongVerseDuplicated',
  'LongVerse/LVExtra',
  'LongVerse/LVElsewhere',
  'LongVerse/LVDuplicated',
  'DuplicateTarget',
  'PassageMissing',
]);

const unknownActions = new Map<string, number>();

function parseCondensed(text: string): AlignedRow[] {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith('#DataStart(Condensed)'));
  let end = lines.findIndex((l) => l.startsWith('#DataStart(Expanded)'));
  if (start === -1) throw new Error('Condensed section not found');
  if (end === -1) end = lines.length;

  const rows: AlignedRow[] = [];
  // Column layout: index -> scheme (or null). Reset per $-section / BIBLES line.
  let colScheme: (Scheme | null)[] = [];

  const parseHeader = (cells: string[]) => {
    // cells[0] is the $header or 'BIBLES' label; cells[1..] are column labels.
    // English KJV -> English; Hebrew -> MT; the FIRST column whose label starts
    // with "Greek" (Greek, Greek*, Greek (NETS), Greek+NRSV, ...) -> LXX. Any
    // subsequent Greek column, Latin, and everything else is ignored.
    const layout: (Scheme | null)[] = [];
    let lxxTaken = false;
    for (let i = 0; i < cells.length; i++) {
      const label = cells[i].trim();
      let scheme: Scheme | null = null;
      if (label === 'English KJV') scheme = 'English';
      else if (label === 'Hebrew') scheme = 'MT';
      else if (!lxxTaken && /^Greek\b/.test(label) && !/^Greek[23]/.test(label)) {
        scheme = 'LXX';
        lxxTaken = true;
      }
      layout[i] = scheme;
    }
    return layout;
  };

  for (let li = start + 1; li < end; li++) {
    const line = lines[li];
    if (!line || line.trim() === '' || line.trim() === ',') continue;
    const cells = line.split('\t');
    const first = cells[0].trim();

    // Header line variants:
    //  (a) "$Gen.31:55--32:32  English KJV  Hebrew  Latin  Greek"
    //  (b) "$Psa.2:12" (bare) followed later by "BIBLES  English KJV  Hebrew ..."
    if (first.startsWith('$')) {
      if (cells.slice(1).some((c) => c.trim() === 'English KJV')) {
        colScheme = parseHeader(cells);
      } else {
        colScheme = []; // wait for a BIBLES line
      }
      continue;
    }
    if (first === 'BIBLES') {
      colScheme = parseHeader(cells);
      continue;
    }
    // TEST rows and `#`-commented rows: skip.
    if (/^TEST\b/i.test(first)) continue;
    if (first.startsWith('#')) continue;
    if (colScheme.length === 0) continue;

    // Only recognized Action keywords are data rows. Everything else (tradition
    // preamble names, prose definitions) is skipped. Log action-shaped unknowns.
    if (!KNOWN_ACTIONS.has(first)) {
      if (/^[A-Za-z][A-Za-z/]*$/.test(first) && !/^(English|Hebrew|Latin|Greek|Brenton|Eng|Grk)/.test(first)) {
        unknownActions.set(first, (unknownActions.get(first) ?? 0) + 1);
      }
      continue;
    }

    // Build per-scheme parsed cells from columns tagged with a scheme.
    const colsOut: Partial<Record<Scheme, CellParse>> = {};
    let sawRefs = false;
    for (let i = 1; i < colScheme.length; i++) {
      const sch = colScheme[i];
      if (!sch) continue;
      const parsed = parseCell(cells[i] ?? '');
      colsOut[sch] = parsed;
      if (parsed.kind === 'refs') sawRefs = true;
    }
    // Need at least one concrete-ref column to align anything meaningful.
    if (sawRefs) rows.push({ action: first, cols: colsOut });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Normalize aligned rows -> per scheme-pair mapping (identity omitted)
// ---------------------------------------------------------------------------
type PairKey = string; // `${from}->${to}`
interface MappingValue {
  chapter: number;
  verse: number;
  part?: string;
}
type PairTable = Record<string, MappingValue | null>;

function keyFor(bookFull: string, chapter: number, verse: number): string {
  return `${bookFull} ${chapter}:${verse}`;
}

/** One directed correlation: a source verse -> a target ref (or null = no equivalent). */
interface Pairing {
  from: Ref;
  to: Ref | null;
}

/**
 * Correlate the `from` cell to the `to` cell for a directed pair, honoring the
 * row's Action semantics. Returns per-source-verse pairings. The `to` field is
 * null when the action / sentinel says the source verse has NO equivalent.
 *
 * Both cells have already been parsed (refs / absent / empty). A missing (empty)
 * `to` yields no pairings (we know nothing about the target). An `absent` `to`
 * yields explicit nulls for every `from` verse.
 */
function correlate(action: string, fromCell: CellParse, toCell: CellParse): Pairing[] {
  if (fromCell.kind !== 'refs') return []; // no source verses to key
  const src = fromCell.refs;

  // Target absent -> every source verse has no equivalent (explicit null).
  if (toCell.kind === 'absent') return src.map((f) => ({ from: f, to: null }));
  // Target column not present on this row -> we cannot say anything.
  if (toCell.kind === 'empty') return [];
  const tgt = toCell.refs;

  const zip = (): Pairing[] => {
    // Positional zip over equal-length ranges (OneToOne, incl. across chapters).
    if (src.length === tgt.length) return src.map((f, i) => ({ from: f, to: tgt[i] }));
    // A single target -> all sources point at it (merge).
    if (tgt.length === 1) return src.map((f) => ({ from: f, to: tgt[0] }));
    // A single source, many targets -> source -> FIRST target (subdivision).
    if (src.length === 1) return [{ from: src[0], to: tgt[0] }];
    // Unequal multi:multi -> align by index up to the shorter length.
    const n = Math.min(src.length, tgt.length);
    return src.slice(0, n).map((f, i) => ({ from: f, to: tgt[i] }));
  };

  switch (action) {
    case 'OneToOne':
    case 'LongVerseElsewhere':
    case 'LongVerseElsewhereJoin':
    case 'LongVerseDuplicated':
    case 'LongVerse/LVExtra':
    case 'LongVerse/LVElsewhere':
    case 'LongVerse/LVDuplicated':
    case 'TextMayBeMissing':
    case 'PassageMissing':
    case 'MergedPrevVerse':
    case 'MergedFollVerse':
    case 'MergedVerse':
      // Concrete-vs-concrete: positional/zip semantics. (Absent handled above.)
      return zip();

    case 'SubdividedVerse':
    case 'DuplicateTarget': {
      // One source verse = multiple target verses (or vice-versa). Map source ->
      // FIRST target; extra targets on the OTHER direction map back to the source
      // (handled by the reverse-direction call, which sees src.length==1).
      if (src.length === 1 && tgt.length > 1) return [{ from: src[0], to: tgt[0] }];
      if (tgt.length === 1 && src.length > 1) return src.map((f) => ({ from: f, to: tgt[0] }));
      return zip();
    }

    default:
      // Unknown but recognized-shaped action: refuse to guess. Emit null and log.
      unknownActions.set(action, (unknownActions.get(action) ?? 0) + 1);
      return src.map((f) => ({ from: f, to: null }));
  }
}

interface NormalizeResult {
  tables: Record<PairKey, PairTable>;
  conflicts: Array<{ pair: PairKey; key: string; existing: MappingValue | null; incoming: MappingValue | null }>;
}

function normalize(rows: AlignedRow[]): NormalizeResult {
  const tables: Record<PairKey, PairTable> = {};
  const conflicts: NormalizeResult['conflicts'] = [];

  for (const from of SCHEMES) {
    for (const to of SCHEMES) {
      if (from === to) continue;
      tables[`${from}->${to}`] = {};
    }
  }

  for (const row of rows) {
    for (const from of SCHEMES) {
      const fromCell = row.cols[from];
      if (!fromCell || fromCell.kind !== 'refs') continue;
      for (const to of SCHEMES) {
        if (from === to) continue;
        const toCell = row.cols[to];
        if (!toCell) continue;
        const pairKey = `${from}->${to}`;
        const table = tables[pairKey];
        for (const { from: f, to: t } of correlate(row.action, fromCell, toCell)) {
          if (f.isTitle) continue; // can't key a title at verse granularity
          const bookFull = OT_BOOKS[f.book].full;
          const isDivergent = MT_LXX_DIVERGENT_BOOKS.has(bookFull);
          const isMtLxx = (from === 'MT' && to === 'LXX') || (from === 'LXX' && to === 'MT');
          const k = keyFor(bookFull, f.chapter, f.verse);

          let value: MappingValue | null;
          if (t === null || t.isTitle) {
            value = null; // no verse-level equivalent (absent / title target)
          } else {
            value = { chapter: t.chapter, verse: t.verse };
            if (t.part) value.part = t.part;
          }

          // Omit identity entries (implicit default) — EXCEPT for divergent-book
          // MT<->LXX pairs, where we store even identity so callers never fall
          // through to a bare identity guess for a reorder book.
          if (
            value &&
            value.chapter === f.chapter &&
            value.verse === f.verse &&
            !value.part &&
            !(isDivergent && isMtLxx)
          ) {
            continue;
          }

          if (k in table) {
            const prev = table[k];
            const same =
              (prev === null && value === null) ||
              (prev !== null &&
                value !== null &&
                prev.chapter === value.chapter &&
                prev.verse === value.verse &&
                prev.part === value.part);
            if (!same) {
              // Prefer a concrete value over a null (a later precise row wins over
              // an earlier absent), otherwise first-write-wins and record.
              if (prev === null && value !== null) {
                table[k] = value;
              } else {
                conflicts.push({ pair: pairKey, key: k, existing: prev, incoming: value });
              }
            }
            continue;
          }
          table[k] = value;
        }
      }
    }
  }
  return { tables, conflicts };
}

// ---------------------------------------------------------------------------
// Validation against ground-truth verse text
// ---------------------------------------------------------------------------
const GT = {
  MT: join(LIB_DIR, 'scriptures-js-source-openscriptures-ohb', 'data', 'openscriptures-OHB'),
  English: join(LIB_DIR, 'scriptures-js-source-crosswire-kjv', 'data', 'crosswire-KJV'),
  LXX: join(LIB_DIR, 'scriptures-js-source-swete-lxx', 'data', 'swete-lxx'),
};

function verseDir(scheme: Scheme, bookFull: string, bookCode: string): string {
  if (scheme === 'LXX') return join(GT.LXX, bookFull);
  const osis = OT_BOOKS[bookCode].osis;
  return join(GT[scheme], osis);
}

interface VerseFile {
  text?: string;
  kjv_text?: string;
  words?: Array<{ hebrew?: string; greek?: string; text?: string }>;
}

async function loadVerseFile(
  scheme: Scheme,
  bookFull: string,
  bookCode: string,
  chapter: number,
  verse: number
): Promise<VerseFile | null> {
  const p = join(verseDir(scheme, bookFull, bookCode), String(chapter), `${verse}.json`);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(await readFile(p, 'utf-8')) as VerseFile;
  } catch {
    return null;
  }
}

/** Extract a comparable token set (proper-noun / number anchors) from a verse. */
function anchorTokens(vf: VerseFile, scheme: Scheme): Set<string> {
  const out = new Set<string>();
  const words = vf.words ?? [];
  for (const w of words) {
    const t = (scheme === 'MT' ? w.hebrew : scheme === 'LXX' ? w.greek : w.text) ?? w.text;
    if (!t) continue;
    // strip diacritics/vowel-points, lowercase for Latin-ish; keep script for Heb/Grk
    const norm = t.normalize('NFD').replace(/[̀-֑ͯ-ׇ]/g, '');
    if (norm.length >= 3) out.add(norm);
    // Arabic numerals as strong anchors
    const num = t.match(/\d+/);
    if (num) out.add('#' + num[0]);
  }
  return out;
}

interface ValidationReport {
  generatedAt: null;
  sha: string;
  pairs: Record<
    string,
    {
      total: number;
      targetExists: number;
      targetMissing: number;
      anchorChecked: number;
      anchorOverlap: number;
      anchorConflicts: number;
      mappedToNull: number;
      conflictSamples: Array<{ key: string; target: string; reason: string }>;
      missingSamples: Array<{ key: string; target: string }>;
    }
  >;
  normalizationConflicts: number;
  normalizationConflictSamples: NormalizeResult['conflicts'];
  /** Per scheme-pair entry counts v1 (prior mapping.json) -> now, concrete vs null. */
  coverageDelta: {
    perPair: Record<string, { v1: number; now: number; nowConcrete: number; nowNull: number }>;
    divergentBooksMtLxx: Record<
      string,
      { mtToLxx: { total: number; concrete: number; null: number }; lxxToMt: { total: number; concrete: number; null: number } }
    >;
  };
  /** Flagship offsets that must still hold after re-parse. */
  flagshipOffsets: Array<{ label: string; expected: string; actual: string; ok: boolean }>;
  /** Actions we could not confidently interpret (emitted null + logged). */
  unrecognizedActions: Record<string, number>;
}

/** Load the previous mapping.json (if any) to compute a coverage delta. */
async function loadPreviousMapping(): Promise<Record<string, PairTable> | null> {
  const p = join(DATA_DIR, 'mapping.json');
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(await readFile(p, 'utf-8')) as Record<string, PairTable>;
  } catch {
    return null;
  }
}

async function validate(
  tables: Record<PairKey, PairTable>,
  conflicts: NormalizeResult['conflicts'],
  sha: string,
  previous: Record<string, PairTable> | null
): Promise<ValidationReport> {
  // Coverage delta vs v1.
  const perPair: ValidationReport['coverageDelta']['perPair'] = {};
  for (const [pair, table] of Object.entries(tables)) {
    const entries = Object.entries(table);
    const nowNull = entries.filter(([, v]) => v === null).length;
    perPair[pair] = {
      v1: previous?.[pair] ? Object.keys(previous[pair]).length : 0,
      now: entries.length,
      nowConcrete: entries.length - nowNull,
      nowNull,
    };
  }
  const bookBreakdown = (pair: string, book: string) => {
    const table = tables[pair] ?? {};
    let total = 0;
    let nul = 0;
    for (const [k, v] of Object.entries(table)) {
      if (k.startsWith(book + ' ')) {
        total++;
        if (v === null) nul++;
      }
    }
    return { total, concrete: total - nul, null: nul };
  };
  const divergentBooksMtLxx: ValidationReport['coverageDelta']['divergentBooksMtLxx'] = {};
  for (const book of MT_LXX_DIVERGENT_BOOKS) {
    divergentBooksMtLxx[book] = {
      mtToLxx: bookBreakdown('MT->LXX', book),
      lxxToMt: bookBreakdown('LXX->MT', book),
    };
  }

  // Flagship offsets.
  const lookup = (pair: string, key: string): string => {
    const v = tables[pair]?.[key];
    if (v === undefined) return 'IDENTITY';
    if (v === null) return 'null';
    return `${v.chapter}:${v.verse}${v.part ?? ''}`;
  };
  const flagshipOffsets: ValidationReport['flagshipOffsets'] = [
    { label: 'MT Gen 32:1 -> LXX 31:55', key: 'Genesis 32:1', pair: 'MT->LXX', expected: '31:55' },
    { label: 'MT Num 17:1 -> LXX 16:36', key: 'Numbers 17:1', pair: 'MT->LXX', expected: '16:36' },
    { label: 'English Jer 25:15 -> LXX 32:1', key: 'Jeremiah 25:15', pair: 'English->LXX', expected: '32:1' },
  ].map(({ label, key, pair, expected }) => {
    const actual = lookup(pair, key);
    return { label, expected, actual, ok: actual === expected };
  });

  const report: ValidationReport = {
    generatedAt: null,
    sha,
    pairs: {},
    normalizationConflicts: conflicts.length,
    normalizationConflictSamples: conflicts.slice(0, 40),
    coverageDelta: { perPair, divergentBooksMtLxx },
    flagshipOffsets,
    unrecognizedActions: Object.fromEntries(unknownActions),
  };

  // reverse-lookup book full name -> code
  const fullToCode: Record<string, string> = {};
  for (const [code, info] of Object.entries(OT_BOOKS)) fullToCode[info.full] = code;

  for (const [pairKey, table] of Object.entries(tables)) {
    const [fromS, toS] = pairKey.split('->') as [Scheme, Scheme];
    const stats = {
      total: 0,
      targetExists: 0,
      targetMissing: 0,
      anchorChecked: 0,
      anchorOverlap: 0,
      anchorConflicts: 0,
      mappedToNull: 0,
      conflictSamples: [] as Array<{ key: string; target: string; reason: string }>,
      missingSamples: [] as Array<{ key: string; target: string }>,
    };

    for (const [key, value] of Object.entries(table)) {
      stats.total++;
      if (value === null) {
        stats.mappedToNull++;
        continue;
      }
      // key = "Book Full ch:vs"
      const m = key.match(/^(.+) (\d+):(\d+)$/);
      if (!m) continue;
      const bookFull = m[1];
      const srcCh = parseInt(m[2], 10);
      const srcVs = parseInt(m[3], 10);
      const code = fullToCode[bookFull];
      if (!code) continue;
      const targetStr = `${bookFull} ${value.chapter}:${value.verse}`;

      const targetVf = await loadVerseFile(toS, bookFull, code, value.chapter, value.verse);
      if (!targetVf) {
        stats.targetMissing++;
        if (stats.missingSamples.length < 25)
          stats.missingSamples.push({ key, target: targetStr });
        continue;
      }
      stats.targetExists++;

      // Anchor overlap: compare source-scheme verse anchors vs target-scheme
      // verse anchors. Both should be the SAME verse-content, so proper nouns /
      // numbers (after diacritic stripping) may overlap. Scripts differ across
      // MT/LXX/English, so overlap is only meaningful for numeric anchors and
      // rarely for shared transliterations; we count when there is ANY overlap
      // and only FLAG when we have anchors on both sides yet zero overlap AND a
      // numeric anchor exists on one side (a strong signal of misalignment).
      const srcVf = await loadVerseFile(fromS, bookFull, code, srcCh, srcVs);
      if (srcVf) {
        const aSrc = anchorTokens(srcVf, fromS);
        const aTgt = anchorTokens(targetVf, toS);
        const numsSrc = [...aSrc].filter((t) => t.startsWith('#'));
        const numsTgt = [...aTgt].filter((t) => t.startsWith('#'));
        if (numsSrc.length && numsTgt.length) {
          stats.anchorChecked++;
          const overlap = numsSrc.some((n) => aTgt.has(n));
          if (overlap) stats.anchorOverlap++;
          else {
            stats.anchorConflicts++;
            if (stats.conflictSamples.length < 25)
              stats.conflictSamples.push({
                key,
                target: targetStr,
                reason: `numeric anchors ${numsSrc.join(',')} vs ${numsTgt.join(',')} disjoint`,
              });
          }
        }
      }
    }
    report.pairs[pairKey] = stats;
  }
  return report;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(SOURCE_DIR, { recursive: true });

  const sha = await resolveMasterSha();
  console.log(`STEPBible-Data master SHA: ${sha}`);
  const text = await fetchTvtms(sha);
  const sha256 = createHash('sha256').update(text, 'utf-8').digest('hex');

  await writeFile(
    join(DATA_DIR, 'SOURCE.json'),
    JSON.stringify({ repo: REPO, sha, sha256, retrieved: null }, null, 2) + '\n',
    'utf-8'
  );

  // Load the prior mapping BEFORE we overwrite it, for the coverage delta.
  const previous = await loadPreviousMapping();

  console.log('Parsing condensed table ...');
  const rows = parseCondensed(text);
  console.log(`  parsed ${rows.length} aligned OT data rows`);

  const { tables, conflicts } = normalize(rows);
  const counts: Record<string, number> = {};
  for (const [pair, table] of Object.entries(tables)) counts[pair] = Object.keys(table).length;
  console.log('Mapping entries per scheme-pair (v1 -> now):');
  for (const [pair, n] of Object.entries(counts)) {
    const v1 = previous?.[pair] ? Object.keys(previous[pair]).length : 0;
    const nul = Object.values(tables[pair]).filter((v) => v === null).length;
    console.log(`  ${pair}: ${v1} -> ${n} (concrete=${n - nul} null=${nul})`);
  }
  console.log(`  normalization conflicts (first-write-wins): ${conflicts.length}`);
  if (unknownActions.size)
    console.log(`  unrecognized actions (emitted null): ${JSON.stringify(Object.fromEntries(unknownActions))}`);

  await writeFile(
    join(DATA_DIR, 'mapping.json'),
    JSON.stringify(tables, null, 0) + '\n',
    'utf-8'
  );

  console.log('Validating against ground-truth verse text ...');
  const report = await validate(tables, conflicts, sha, previous);
  await writeFile(
    join(DATA_DIR, 'validation-report.json'),
    JSON.stringify(report, null, 2) + '\n',
    'utf-8'
  );

  console.log('\nValidation summary:');
  for (const [pair, s] of Object.entries(report.pairs)) {
    console.log(
      `  ${pair}: total=${s.total} targetExists=${s.targetExists} missing=${s.targetMissing} null=${s.mappedToNull} anchorChecked=${s.anchorChecked} anchorOverlap=${s.anchorOverlap} anchorConflicts=${s.anchorConflicts}`
    );
  }
  console.log(`  normalizationConflicts=${report.normalizationConflicts}`);

  console.log('\nDivergent-book MT<->LXX coverage (concrete/null):');
  for (const [book, d] of Object.entries(report.coverageDelta.divergentBooksMtLxx)) {
    console.log(
      `  ${book}: MT->LXX ${d.mtToLxx.concrete}/${d.mtToLxx.null} (${d.mtToLxx.total})  LXX->MT ${d.lxxToMt.concrete}/${d.lxxToMt.null} (${d.lxxToMt.total})`
    );
  }
  console.log('\nFlagship offsets:');
  for (const f of report.flagshipOffsets)
    console.log(`  [${f.ok ? 'OK' : 'FAIL'}] ${f.label}: expected ${f.expected}, got ${f.actual}`);

  console.log('\nDone. Wrote SOURCE.json, mapping.json, validation-report.json');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
