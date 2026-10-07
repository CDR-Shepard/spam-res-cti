import type { ListViewsResponse, SfObject } from '@cti/contracts';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { errorText } from '@/lib/outreach-words';

export type SourceKind = 'list_view' | 'soql';

export interface CampaignSourceFieldsProps {
  sfObject: SfObject;
  kind: SourceKind;
  listViewId: string;
  soql: string;
  views: { isPending: boolean; error: unknown; data?: ListViewsResponse };
  onKind: (kind: SourceKind) => void;
  onListView: (id: string) => void;
  onSoql: (soql: string) => void;
}

/** Who is in the campaign: a Salesforce list view or a pasted query. */
export function CampaignSourceFields({ sfObject, kind, listViewId, soql, views, onKind, onListView, onSoql }: CampaignSourceFieldsProps) {
  return (
    <Tabs value={kind} onValueChange={(v) => onKind(v === 'soql' ? 'soql' : 'list_view')}>
      <TabsList aria-label="Who is in the campaign">
        <TabsTrigger value="list_view">List view</TabsTrigger>
        <TabsTrigger value="soql">SOQL</TabsTrigger>
      </TabsList>
      <TabsContent value="list_view" className="grid gap-1 pt-2">
        <Label htmlFor="campaign-list-view">Salesforce list view</Label>
        <NativeSelect
          id="campaign-list-view"
          value={listViewId}
          onChange={(e) => onListView(e.target.value)}
        >
          <option value="">{views.isPending ? 'Loading list views…' : 'Choose a list view'}</option>
          {views.data?.listViews.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
        </NativeSelect>
        {Boolean(views.error) && <p role="alert" className="text-sm text-destructive">{errorText(views.error)}</p>}
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
          onChange={(e) => onSoql(e.target.value)}
          placeholder={`SELECT Id FROM ${sfObject} WHERE ...`}
        />
        <p className="text-xs text-muted-foreground">One SELECT on {sfObject}. No COUNT(), GROUP BY, or semicolons.</p>
      </TabsContent>
    </Tabs>
  );
}
