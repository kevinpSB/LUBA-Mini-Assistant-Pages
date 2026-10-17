import { prepareBackup, validateBackup } from './backup.js';
function node(tag, text = '') {
    const n = document.createElement(tag);
    n.textContent = text;
    return n;
}
function action(label, run) {
    const b = node('button', label);
    b.type = 'button';
    b.onclick = run;
    return b;
}
export async function backupPanel(repository, selected, lock, restored) {
    const panel = node('details');
    panel.className = 'panel';
    panel.append(node('summary', 'Data, backup and restoration'));
    panel.append(node('p', 'Backups are readable files containing all saved profiles, areas, retired areas and mapping history in the chosen scope. Unsaved form edits are not included. Browser storage and internal test copies can be lost. Keep dated Files backups and a periodic independent copy.'));
    let receipt = await repository.getMetadata('backupReceipt');
    const saved = node('p', receipt ? `Owner confirmed saved: ${receipt.ownerConfirmedSavedAt}. This does not prove Files or cloud persistence.` : 'No owner-confirmed saved backup recorded.');
    panel.append(saved);
    const days = node('input');
    days.type = 'number';
    days.min = '1';
    days.max = '365';
    days.value = String(await repository.getMetadata('backupReminderDays') ?? 7);
    const reminder = node('label', 'On-open backup reminder interval (days)');
    reminder.append(days);
    panel.append(reminder);
    const feedback = node('p');
    feedback.setAttribute('role', 'status');
    panel.append(feedback);
    days.onchange = () => {
        const value = Number(days.value);
        if (!Number.isInteger(value) || value < 1 || value > 365) {
            feedback.textContent = 'Choose 1–365 days.';
            return;
        }
        void repository.setMetadata('backupReminderDays', value).catch(showError);
    };
    const gardens = await repository.listGardens();
    const changed = !receipt || gardens.some(g => !receipt.profiles.some(p => p.profileInstanceId === g.profileInstanceId && p.generationId === g.generationId && p.version === g.version));
    if (changed || Date.now() - Date.parse(receipt.ownerConfirmedSavedAt) > Number(days.value) * 86400000) {
        saved.append(node('strong', changed ? ' Backup recommended after saved changes.' : ' Backup reminder is due.'));
        panel.open = !gardens.length;
    }
    function showError(error) {
        feedback.textContent = error instanceof Error ? error.message : 'Operation failed. Existing records remain active.';
        if (error instanceof DOMException && error.name === 'QuotaExceededError')
            feedback.textContent = 'Storage is full. Existing gardens remain active. Free device space, discard unfinished staging and retry with the same saved backup files.';
    }
    let working = false;
    async function operation(run) {
        if (working)
            return;
        working = true;
        lock(true);
        scope.disabled = true;
        input.disabled = true;
        feedback.textContent = 'Working locally…';
        try {
            await run();
        }
        catch (error) {
            showError(error);
        }
        finally {
            working = false;
            lock(false);
            scope.disabled = false;
            input.disabled = false;
        }
    }
    const scope = node('select');
    scope.setAttribute('aria-label', 'Backup scope');
    for (const [value, label] of [['all', 'All gardens'], ...(selected ? [['selected', 'Selected garden']] : [])]) {
        const option = node('option', label);
        option.value = value;
        scope.append(option);
    }
    panel.append(scope);
    const prepared = node('div');
    panel.append(action('1. Prepare backup', () => {
        void operation(async () => {
            prepared.replaceChildren();
            const data = await repository.capture(scope.value === 'selected' ? selected?.profileInstanceId : undefined);
            const files = await prepareBackup(data);
            const validated = await validateBackup(files);
            const emitted = new Set();
            const progress = node('p', `Prepared ${files.length} file(s). No external copy is confirmed saved.`);
            const confirm = action('I confirm every file is saved in Files', () => {
                void operation(async () => {
                    if (emitted.size !== files.length)
                        throw new Error('Save or share every file first.');
                    receipt = { exportId: validated.manifest.exportId, createdAt: validated.manifest.createdAt, ownerConfirmedSavedAt: new Date().toISOString(), scope: data.profiles.length === 1 ? 'one local garden instance' : 'all local garden instances', counts: validated.manifest.counts, profiles: data.profiles.map(p => ({ profileInstanceId: p.garden.profileInstanceId, generationId: p.garden.generationId, version: p.garden.version })) };
                    await repository.setMetadata('backupReceipt', receipt);
                    saved.textContent = `Owner confirmed saved: ${receipt.ownerConfirmedSavedAt}. Files/cloud persistence is not independently proven.`;
                    feedback.textContent = 'Your confirmation is recorded. Reselect the saved files below to verify their contents.';
                });
            });
            confirm.disabled = true;
            prepared.append(progress, node('p', `Set ${validated.manifest.exportId}. Keep all ${files.length} file(s) together in one dated Files folder. On iPhone, use Share → Save to Files. If sharing is unavailable, use Download and check Safari Downloads/Files. A download or completed share does not prove storage.`));
            files.forEach((f, i) => {
                const file = new File([f.text], f.name, { type: 'application/json' });
                const mark = () => { emitted.add(i); progress.textContent = `${emitted.size}/${files.length} file(s) handed to share/download. Awaiting your saved confirmation.`; confirm.disabled = emitted.size !== files.length; };
                prepared.append(node('p', `${i + 1}/${files.length}: ${f.name}`));
                prepared.append(action('2. Save/share backup file', () => {
                    if (!navigator.canShare?.({ files: [file] })) {
                        feedback.textContent = 'File sharing is unavailable here. Use Download this file, then check Files.';
                        return;
                    }
                    // Call share directly during this fresh user gesture; never after hashing/preparation.
                    void navigator.share({ files: [file], title: 'LUBA garden backup' }).then(mark).catch(error => { feedback.textContent = error?.name === 'AbortError' ? 'Sharing cancelled. Prepared files remain available to retry.' : 'Sharing failed. Retry or use Download.'; });
                }));
                prepared.append(action('Download this file', () => {
                    const url = URL.createObjectURL(file), link = node('a');
                    link.href = url;
                    link.download = f.name;
                    panel.append(link);
                    link.click();
                    link.remove();
                    setTimeout(() => URL.revokeObjectURL(url), 60000);
                    mark();
                }));
            });
            prepared.append(confirm);
            feedback.textContent = 'Backup prepared and internally validated. Save/share is a separate step.';
        });
    }));
    panel.append(prepared);
    panel.append(node('h3', 'Verify or restore saved files'), node('p', 'Select one backup file, or its manifest and every numbered part together. Offline restoration needs files downloaded to this device, not cloud-only placeholders. Verification changes no garden records.'));
    const input = node('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.multiple = true;
    input.setAttribute('aria-label', 'Select saved backup files');
    panel.append(input);
    let validated;
    const preview = node('div');
    panel.append(preview);
    input.onchange = () => {
        void operation(async () => {
            validated = undefined;
            preview.replaceChildren();
            const files = [];
            for (const f of input.files ?? [])
                files.push({ name: f.name, text: await f.text() });
            validated = await validateBackup(files);
            const c = validated.manifest.counts;
            preview.append(node('p', `Verified set ${validated.manifest.exportId}, created ${validated.manifest.createdAt}, app ${validated.manifest.appVersion}. ${c.gardens} garden(s), ${c.areas} area(s), ${c.revisions} mapping revision(s).`));
            for (const p of validated.data.profiles)
                preview.append(node('p', `${p.garden.localLabel ?? p.garden.displayName}: ${p.areas.length} areas, ${p.revisions.length} revisions. Stable garden ID: ${p.garden.id}`));
            preview.append(node('p', `Application metadata entries: ${Object.keys(validated.data.metadata).length}. Imported settings and older saved receipts are retained as provenance; they do not confirm a new external backup.`));
            preview.append(node('p', 'Restore as new creates independent local copies and preserves existing gardens. Stable garden, area and revision IDs, dates and unknowns are retained. Local instance/generation addresses change. Restoration will discard unsaved form edits in this window.'));
            const cancel = action('Cancel restoration / clear selection', () => { validated = undefined; preview.replaceChildren(); input.value = ''; feedback.textContent = 'Cancelled. Existing data is unchanged.'; });
            preview.append(cancel);
            const runRestore = (replace) => {
                void operation(async () => {
                    if (!validated)
                        return;
                    if (replace) {
                        const currentReceipt = await repository.getMetadata('backupReceipt');
                        if (!currentReceipt?.profiles.some(p => p.profileInstanceId === replace.profileInstanceId && p.generationId === replace.generationId && p.version === replace.version))
                            throw new Error('First prepare and save a backup of the current target garden, then confirm it is saved. Reselect the restore files afterwards.');
                    }
                    if (!window.confirm(replace ? `Replace only ${replace.localLabel ?? replace.displayName} with this backup? Its current active data will be replaced. Unsaved edits will be discarded.` : 'Restore this complete set as independent new garden copies? Existing gardens are retained. Unsaved edits will be discarded.')) {
                        feedback.textContent = 'Cancelled. Existing data is unchanged.';
                        return;
                    }
                    const controller = new AbortController();
                    const interrupt = action('Cancel in-progress restoration', () => controller.abort());
                    preview.append(interrupt);
                    try {
                        const id = await repository.stageRestore(validated, { confirmed: true, replace, signal: controller.signal });
                        await repository.activateRestore(id, true, controller.signal);
                        // Activation is the success boundary; a cleanup failure is retryable and cannot undo it.
                        await repository.discardRestore().catch(() => { });
                        await restored();
                    }
                    finally {
                        interrupt.remove();
                    }
                });
            };
            preview.append(action('Restore as new / test copies', () => runRestore()));
            if (selected && validated.data.profiles.length === 1 && validated.data.profiles[0].garden.id === selected.id) {
                preview.append(node('p', 'Replacement affects only the currently selected local instance. A saved backup of its current version is required. No merge is performed.'));
                preview.append(action('Replace selected garden…', () => runRestore(selected)));
            }
            feedback.textContent = 'Saved files verified. No garden data has been changed.';
        });
    };
    for (const plan of await repository.pendingRestores()) {
        const pending = node('div');
        pending.append(node('p', `Unfinished restoration ${plan.exportId} (${plan.createdAt}). Existing gardens remain active. To retry, discard this staging and reselect the complete saved file set.`));
        pending.append(action('Discard unfinished staging', () => { void operation(async () => { await repository.discardRestore(plan.id); pending.remove(); feedback.textContent = 'Unfinished staging discarded. Active gardens are unchanged.'; }); }));
        panel.append(pending);
    }
    return panel;
}
