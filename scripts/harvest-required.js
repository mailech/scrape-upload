// Regenerate lib/requiredFields.json — the set of fields the new site's FORMS mark as required
// (red *). Scans the frontend form components for <FormX ... required ... formData.<field>>.
// DEV-only: needs the main repo's frontend next to this project. Run from scrape-upload/:
//   node scripts/harvest-required.js
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..', 'frontend', 'src', 'pages', 'dashboard', 'shared', 'forms');
if (!fs.existsSync(root)) { console.error('frontend forms not found at', root); process.exit(1); }

const files = [];
(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.tsx')) files.push(p); } })(root);

const req = new Set();
const blockRe = /<Form\w+[\s\S]*?\/>/g;
for (const f of files) {
    const blocks = fs.readFileSync(f, 'utf8').match(blockRe) || [];
    for (const b of blocks) { if (!/\brequired\b/.test(b)) continue; const m = b.match(/formData\.(\w+)/); if (m) req.add(m[1]); }
}
const arr = [...req].sort();
fs.writeFileSync(path.join(__dirname, '..', 'lib', 'requiredFields.json'), JSON.stringify(arr));
console.log('scanned', files.length, 'components ->', arr.length, 'required fields written to lib/requiredFields.json');
