import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { getAppVersion, outreachKeys } from '@/lib/outreach-api';
import { bakedCommit, formatDeployed, isStaleBuild } from '@/lib/version';

export const VERSION_REFETCH_MS = 60_000;

/**
 * Bottom of the sidebar: which commit the live app (outreach-web and outreach-api, one build) and the AI voice server
 * run, and when the app last started, so the owner can tell whether a push has deployed. "New version — refresh"
 * shows only when this open tab was built from an older commit than the live app. Until the server answers, or if it
 * cannot, it quietly shows this tab's own commit.
 */
export function VersionTag() {
  const baked = bakedCommit();
  const version = useQuery({
    queryKey: outreachKeys.appVersion,
    queryFn: getAppVersion,
    refetchInterval: VERSION_REFETCH_MS,
    refetchOnWindowFocus: 'always',
    retry: false,
  });
  const live = version.data;
  if (!live) return <div className="px-1 text-xs leading-5 text-muted-foreground"><span>App {baked}</span></div>;
  return (
    <div className="space-y-0.5 px-1 text-xs leading-5 text-muted-foreground">
      <p className="flex flex-wrap gap-x-1.5">
        <span title="The commit the app (web and API) is running">App {live.app.commit}</span>
        <span aria-hidden>·</span>
        <span title="The commit the AI voice server is running">Calls {live.calls?.commit ?? 'unknown'}</span>
      </p>
      <p>deployed {formatDeployed(live.app.startedAt)}</p>
      {isStaleBuild(baked, live.app.commit) && (
        <Button variant="outline" size="xs" className="mt-1.5" onClick={() => window.location.reload()}>New version — refresh</Button>
      )}
    </div>
  );
}
