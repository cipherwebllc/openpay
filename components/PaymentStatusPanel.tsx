'use client';

import { Loader2 } from 'lucide-react';

type PaymentStatusPanelProps = {
  title: string;
  body: string;
  titleWithIcon?: boolean;
  showSpinner?: boolean;
  identifier?: string;
  explorerHref?: string;
  explorerLabel?: string;
  actionLabel?: string;
  actionDisabled?: boolean;
  onAction?: () => void;
};

const ACTION_CLASS =
  'mt-3 w-full rounded-lg bg-sky-600 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-700';

export function PaymentStatusPanel({
  title,
  body,
  titleWithIcon = false,
  showSpinner = false,
  identifier,
  explorerHref,
  explorerLabel,
  actionLabel,
  actionDisabled,
  onAction,
}: PaymentStatusPanelProps) {
  return (
    <div className="rounded-xl border border-sky-200 bg-sky-50 p-4 text-sm text-sky-800">
      <p
        className={
          titleWithIcon
            ? 'flex items-center gap-1.5 font-semibold'
            : 'font-semibold'
        }
      >
        {showSpinner && (
          <Loader2 className="h-4 w-4 flex-none animate-spin" aria-hidden />
        )}
        {title}
      </p>
      <p className="mt-1 break-words">{body}</p>
      {identifier && (
        <p className="mt-2 break-all font-mono text-xs">
          {identifier}
          {explorerHref && explorerLabel && (
            <>
              {' · '}
              <a
                href={explorerHref}
                target="_blank"
                rel="noreferrer noopener"
                className="font-sans underline hover:text-sky-900"
              >
                {explorerLabel} ↗
              </a>
            </>
          )}
        </p>
      )}
      {actionLabel && onAction && (
        <button
          type="button"
          disabled={actionDisabled}
          onClick={onAction}
          className={
            actionDisabled === undefined
              ? ACTION_CLASS
              : `${ACTION_CLASS} disabled:cursor-not-allowed disabled:opacity-50`
          }
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}
