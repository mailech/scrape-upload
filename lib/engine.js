// Three-phase engine, mirroring the Data Migration Tool's fetch -> transform -> seed:
//
//   parse({ data })             -> the RAW old-site rows grouped by sheet. NO mapping, NO DB.
//   transform({ prisma, data }) -> maps every row to our schema + a per-row/per-field VALIDATION
//                                  report (errors + warnings). Resolves KVK per row. NO writes.
//   commit({ prisma, forms })   -> inserts the user-reviewed rows. Dedup-guarded. Writes.
//
// This is a SUPERADMIN scrape: there is no single target KVK — the KVK travels with each row.

const { buildForms } = require('./forms');

// Prisma DMMF (from the bundled generated client) lets us drop any stray UI-added column that
// isn't a real field on the model, so create() never throws "Unknown argument".
let PrismaDmmf = null;
try { PrismaDmmf = require('@prisma/client').Prisma; } catch (e) { /* generated on install */ }
function modelScalars(model) {
    if (!PrismaDmmf) return null;
    try {
        const name = model.charAt(0).toUpperCase() + model.slice(1);
        const m = PrismaDmmf.dmmf.datamodel.models.find((x) => x.name === name);
        if (!m) return { __missing: true };
        const s = new Set();
        for (const f of m.fields) if (f.kind === 'scalar' || f.kind === 'enum') s.add(f.name);
        return s;
    } catch (e) { return null; }
}

// Mandatory fields = the red-* fields on the new site's FORMS (not the DB schema — the schema
// defaults everything). Harvested from the frontend form components into requiredFields.json, then
// intersected with each model's real columns. (Regenerate with scripts/harvest-required.js.)
let GLOBAL_REQUIRED = new Set();
try { GLOBAL_REQUIRED = new Set(require('./requiredFields.json')); } catch (e) { /* optional */ }
function modelRequired(model) {
    const sc = modelScalars(model);
    if (!sc || sc.__missing) return [];
    const out = [];
    for (const fld of sc) {
        if (['kvkId', 'reportingYearDate', 'reportingYear', 'agriDroneId'].includes(fld)) continue; // set automatically
        if (GLOBAL_REQUIRED.has(fld)) out.push(fld);
    }
    return out;
}
const isEmpty = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

// every user-fillable field on the model (so the grid can show ALL form fields, not just mapped
// ones), excluding auto-managed/media fields. Returns ordered names + their types.
const AUTO_FIELDS = new Set(['kvkId', 'reportingYearDate', 'agriDroneId', 'createdAt', 'updatedAt', 'deletedAt']);
const MEDIA_RE = /^(photographs|images|image|uploadFile|uploadedFile|attachmentPath)$/i;
function modelFieldList(model) {
    if (!PrismaDmmf) return { fields: [], types: {} };
    try {
        const name = model.charAt(0).toUpperCase() + model.slice(1);
        const m = PrismaDmmf.dmmf.datamodel.models.find((x) => x.name === name);
        if (!m) return { fields: [], types: {} };
        const fields = []; const types = {};
        const pk = model + 'Id';
        for (const f of m.fields) {
            if (!(f.kind === 'scalar' || f.kind === 'enum')) continue;
            if (f.isId || f.name === pk || f.name === 'id' || f.isUpdatedAt || AUTO_FIELDS.has(f.name) || MEDIA_RE.test(f.name)) continue;
            fields.push(f.name);
            types[f.name] = f.kind === 'enum' ? 'Enum' : f.type;
        }
        return { fields, types };
    } catch (e) { return { fields: [], types: {} }; }
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
function deISO(v) { return (typeof v === 'string' && ISO.test(v)) ? new Date(v) : v; }

async function loadSeasonRows(prisma) {
    let rows = [];
    try { rows = (await prisma.season.findMany()).map((s) => ({ id: s.seasonId, name: s.seasonName })); } catch (e) { /* */ }
    const map = {}; rows.forEach((s) => { map[String(s.name).toLowerCase().trim()] = s.id; });
    return { rows, lookup: (name) => map[String(name || '').toLowerCase().trim()] || null };
}

const normName = (s) => String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim();

// per-KVK staff roster: kvkId -> Map(normalized staffName -> kvkStaffId). Used to resolve OFT/FLD staff
// (staff is a KVK-scoped roster, not a global master, so it can't go through MasterResolver).
async function loadStaffByKvk(prisma) {
    const map = new Map();
    try {
        const rows = await prisma.kvkStaff.findMany({ select: { kvkStaffId: true, staffName: true, kvkId: true } });
        rows.forEach((s) => {
            if (!map.has(s.kvkId)) map.set(s.kvkId, new Map());
            map.get(s.kvkId).set(normName(s.staffName), s.kvkStaffId);
        });
    } catch (e) { /* */ }
    return map;
}

function pickKvkName(row, kvkCols) {
    for (const c of kvkCols) { const v = row[c]; if (v != null && String(v).trim()) return String(v).trim(); }
    return '';
}

function cleanRecord(model, raw) {
    const scalars = modelScalars(model);
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
        if (k.startsWith('_')) continue;
        if (v === undefined) continue;
        if (scalars && !scalars.__missing && !scalars.has(k)) continue;
        out[k] = deISO(v);
    }
    return out;
}

// The scraper splits very wide tables into a main sheet + a "<base> - <suffix>" continuation
// sheet (same rows, extra columns). Merge the continuation's columns back into the base sheet by
// row index when their row counts match, so no column data is lost or left "not handled".
function mergeContinuation(data) {
    if (!data || typeof data !== 'object') return data;
    const out = {};
    for (const k of Object.keys(data)) out[k] = data[k];
    for (const k of Object.keys(data)) {
        const m = k.match(/^(.+?) - .+$/);
        if (!m) continue;
        const base = m[1];
        if (!out[base] || !data[k]) continue;
        const baseRows = out[base].rows || [];
        const contRows = data[k].rows || [];
        if (!contRows.length) { delete out[k]; continue; }
        if (baseRows.length === contRows.length) {
            const rows = baseRows.map((row, i) => Object.assign({}, contRows[i], row)); // base wins on clash
            const headers = Array.from(new Set([...((out[base].headers) || []), ...((data[k].headers) || [])]));
            out[base] = { headers, rows };
            delete out[k];
        }
        // counts differ -> leave the continuation as its own sheet (shown, flagged not-handled)
    }
    return out;
}

// sheet -> form label (for naming raw sheets in parse)
function sheetLabels() {
    const map = {};
    buildForms({ season: () => null }).forEach((f) => { map[f.sheet] = f.label; });
    return map;
}

// ---------- phase 1: raw old data ----------
function parse({ data }) {
    data = mergeContinuation(data);
    const labels = sheetLabels();
    const sheets = Object.keys(data || {})
        .map((s) => {
            const rows = (data[s] && data[s].rows) || [];
            const headers = (data[s] && data[s].headers) || (rows[0] ? Object.keys(rows[0]) : []);
            return { sheet: s, label: labels[s] || null, mapped: !!labels[s], count: rows.length, headers, rows };
        })
        .filter((x) => x.count > 0)
        .sort((a, b) => (b.mapped - a.mapped) || a.sheet.localeCompare(b.sheet));
    return {
        sheets,
        totals: {
            sheets: sheets.length,
            rows: sheets.reduce((a, s) => a + s.count, 0),
            recognised: sheets.filter((s) => s.mapped).length,
            unrecognised: sheets.filter((s) => !s.mapped).length,
        },
    };
}

// ---------- phase 2: transform + validation report ----------
async function transform({ prisma, data }) {
    data = mergeContinuation(data);
    const { loadKvks, buildMatcher } = require('./kvk');
    const { MasterResolver, MASTER_KEYS } = require('./masters');
    const kvks = await loadKvks(prisma);
    const match = buildMatcher(kvks);
    const seasons = await loadSeasonRows(prisma);              // sync season() for the maps
    const resolver = await new MasterResolver(prisma).preload(MASTER_KEYS);
    const staffByKvk = await loadStaffByKvk(prisma);           // per-KVK roster for OFT/FLD staff
    const FORMS = buildForms({ season: seasons.lookup });

    const labels = sheetLabels();
    const handled = new Set(Object.keys(labels));
    const present = new Set(Object.keys(data || {}).filter((s) => ((data[s] && data[s].rows) || []).length));

    const forms = [];
    const totals = { rows: 0, mapped: 0, errors: 0, warnings: 0, rowsNeedingKvk: 0 };

    for (const f of FORMS) {
        const rows = (data[f.sheet] && data[f.sheet].rows) || [];
        if (!rows.length) continue;
        const sc = modelScalars(f.model);
        const required = modelRequired(f.model);
        const fl = modelFieldList(f.model);
        const out = { sheet: f.sheet, label: f.label, model: f.model, modelMissing: !!(sc && sc.__missing), fkFields: f.fkFields || {}, requiredFields: required, fields: fl.fields, fieldTypes: fl.types, rows: [], counts: { rows: 0, mapped: 0, errors: 0, warnings: 0 } };

        for (const r of rows) {
            const kvkName = pickKvkName(r, f.kvkCols);
            const m = match(kvkName);
            const issues = [];
            let rec;
            try { rec = f.map(r); } catch (e) { rec = { __error: e.message }; }

            if (rec.__error) {
                issues.push({ field: '(row)', message: 'Could not map: ' + rec.__error, severity: 'error' });
            } else {
                // KVK resolution — flagged here, by name
                if (!m.kvkId) issues.push({ field: 'kvkId', message: `KVK "${kvkName || '(blank)'}" not found in the new site — pick it manually`, severity: 'error' });
                else if (m.matched === 'fuzzy') issues.push({ field: 'kvkId', message: `Old name "${kvkName}" → our #${m.kvkId} "${m.kvkName}" (matched by name)`, severity: 'warn' });

                // resolve dropdown/master FKs by name; flag only if genuinely new (will be created on import)
                for (const fk of (f.fk || [])) {
                    const val = fk.from(r);
                    if (!val) continue;
                    const id = await resolver.resolve(fk.master, val);
                    if (id != null) rec[fk.field] = id;
                    else {
                        rec._fk = rec._fk || {};
                        rec._fk[fk.field] = { master: fk.master, value: val };
                        issues.push({ field: fk.field, message: `"${val}" isn't in the list yet — it will be added to the dropdown when you import`, severity: 'warn' });
                    }
                }

                // per-KVK staff resolution (OFT) — required FK to the KVK's own roster, not a global master.
                // Stash the raw name so commit can re-resolve authoritatively (never let a name reach create()).
                if (f.staff) {
                    rec._staffName = (r[f.staff.col] || '').toString().trim();
                    if (m.kvkId) {
                        const roster = staffByKvk.get(m.kvkId);
                        const sid = roster && roster.get(normName(rec._staffName));
                        if (sid) rec[f.staff.field] = sid;
                        else issues.push({ field: f.staff.field, message: `Staff "${rec._staffName || '(blank)'}" isn't in KVK #${m.kvkId}'s staff roster — required for OFT`, severity: 'error' });
                    }
                }

                // form-specific issues (season miss, stashed totals)
                if (f.issues) for (const it of (f.issues(r) || [])) issues.push(it);
                // NB: mandatory-but-empty is computed live in the browser (so it updates as you fill).
            }

            const row = { data: rec, _kvkId: m.kvkId, _kvkName: kvkName, _match: m.matched, _matchedName: m.kvkName, _issues: issues };
            out.rows.push(row);
            out.counts.rows++;
            if (!rec.__error) out.counts.mapped++;
            out.counts.errors += issues.filter((i) => i.severity === 'error').length;
            out.counts.warnings += issues.filter((i) => i.severity === 'warn').length;
            if (!m.kvkId) totals.rowsNeedingKvk++;
        }

        totals.rows += out.counts.rows; totals.mapped += out.counts.mapped;
        totals.errors += out.counts.errors; totals.warnings += out.counts.warnings;
        forms.push(out);
    }

    const masters = {}; MASTER_KEYS.forEach((k) => { masters[k] = resolver.options(k); });
    return {
        forms, kvks, masters,
        unmappedSheets: [...present].filter((s) => !handled.has(s)),
        totals,
    };
}

// ---------- phase 3: commit ----------
async function commit({ prisma, forms }) {
    const { MasterResolver } = require('./masters');
    const seasons = await loadSeasonRows(prisma);
    const resolver = new MasterResolver(prisma);
    const staffByKvk = await loadStaffByKvk(prisma);          // authoritative per-KVK staff roster
    const FORMS = buildForms({ season: seasons.lookup });
    const bySheet = {}; FORMS.forEach((f) => { bySheet[f.sheet] = f; });
    const inBySheet = {}; for (const inf of (forms || [])) inBySheet[inf.sheet] = inf;

    const report = { forms: [], totals: { inserted: 0, skipped: 0, failed: 0, noKvk: 0 } };

    for (const f of FORMS) { // catalogue order: Agri-Drone intro before its demonstrations
        const inf = inBySheet[f.sheet];
        if (!inf || !Array.isArray(inf.records) || !inf.records.length) continue;
        const res = { sheet: f.sheet, label: f.label, model: f.model, inserted: 0, skipped: 0, failed: 0, noKvk: 0, failures: [] };

        let i = 0;
        for (const rawRec of inf.records) {
            i++;
            const kvkId = Number(rawRec._kvkId);
            if (!kvkId) { res.noKvk++; continue; }
            try {
                const d = cleanRecord(f.model, rawRec);
                d.kvkId = kvkId;
                // any FK the user left unresolved -> find or CREATE the master row, then link it
                if (rawRec._fk) {
                    for (const [field, info] of Object.entries(rawRec._fk)) {
                        if (d[field] != null) continue; // user picked one in the grid
                        try { d[field] = await resolver.findOrCreate(info.master, info.value); } catch (e) { /* leave null */ }
                    }
                }
                if (f.needsParentAgriDrone) {
                    const intro = await prisma.kvkAgriDrone.findFirst({ where: { kvkId } });
                    if (!intro) throw new Error('No Agri-Drone intro record for this KVK yet — import "Agri-Drone — Introduction" first');
                    d.agriDroneId = intro.id ?? intro.kvkAgriDroneId ?? intro.agriDroneId ?? intro.kvkAgriDroneIntroId;
                }
                // per-KVK staff (OFT): re-resolve authoritatively from the roster so a name can NEVER reach
                // create(). Unresolved -> fail this row cleanly with a clear reason (no bad write).
                if (f.staff) {
                    const roster = staffByKvk.get(kvkId);
                    const sid = roster && roster.get(normName(rawRec._staffName));
                    if (sid) d[f.staff.field] = sid;
                    else { delete d[f.staff.field]; throw new Error(`Staff "${(rawRec._staffName || '').trim() || '(blank)'}" isn't in KVK #${kvkId}'s roster — add the staff member first, or fix the name`); }
                }
                const where = {};
                for (const [k, v] of Object.entries(f.key(d, kvkId))) where[k] = deISO(v);
                const ex = await prisma[f.model].findFirst({ where });
                let createdRec = ex;
                if (ex) { res.skipped++; }
                else { createdRec = await prisma[f.model].create({ data: d }); res.inserted++; }
                // nested children (e.g. OFT technologies + result report/tables) — idempotent, runs for
                // both freshly-created and pre-existing parents so results attach even to existing rows.
                if (f.postCreate) await f.postCreate(prisma, createdRec, rawRec);
                if (ex) continue;
            } catch (e) {
                res.failed++;
                if (res.failures.length < 10) res.failures.push({ row: i, kvkId, reason: e.message });
            }
        }
        report.totals.inserted += res.inserted; report.totals.skipped += res.skipped;
        report.totals.failed += res.failed; report.totals.noKvk += res.noKvk;
        report.forms.push(res);
    }
    return report;
}

module.exports = { parse, transform, commit };
