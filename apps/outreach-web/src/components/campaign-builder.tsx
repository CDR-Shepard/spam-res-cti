import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { CampaignSource, type Campaign, type CreateCampaignRequest, type PreviewRequest, type SfObject } from '@cti/contracts';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { ApiRequestError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { createCampaign, listViews, outreachKeys, previewCampaign } from '@/lib/outreach-api';
import { errorText } from '@/lib/outreach-words';
import { CampaignPreview } from './campaign-preview';

type SourceKind = CampaignSource['kind'];

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
  const source = sourceFrom(kind, listViewId, soql);
  const views = useQuery({ queryKey: outreachKeys.listViews(sfObject), queryFn: () => listViews(sfObject), enabled: isAdmin && kind === 'list_view' });
  const preview = useMutation({ mutationFn: (req: PreviewRequest) => previewCampaign(req) });
  const create = useMutation({
    mutationFn: (req: CreateCampaignRequest) => createCampaign(req),
    onSuccess: (created) => { void qc.invalidateQueries({ queryKey: outreachKeys.campaignLists }); onCreated(created); },
  });
  /** Any change to what the campaign reads makes an earlier preview or error stale. */
  const sourceChanged = () => { preview.reset(); create.reset(); };

  if (!isAdmin) return <p className="text-sm text-muted-foreground">Only admins can create campaigns.</p>;

  const sourceError = [preview.error, create.error].find(isInvalidSource);
  const otherError = [preview.error, create.error].find((e) => e && !isInvalidSource(e));
  return (
    <Card>
      <CardHeader>
        <CardTitle>New campaign</CardTitle>
        <CardDescription>A campaign starts as a draft. Nothing is sent until you start a dry run and then go live.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-1">
            <Label htmlFor="campaign-name">Campaign name</Label>
            <Input id="campaign-name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="Spring motivated sellers" />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="campaign-object">Salesforce object</Label>
            <select
              id="campaign-object"
              className="h-9 rounded-md border bg-background px-2 text-sm"
              value={sfObject}
              onChange={(e) => { setSfObject(e.target.value === 'Opportunity' ? 'Opportunity' : 'Lead'); setListViewId(''); sourceChanged(); }}
            >
              <option value="Lead">Leads</option>
              <option value="Opportunity">Opportunities</option>
            </select>
          </div>
        </div>
        <Tabs value={kind} onValueChange={(v) => { setKind(v === 'soql' ? 'soql' : 'list_view'); sourceChanged(); }}>
          <TabsList aria-label="Who is in the campaign">
            <TabsTrigger value="list_view">List view</TabsTrigger>
            <TabsTrigger value="soql">SOQL</TabsTrigger>
          </TabsList>
          <TabsContent value="list_view" className="grid gap-1 pt-2">
            <Label htmlFor="campaign-list-view">Salesforce list view</Label>
            <select
              id="campaign-list-view"
              className="h-9 rounded-md border bg-background px-2 text-sm"
              value={listViewId}
              onChange={(e) => { setListViewId(e.target.value); sourceChanged(); }}
            >
              <option value="">{views.isPending ? 'Loading list views…' : 'Choose a list view'}</option>
              {views.data?.listViews.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
            </select>
            {views.error && <p role="alert" className="text-sm text-destructive">{errorText(views.error)}</p>}
            <p className="text-xs text-muted-foreground">The list view is read again on every refresh, so edits in Salesforce carry over.</p>
          </TabsContent>
          <TabsContent value="soql" className="grid gap-1 pt-2">
            <Label htmlFor="campaign-soql">SOQL query</Label>
            <Textarea
              id="campaign-soql"
              rows={6}
              spellCheck={false}
              className="font-mono"
              value={soql}
              onChange={(e) => { setSoql(e.target.value); sourceChanged(); }}
              placeholder={`SELECT Id FROM ${sfObject} WHERE ...`}
            />
            <p className="text-xs text-muted-foreground">One SELECT on {sfObject}. No COUNT(), GROUP BY, or semicolons.</p>
          </TabsContent>
        </Tabs>
        {sourceError && <p role="alert" className="text-sm text-destructive">Salesforce can't use this source: {sourceError.message}</p>}
        <div className="flex gap-2">
          <Button type="button" variant="outline" disabled={!source || preview.isPending} onClick={() => source && preview.mutate({ sfObject, source })}>Preview</Button>
          <Button type="button" disabled={!source || !name.trim() || create.isPending} onClick={() => source && create.mutate({ name: name.trim(), sfObject, source })}>Create campaign</Button>
        </div>
        {preview.isPending && <p className="text-sm text-muted-foreground">Checking records in Salesforce…</p>}
        {otherError && <p role="alert" className="text-sm text-destructive">{errorText(otherError)}</p>}
        {preview.data && <CampaignPreview preview={preview.data} />}
      </CardContent>
    </Card>
  );
}
