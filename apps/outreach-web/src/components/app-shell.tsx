import { useState, type ReactNode } from 'react';
import { Menu } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { AccountPanel, MainNav, Wordmark } from './app-nav';

const SIDEBAR_WIDTH = 'md:pl-[232px]';

/**
 * The signed-in frame. Desktop: a fixed 232px sidebar (wordmark, main nav, account at the bottom). Below 768px: a
 * top bar whose menu button opens the same nav in a drawer (Escape or the close button shuts it; a link closes it).
 */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <a href="#main" className="sr-only z-[60] rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground focus:not-sr-only focus:fixed focus:top-3 focus:left-3">
        Skip to content
      </a>
      <div className="fixed inset-y-0 left-0 z-30 hidden w-[232px] flex-col border-r border-sidebar-border bg-sidebar md:flex">
        <div className="flex h-16 shrink-0 items-center px-5"><Wordmark /></div>
        <div className="flex-1 overflow-y-auto px-3 pt-2 pb-4"><MainNav /></div>
        <AccountPanel />
      </div>
      <MobileBar />
      <main id="main" tabIndex={-1} className={`min-w-0 outline-none ${SIDEBAR_WIDTH}`}>
        <div className="mx-auto w-full max-w-[1120px] px-4 pt-6 pb-16 sm:px-6 md:px-10 md:pt-10">{children}</div>
      </main>
    </div>
  );
}

function MobileBar() {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  return (
    <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b bg-background/85 px-4 backdrop-blur-md md:hidden">
      <Wordmark />
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <Button variant="ghost" size="icon" aria-label="Open menu"><Menu aria-hidden /></Button>
        </SheetTrigger>
        <SheetContent>
          <SheetTitle>Menu</SheetTitle>
          <div className="flex h-14 shrink-0 items-center px-5"><Wordmark onNavigate={close} /></div>
          <div className="flex-1 overflow-y-auto px-3 pt-2 pb-4"><MainNav onNavigate={close} /></div>
          <AccountPanel />
        </SheetContent>
      </Sheet>
    </header>
  );
}
