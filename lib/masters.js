// Master/dropdown resolver — mirrors the Data Migration Tool's MasterResolver.
// resolve(): name -> existing id (miss => null, so the UI can flag it by name).
// findOrCreate(): name -> existing id, or CREATE the master row (these masters all have a
//   @unique name), so a real old-site dropdown value is never dropped — it's added on import.
//
// All of these are tiny lookup tables keyed by a unique name. To add another dropdown, add a DEF.

const DEFS = {
    season:             { accessor: 'season',                            id: 'seasonId',                      name: 'seasonName' },
    nicraDignitaryType: { accessor: 'nicraDignitaryTypeMaster',          id: 'nicraDignitaryTypeId',          name: 'name' },
    nicraPiType:        { accessor: 'nicraPiTypeMaster',                 id: 'nicraPiTypeId',                 name: 'name' },
    nfActivity:         { accessor: 'naturalFarmingActivityMaster',      id: 'naturalFarmingActivityId',      name: 'activityName' },
    nfSoilParameter:    { accessor: 'naturalFarmingSoilParameterMaster', id: 'naturalFarmingSoilParameterId', name: 'parameterName' },
};

const NORM = (s) => String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim();

class MasterResolver {
    constructor(prisma) { this.prisma = prisma; this.cache = {}; }

    async _load(key) {
        if (this.cache[key]) return this.cache[key];
        const d = DEFS[key];
        if (!d) throw new Error('unknown master: ' + key);
        let rows = [];
        try { rows = await this.prisma[d.accessor].findMany(); } catch (e) { rows = []; }
        const map = new Map();
        rows.forEach((r) => map.set(NORM(r[d.name]), r[d.id]));
        this.cache[key] = { d, map, options: rows.map((r) => ({ id: r[d.id], name: r[d.name] })) };
        return this.cache[key];
    }

    async resolve(key, value) {
        if (!value) return null;
        const c = await this._load(key);
        return c.map.has(NORM(value)) ? c.map.get(NORM(value)) : null;
    }

    async findOrCreate(key, value) {
        if (!value) return null;
        const c = await this._load(key);
        if (c.map.has(NORM(value))) return c.map.get(NORM(value));
        const created = await this.prisma[c.d.accessor].create({ data: { [c.d.name]: String(value).trim() } });
        c.map.set(NORM(value), created[c.d.id]);
        c.options.push({ id: created[c.d.id], name: created[c.d.name] });
        return created[c.d.id];
    }

    options(key) { return (this.cache[key] && this.cache[key].options) || []; }
    async preload(keys) { for (const k of keys) await this._load(k); return this; }
}

module.exports = { MasterResolver, MASTER_KEYS: Object.keys(DEFS) };
