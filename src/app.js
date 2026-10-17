import { APP_VERSION } from './version.js';
import { backupPanel } from './backup-ui.js';
import { Repository } from './repository.js';
const root = document.querySelector('#app');
let repository;
let selected;
let snapshot;
let busy = false;
let dirty = false;
root.addEventListener('input', event => { if (event.target.closest('form'))
    dirty = true; });
window.addEventListener('beforeunload', event => { if (dirty || busy) {
    event.preventDefault();
    event.returnValue = '';
} });
let status;
function el(tag, text = '', className = '') {
    const node = document.createElement(tag);
    node.textContent = text;
    node.className = className;
    return node;
}
function message(error) {
    if (error instanceof DOMException && error.name === 'QuotaExceededError')
        return 'Storage is full. These edits are unsaved. Keep this form open and copy your changes before freeing device space.';
    if (error instanceof DOMException && error.name === 'VersionError')
        return 'This browser has a newer database version. Open the newer app; your data has not been reset.';
    return error instanceof Error ? error.message : 'Local storage is unavailable. Keep a copy of your edits and try again.';
}
function field(form, label, name, value = '', type = 'text', required = false) {
    const wrap = el('label', label), input = el('input');
    input.name = name;
    input.type = type;
    input.value = value;
    input.required = required;
    wrap.append(input);
    form.append(wrap);
    return input;
}
function notes(form, value) {
    const label = el('label', 'Notes (optional)'), input = el('textarea');
    input.name = 'notes';
    input.value = value;
    label.append(input);
    form.append(label);
}
function button(label, className = '') { const b = el('button', label, className); b.type = 'button'; return b; }
function disclosure(label) { const d = el('details'); d.append(el('summary', label)); return d; }
function handle(form, save) {
    const error = el('p', '', 'error');
    error.setAttribute('role', 'alert');
    form.append(error);
    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (busy)
            return;
        error.textContent = '';
        busy = true;
        const buttons = [...root.querySelectorAll('button')].map(b => ({ b, disabled: b.disabled }));
        buttons.forEach(({ b }) => b.disabled = true);
        try {
            await save(new FormData(form), event.submitter);
        }
        catch (e) {
            error.textContent = `${message(e)} Your form has been kept.`;
        }
        finally {
            busy = false;
            buttons.forEach(({ b, disabled }) => b.disabled = disabled);
        }
    });
}
const str = (data, key) => String(data.get(key) ?? '');
function gardenForm(garden) {
    const form = el('form');
    field(form, 'Garden name', 'name', garden?.displayName ?? '', 'text', true);
    field(form, 'IANA timezone', 'timezone', garden?.timezone ?? 'Europe/London', 'text', true);
    notes(form, garden?.notes ?? '');
    if (!garden) {
        const label = el('label'), check = el('input');
        check.name = 'starters';
        check.type = 'checkbox';
        check.checked = true;
        label.append(check, ' Include four fictional example areas (250 m²)');
        form.append(label);
        form.append(el('p', 'Untick to start with an empty garden. Add as many areas as you need.', 'muted'));
    }
    const submit = button(garden ? 'Save garden profile' : 'Create garden');
    submit.type = 'submit';
    form.append(submit);
    handle(form, async (data) => {
        if (garden)
            await repository.updateGarden(garden, str(data, 'name'), str(data, 'timezone'), str(data, 'notes'));
        else
            selected = (await repository.create(str(data, 'name'), str(data, 'timezone'), str(data, 'notes'), data.has('starters'))).profileInstanceId;
        await render('Garden saved on this device.');
    });
    return form;
}
function areaForm(garden, area, revision) {
    const form = el('form');
    field(form, 'Area name', 'name', revision?.name ?? '', 'text', true);
    const size = field(form, 'Size (m²)', 'size', revision ? String(revision.sizeM2) : '', 'number', true);
    size.min = '0';
    size.step = 'any';
    size.inputMode = 'decimal';
    const growthLabel = el('label', 'Reported growth'), growth = el('select');
    growth.name = 'growth';
    for (const [value, label] of [['unknown', 'Unknown'], ['faster', 'Faster-growing'], ['slower', 'Slower-growing']]) {
        const option = el('option', label);
        option.value = value;
        growth.append(option);
    }
    growth.value = revision?.growthClass ?? 'unknown';
    growthLabel.append(growth);
    form.append(growthLabel);
    field(form, 'Shape (optional)', 'shape', revision?.shape ?? '');
    notes(form, revision?.notes ?? '');
    field(form, 'Mapping effective date (optional)', 'date', '', 'date');
    form.append(el('p', 'Leave blank if unknown. This is when the mapping changed, not when you entered it. Same-day and backdated changes remain separate snapshots; no historical applicability is inferred.', 'muted'));
    field(form, 'Change reason', 'reason', revision ? '' : 'Initial area configuration', 'text', true);
    const actions = el('div', '', 'actions'), save = button(revision ? 'Save new revision' : 'Add area');
    save.type = 'submit';
    actions.append(save);
    if (revision) {
        const retire = button('Retire area', 'secondary');
        retire.type = 'submit';
        retire.name = 'retire';
        actions.append(retire);
    }
    form.append(actions);
    handle(form, async (data, submitter) => {
        const retire = submitter?.getAttribute('name') === 'retire';
        if (retire && !window.confirm('Retire this area? It will leave the active dashboard. Its identity and all revisions will be retained.'))
            return;
        const input = { name: str(data, 'name'), sizeM2: Number(str(data, 'size')), growthClass: str(data, 'growth'), shape: str(data, 'shape'), notes: str(data, 'notes'), effectiveFrom: str(data, 'date') || null, changeReason: str(data, 'reason') };
        await repository.saveArea(garden, input, area?.id, retire);
        await render(retire ? 'Area retired; all revisions retained.' : 'Area saved on this device.');
    });
    return form;
}
function card(garden, area, revision, all) {
    const node = el('article', '', 'card');
    node.append(el('h3', revision.name), el('p', `${revision.sizeM2.toLocaleString('en-GB')} m² · ${revision.lifecycleStatus}`), el('p', `Reported growth: ${revision.growthClass}. ${revision.shape}`, 'muted'));
    if (revision.notes)
        node.append(el('p', revision.notes));
    if (revision.lifecycleStatus === 'active') {
        const edit = disclosure('Edit or retire area');
        edit.append(areaForm(garden, area, revision));
        node.append(edit);
    }
    const history = disclosure(`Mapping revisions (${all.length})`), list = el('ol');
    all.sort((a, b) => b.creationSequence - a.creationSequence).forEach(r => {
        const li = el('li');
        li.append(el('strong', `Revision ${r.creationSequence}: ${r.name} · ${r.sizeM2} m² · ${r.lifecycleStatus}`), el('small', `Effective: ${r.effectiveFrom ?? 'unknown'} · Recorded: ${new Date(r.recordedAt).toLocaleString('en-GB', { timeZone: garden.timezone })} (${garden.timezone})`), el('small', `Growth: ${r.growthClass} · Shape: ${r.shape || 'unknown'} · Notes: ${r.notes || 'none'}`), el('small', `Reason: ${r.changeReason} · Owner-reported`), el('small', `Revision ID: ${r.id}`));
        list.append(li);
    });
    history.append(el('p', `Stable area ID: ${area.id}`), el('p', 'Recording order is shown. Unknown dates do not establish historical applicability; date-only changes on the same day remain ambiguous.', 'muted'), list);
    node.append(history);
    return node;
}
async function render(notice = '') {
    const gardens = await repository.listGardens();
    selected ??= gardens[0]?.profileInstanceId;
    snapshot = selected ? await repository.load(selected) : undefined;
    dirty = false;
    root.replaceChildren();
    status = el('p', notice, 'notice');
    status.setAttribute('role', 'status');
    root.append(status);
    if (snapshot) {
        const { garden, areas, revisions } = snapshot;
        const label = el('label', 'Your gardens'), select = el('select');
        select.setAttribute('aria-label', 'Your gardens');
        for (const g of gardens) {
            const option = el('option', g.localLabel ?? g.displayName);
            option.value = g.profileInstanceId;
            select.append(option);
        }
        select.value = garden.profileInstanceId;
        label.append(select);
        root.append(label);
        select.onchange = () => {
            if (busy || !window.confirm('Switch gardens? Any unsaved form edits in this window will be lost.')) {
                select.value = garden.profileInstanceId;
                return;
            }
            selected = select.value;
            void render().catch(showFatal);
        };
        const current = areas.map(area => ({ area, revision: revisions.find(r => r.id === area.currentRevisionId) }))
            .sort((a, b) => a.revision.name.localeCompare(b.revision.name, 'en-GB', { numeric: true }));
        const active = current.filter(row => row.revision.lifecycleStatus === 'active');
        const hero = el('section', '', 'panel hero');
        hero.append(el('p', 'YOUR GARDEN', 'muted'), el('h1', garden.displayName), el('p', `${active.reduce((sum, row) => sum + row.revision.sizeM2, 0).toLocaleString('en-GB')} m²`, 'total'), el('p', `${active.length} active ${active.length === 1 ? 'area' : 'areas'} · ${garden.timezone}`, 'muted'));
        root.append(hero);
        const names = active.map(row => row.revision.name.toLocaleLowerCase());
        if (new Set(names).size !== names.length)
            root.append(el('p', 'Some active areas share a name. Use the stable IDs in their revision details to distinguish them.', 'notice'));
        const profile = disclosure('Garden profile');
        profile.className = 'panel';
        profile.append(gardenForm(garden));
        root.append(profile);
        root.append(el('h2', 'Mowing areas'));
        if (!active.length)
            root.append(el('p', 'Your garden is ready for its first area.'));
        const grid = el('div', '', 'grid');
        active.forEach(({ area, revision }) => grid.append(card(garden, area, revision, revisions.filter(r => r.areaId === area.id))));
        root.append(grid);
        const add = disclosure('Add a mowing area');
        add.className = 'panel';
        add.append(areaForm(garden));
        root.append(add);
        const retired = current.filter(row => row.revision.lifecycleStatus === 'retired');
        if (retired.length) {
            const history = disclosure(`Retired areas (${retired.length})`);
            history.className = 'panel';
            retired.forEach(({ area, revision }) => history.append(card(garden, area, revision, revisions.filter(r => r.areaId === area.id))));
            root.append(history);
        }
    }
    else
        root.append(el('h1', 'Make room for your garden'), el('p', 'Create a local garden profile. Start with the supplied areas or a blank garden.'));
    const create = disclosure(snapshot ? 'Create another garden' : 'Create your garden');
    create.open = !snapshot;
    create.className = 'panel';
    create.append(gardenForm());
    root.append(create);
    root.append(await backupPanel(repository, snapshot?.garden, value => { busy = value; }, async () => { dirty = false; await render('Restoration completed. All mapping revisions retained. New copies appear in Your gardens.'); }));
}
function showFatal(error) {
    const alert = el('p', message(error), 'error');
    alert.setAttribute('role', 'alert');
    root.append(alert);
}
async function offline() {
    const label = document.querySelector('#offline');
    if (!('serviceWorker' in navigator) || !window.isSecureContext) {
        label.textContent = 'Offline setup needs localhost on the Mac or an approved HTTPS origin.';
        return;
    }
    try {
        const registration = await navigator.serviceWorker.register('./sw.js', { scope: './', updateViaCache: 'none' });
        await navigator.serviceWorker.ready;
        // Ask the controlling shell to verify every required asset, not just registration.
        const verify = () => {
            const channel = new MessageChannel();
            const timeout = setTimeout(() => label.textContent = 'Offline readiness could not be verified. Keep this page open and reload when convenient.', 5000);
            channel.port1.onmessage = event => { clearTimeout(timeout); label.textContent = event.data === true ? 'Ready offline · application assets verified' : 'Offline cache is incomplete. Reopen online to retry setup.'; channel.port1.close(); };
            (navigator.serviceWorker.controller ?? registration.active)?.postMessage('VERIFY', [channel.port2]);
        };
        verify();
        navigator.serviceWorker.addEventListener('controllerchange', verify);
        if (registration.waiting)
            label.textContent = 'An app update is ready. Close all LUBA windows, then reopen when your edits are saved.';
        registration.addEventListener('updatefound', () => registration.installing?.addEventListener('statechange', () => {
            if (registration.waiting && navigator.serviceWorker.controller)
                label.textContent = 'An app update is ready. Close all LUBA windows, then reopen when your edits are saved.';
        }));
    }
    catch {
        label.textContent = 'Offline setup failed. Your local records are separate from the app cache. Reopen online to retry.';
    }
}
try {
    repository = await Repository.open();
    await render();
}
catch (error) {
    root.replaceChildren();
    showFatal(error);
}
document.querySelector('#version').textContent = `Version ${APP_VERSION} · Milestone 1C · No mower connection`;
void offline();
