import { sameScope, validateGarden } from './domain.js';
import { APP_VERSION } from './version.js';
export const FORMAT = 'luba-garden-backup';
export const FORMAT_VERSION = 1;
// Character chunks keep every encoded JSON file below the provisional 8 MiB target,
// even with escaping. This is a part size, never a total dataset/import ceiling.
export const CHUNK_CHARACTERS = 256 * 1024;
const bytes = (s) => new TextEncoder().encode(s);
export async function sha256(s) {
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes(s)))].map(n => n.toString(16).padStart(2, '0')).join('');
}
function check(value, message) { if (!value)
    throw new Error(`Invalid backup: ${message}`); }
function object(value) { check(value && typeof value === 'object' && !Array.isArray(value), 'expected an object.'); }
function text(value) { check(typeof value === 'string', 'expected text.'); }
function id(value) { text(value); check(value.length > 0, 'empty identifier.'); }
function instant(value) { text(value); check(/^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value)), 'invalid timestamp.'); }
function positive(value) { check(Number.isSafeInteger(value) && Number(value) > 0, 'invalid record version.'); }
function unique(rows) {
    for (const row of rows) {
        object(row);
        id(row.id);
    }
    check(new Set(rows.map(r => r.id)).size === rows.length, 'duplicate identifier.');
}
export function counts(data) {
    return { gardens: data.profiles.length, areas: data.profiles.reduce((n, p) => n + p.areas.length, 0), revisions: data.profiles.reduce((n, p) => n + p.revisions.length, 0) };
}
export function validateData(value) {
    object(value);
    check(Array.isArray(value.profiles), 'missing profiles.');
    object(value.metadata);
    const instances = new Set();
    for (const p of value.profiles) {
        object(p);
        object(p.garden);
        check(Array.isArray(p.areas) && Array.isArray(p.revisions), 'missing area history.');
        const g = p.garden;
        for (const key of ['id', 'gardenId', 'profileInstanceId', 'generationId'])
            id(g[key]);
        check(!instances.has(g.profileInstanceId), 'duplicate profile instance.');
        instances.add(g.profileInstanceId);
        check(g.id === g.gardenId, 'garden ownership.');
        text(g.displayName);
        text(g.timezone);
        text(g.notes);
        validateGarden(g.displayName, g.timezone);
        if (g.localLabel !== undefined)
            text(g.localLabel);
        positive(g.version);
        instant(g.createdAt);
        instant(g.updatedAt);
        unique(p.areas);
        unique(p.revisions);
        const areas = new Map();
        const histories = new Map();
        for (const a of p.areas) {
            object(a);
            id(a.id);
            id(a.currentRevisionId);
            positive(a.version);
            instant(a.createdAt);
            instant(a.updatedAt);
            check(sameScope(g, a), 'cross-profile area.');
            areas.set(a.id, a);
            histories.set(a.id, []);
        }
        for (const r of p.revisions) {
            object(r);
            id(r.id);
            id(r.areaId);
            check(sameScope(g, r) && areas.has(r.areaId), 'orphan or cross-profile revision.');
            positive(r.creationSequence);
            instant(r.recordedAt);
            for (const key of ['name', 'changeReason', 'shape', 'notes'])
                text(r[key]);
            check(r.name.trim() && r.changeReason.trim(), 'empty revision name/reason.');
            check(typeof r.sizeM2 === 'number' && Number.isFinite(r.sizeM2) && r.sizeM2 > 0, 'invalid area size.');
            check(['unknown', 'faster', 'slower'].includes(r.growthClass), 'invalid growth class.');
            check(['active', 'retired'].includes(r.lifecycleStatus) && r.evidenceClass === 'ownerReported', 'invalid evidence/status.');
            check(r.effectiveFrom === null ? r.datePrecision === 'unknown' : typeof r.effectiveFrom === 'string' && /^\d{4}-\d\d-\d\d$/.test(r.effectiveFrom) && Number.isFinite(Date.parse(r.effectiveFrom)) && new Date(r.effectiveFrom).toISOString().slice(0, 10) === r.effectiveFrom && r.datePrecision === 'day', 'invalid effective date.');
            histories.get(r.areaId).push(r);
        }
        for (const a of p.areas) {
            const history = histories.get(a.id).sort((a, b) => a.creationSequence - b.creationSequence);
            check(history.length === a.version && history.every((r, i) => r.creationSequence === i + 1), 'incomplete revision history.');
            check(history.at(-1)?.id === a.currentRevisionId, 'invalid current revision pointer.');
            check(history.slice(0, -1).every(r => r.lifecycleStatus === 'active'), 'revision after retirement.');
        }
    }
}
async function sealIndex(index) {
    const payload = JSON.stringify(index);
    return JSON.stringify({ index: payload, indexHash: await sha256(payload) });
}
export async function prepareBackup(data, chunkSize = CHUNK_CHARACTERS) {
    validateData(data);
    if (!Number.isSafeInteger(chunkSize) || chunkSize < 1 || chunkSize > CHUNK_CHARACTERS)
        throw new Error('Invalid backup chunk size.');
    const header = { format: FORMAT, formatVersion: 1, schemaVersion: 1, appVersion: APP_VERSION,
        exportId: crypto.randomUUID(), createdAt: new Date().toISOString(), capacityProfile: 'metadata-v1-chunked' };
    const payload = JSON.stringify(data), chunks = [];
    for (let start = 0; start < payload.length;) {
        let end = Math.min(start + chunkSize, payload.length);
        // Never split a UTF-16 surrogate pair; JSON string hashing then has exact UTF-8 semantics.
        if (end < payload.length && /[\uD800-\uDBFF]/.test(payload[end - 1]))
            end++;
        chunks.push(payload.slice(start, end));
        start = end;
    }
    const prefix = `luba-${header.createdAt.slice(0, 10)}-${header.exportId}`;
    const base = { ...header, counts: counts(data), exclusions: ['application shell caches', 'inactive generations', 'unfinished restore staging'] };
    let files;
    if (chunks.length === 1) {
        files = [{ name: `${prefix}.json`, text: await sealIndex({ ...base, kind: 'bundle', parts: [], payload, payloadHash: await sha256(payload) }) }];
    }
    else {
        const parts = [];
        files = [];
        for (let i = 0; i < chunks.length; i++) {
            const payload = chunks[i];
            const content = JSON.stringify({ ...header, kind: 'part', ordinal: i + 1, payload, payloadHash: await sha256(payload) });
            parts.push({ ordinal: i + 1, bytes: bytes(content).length, sha256: await sha256(content) });
            files.push({ name: `${prefix}-part-${String(i + 1).padStart(4, '0')}.json`, text: content });
        }
        files.unshift({ name: `${prefix}-manifest.json`, text: await sealIndex({ ...base, kind: 'manifest', parts }) });
    }
    await validateBackup(files); // No complete/prepared result until the writer's output round-trips.
    return files;
}
export async function validateBackup(files) {
    check(files.length > 0, 'select a bundle or the manifest and every numbered part.');
    const uniqueFiles = [...new Set(files.map(f => f.text))];
    const parsed = await Promise.all(uniqueFiles.map(async (source) => {
        let v;
        try {
            v = JSON.parse(source);
        }
        catch {
            throw new Error('Invalid backup: malformed JSON.');
        }
        object(v);
        if ('index' in v) {
            text(v.index);
            check(await sha256(v.index) === v.indexHash, 'manifest integrity failure.');
            try {
                v = JSON.parse(v.index);
            }
            catch {
                throw new Error('Invalid backup: malformed manifest.');
            }
            object(v);
        }
        else
            check(v.kind === 'part', 'missing integrity envelope.');
        check(v.format === FORMAT, 'unrecognised format.');
        check(v.formatVersion === 1 && v.schemaVersion === 1, 'unsupported format or schema version. Use a compatible app.');
        id(v.exportId);
        instant(v.createdAt);
        text(v.appVersion);
        check(v.capacityProfile === 'metadata-v1-chunked', 'unsupported capacity profile.');
        return { v, source };
    }));
    const manifests = parsed.filter(({ v }) => v.kind === 'bundle' || v.kind === 'manifest');
    check(manifests.length === 1, 'select exactly one complete backup set.');
    const m = manifests[0].v;
    check(parsed.every(({ v }) => v.exportId === m.exportId && v.createdAt === m.createdAt && v.appVersion === m.appVersion), 'mixed backup sets.');
    check(Array.isArray(m.parts) && Array.isArray(m.exclusions), 'missing inventory.');
    let payload;
    if (m.kind === 'bundle') {
        check(parsed.length === 1 && m.parts.length === 0, 'unexpected parts.');
        text(m.payload);
        check(await sha256(m.payload) === m.payloadHash, 'payload integrity failure.');
        payload = m.payload;
    }
    else {
        check(m.parts.length > 0 && parsed.length === m.parts.length + 1, 'missing or unexpected parts.');
        const chunks = [];
        for (let i = 0; i < m.parts.length; i++) {
            const descriptor = m.parts[i];
            object(descriptor);
            check(descriptor.ordinal === i + 1, 'invalid part inventory.');
            const matches = parsed.filter(({ v }) => v.kind === 'part' && v.ordinal === i + 1);
            check(matches.length === 1, 'missing or conflicting part.');
            const part = matches[0];
            text(part.v.payload);
            check(bytes(part.source).length === descriptor.bytes && await sha256(part.source) === descriptor.sha256 && await sha256(part.v.payload) === part.v.payloadHash, 'part integrity failure.');
            chunks.push(part.v.payload);
        }
        payload = chunks.join('');
    }
    let data;
    try {
        data = JSON.parse(payload);
    }
    catch {
        throw new Error('Invalid backup: malformed payload.');
    }
    validateData(data);
    object(m.counts);
    const c = counts(data);
    check(Object.keys(c).every(k => c[k] === m.counts[k]), 'record counts do not match.');
    return { manifest: m, data };
}
