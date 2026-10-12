# @metaxia/scriptures-source-stepbible-versification

It is a data source for [GematriaBible.com](https://gematriabible.com) — an interlinear Bible with gematria values and Strong's numbers.

Cross-tradition **versification** mapping for [@metaxia/scriptures-core](https://github.com/metaxiamultimedia/scriptures-js-core), derived from the STEPBible **TVTMS** (Translators Versification Traditions with Methodology for Standardisation).

The Old Testament is numbered differently in the Hebrew/Masoretic, Greek/Septuagint, and English/KJV traditions. This package provides a normalized, empirically-validated lookup table between those three numbering schemes and registers it as a `VersificationSource` with core.

## What it is

- A compact JSON mapping (`data/stepbible-versification/mapping.json`) for each ordered scheme pair among **MT** (Hebrew/Masoretic), **LXX** (Septuagint Greek OT), and **English** (KJV).
- Only verses whose numbering **differs from identity** are stored; anything not in the table maps to itself. Entries mapped to `null` mean "no equivalent in the target scheme" (e.g. a Hebrew Psalm superscription that the KJV does not number).
- A `VersificationSource` (`src/source.ts`) with `priority: 10`, so it overrides core's built-in mapping (priority `0`) for the pairs it covers.

Examples of what TVTMS adds over the built-in:

- LXX Genesis 31:55 = MT Genesis 32:1 (Laban blesses his sons/daughters).
- LXX Numbers 16:36 = MT Numbers 17:1.
- LXX Psalm 50:1 = MT Psalm 51:1 (the Greek Psalter is offset by one).
- English Joel 2:28 = MT Joel 3:1 (Hebrew Joel has four chapters).

## Scope (v1)

- **39 Old Testament books** (Protestant canon) only.
- Schemes: **MT**, **LXX** (the first Greek column of TVTMS), **English** (KJV). The Latin column and additional Greek variant columns are not included.
- **New Testament rows are skipped** — the Textus-Receptus Greek NT already uses KJV numbering, which core handles directly.
- Structurally-divergent books (e.g. Jeremiah's whole-book reorder, Exodus 35–40, 1 Kings / 3 Kingdoms) contain many-to-one and block reorderings; those rows are surfaced (and any normalization conflicts recorded in the validation report) rather than silently dropped.

## Usage

```typescript
import '@metaxia/scriptures-source-stepbible-versification'; // auto-registers with core
import { sourceInfo } from '@metaxia/scriptures-source-stepbible-versification';

sourceInfo.mapRef('Genesis', 32, 1, 'MT', 'LXX');  // -> { chapter: 31, verse: 55 }
sourceInfo.mapRef('Genesis', 1, 1, 'MT', 'LXX');   // -> { chapter: 1, verse: 1 } (identity)
sourceInfo.mapRef('Psalms', 3, 1, 'MT', 'English');// -> null (no numbered equivalent)
```

Importing the package for its side effect calls `registerVersification(sourceInfo)` on core, so once core exposes the versification registry the mapping is available to `mapVerse`/`getParallelVerses` automatically, preferred over the built-in.

## Development

```bash
npm install
npm run import   # pin STEPBible SHA, fetch TVTMS, parse, normalize, validate
npm run build
npm test
```

`npm run import`:

1. Resolves STEPBible-Data's current `master` commit SHA via the GitHub API and fetches the TVTMS file **at that pinned SHA** (cached under `source/`). Writes `data/stepbible-versification/SOURCE.json` (`repo`, `sha`, `sha256`, `retrieved: null` — a human stamps `retrieved`).
2. Parses the TVTMS Condensed table into aligned per-tradition rows.
3. Normalizes to `data/stepbible-versification/mapping.json` (identity-omitted).
4. Validates every mapped target against actual verse text in the companion packages (openscriptures-OHB = MT, crosswire-KJV = English, swete-lxx = LXX) and writes `data/stepbible-versification/validation-report.json`.

## Source & attribution

- **Upstream data:** [STEPBible-Data TVTMS](https://github.com/STEPBible/STEPBible-Data)
- **Original creators:** STEP Bible / Tyndale House, Cambridge
- **Data license:** [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)

> Data provided by STEP Bible (www.STEPBible.org) under CC BY 4.0. Original work by Tyndale House, Cambridge.

**Canonical source:** STEPBible asks that others be referred to [github.com/STEPBible/STEPBible-Data](https://github.com/STEPBible/STEPBible-Data) as the authoritative source of the TVTMS data (so corrections flow from one place). CC BY 4.0 permits our redistribution of this reformatted subset, but for the original, complete, up-to-date data please go upstream.

### Changes made to the data (CC BY "indicate changes")

This package **reformats** the TVTMS text file into JSON: it restricts to the 39 OT books and the MT/LXX/English subset, drops the Latin and extra-Greek columns and the NT rows, and stores only entries that differ from identity. The underlying versification facts are unchanged. See the `MODIFICATIONS` section of [LICENSE](./LICENSE).

## License

Dual-licensed: **MIT** for the code, **CC BY 4.0** for the TVTMS-derived data. See [LICENSE](./LICENSE).
