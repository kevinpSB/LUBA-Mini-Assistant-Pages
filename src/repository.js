import { createGarden, reviseArea, scopeOf, starterAreas, validateGarden, environment } from './domain.js';
const conflict = 'This record changed in another window. Your edits are unsaved. Copy them, then reload and review before saving again.';
const stores = ['gardens', 'areas', 'revisions'];
function done(tx) {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error ?? new Error('Local save was interrupted. Your changes have not been saved.'));
        tx.onerror = () => { }; // onabort reports the transaction outcome.
    });
}
function request(req) {
    return new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
}
export class Repository {
    db;
    constructor(db) {
        this.db = db;
    }
    static open(name = 'luba-foundation') {
        return new Promise((resolve, reject) => {
            let blocked = false;
            const req = indexedDB.open(name, 1);
            req.onupgradeneeded = () => {
                const db = req.result;
                db.createObjectStore('gardens', { keyPath: 'profileInstanceId' });
                for (const name of ['areas', 'revisions']) {
                    const store = db.createObjectStore(name, { keyPath: ['profileInstanceId', 'generationId', 'id'] });
                    store.createIndex('scope', ['profileInstanceId', 'generationId', 'gardenId']);
                }
            };
            req.onblocked = () => { blocked = true; reject(new Error('Close other LUBA windows, then reload to open local storage.')); };
            req.onerror = () => reject(req.error);
            req.onsuccess = () => {
                if (blocked) {
                    req.result.close();
                    return;
                }
                req.result.onversionchange = () => req.result.close();
                resolve(new Repository(req.result));
            };
        });
    }
    close() { this.db.close(); }
    async listGardens() {
        const tx = this.db.transaction('gardens');
        const completed = done(tx);
        const rows = await request(tx.objectStore('gardens').getAll());
        await completed;
        return rows;
    }
    async create(name, timezone, notes, withStarters) {
        const garden = createGarden(name, timezone, notes);
        const seeds = withStarters ? starterAreas.map(input => reviseArea(garden, input)) : [];
        const tx = this.db.transaction(stores, 'readwrite');
        const completed = done(tx);
        tx.objectStore('gardens').add(garden);
        for (const seed of seeds) {
            tx.objectStore('areas').add(seed.area);
            tx.objectStore('revisions').add(seed.revision);
        }
        await completed;
        return garden;
    }
    async load(profileInstanceId) {
        const tx = this.db.transaction(stores);
        const completed = done(tx);
        let snapshot;
        const req = tx.objectStore('gardens').get(profileInstanceId);
        req.onsuccess = () => {
            const garden = req.result;
            if (!garden)
                return;
            snapshot = { garden, areas: [], revisions: [] };
            const key = [garden.profileInstanceId, garden.generationId, garden.id];
            const a = tx.objectStore('areas').index('scope').getAll(key);
            const r = tx.objectStore('revisions').index('scope').getAll(key);
            a.onsuccess = () => { snapshot.areas = a.result; };
            r.onsuccess = () => { snapshot.revisions = r.result; };
        };
        await completed;
        if (!snapshot)
            throw new Error('Garden not found. Reload and select a garden.');
        for (const area of snapshot.areas)
            if (!snapshot.revisions.some(r => r.id === area.currentRevisionId && r.areaId === area.id))
                throw new Error('An area revision is missing. Local data has been left unchanged.');
        return snapshot;
    }
    async change(garden, apply) {
        const tx = this.db.transaction(stores, 'readwrite');
        const completed = done(tx);
        let failure;
        const req = tx.objectStore('gardens').get(garden.profileInstanceId);
        req.onsuccess = () => {
            try {
                const current = req.result;
                if (!current || current.version !== garden.version || current.generationId !== garden.generationId || current.id !== garden.id)
                    throw new Error(conflict);
                apply(tx, current);
            }
            catch (error) {
                failure = error;
                tx.abort();
            }
        };
        try {
            await completed;
        }
        catch (error) {
            throw failure ?? error;
        }
    }
    async updateGarden(garden, name, timezone, notes) {
        validateGarden(name, timezone);
        await this.change(garden, (tx, current) => tx.objectStore('gardens').put({ ...current, displayName: name.trim(), timezone: timezone.trim(), notes: notes.trim(), version: current.version + 1, updatedAt: environment.now() }));
    }
    async saveArea(garden, input, areaId, retire = false) {
        let validationError;
        await this.change(garden, (tx, current) => {
            const persist = (prior) => {
                const result = reviseArea(current, input, prior, retire);
                tx.objectStore('areas').put(result.area);
                tx.objectStore('revisions').add(result.revision);
                tx.objectStore('gardens').put({ ...current, ...scopeOf(current), version: current.version + 1, updatedAt: result.area.updatedAt });
            };
            if (!areaId) {
                persist();
                return;
            }
            const a = tx.objectStore('areas').get([current.profileInstanceId, current.generationId, areaId]);
            a.onsuccess = () => {
                const area = a.result;
                if (!area) {
                    tx.abort();
                    return;
                }
                const r = tx.objectStore('revisions').get([current.profileInstanceId, current.generationId, area.currentRevisionId]);
                r.onsuccess = () => {
                    // Validation errors abort the entire transaction, preserving the old pointer and history.
                    try {
                        persist({ area, revision: r.result });
                    }
                    catch (error) {
                        validationError = error;
                        tx.abort();
                    }
                };
            };
        }).catch(error => { throw validationError ?? error; });
    }
}
