import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { ArrowDownIcon, ArrowUpIcon, XIcon } from 'lucide-react';
import type { FieldMap, ObjectFieldMap, SfObject } from '@cti/contracts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { outreachKeys, saveFieldMap } from '@/lib/outreach-api';
import { errorText } from '@/lib/outreach-words';

const SF_OBJECTS: readonly SfObject[] = ['Lead', 'Opportunity'];
const MAX_NOTES_FIELDS = 20;
const SF_FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

/** Why `name` can't be added to the notes list, or null when it can. */
export function noteFieldProblem(name: string, existing: readonly string[]): string | null {
  if (!name) return 'Type a field API name, like Notes__c.';
  if (!SF_FIELD_NAME.test(name)) return 'Use the field API name (letters, numbers, and underscores), like Notes__c.';
  if (existing.some((f) => f.toLowerCase() === name.toLowerCase())) return `${name} is already in the list.`;
  if (existing.length >= MAX_NOTES_FIELDS) return `A list can have at most ${MAX_NOTES_FIELDS} notes fields.`;
  return null;
}

/** `list` with the items at `a` and `b` swapped, as a new array. */
function swapped(list: readonly string[], a: number, b: number): string[] {
  return list.map((item, i) => (i === a ? list[b] : i === b ? list[a] : item) as string);
}

export function FieldMapEditor({ value, canEdit }: { value: FieldMap; canEdit: boolean }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<FieldMap>(value);
  const save = useMutation({
    mutationFn: () => saveFieldMap(draft),
    onSuccess: () => void qc.invalidateQueries({ queryKey: outreachKeys.connection }),
  });
  const update = (sfObject: SfObject, next: ObjectFieldMap) => {
    save.reset();
    setDraft((current) => ({ ...current, [sfObject]: next }));
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>Fields we read</CardTitle>
        <CardDescription>Notes fields feed the AI triage. Phone fields are tried in this order.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {SF_OBJECTS.map((sfObject) => (
          <ObjectFieldsEditor key={sfObject} sfObject={sfObject} value={draft[sfObject]} canEdit={canEdit} onChange={(next) => update(sfObject, next)} />
        ))}
        {canEdit && (
          <div className="flex items-center gap-3">
            <Button onClick={() => save.mutate()} disabled={save.isPending}>Save fields</Button>
            {save.isSuccess && <p role="status" className="text-sm text-muted-foreground">Saved.</p>}
          </div>
        )}
        {save.error && <p role="alert" className="text-sm text-destructive">{errorText(save.error)}</p>}
      </CardContent>
    </Card>
  );
}

interface ObjectFieldsEditorProps { sfObject: SfObject; value: ObjectFieldMap; canEdit: boolean; onChange: (next: ObjectFieldMap) => void }

function ObjectFieldsEditor({ sfObject, value, canEdit, onChange }: ObjectFieldsEditorProps) {
  const headingId = useId();
  const inputId = useId();
  const [newField, setNewField] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const addNote = () => {
    const name = newField.trim();
    const why = noteFieldProblem(name, value.notes);
    setProblem(why);
    if (why) return;
    onChange({ ...value, notes: [...value.notes, name] });
    setNewField('');
  };
  const movePhone = (from: number, to: number) => onChange({ ...value, phones: swapped(value.phones, from, to) });
  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <h3 id={headingId} className="font-medium">{sfObject} fields</h3>
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">Notes fields</p>
        {value.notes.length === 0 && <p className="text-sm text-muted-foreground">None. Triage will only see Tasks.</p>}
        <ul aria-label={`${sfObject} notes fields`} className="flex flex-wrap gap-2">
          {value.notes.map((field) => (
            <li key={field}>
              <Badge variant="secondary" className="gap-1">
                {field}
                {canEdit && (
                  <button type="button" aria-label={`Remove ${field}`} onClick={() => onChange({ ...value, notes: value.notes.filter((f) => f !== field) })}>
                    <XIcon className="size-3" />
                  </button>
                )}
              </Badge>
            </li>
          ))}
        </ul>
        {canEdit && (
          <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); addNote(); }}>
            <div className="grid gap-1">
              <Label htmlFor={inputId}>Add a notes field</Label>
              <Input id={inputId} value={newField} onChange={(e) => setNewField(e.target.value)} placeholder="Notes__c" className="w-56" />
            </div>
            <Button type="submit" variant="outline" size="sm">Add</Button>
          </form>
        )}
        {problem && <p role="alert" className="text-sm text-destructive">{problem}</p>}
      </div>
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">Phone fields, in calling order</p>
        <ol aria-label={`${sfObject} phone fields`} className="space-y-1">
          {value.phones.map((field, i) => (
            <li key={field} className="flex items-center gap-2 text-sm">
              <span className="w-40">{i + 1}. {field}</span>
              {canEdit && (
                <>
                  <Button variant="ghost" size="icon-xs" aria-label={`Move ${field} up`} disabled={i === 0} onClick={() => movePhone(i, i - 1)}><ArrowUpIcon /></Button>
                  <Button variant="ghost" size="icon-xs" aria-label={`Move ${field} down`} disabled={i === value.phones.length - 1} onClick={() => movePhone(i, i + 1)}><ArrowDownIcon /></Button>
                </>
              )}
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
