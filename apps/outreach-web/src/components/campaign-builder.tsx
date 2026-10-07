import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { CampaignSource, type Campaign, type CampaignMode, type CreateCampaignInput, type PreviewRequest, type SfObject } from '@cti/contracts';
import { PageHeader } from '@/components/layout/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { ApiRequestError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { createCampaign, listViews, outreachKeys, previewCampaign } from '@/lib/outreach-api';
import { errorText } from '@/lib/outreach-words';
import { CampaignPreview } from './campaign-preview';
import { CampaignSourceFields, type SourceKind } from './campaign-source-fields';
import { LeadPicker } from './lead-picker';

/** The source the form describes, or null while it is incomplete (no list view picked, query too short). */
export function sourceFrom(kind: SourceKind, listViewId: string, soql: string): CampaignSource | null {
  const candidate = kind === 'list_view' ? { kind, listViewId } : { kind, soql: soql.trim() };
  const parsed = CampaignSource.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

const isInvalidSource = (e: unknown): e is ApiRequestError => e instanceof ApiRequestError && e.code === 'INVALID_SOURCE';

export interface CampaignBuilderProps { onCreated: (campaign: Campaign) => void }

export function CampaignBuilder({ onCreated }: CampaignBuilderProps) {
  const auth = useAuth();
  const isAdmin = Boolean(auth.user?.isAdmin || auth.user?.isSuperAdmin);
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [sfObject, setSfObject] = useState<SfObject>('Lead');
  const [kind, setKind] = useState<SourceKind>('list_view');
  const [listViewId, setListViewId] = useState('');
  const [soql, setSoql] = useState('');
  const [mode, setMode] = useState<CampaignMode>('sequence');
  /** An AI call campaign, created as a draft and now waiting for its leads to be picked. */
  const [draft, setDraft] = useState<Campaign | null>(null);
  const source = sourceFrom(kind, listViewId, soql);
  const views = useQuery({ queryKey: outreachKeys.listViews(sfObject), queryFn: () => listViews(sfObject), enabled: isAdmin && kind === 'list_view' });
  const preview = useMutation({ mutationFn: (req: PreviewRequest) => previewCampaign(req) });
  const create = useMutation({
    mutationFn: (req: CreateCampaignInput) => createCampaign(req),
    onSuccess: (created) => {
      void qc.invalidateQueries({ queryKey: outreachKeys.campaignLists });
      if (created.mode === 'ai_call') setDraft(created);
      else onCreated(created);
    },
  });
  /** Any change to what the campaign reads makes an earlier preview or error stale. */
  const sourceChanged = () => { preview.reset(); create.reset(); };

  if (!isAdmin) return <p className="text-sm text-muted-foreground">Only admins can create campaigns.</p>;
  if (draft) {
    return (
      <div className="space-y-6">
        <PageHeader title={draft.name} actions={<Button type="button" onClick={() => onCreated(draft)}>Continue to campaign</Button>} />
        <LeadPicker campaignId={draft.id} canEdit />
      </div>
    );
  }

  const sourceError = [preview.error, create.error].find(isInvalidSource);
  const otherError = [preview.error, create.error].find((e) => e && !isInvalidSource(e));
  return (
    <div className="space-y-6">
      <PageHeader title="New campaign" description="A campaign starts as a draft. Nothing is sent until you start a dry run and then go live." />
      <Card className="max-w-3xl">
        <CardContent className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="campaign-name">Campaign name</Label>
              <Input id="campaign-name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="Spring motivated sellers" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="campaign-mode">What the campaign does</Label>
              <NativeSelect
                id="campaign-mode"
                value={mode}
                onChange={(e) => setMode(e.target.value === 'ai_call' ? 'ai_call' : 'sequence')}
              >
                <option value="sequence">Calls through reps (sequence)</option>
                <option value="ai_call">AI calls to leads you pick</option>
              </NativeSelect>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="campaign-object">Salesforce object</Label>
              <NativeSelect
                id="campaign-object"
                value={sfObject}
                onChange={(e) => { setSfObject(e.target.value === 'Opportunity' ? 'Opportunity' : 'Lead'); setListViewId(''); sourceChanged(); }}
              >
                <option value="Lead">Leads</option>
                <option value="Opportunity">Opportunities</option>
              </NativeSelect>
            </div>
          </div>
          <CampaignSourceFields
            sfObject={sfObject}
            kind={kind}
            listViewId={listViewId}
            soql={soql}
            views={views}
            onKind={(k) => { setKind(k); sourceChanged(); }}
            onListView={(id) => { setListViewId(id); sourceChanged(); }}
            onSoql={(text) => { setSoql(text); sourceChanged(); }}
          />
          {sourceError && <p role="alert" className="text-sm text-destructive">Salesforce can't use this source: {sourceError.message}</p>}
          <div className="flex flex-wrap gap-2 border-t pt-5">
            <Button type="button" variant="outline" disabled={!source || preview.isPending} onClick={() => source && preview.mutate({ sfObject, source })}>Preview</Button>
            <Button type="button" disabled={!source || !name.trim() || create.isPending} onClick={() => source && create.mutate({ name: name.trim(), sfObject, source, mode })}>Create campaign</Button>
          </div>
          {preview.isPending && <p className="text-sm text-muted-foreground">Checking records in Salesforce…</p>}
          {otherError && <p role="alert" className="text-sm text-destructive">{errorText(otherError)}</p>}
          {preview.data && <CampaignPreview preview={preview.data} />}
        </CardContent>
      </Card>
    </div>
  );
}
