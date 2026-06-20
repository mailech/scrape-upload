// Standalone uploader for the NICRA / Natural-Farming / Agri-Drone / Seed-Hub forms.
// Its own little app (own port, own page, own DB target). It does NOT touch the main site.
//
// This scrape is SUPERADMIN-side: one file holds many KVKs, every row carrying its own "KVK Name".
// So the flow is: upload -> preview (each row resolved to its KVK; unmatched rows get a dropdown)
// -> review/edit -> push. Writes go to whatever DATABASE_URL in .env points at (use a TEST DB).
//
// Run:  cd scrape-upload && npm install && cp .env.example .env  (point at TEST db) && npm start
const express = require('express');
const path = require('path');
const prisma = require('./config/db');
const { parse, transform, commit } = require('./lib/engine');
const { xlsxToSheets } = require('./lib/xlsxToSheets');

const app = express();
app.use(express.json({ limit: '120mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// accept a parsed scraper JSON `data` object OR a base64 .xlsx upload
async function toData(body) {
    if (body && body.xlsxBase64) return xlsxToSheets(Buffer.from(body.xlsxBase64, 'base64'));
    if (body && body.data && typeof body.data === 'object') return body.data;
    throw new Error('Upload a scraped .json or .xlsx file.');
}

app.get('/api/health', async (req, res) => {
    try {
        const n = await prisma.kvk.count();
        res.json({ ok: true, kvks: n, db: (process.env.DATABASE_URL || '').replace(/:[^:@/]+@/, ':****@').slice(0, 60) });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// phase 1: parse the upload -> raw old-site rows grouped by sheet. No DB, no mapping.
app.post('/api/parse', async (req, res) => {
    try {
        const data = await toData(req.body);
        res.json(Object.assign({ data }, parse({ data })));
    } catch (e) { res.status(400).json({ error: e.message }); }
});

// phase 2: transform -> mapped records + validation report (errors/warnings). No writes.
app.post('/api/transform', async (req, res) => {
    try {
        const data = await toData(req.body);
        const report = await transform({ prisma, data });
        res.json(report);
    } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/commit', async (req, res) => {
    try {
        if (!Array.isArray(req.body && req.body.forms)) throw new Error('Nothing to import — send reviewed forms.');
        const report = await commit({ prisma, forms: req.body.forms });
        res.json(report);
    } catch (e) { res.status(400).json({ error: e.message }); }
});

const PORT = process.env.PORT || 5070;
app.listen(PORT, () => {
    const target = (process.env.DATABASE_URL || '').replace(/:[^:@/]+@/, ':****@').slice(0, 70);
    console.log(`\n  NICRA / Natural-Farming / Agri-Drone / Seed-Hub uploader  ->  http://localhost:${PORT}`);
    console.log(`  Writing to: ${target}...`);
    console.log(`  (point DATABASE_URL at a TEST database first)\n`);
});
