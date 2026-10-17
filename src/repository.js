import { validateData } from './backup.js';
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
            const req = indexedDB.open(name, 2);
            req.onupgradeneeded = event => {
                const db = req.result;
                if (event.oldVersion < 2) {
                    db.createObjectStore('staging', { keyPath: 'id' });
                    db.createObjectStore('metadata', { keyPath: 'key' });
                }
                if (event.oldVersion !== 0)
                    return;
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
    // One readonly transaction pins every active profile and its records to the same snapshot.
    async capture(instanceId) {
        const tx = this.db.transaction([...stores, 'metadata']);
        const completed = done(tx);
        const data = { profiles: [], metadata: {} };
        const req = tx.objectStore('gardens').getAll();
        req.onsuccess = () => {
            for (const garden of req.result) {
                if (instanceId && garden.profileInstanceId !== instanceId)
                    continue;
                const profile = { garden, areas: [], revisions: [] };
                data.profiles.push(profile);
                const key = [garden.profileInstanceId, garden.generationId, garden.id];
                const a = tx.objectStore('areas').index('scope').getAll(key);
                const r = tx.objectStore('revisions').index('scope').getAll(key);
                a.onsuccess = () => profile.areas = a.result;
                r.onsuccess = () => profile.revisions = r.result;
            }
        };
        const meta = tx.objectStore('metadata').getAll();
        meta.onsuccess = () => { for (const row of meta.result)
            data.metadata[row.key] = row.value; };
        await completed;
        if (instanceId && !data.profiles.length)
            throw new Error('Selected garden no longer exists.');
        validateData(data);
        return data;
    }
    async getMetadata(key) {
        const tx = this.db.transaction('metadata');
        const completed = done(tx);
        const row = await request(tx.objectStore('metadata').get(key));
        await completed;
        return row?.value;
    }
    async setMetadata(key, value) {
        const tx = this.db.transaction('metadata', 'readwrite');
        const completed = done(tx);
        tx.objectStore('metadata').put({ key, value });
        await completed;
    }
    async pendingRestores() {
        const tx = this.db.transaction('staging');
        const completed = done(tx);
        const rows = await request(tx.objectStore('staging').getAll());
        await completed;
        return rows;
    }
    async stageRestore(backup, options) {
        if (!options.confirmed)
            throw new Error('Restoration cancelled. Existing data is unchanged.');
        const data = structuredClone(backup.data);
        validateData(data);
        if (options.replace && (data.profiles.length !== 1 || data.profiles[0].garden.id !== options.replace.id))
            throw new Error('Replacement requires one backup profile with the same stable garden ID. Use restore as new.');
        const cancelled = () => { if (options.signal?.aborted)
            throw new Error('Restoration interrupted. Existing data remains active. Discard staging or reselect the files to retry.'); };
        cancelled();
        // Advisory quota estimate includes both existing and incoming data; native
        // transaction failures remain authoritative. Never delete live data for space.
        if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
            const estimate = await navigator.storage.estimate().catch(() => ({}));
            const needed = new TextEncoder().encode(JSON.stringify(data)).byteLength * 3;
            if (estimate.quota !== undefined && estimate.usage !== undefined && estimate.quota - estimate.usage < needed) {
                throw new Error('Not enough estimated storage for safe restoration alongside existing records. Free device space and retry; no existing garden was removed.');
            }
        }
        cancelled();
        const plan = { id: environment.id(), exportId: backup.manifest.exportId, createdAt: environment.now(), ready: false,
            gardens: [], targets: options.replace ? [structuredClone(options.replace)] : [], metadata: data.metadata };
        const profiles = data.profiles.map(p => {
            const namespace = options.replace?.profileInstanceId ?? environment.id();
            const generation = environment.id();
            const source = p.garden;
            const garden = { ...source, profileInstanceId: namespace, generationId: generation,
                version: options.replace ? options.replace.version + 1 : source.version,
                localLabel: options.replace?.localLabel ?? `${source.localLabel ?? source.displayName} · restored ${plan.createdAt}`,
                restoreProvenance: { exportId: plan.exportId, restoredAt: plan.createdAt, sourceProfileInstanceId: source.profileInstanceId, sourceGenerationId: source.generationId, sourceVersion: source.version, ...(source.restoreProvenance ? { priorRestoreProvenance: source.restoreProvenance } : {}) } };
            plan.gardens.push(garden);
            // Only local addressing changes. Stable garden/entity IDs and evidence fields stay intact.
            return { garden, areas: p.areas.map(a => ({ ...a, ...scopeOf(garden) })), revisions: p.revisions.map(r => ({ ...r, ...scopeOf(garden) })) };
        });
        let tx = this.db.transaction('staging', 'readwrite');
        let completed = done(tx);
        tx.objectStore('staging').add(plan);
        await completed;
        for (const p of profiles) {
            for (const [store, rows] of [['areas', p.areas], ['revisions', p.revisions]]) {
                for (let offset = 0; offset < rows.length; offset += 200) {
                    cancelled();
                    tx = this.db.transaction([store, 'staging'], 'readwrite');
                    completed = done(tx);
                    let batchFailure;
                    const marker = tx.objectStore('staging').get(plan.id);
                    marker.onsuccess = () => {
                        if (!marker.result) {
                            tx.abort();
                            return;
                        }
                        try {
                            for (const row of rows.slice(offset, offset + 200))
                                tx.objectStore(store).add(row);
                        }
                        catch (error) {
                            batchFailure = error;
                            try {
                                tx.abort();
                            }
                            catch { /* Already aborted. */ }
                        }
                    };
                    try {
                        await completed;
                    }
                    catch (error) {
                        throw batchFailure ?? error;
                    }
                }
            }
        }
        cancelled();
        plan.ready = true;
        tx = this.db.transaction('staging', 'readwrite');
        completed = done(tx);
        const marker = tx.objectStore('staging').get(plan.id);
        marker.onsuccess = () => { if (!marker.result)
            tx.abort();
        else
            tx.objectStore('staging').put(plan); };
        await completed;
        return plan.id;
    }
    async activateRestore(id, confirmed, signal) {
        if (!confirmed || signal?.aborted)
            throw new Error('Restoration cancelled. Existing data is unchanged.');
        const tx = this.db.transaction(['gardens', 'staging', 'metadata'], 'readwrite');
        const completed = done(tx);
        let failure;
        const req = tx.objectStore('staging').get(id);
        const abort = (error) => { failure = error; try {
            tx.abort();
        }
        catch { /* Already aborted. */ } };
        req.onsuccess = () => {
            const plan = req.result;
            if (!plan?.ready) {
                abort(new Error('Restore staging is incomplete. Reselect the backup files to retry.'));
                return;
            }
            const activate = () => {
                try {
                    for (const garden of plan.gardens) {
                        if (plan.targets.length)
                            tx.objectStore('gardens').put(garden);
                        else
                            tx.objectStore('gardens').add(garden);
                    }
                    tx.objectStore('metadata').put({ key: `imported:${plan.id}`, value: { exportId: plan.exportId, metadata: plan.metadata } });
                    tx.objectStore('staging').delete(id);
                }
                catch (error) {
                    abort(error);
                }
            };
            if (!plan.targets.length) {
                activate();
                return;
            }
            const target = plan.targets[0];
            const current = tx.objectStore('gardens').get(target.profileInstanceId);
            current.onsuccess = () => {
                const g = current.result;
                if (!g || g.id !== target.id || g.version !== target.version || g.generationId !== target.generationId) {
                    abort(new Error(conflict));
                    return;
                }
                activate();
            };
        };
        try {
            await completed;
        }
        catch (error) {
            throw failure ?? error;
        }
    }
    // This also safely reclaims old generations after activation. Active data and other
    // in-progress imports are protected in the same transaction, including across tabs.
    async discardRestore(id) {
        const tx = this.db.transaction([...stores, 'staging'], 'readwrite');
        const completed = done(tx);
        if (id)
            tx.objectStore('staging').delete(id);
        const gardens = tx.objectStore('gardens').getAll(), staging = tx.objectStore('staging').getAll();
        let ready = 0;
        const clean = () => {
            if (++ready !== 2)
                return;
            const keep = new Set();
            const key = (g) => JSON.stringify([g.profileInstanceId, g.generationId]);
            for (const g of gardens.result)
                keep.add(key(g));
            for (const p of staging.result)
                for (const g of p.gardens)
                    keep.add(key(g));
            for (const name of ['areas', 'revisions']) {
                const cursor = tx.objectStore(name).openCursor();
                cursor.onsuccess = () => {
                    const c = cursor.result;
                    if (!c)
                        return;
                    if (!keep.has(key(c.value)))
                        c.delete();
                    c.continue();
                };
            }
        };
        gardens.onsuccess = clean;
        staging.onsuccess = clean;
        await completed;
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
