import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { addTestPhone, outreachKeys } from '@/lib/outreach-api';
import { errorText } from '@/lib/outreach-words';

const LABEL_MAX_CHARS = 60;

/** Add a phone: the number as typed and an optional label. The server's refusal is shown in its own words, and what was typed stays. */
export function TestPhoneForm() {
  const qc = useQueryClient();
  const [phone, setPhone] = useState('');
  const [label, setLabel] = useState('');
  const add = useMutation({
    mutationFn: () => addTestPhone(phone, label),
    onSuccess: async () => {
      setPhone('');
      setLabel('');
      // The other test-call cards (Test call to my phone, Practice, Test a record) list the same phones.
      await Promise.all([qc.invalidateQueries({ queryKey: outreachKeys.testPhones }), qc.invalidateQueries({ queryKey: outreachKeys.aiAvailability })]);
    },
  });
  return (
    <div className="space-y-2">
      <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
        <div className="grid w-full gap-1.5 sm:w-56">
          <Label htmlFor="test-phone-number">Phone</Label>
          <Input id="test-phone-number" type="tel" autoComplete="off" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="(619) 555-0123" />
        </div>
        <div className="grid w-full gap-1.5 sm:w-56">
          <Label htmlFor="test-phone-label">Label (optional)</Label>
          <Input id="test-phone-label" maxLength={LABEL_MAX_CHARS} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Whose phone it is" />
        </div>
        <Button type="submit" disabled={add.isPending || phone.trim() === ''}>Add phone</Button>
      </form>
      {add.error && <p role="alert" className="text-sm text-destructive">{errorText(add.error)}</p>}
    </div>
  );
}
