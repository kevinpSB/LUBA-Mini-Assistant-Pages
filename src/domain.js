export const environment = { now: () => new Date().toISOString(), id: () => crypto.randomUUID() };
export function requireText(value, label) {
    const clean = value.trim();
    if (!clean)
        throw new Error(`${label} is required.`);
    return clean;
}
export function validateGarden(name, timezone) {
    requireText(name, 'Garden name');
    try {
        new Intl.DateTimeFormat('en', { timeZone: requireText(timezone, 'Timezone') });
    }
    catch {
        throw new Error('Enter a valid IANA timezone, for example Europe/London.');
    }
}
export function localDay(instant, timezone) {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(instant));
    const part = (name) => parts.find(p => p.type === name).value;
    return `${part('year')}-${part('month')}-${part('day')}`;
}
export function createGarden(displayName, timezone, notes = '', env = environment) {
    validateGarden(displayName, timezone);
    const id = env.id(), now = env.now();
    return { id, gardenId: id, profileInstanceId: env.id(), generationId: env.id(), displayName: displayName.trim(), timezone: timezone.trim(), notes: notes.trim(), version: 1, createdAt: now, updatedAt: now };
}
export function scopeOf(garden) {
    return { profileInstanceId: garden.profileInstanceId, generationId: garden.generationId, gardenId: garden.id };
}
export function sameScope(a, b) {
    return a.profileInstanceId === b.profileInstanceId && a.generationId === b.generationId && a.gardenId === b.gardenId;
}
export function reviseArea(garden, input, prior, retire = false, env = environment) {
    const name = requireText(input.name, 'Area name');
    if (!Number.isFinite(input.sizeM2) || input.sizeM2 <= 0)
        throw new Error('Area size must be a finite number greater than zero, in m².');
    const reason = requireText(input.changeReason, 'Change reason');
    if (!['faster', 'slower', 'unknown'].includes(input.growthClass))
        throw new Error('Choose a valid growth class.');
    const now = env.now();
    const date = input.effectiveFrom;
    if (date !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date || date > localDay(now, garden.timezone))) {
        throw new Error('Use a real effective date today or earlier, or leave it unknown. Future mapping changes are not supported.');
    }
    if (prior && (!sameScope(garden, prior.area) || !sameScope(garden, prior.revision) || prior.revision.areaId !== prior.area.id || prior.area.currentRevisionId !== prior.revision.id))
        throw new Error('This area does not belong to the selected garden or revision.');
    if (prior?.revision.lifecycleStatus === 'retired')
        throw new Error('This area is retired. Its history is read-only.');
    if (retire && !prior)
        throw new Error('Only an existing area can be retired.');
    const areaId = prior?.area.id ?? env.id();
    const revision = { ...scopeOf(garden), id: env.id(), areaId,
        creationSequence: (prior?.area.version ?? 0) + 1, effectiveFrom: date,
        datePrecision: date ? 'day' : 'unknown', recordedAt: now, changeReason: reason,
        name, sizeM2: input.sizeM2, growthClass: input.growthClass, shape: input.shape.trim(), notes: input.notes.trim(),
        lifecycleStatus: retire ? 'retired' : 'active', evidenceClass: 'ownerReported' };
    const area = { ...scopeOf(garden), id: areaId, currentRevisionId: revision.id, version: revision.creationSequence, createdAt: prior?.area.createdAt ?? now, updatedAt: now };
    return { area, revision };
}
// Fictional examples only: never consulted by validation or area management.
export const starterAreas = [
    { name: 'Example A', sizeM2: 100, growthClass: 'unknown', shape: '', notes: '' },
    { name: 'Example B', sizeM2: 50, growthClass: 'unknown', shape: '', notes: '' },
    { name: 'Example C', sizeM2: 25, growthClass: 'unknown', shape: '', notes: '' },
    { name: 'Example D', sizeM2: 75, growthClass: 'unknown', shape: '', notes: '' }
].map(item => ({ ...item, effectiveFrom: null, changeReason: 'Fictional example starter data; effective date unknown' }));
