// The form catalogue: one entry per scraped sheet -> target Prisma model.
//
// Each map() returns a record WITHOUT kvkId (the engine injects the per-row resolved kvkId).
// We write DIRECTLY to Prisma (not through the site's repositories) on purpose: this is a bulk
// historical import, and the repos reject rows the scrape simply doesn't have (e.g. demonstration
// rows carry no mobile number, which the repo's required-mobile validation would throw on).
//
// issues(r, ctx) returns a structured validation list: [{ field, message, severity }] where
// severity is 'error' (must fix before importing) or 'warn' (imported, but you should review).
// This is where a dropdown/master value that exists on the OLD site but NOT in our new DB gets
// FLAGGED by name — never silently dropped. (KVK matching is flagged by the engine, not here.)

const crypto = require('crypto');

// ---------- pure helpers ----------
const S = (v) => String(v == null ? '' : v).trim();
const num = (v) => { const n = parseFloat(S(v).replace(/,/g, '')); return isFinite(n) ? n : 0; };
const int = (v) => Math.trunc(num(v));
const yearOf = (v) => { const m = S(v).match(/(19|20)\d{2}/); return m ? parseInt(m[0], 10) : null; };
// read the first non-empty of several possible column names. Tolerant: case/punctuation-insensitive
// exact match first, then a "header contains this fragment" fallback (scrapes vary in wording, e.g.
// "Cropping patter of Farmer plot", "Technology demonstrated").
const _n = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
const pick = (r, ...names) => {
    const keys = Object.keys(r);
    for (const n of names) { const nn = _n(n); const k = keys.find((k) => _n(k) === nn); if (k && String(r[k]).trim() !== '') return String(r[k]).trim(); }
    for (const n of names) { const nn = _n(n); if (nn.length < 4) continue; const k = keys.find((k) => _n(k).includes(nn)); if (k && String(r[k]).trim() !== '') return String(r[k]).trim(); }
    return '';
};
const gender = (v) => /female/i.test(String(v == null ? '' : v)) ? 'FEMALE' : 'MALE';
const category = (v) => { const u = String(v == null ? '' : v).toUpperCase().replace(/[^A-Z]/g, ''); if (u.includes('OBC')) return 'OBC'; if (u.startsWith('SC')) return 'SC'; if (u.startsWith('ST')) return 'ST'; return 'GENERAL'; };

const D = (v) => {
    v = S(v); if (!v) return null;
    let iso = v;
    if (/^\d{1,2}-\d{1,2}-\d{4}$/.test(v)) { const [d, m, y] = v.split('-'); iso = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`; }
    const dt = new Date(iso);
    return isNaN(dt.getTime()) ? null : dt;
};

const ryYear = (r, cols = ['Reporting Year', 'Year']) => {
    for (const c of cols) { const y = yearOf(r[c]); if (y) return y; }
    for (const k of Object.keys(r)) { const y = yearOf(r[k]); if (y) return y; }
    return 2025;
};
const ryDate = (r, cols) => new Date(Date.UTC(ryYear(r, cols), 0, 1));

// issue builders
const ISS = (field, message, severity = 'warn') => ({ field, message, severity });
// a single old-site total that has no matching column on the new model -> warn, value preserved elsewhere
const stash = (field, label, n) => n ? [ISS(field, `${label} (${n}) has no column on this form — kept under "${field}"`)] : [];

// ---------- OFT result helpers (mirror the new-site oftRepository conventions exactly) ----------
const oftStatus = (v) => /transfer/i.test(S(v)) ? 'TRANSFERRED_TO_NEXT_YEAR' : (/complet/i.test(S(v)) ? 'COMPLETED' : 'ONGOING');
// column/row key slugs, matching the site: "Yield (q/ha)*" -> "yield_q_ha"; label stored as "Foo *"
const oftSlug = (label) => S(label).replace(/\*+$/, '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
const oftLabel = (label) => S(label).replace(/\*+$/, '').trim() + ' *';
const oftOptionKey = (name, seed = 0) =>
    'opt_' + crypto.createHash('sha1').update(`${String(name || '').trim().toLowerCase()}:${seed}`).digest('hex').slice(0, 12);
// the first __resultTables entry is the treatment-definition table (Technology options / Details);
// the rest are the parameter grids that become OftResultTable rows.
const oftIsTechTable = (t) => t && t.columns && /technolog(y|ies)option/.test(_n(t.columns[0])) && _n(t.columns[1] || '') === 'details';

function oftBuildTechnologies(resultTables) {
    const t = (resultTables || []).find(oftIsTechTable);
    if (!t) return [];
    return (t.rows || [])
        .filter((r) => S(r[1]))                                    // keep only options that carry a detail
        .map((r, i) => ({ optionKey: oftOptionKey(S(r[0]), i), optionName: S(r[0]), details: S(r[1]) }));
}
function oftBuildResultTables(resultTables) {
    const grids = (resultTables || []).filter((t) => !oftIsTechTable(t) && t.columns && t.columns.length && t.rows && t.rows.length);
    return grids.map((t, ti) => {
        const columns = t.columns.map((c, ci) => ({
            columnKey: ci === 0 ? 'tech_option' : oftSlug(c),
            columnLabel: oftLabel(c),
            isMandatory: ci === 0,
            sortOrder: ci + 1,
        }));
        const rows = t.rows.map((r, ri) => {
            const cells = {};
            columns.forEach((col, ci) => { cells[col.columnKey] = S(r[ci]); });
            return { optionKey: 'fixed_' + oftSlug(r[0]), rowLabel: S(r[0]), sortOrder: ri + 1, cells };
        });
        return { tableTitle: S(t.title) || `Table ${ti + 1}`, sortOrder: ti + 1, columns, rows };
    });
}
// full nested payload stashed on the mapped record (dropped from the scalar create, read by postCreate)
function oftBuildNested(r) {
    const res = r.__result || {};
    return {
        technologies: oftBuildTechnologies(r.__resultTables),
        tables: oftBuildResultTables(r.__resultTables),
        report: {
            finalRecommendation: S(res.final_recommendation),
            constraintsFeedback: S(res.constraints_identified) || S(r['Constraints identified and feedback for research']),
            farmersParticipationProcess: S(res.farmers_participation) || S(r['Process of farmers participation and their reaction']),
            resultText: S(res.result_description) || S(r['Result']),
            remark: S(res.remark) || S(r['Remark']),
        },
    };
}
// write the result report's tables/columns/rows/cells (sequential — cells need the created column ids)
async function oftWriteResultTables(prisma, reportId, tables) {
    for (const t of (tables || [])) {
        const table = await prisma.oftResultTable.create({ data: { oftResultReportId: reportId, tableTitle: t.tableTitle, sortOrder: t.sortOrder } });
        const colByKey = {};
        for (const c of t.columns) {
            const col = await prisma.oftResultTableColumn.create({ data: { oftResultTableId: table.oftResultTableId, columnKey: c.columnKey, columnLabel: c.columnLabel, isMandatory: c.isMandatory, sortOrder: c.sortOrder } });
            colByKey[c.columnKey] = col.oftResultTableColumnId;
        }
        for (const row of t.rows) {
            const createdRow = await prisma.oftResultTableRow.create({ data: { oftResultTableId: table.oftResultTableId, optionKey: row.optionKey, rowLabel: row.rowLabel, sortOrder: row.sortOrder } });
            const cellInserts = Object.entries(row.cells).map(([k, v]) => colByKey[k] ? { oftResultTableRowId: createdRow.oftResultTableRowId, oftResultTableColumnId: colByKey[k], value: S(v) } : null).filter(Boolean);
            if (cellInserts.length) await prisma.oftResultTableCell.createMany({ data: cellInserts });
        }
    }
}
// idempotent attach of technologies + result report + tables after the parent kvkoft exists
async function oftPostCreate(prisma, oft, rawRec) {
    const nested = (rawRec && rawRec._oft) || {};
    const techCount = await prisma.kvkoftTechnology.count({ where: { kvkOftId: oft.kvkOftId } });
    if (!techCount && nested.technologies && nested.technologies.length) {
        await prisma.kvkoftTechnology.createMany({ data: nested.technologies.map((t) => ({ kvkOftId: oft.kvkOftId, optionKey: t.optionKey, optionName: t.optionName, details: t.details })) });
    }
    const existRep = await prisma.oftResultReport.findUnique({ where: { kvkOftId: oft.kvkOftId }, select: { oftResultReportId: true } });
    const rep = nested.report || {};
    const hasReport = rep.finalRecommendation || rep.resultText || (nested.tables && nested.tables.length);
    if (!existRep && hasReport) {
        const created = await prisma.oftResultReport.create({ data: { kvkOftId: oft.kvkOftId, finalRecommendation: rep.finalRecommendation || '', constraintsFeedback: rep.constraintsFeedback || '', farmersParticipationProcess: rep.farmersParticipationProcess || '', resultText: rep.resultText || '', remark: rep.remark || '' }, select: { oftResultReportId: true } });
        await oftWriteResultTables(prisma, created.oftResultReportId, nested.tables);
    }
}

// ctx = { season(name) -> seasonId|null }
function buildForms(ctx) {
    const season = (name) => ctx.season(S(name));
    // season dropdown miss -> warn by name (old-site value not in our season master)
    const seasonIssue = (r, field, fallbackNote) => {
        const v = S(r['Season']); if (!v) return [];
        return season(v) ? [] : [ISS(field, `Season "${v}" isn't in the new site's list — ${fallbackNote}. Pick the right season.`)];
    };

    return [
        // ============================== NICRA ==============================
        {
            sheet: 'View_Intervention', label: 'NICRA — Intervention', model: 'nicraIntervention', kvkCols: ['KVK Name', 'KVK'],
            map: (r) => ({
                startDate: D(r['Start Date']) || ryDate(r), endDate: D(r['End Date']) || ryDate(r),
                crop: S(r['Crop']), variety: S(r['Variety']), quantityQ: num(r['Quantity in (q)']),
            }),
            key: (d, kvkId) => ({ kvkId, crop: d.crop, variety: d.variety, startDate: d.startDate }),
        },
        {
            sheet: 'Revenue_generated', label: 'NICRA — Revenue Generated', model: 'nicraRevenueGenerated', kvkCols: ['KVK', 'KVK Name'],
            map: (r) => ({ reportingYear: ryDate(r), revenue: num(r['Revenue']) }),
            key: (d, kvkId) => ({ kvkId, reportingYear: d.reportingYear, revenue: d.revenue }),
        },
        {
            sheet: 'View_Custom_Hiring_of_Farm', label: 'NICRA — Custom Hiring of Farm Implement', model: 'nicraFarmImplement', kvkCols: ['KVK', 'KVK Name'],
            map: (r) => ({
                reportingYear: ryDate(r), startDate: ryDate(r), endDate: ryDate(r),
                nameOfFarmImplement: S(r['Name of farm implement/equipment']),
                areaCovered: num(r['Area covered']),
                farmImplementUsedHours: num(r['Farm Implement used (In Hours)']),
                revenueGeneratedRs: num(r['Revenue generated (Rs.)']),
                expenditureIncurredRepairingRs: num(r['Expenditure incurred on repairing (Rs.)']),
                generalM: int(r['No. of farmers used Implement']),
            }),
            key: (d, kvkId) => ({ kvkId, nameOfFarmImplement: d.nameOfFarmImplement, reportingYear: d.reportingYear }),
            issues: (r) => stash('generalM', 'No. of farmers used Implement', int(r['No. of farmers used Implement'])),
        },
        {
            sheet: 'View_Village_Climate_Risk_', label: 'NICRA — Village-wise VCRMC', model: 'nicraVcrmc', kvkCols: ['KVK', 'KVK Name'],
            map: (r) => ({
                reportingYear: ryDate(r), villageName: S(r['Village name']),
                constitutionDate: D(r['VCRMC Constitution date']) || ryDate(r),
                meetingsOrganized: int(r['Meetings organized by VCRMC (no.)']),
                meetingDate: D(r['Date of VCRMC meeting']) || ryDate(r),
                nameOfSecretary: S(r['Name of Secretary']), nameOfPresident: '', majorDecisionTaken: '',
                maleMembers: int(r['VCRMC members (no.)']), femaleMembers: 0,
            }),
            key: (d, kvkId) => ({ kvkId, villageName: d.villageName, constitutionDate: d.constitutionDate }),
            issues: (r) => int(r['VCRMC members (no.)']) ? [ISS('maleMembers', `VCRMC members total (${int(r['VCRMC members (no.)'])}) kept under Male-members (no separate total column)`)] : [],
        },
        {
            sheet: 'View_Soil_Health_Card', label: 'NICRA — Soil Health Card', model: 'nicraSoilHealthCard', kvkCols: ['KVK', 'KVK Name'],
            map: (r) => ({
                startDate: D(r['Start Date']) || ryDate(r), endDate: D(r['End Date']) || ryDate(r),
                noOfSoilSamplesCollected: int(r['No. of soil samples collected']),
                noOfSamplesAnalysed: int(r['No. of samples analysed']),
                shcIssued: int(r['SHC issued']),
                generalM: int(r['No. of farmers benefitted']),
            }),
            key: (d, kvkId) => ({ kvkId, startDate: d.startDate, endDate: d.endDate, shcIssued: d.shcIssued }),
            issues: (r) => stash('generalM', 'No. of farmers benefitted', int(r['No. of farmers benefitted'])),
        },
        {
            sheet: 'View_Convergence_Programme', label: 'NICRA — Convergence Programme', model: 'nicraConvergenceProgramme', kvkCols: ['KVK', 'KVK Name'],
            map: (r) => ({
                startDate: D(r['Start Date']) || ryDate(r), endDate: D(r['End Date']) || ryDate(r),
                developmentSchemeProgramme: S(r['Development Scheme/Programme']),
                natureOfWork: S(r['Nature of work']), amountRs: num(r['Amount (Rs.)']),
            }),
            key: (d, kvkId) => ({ kvkId, developmentSchemeProgramme: d.developmentSchemeProgramme, startDate: d.startDate }),
        },
        {
            sheet: 'View_Dignitaries_Visited', label: 'NICRA — Dignitaries Visited', model: 'nicraDignitariesVisited', kvkCols: ['KVK', 'KVK Name'],
            map: (r) => ({
                dateOfVisit: D(r['Date of visited']) || ryDate(r), name: S(r['Name']), remark: '',
            }),
            key: (d, kvkId) => ({ kvkId, name: d.name, dateOfVisit: d.dateOfVisit }),
            fk: [{ field: 'dignitaryTypeId', master: 'nicraDignitaryType', from: (r) => S(r['VIP/Experts']) }],
            fkFields: { dignitaryTypeId: 'nicraDignitaryType' },
        },
        {
            sheet: 'View_Investigator', label: 'NICRA — PI / Co-PI List', model: 'nicraPiCopi', kvkCols: ['KVK', 'KVK Name'],
            map: (r) => ({
                startDate: D(r['Start Date']) || ryDate(r), endDate: D(r['End Date']) || ryDate(r),
                name: S(r['Name']),
            }),
            key: (d, kvkId) => ({ kvkId, name: d.name, startDate: d.startDate }),
            fk: [{ field: 'piTypeId', master: 'nicraPiType', from: (r) => S(r['PI/CO PI']) }],
            fkFields: { piTypeId: 'nicraPiType' },
        },
        {
            sheet: 'View_Any_Other_Program', label: 'NICRA — Any Other Programme', model: 'kvkOtherProgramme', kvkCols: ['KVK', 'KVK Name'],
            map: (r) => ({
                programmeName: S(r['Name of the programme']), programmeDate: D(r['Date of the programme']) || ryDate(r),
                venue: S(r['Venue']), purpose: S(r['Purpose']),
                farmersGeneralM: int(r['No. of participants']), farmersGeneralF: 0,
                farmersObcM: 0, farmersObcF: 0, farmersScM: 0, farmersScF: 0, farmersStM: 0, farmersStF: 0,
            }),
            key: (d, kvkId) => ({ kvkId, programmeName: d.programmeName, programmeDate: d.programmeDate }),
            issues: (r) => stash('farmersGeneralM', 'No. of participants', int(r['No. of participants'])),
        },

        // ===================== Out-scaling of Natural Farming =====================
        {
            sheet: 'Geographical_Information', label: 'Natural Farming — Geographical Info', model: 'geographicalInfo', kvkCols: ['KVK Name', 'KVK'],
            map: (r) => {
                const start = D(r['Start Date']) || ryDate(r);
                return {
                    startDate: start, endDate: D(r['End Date']) || start, reportingYear: start,
                    agroClimaticZone: S(r['Agro Climatic Zone']),
                    farmingSituation: S(r['Farming Situation of the Selected Farmer']),
                    latitude: num(r['Latitude (N)']), longitude: num(r['Longitude (E)']),
                };
            },
            key: (d, kvkId) => ({ kvkId, startDate: d.startDate, agroClimaticZone: d.agroClimaticZone }),
        },
        {
            sheet: 'Natural_Farming', label: 'Natural Farming — Physical Info / Training', model: 'physicalInfo', kvkCols: ['KVK Name', 'KVK'],
            map: (r) => ({
                trainingTitle: S(r['Title of Natural Farming training Programme']) || S(r['Activity Name']),
                trainingDate: D(r['Date of Training']) || ryDate(r),
                venue: S(r['Venue of programme']),
                generalM: int(r['Participants']), generalF: 0, obcM: 0, obcF: 0, scM: 0, scF: 0, stM: 0, stF: 0,
                remarks: '',
            }),
            key: (d, kvkId) => ({ kvkId, trainingTitle: d.trainingTitle, trainingDate: d.trainingDate }),
            fk: [{ field: 'activityId', master: 'nfActivity', from: (r) => S(r['Activity Name']) }],
            fkFields: { activityId: 'nfActivity' },
            issues: (r) => stash('generalM', 'Participants', int(r['Participants'])),
        },
        {
            sheet: 'Demonstration_Information', label: 'Natural Farming — Demonstration Info', model: 'demonstrationInfo', kvkCols: ['KVK Name', 'KVK'],
            map: (r) => ({
                reportingYear: ryDate(r),
                startDate: D(r['Start Date']) || ryDate(r),
                endDate: D(r['End Date']) || D(r['Start Date']) || ryDate(r),
                farmerName: pick(r, 'Farmer Name', 'Name of Farmer'),
                villageName: pick(r, 'Village Name', 'Village'),
                address: pick(r, 'Address', 'Full Address'),
                contactNumber: pick(r, 'Contact Number', 'Mobile', 'Mobile Number', 'Cell no.', 'Phone'),
                gender: gender(pick(r, 'Gender', 'Sex')),
                category: category(pick(r, 'Category', 'Social Category')),
                croppingPattern: pick(r, 'Cropping patter', 'Cropping pattern', 'Cropping System'),
                farmingSituation: pick(r, 'Farming Situation'),
                latitude: num(pick(r, 'Latitude (N)', 'Latitude')),
                longitude: num(pick(r, 'Longitude (E)', 'Longitude')),
                activityName: pick(r, 'Name of Activity', 'Activity Name', 'Activity'),
                crop: S(r['Crop']), variety: S(r['Variety']),
                seasonId: season(pick(r, 'Season')) || undefined,
                technologyDemonstrated: pick(r, 'Technology demonstrated', 'Technology'),
                areaInHa: num(pick(r, 'Area (ha) in Natural farming practice', 'Area (ha)', 'Area')),
                farmerPracticeDetails: pick(r, 'Detail of farmer practice', 'Farmer Practice Details', 'Motivation Factors'),
                farmerFeedback: pick(r, 'Farmer Feedback', 'Farmers Feedback', 'Feedback'),
            }),
            key: (d, kvkId) => ({ kvkId, farmerName: d.farmerName, activityName: d.activityName, crop: d.crop }),
            fkFields: { seasonId: 'season' },
            issues: (r) => seasonIssue(r, 'seasonId', 'left blank'),
        },
        {
            sheet: 'Farmer_Details', label: 'Natural Farming — Farmer Already Practicing', model: 'demonstrationInfo', kvkCols: ['KVK Name', 'KVK'],
            map: (r) => ({
                reportingYear: ryDate(r), startDate: D(r['Start Date']) || ryDate(r), endDate: D(r['End Date']) || ryDate(r),
                farmerName: pick(r, 'Farmer Name', 'Name of Farmer'),
                villageName: pick(r, 'Village Name', 'Village'),
                address: pick(r, 'Address', 'Full Address'),
                contactNumber: pick(r, 'Contact Number', 'Mobile', 'Mobile Number', 'Cell no.', 'Phone'),
                gender: gender(pick(r, 'Gender', 'Sex')), category: category(pick(r, 'Category', 'Social Category')),
                croppingPattern: pick(r, 'Normal crops grown', 'Cropping pattern', 'Cropping Pattern'),
                farmingSituation: pick(r, 'Farming Situation'),
                latitude: num(pick(r, 'Latitude', 'Latitude (N)')), longitude: num(pick(r, 'Longitude', 'Longitude (E)')),
                activityName: 'Already Practicing Natural Farming',
                crop: pick(r, 'Normal crops grown', 'Crop'), variety: S(r['Variety']),
                seasonId: season(pick(r, 'Season')) || undefined,
                technologyDemonstrated: '', areaInHa: num(pick(r, 'Area (ha)', 'Area')),
                farmerPracticeDetails: S(r['Practicing year of natural farming']) ? `Practicing since ${S(r['Practicing year of natural farming'])}` : pick(r, 'Farmer Practice Details'),
                farmerFeedback: pick(r, 'Farmer Feedback', 'Feedback'),
            }),
            fkFields: { seasonId: 'season' },
            key: (d, kvkId) => ({ kvkId, farmerName: d.farmerName, activityName: d.activityName }),
        },
        {
            sheet: 'Beneficiaries_Details', label: 'Natural Farming — Beneficiaries', model: 'beneficiariesDetails', kvkCols: ['KVK Name', 'KVK'],
            map: (r) => ({
                year: ryYear(r), reportingYearDate: ryDate(r),
                blocksCovered: int(r['Number of block']), villagesCovered: int(r['Number of village']),
                totalTrainedFarmers: int(r['Number of training']),
                farmersInfluenced: int(r['No. of farmers influenced to adopt Natural Farming']),
                farmersEngagedAllSeason: 0, farmersEngagedOneSeason: 0, remarks: '',
            }),
            key: (d, kvkId) => ({ kvkId, blocksCovered: d.blocksCovered, villagesCovered: d.villagesCovered, totalTrainedFarmers: d.totalTrainedFarmers }),
        },
        {
            sheet: 'Soil_Information', label: 'Natural Farming — Soil Data', model: 'soilDataInformation', kvkCols: ['KVK Name', 'KVK'],
            map: (r) => ({
                year: ryYear(r), reportingYearDate: ryDate(r), crop: S(r['Crop']), seasonId: season(r['Season']) || undefined,
                phBefore: num(r['Before pH']), ecBefore: num(r['Before EC (dS/m)']), ocBefore: num(r['Before EC OC (%)']),
                nBefore: 0, pBefore: 0, kBefore: 0, soilMicrobesBefore: 0,
                phAfter: num(r['After pH']), ecAfter: num(r['After EC (dS/m)']), ocAfter: num(r['After EC OC (%)']),
                nAfter: 0, pAfter: 0, kAfter: 0, soilMicrobesAfter: 0,
            }),
            key: (d, kvkId) => ({ kvkId, crop: d.crop, phBefore: d.phBefore, phAfter: d.phAfter }),
            fk: [{ field: 'soilParameterId', master: 'nfSoilParameter', from: (r) => S(r['Type']) }],
            fkFields: { seasonId: 'season', soilParameterId: 'nfSoilParameter' },
            issues: (r) => seasonIssue(r, 'seasonId', 'left blank'),
        },
        {
            sheet: 'Financial_information', label: 'Natural Farming — Budget / Financial', model: 'financialInformation', kvkCols: ['KVK Name', 'KVK'],
            map: (r) => ({
                year: ryYear(r), reportingYearDate: ryDate(r),
                numberOfActivities: int(r['Number of activity organised']),
                budgetSanction: num(r['Budget sanction (Rs)']), budgetExpenditure: num(r['Budget expenditure (Rs)']),
                totalBudgetExpenditure: num(r['Total Budget Expenditure (Rs)']),
            }),
            key: (d, kvkId) => ({ kvkId, budgetSanction: d.budgetSanction, budgetExpenditure: d.budgetExpenditure, numberOfActivities: d.numberOfActivities }),
            fk: [{ field: 'activityId', master: 'nfActivity', from: (r) => S(r['Name of Activity']) }],
            fkFields: { activityId: 'nfActivity' },
        },

        // ============================== Agri-Drone ==============================
        {
            sheet: 'View_Agri_Drone', label: 'Agri-Drone — Introduction', model: 'kvkAgriDrone', kvkCols: ['KVK Name', 'KVK'],
            map: (r) => ({
                reportingYear: ryDate(r),
                projectImplementingCentre: pick(r, 'Name of the project implementing centre (PIC)', 'Project implementing centre name', 'Project Implementing Centre'),
                droneCompany: pick(r, 'Company of Drone'),
                droneModel: pick(r, 'Model of Drone'),
                dronesSanctioned: int(pick(r, 'No. of Agri Drones Sanctioned')),
                dronesPurchased: int(pick(r, 'No. of Agri Drones Purchased')),
                amountSanctioned: num(pick(r, 'Amount sanctioned (Rs)')),
                costPerDrone: num(pick(r, 'Purchased cost of each Drone (Rs.)', 'Purchased cost of each Drone')),
                pilotName: pick(r, 'Name Agri Drone Pilot', 'Name of Agri Drone Pilot', 'Pilot Name'),
                pilotContact: pick(r, 'Contact No of Agri Drone Pilot', 'Contact No. of Agri Drone Pilot', 'Pilot Contact'),
                targetAreaHa: num(pick(r, 'Target Area for Agri Drone Demonstration', 'Target Area')),
                demoAmountSanctioned: num(pick(r, 'Amount sanctioned for Agri Drone Demonstrations (Rs.)', 'Amount sanctioned for Agri Drone Demonstrations')),
                demoAmountUtilised: num(pick(r, 'Amount utilised for Agri Drone Demonstrations (Rs.)', 'Amount utilised for Agri Drone Demonstrations')),
                operationType: pick(r, 'Operation carried out (Pesticide/Weedicide/Nutrient application) in demonstration organised', 'Operation carried out'),
                advantagesObserved: pick(r, 'Advantages of using Agri Drones as observed during the demonstrations', 'Advantages of using Agri Drones'),
            }),
            key: (d, kvkId) => ({ kvkId, reportingYear: d.reportingYear, projectImplementingCentre: d.projectImplementingCentre }),
        },
        {
            sheet: 'View_Agri_Drone_Demonstrat', label: 'Agri-Drone — Demonstration Details', model: 'kvkAgriDroneDemonstration', kvkCols: ['KVK Name', 'KVK'],
            needsParentAgriDrone: true,
            map: (r) => ({
                reportingYear: ryDate(r),
                dateOfDemonstration: D(r['Date of Demons.']), placeOfDemonstration: S(r['Place of demons.']),
                cropName: S(r['Crop Name']), noOfDemos: int(r['No. of demos']),
                areaHa: num(r['Area covered under demos.']), noOfFarmers: int(r['No of farmers']),
            }),
            key: (d, kvkId) => ({ kvkId, dateOfDemonstration: d.dateOfDemonstration, placeOfDemonstration: d.placeOfDemonstration, cropName: d.cropName }),
            issues: () => [ISS('agriDroneId', 'Links to this KVK\'s Agri-Drone intro record — import "Agri-Drone — Introduction" first', 'warn')],
        },

        // ============================== Seed Hub ==============================
        {
            sheet: 'View_Seed_Hub_Program', label: 'Seed Hub Program', model: 'kvkSeedHubProgram', kvkCols: ['KVK Name', 'KVK'],
            map: (r) => ({
                reportingYear: ryDate(r), seasonId: season(r['Season']) || 1,
                cropName: S(r['Crop Name']), varietyName: S(r['Variety']),
                areaCoveredHa: num(r['Area (ha)']), yieldQPerHa: num(r['Yield (ha)']),
                quantityProducedQ: 0, quantitySaleOutQ: 0, farmersPurchased: 0, quantitySaleToFarmersQ: 0,
                villagesCovered: 0, quantitySaleToOtherOrgQ: 0, amountGeneratedLakh: 0, totalAmountPresentLakh: 0,
            }),
            key: (d, kvkId) => ({ kvkId, cropName: d.cropName, varietyName: d.varietyName, seasonId: d.seasonId }),
            fkFields: { seasonId: 'season' },
            issues: (r) => seasonIssue(r, 'seasonId', 'defaulted to the first season (#1)'),
        },

        // ============================== OFT (On-Farm Trial) — with results ==============================
        // Writes the main kvkoft record, then (via postCreate) its treatment options + result report +
        // result tables (columns/rows/cells), exactly as the new-site OFT Result form stores them.
        {
            sheet: 'View_OFT_Details', label: 'OFT — On-Farm Trial (with results)', model: 'kvkoft', kvkCols: ['KVK Name', 'KVK'],
            // per-KVK staff roster lookup (resolved by the engine, since it needs the row's kvkId)
            staff: { col: 'Staff', field: 'staffId' },
            map: (r) => ({
                seasonId: season(r['Season']) || undefined,
                title: S(r['Title of On farm Trial (OFT)']),
                problemDiagnosed: S(r['Problem diagnosed']),
                sourceOfTechnology: S(r['Source of Technology (ICAR/ AICRP/SAU/other, please specify)']),
                productionSystem: S(r['Production system and thematic area']),
                performanceIndicators: S(r['Performance indicators of the technology']),
                quantity: num(r['Area(ha)/Number']),
                numberOfLocation: 0,
                numberOfTrialReplication: int(r['No. of Trial/Replication']),
                oftStartDate: D(r['OFT Start on']) || ryDate(r),
                criticalInput: S(r['Critical Input']),
                costOfOft: num(r['Cost of OFT']),
                farmersGeneralM: int(r['General_M']), farmersGeneralF: int(r['General_F']),
                farmersObcM: int(r['OBC_M']), farmersObcF: int(r['OBC_F']),
                farmersScM: int(r['SC_M']), farmersScF: int(r['SC_F']),
                farmersStM: int(r['ST_M']), farmersStF: int(r['ST_F']),
                status: oftStatus(r['Ongoing/Completed']),
                unit: null,
                _oft: oftBuildNested(r),                                   // nested payload for postCreate + preview
            }),
            fk: [
                { field: 'oftSubjectId', master: 'oftSubject', from: (r) => S(r['OFT Subject']) },
                { field: 'oftThematicAreaId', master: 'oftThematicArea', from: (r) => S(r['Thematic Area']) },
                { field: 'disciplineId', master: 'discipline', from: (r) => S(r['Discipline']) },
            ],
            fkFields: { seasonId: 'season', oftSubjectId: 'oftSubject', oftThematicAreaId: 'oftThematicArea', disciplineId: 'discipline' },
            issues: (r) => seasonIssue(r, 'seasonId', 'left blank'),
            key: (d, kvkId) => ({ kvkId, title: d.title }),
            postCreate: oftPostCreate,
        },
    ];
}

module.exports = { buildForms, S, num, int };
