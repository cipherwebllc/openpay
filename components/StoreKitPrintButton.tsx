'use client';

import { Printer } from 'lucide-react';

export function StoreKitPrintButton({ label }: { label: string }) {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="inline-flex items-center gap-2 rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-dark print:hidden"
    >
      <Printer className="h-4 w-4" aria-hidden />
      {label}
    </button>
  );
}
