import type { Metadata } from 'next';
import { Bricolage_Grotesque, IBM_Plex_Mono, Public_Sans } from 'next/font/google';
import './globals.css';

// Display carries the personality; body is the plain civic voice this subject
// wants; mono is reserved for data a person can check — addresses, counts, site
// labels — so the typeface itself marks what is evidence.
const display = Bricolage_Grotesque({
  subsets: ['latin'],
  weight: ['600', '700'],
  variable: '--font-display',
});

const body = Public_Sans({
  subsets: ['latin'],
  weight: ['400', '600'],
  variable: '--font-body',
});

const mono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-mono',
});

export const metadata: Metadata = {
  title: 'DepositCheck',
  description: 'Check whether a rental listing photo belongs to the address it claims.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
