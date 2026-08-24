/**
 * What the wrap-up submit should do with the Salesforce Task that Open CTI
 * owns for the current call.
 *
 * The subtlety is the RETRY. The first submit may write the Task via Open CTI
 * and then fail on the backend PATCH; the rep fixes something — often the
 * disposition itself — and resubmits. Because the disposition now lives inside
 * Task.Subject (call-subject.ts), leaving the first attempt's Task untouched
 * would strand the wrong disposition in the Salesforce timeline.
 *
 * Open CTI's saveLog UPDATES a record when the value carries its `Id`, so a
 * retry can rewrite the Task in place — but ONLY when Salesforce actually
 * returned the id. Without one, a second saveLog would create a DUPLICATE
 * Task, which is strictly worse than a stale subject, so we keep the first
 * Task and let the backend PATCH be the only thing retried.
 */
export interface OpenCtiSavePlan {
  /** Call saveCallLog at all? */
  write: boolean;
  /** Present only for a retry that can UPDATE the Task rather than create one. */
  updateId?: string;
}

export function openCtiSavePlan(args: {
  /** The click-to-dial record this call came from, when there is one. */
  recordId?: string;
  /** false when the server's ownership gate blocked an SF Task for this call. */
  taskAllowed?: boolean;
  /** A prior submit already wrote the Task via Open CTI. */
  alreadyWritten: boolean;
  /** The Task id Salesforce returned from that write, when it returned one. */
  existingTaskId: string | null;
}): OpenCtiSavePlan {
  if (!args.recordId || args.taskAllowed === false) return { write: false };
  if (!args.alreadyWritten) return { write: true };
  return args.existingTaskId ? { write: true, updateId: args.existingTaskId } : { write: false };
}
