// /transparency: OpenPay の既存実装・開示を集約する運用透明性ページ。
//
// content SOT は lib/transparency.ts (ja/en 同梱)。描画は PosGuidePieces の
// Section/BulletList と AgentGuidePieces の CodeBlock を再利用する。
// SEO 対象なので robots は index/follow。掟 3: default / generateMetadata 以外を export しない。

import type { Metadata } from 'next';
import Link from 'next/link';
import { setRequestLocale } from 'next-intl/server';
import { AppShell } from '@/components/AppShell';
import { CodeBlock } from '@/components/guide/AgentGuidePieces';
import {
  BulletList,
  Section,
} from '@/components/guide/PosGuidePieces';
import {
  transparencyContentFor,
  transparencyMetadata,
} from '@/lib/transparency';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  setRequestLocale(locale);
  return transparencyMetadata(locale);
}

export default async function TransparencyPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const content = transparencyContentFor(locale);

  return (
    <AppShell>
      <article className="mx-auto max-w-4xl">
        <Link
          href={`/${locale}`}
          prefetch={false}
          className="text-sm font-medium text-emerald-700 hover:text-emerald-900"
        >
          {content.backHome}
        </Link>

        <header className="mt-4">
          <h1 className="text-2xl font-bold text-slate-900 sm:text-3xl">
            {content.title}
          </h1>
          <p className="mt-4 text-sm leading-relaxed text-slate-700">
            {content.subtitle}
          </p>
        </header>

        <Section title={content.custodyTitle}>
          <BulletList
            items={content.custodyItems}
            marker="•"
            markerClassName="text-emerald-600"
          />
        </Section>

        <Section title={content.contractsTitle}>
          <div className="mt-4 overflow-hidden rounded-2xl bg-white shadow-card ring-1 ring-slate-200/70">
            <table className="w-full table-fixed text-left text-sm">
              <colgroup>
                <col className="w-[18%]" />
                <col className="w-[27%]" />
                <col className="w-[55%]" />
              </colgroup>
              <thead className="bg-slate-50 text-xs text-slate-600">
                <tr>
                  <th scope="col" className="px-3 py-3 font-semibold sm:px-4">
                    {content.contractHeaders.token}
                  </th>
                  <th scope="col" className="px-3 py-3 font-semibold sm:px-4">
                    {content.contractHeaders.chain}
                  </th>
                  <th scope="col" className="px-3 py-3 font-semibold sm:px-4">
                    {content.contractHeaders.address}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {content.contracts.map((contract) => (
                  <tr key={`${contract.token}:${contract.chain}`}>
                    <td className="px-3 py-3 font-semibold text-slate-900 sm:px-4">
                      {contract.token}
                    </td>
                    <td className="break-words px-3 py-3 text-slate-700 sm:px-4">
                      {contract.chain}
                    </td>
                    <td className="break-all px-3 py-3 font-mono text-xs text-slate-700 sm:px-4">
                      {contract.address}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 rounded-xl bg-amber-50 p-4 text-sm leading-relaxed text-amber-900 ring-1 ring-amber-200">
            {content.contractNote}
          </p>
        </Section>

        <Section title={content.verificationTitle}>
          <BulletList
            items={content.verificationItems}
            marker="•"
            markerClassName="text-emerald-600"
          />
          <CodeBlock
            label={content.receiptEndpointLabel}
            code={content.receiptEndpoint}
          />
        </Section>

        <Section title={content.feesTitle}>
          <BulletList
            items={content.fees}
            marker="•"
            markerClassName="text-emerald-600"
          />
          <p className="mt-4 text-sm leading-relaxed text-slate-700">
            {content.feeDetailsLead}{' '}
            {content.feeLinks.map((link, index) => (
              <span key={link.href}>
                {index > 0 ? ' / ' : null}
                <Link
                  href={`/${locale}${link.href}`}
                  className="font-medium text-emerald-700 underline decoration-emerald-300 underline-offset-2 hover:text-emerald-900"
                >
                  {link.label}
                </Link>
              </span>
            ))}
          </p>
        </Section>

        <Section title={content.refundsTitle}>
          <BulletList
            items={content.refundsItems}
            marker="•"
            markerClassName="text-emerald-600"
          />
        </Section>

        <Section title={content.uncertaintyTitle}>
          <BulletList
            items={content.uncertaintyItems}
            marker="•"
            markerClassName="text-emerald-600"
          />
        </Section>

        <Section title={content.listingsTitle}>
          <BulletList
            items={content.listings}
            marker="•"
            markerClassName="text-emerald-600"
          />
        </Section>

        <Section title={content.metricsTitle}>
          <BulletList
            items={content.metricsItems}
            marker="•"
            markerClassName="text-emerald-600"
          />
        </Section>

        <footer className="mt-12 border-t border-slate-200 pt-6 text-sm leading-relaxed text-slate-600">
          <p>
            {content.legalLead}{' '}
            {content.legalLinks.map((link, index) => (
              <span key={link.href}>
                {index > 0 ? ' / ' : null}
                <Link
                  href={`/${locale}${link.href}`}
                  className="font-medium text-emerald-700 underline decoration-emerald-300 underline-offset-2 hover:text-emerald-900"
                >
                  {link.label}
                </Link>
              </span>
            ))}
          </p>
          <p className="mt-3">
            {content.guidesLead}{' '}
            {content.guideLinks.map((link, index) => (
              <span key={link.href}>
                {index > 0 ? ' / ' : null}
                <Link
                  href={`/${locale}${link.href}`}
                  className="font-medium text-emerald-700 underline decoration-emerald-300 underline-offset-2 hover:text-emerald-900"
                >
                  {link.label}
                </Link>
              </span>
            ))}
          </p>
        </footer>
      </article>
    </AppShell>
  );
}
