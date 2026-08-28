import { useMemo, useState } from 'preact/hooks';
import { api, ApiError } from '../lib/api';
import { ImageLightbox } from '../components/ImageLightbox';
import { Modal } from '../components/Modal';
import { toast } from '../lib/toast';
import { useI18n } from '../i18n/provider';
import type { DesignAssetCapabilityView, DesignAssetFunctionalDetails, DesignAssetView, DesignTask } from '../lib/design';
import type { MessageKey } from '../../../shared/i18n/messages';

const PRESETS = ['full_page_mockup', 'component_states', 'visual_direction'] as const;
const SIZES = ['1024x1024', '1536x1024', '1024x1536'] as const;
const EMPTY_DETAILS: DesignAssetFunctionalDetails = { altText: '', interactions: [], responsiveBehavior: [], accessibilityNotes: [], acceptanceCriteria: [] };

function lines(value: string): string[] { return value.split('\n').map((item) => item.trim()).filter(Boolean); }
function join(value: string[]): string { return value.join('\n'); }
function presetKey(asset: DesignAssetView): MessageKey {
  if (asset.preset === 'full_page_mockup') return 'design.preset.full_page_mockup';
  if (asset.preset === 'component_states') return 'design.preset.component_states';
  if (asset.preset === 'visual_direction') return 'design.preset.visual_direction';
  return 'design.assets';
}
function statusKey(status: DesignAssetView['status']): MessageKey {
  return status === 'succeeded' ? 'design.run.completed' : `design.run.${status}`;
}

export function DesignAssetsPanel({ pid, did, task, canManage, capability, assets, onRefresh }: {
  pid: number; did: number; task: DesignTask; canManage: boolean;
  capability: DesignAssetCapabilityView | null; assets: DesignAssetView[]; onRefresh: () => void;
}) {
  const { t } = useI18n();
  const [preset, setPreset] = useState<(typeof PRESETS)[number]>('full_page_mockup');
  const [size, setSize] = useState<(typeof SIZES)[number]>('1024x1024');
  const [prompt, setPrompt] = useState('');
  const [includeContext, setIncludeContext] = useState(true);
  const [referencePaths, setReferencePaths] = useState('');
  const [selectedReferenceIds, setSelectedReferenceIds] = useState<number[]>([]);
  const [confirmation, setConfirmation] = useState<{ requestKey: string; retryId: number | null } | null>(null);
  const [busy, setBusy] = useState('');
  const [lightbox, setLightbox] = useState<DesignAssetView | null>(null);
  const [editing, setEditing] = useState<DesignAssetView | null>(null);
  const [details, setDetails] = useState<DesignAssetFunctionalDetails>(EMPTY_DETAILS);
  const [ready, setReady] = useState(false);
  const current = assets.filter((asset) => asset.designRevision === task.currentRevision);
  const previous = assets.filter((asset) => asset.designRevision !== task.currentRevision);
  const successful = assets.filter((asset) => asset.status === 'succeeded');
  const pending = assets.some((asset) => asset.status === 'queued' || asset.status === 'running');
  const references = useMemo(() => [
    ...selectedReferenceIds.map((assetId) => ({ source: 'design_asset' as const, assetId })),
    ...lines(referencePaths).map((path) => ({ source: 'project_file' as const, path })),
  ], [selectedReferenceIds, referencePaths]);

  const operate = async (name: string, operation: () => Promise<unknown>): Promise<void> => {
    if (busy) return;
    setBusy(name);
    try { await operation(); onRefresh(); toast.success(t('ui.saved')); }
    catch (cause) { toast.error(cause instanceof ApiError ? cause.message : t('design.loadFailed')); }
    finally { setBusy(''); }
  };
  const requestBody = () => ({
    expectedRevision: task.currentRevision, preset, prompt: prompt.trim(), size,
    includeRevisionContext: includeContext, references,
    acknowledgeExternalProcessingAndCost: true as const,
  });
  const generate = async (): Promise<void> => {
    if (!confirmation) return;
    const suffix = confirmation.retryId === null ? 'generate' : `${confirmation.retryId}/retry`;
    await operate('generate', async () => {
      await api(`/api/projects/${pid}/designs/${did}/assets/${suffix}`, 'POST', requestBody(), { idempotencyKey: confirmation.requestKey });
      setConfirmation(null);
    });
  };
  const openEditor = (asset: DesignAssetView) => {
    setEditing(asset); setDetails(asset.functionalDetails ?? EMPTY_DETAILS); setReady(asset.implementationReady);
  };
  const complete = details.altText.trim() && details.interactions.length && details.responsiveBehavior.length && details.accessibilityNotes.length && details.acceptanceCriteria.length;
  const assetCard = (asset: DesignAssetView) => <li class="design-asset-card" key={asset.id}>
    {asset.contentUrl ? <button class="design-asset-image" onClick={() => setLightbox(asset)} aria-label={t('design.assetOpen', { id: asset.id })}><img src={asset.contentUrl} alt={asset.functionalDetails?.altText || t(presetKey(asset))}/></button> : <div class="design-asset-placeholder" aria-hidden="true"/>}
    <div class="design-asset-card-body"><div class="row"><strong>{t(presetKey(asset))}</strong><span class={`badge ${asset.status === 'failed' ? 'b-red' : 'b-gray'}`}>{t(statusKey(asset.status))}</span>{asset.implementationReady && <span class="badge b-green">{t('design.implementationReady')}</span>}</div>
      {(asset.status === 'queued' || asset.status === 'running') && (
        <div class="design-asset-progress" role="progressbar" aria-label={t('design.assetGenerating')}/>
      )}
      <dl class="design-asset-provenance"><div><dt>{t('design.assetRevision')}</dt><dd>{asset.designRevision}</dd></div><div><dt>{t('design.assetProvider')}</dt><dd>{asset.provider ?? '—'} · {asset.providerModel ?? '—'}</dd></div><div><dt>{t('design.assetDimensions')}</dt><dd>{asset.width && asset.height ? `${asset.width}×${asset.height}` : asset.size ?? '—'}</dd></div>{asset.retryOfAssetId && <div><dt>{t('design.assetRetryOf')}</dt><dd>#{asset.retryOfAssetId}</dd></div>}</dl>
      {asset.error && <p class="error">{t('design.assetGenerationFailed')}</p>}
      {canManage && <div class="row">{(asset.status === 'queued' || asset.status === 'running') && <button class="btn" disabled={!!busy} onClick={() => void operate(`cancel-${asset.id}`, () => api(`/api/projects/${pid}/designs/${did}/assets/${asset.id}/cancel`, 'POST', {}))}>{t('common.cancel')}</button>}{(asset.status === 'failed' || asset.status === 'cancelled') && <button class="btn" disabled={!capability?.enabled || !prompt.trim()} onClick={() => setConfirmation({ requestKey: crypto.randomUUID(), retryId: asset.id })}>{t('design.retryAsset')}</button>}{asset.status === 'succeeded' && <button class="btn" onClick={() => openEditor(asset)}>{t('design.functionalDetails')}</button>}</div>}
    </div>
  </li>;

  return <div class="design-assets-slot" role="tabpanel">
    <div class="design-assets-status" aria-live="polite">{pending ? t('design.assetGenerating') : capability?.enabled ? t('design.assetProviderReady') : t('design.assetProviderDisabled')}</div>
    {canManage && <div class="design-asset-composer"><div class="design-asset-options"><label>{t('design.assetPreset')}<select value={preset} onChange={(event) => setPreset(event.currentTarget.value as typeof preset)}>{PRESETS.map((value) => <option value={value}>{t(`design.preset.${value}`)}</option>)}</select></label><label>{t('design.assetSize')}<select value={size} onChange={(event) => setSize(event.currentTarget.value as typeof size)}>{SIZES.map((value) => <option value={value}>{value}</option>)}</select></label></div>
      <label>{t('design.assetPrompt')}<textarea value={prompt} maxLength={2000} onInput={(event) => setPrompt(event.currentTarget.value)}/></label>
      <label class="design-check"><input type="checkbox" checked={includeContext} onChange={(event) => setIncludeContext(event.currentTarget.checked)}/>{t('design.includeRevisionContext')}</label>
      <details><summary>{t('design.assetReferences')}</summary><div class="design-reference-picker">{successful.map((asset) => <label><input type="checkbox" checked={selectedReferenceIds.includes(asset.id)} disabled={!selectedReferenceIds.includes(asset.id) && references.length >= (capability?.maxReferences ?? 4)} onChange={(event) => setSelectedReferenceIds((items) => event.currentTarget.checked ? [...items, asset.id] : items.filter((id) => id !== asset.id))}/>#{asset.id} · {t(presetKey(asset))}</label>)}<label>{t('design.projectReferencePaths')}<textarea value={referencePaths} onInput={(event) => setReferencePaths(event.currentTarget.value)}/></label></div></details>
      <button class="btn primary" disabled={!capability?.enabled || !prompt.trim() || references.length > (capability?.maxReferences ?? 4)} onClick={() => setConfirmation({ requestKey: crypto.randomUUID(), retryId: null })}>{t('design.generateAsset')}</button>
    </div>}
    {!canManage && <p class="mut">{t('design.assetsReadOnly')}</p>}
    {assets.length === 0 ? <div class="design-output-empty">{t('design.assetsUnavailable')}</div> : <><section><h3>{t('design.currentRevisionAssets')}</h3><ol class="design-asset-gallery">{current.map(assetCard)}</ol></section>{previous.length > 0 && <details class="design-previous-assets"><summary>{t('design.previousRevisionAssets', { count: previous.length })}</summary><ol class="design-asset-gallery">{previous.map(assetCard)}</ol></details>}</>}
    {confirmation && <Modal title={t('design.assetConsentTitle')} onClose={() => setConfirmation(null)}><div class="design-asset-consent"><p>{t('design.assetConsentHelp')}</p><ul><li>{t(`design.preset.${preset}`)}</li><li>{size}</li><li>{t('design.assetReferenceCount', { count: references.length })}</li></ul><div class="form-actions"><button class="btn" onClick={() => setConfirmation(null)}>{t('common.cancel')}</button><button class="btn primary" disabled={busy === 'generate'} onClick={() => void generate()}>{t('design.confirmGeneration')}</button></div></div></Modal>}
    {editing && <Modal wide title={t('design.functionalDetails')} onClose={() => setEditing(null)}><div class="design-details-editor"><label>{t('design.altText')}<input value={details.altText} onInput={(event) => setDetails({ ...details, altText: event.currentTarget.value })}/></label>{(['interactions','responsiveBehavior','accessibilityNotes','acceptanceCriteria'] as const).map((key) => <label>{t(`design.details.${key}`)}<textarea value={join(details[key])} onInput={(event) => setDetails({ ...details, [key]: lines(event.currentTarget.value) })}/></label>)}<fieldset><legend>{t('design.readyChecklist')}</legend>{(['altText','interactions','responsiveBehavior','accessibilityNotes','acceptanceCriteria'] as const).map((key) => <label class="design-check"><input type="checkbox" checked={key === 'altText' ? !!details.altText.trim() : details[key].length > 0} disabled/>{t(`design.details.${key}`)}</label>)}</fieldset><label class="design-check"><input type="checkbox" checked={ready} disabled={!complete} onChange={(event) => setReady(event.currentTarget.checked)}/>{t('design.markImplementationReady')}</label><div class="form-actions"><button class="btn" onClick={() => setEditing(null)}>{t('common.cancel')}</button><button class="btn primary" disabled={!!busy} onClick={() => void operate('details', async () => { const result = await api<{ asset: DesignAssetView }>(`/api/projects/${pid}/designs/${did}/assets/${editing.id}`, 'PATCH', { expectedAssetVersion: editing.assetVersion, functionalDetails: details, implementationReady: ready }); setEditing(result.asset); setReady(result.asset.implementationReady); })}>{t('ui.save')}</button></div></div></Modal>}
    {lightbox?.contentUrl && (
      <ImageLightbox
        src={lightbox.contentUrl}
        downloadUrl={lightbox.contentUrl}
        name={`asset-${lightbox.id}`}
        sourceLabel={t(presetKey(lightbox))}
        ariaLabel={lightbox.functionalDetails?.altText || t('design.assetOpen', { id: lightbox.id })}
        onClose={() => setLightbox(null)}
      />
    )}
  </div>;
}
